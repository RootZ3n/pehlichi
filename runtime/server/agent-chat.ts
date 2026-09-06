import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MimoDriver, type AgentEvent, type Driver, type Message, type ToolResult } from '../../src/core/index.js';
import { createFullToolRegistry } from '../../src/core/agent-tools/index.js';
import { DATA_ROOT_VARIABLES, requiredDataRoot } from '../../src/core/data-roots.js';
import { agentProfile } from '../../src/profiles/agent.js';
import { loadAgentRuntimeConfiguration, authorizedToolNames } from './config.js';
import {
  KernelChatSession,
  ResilientDriver,
  defaultApprovalPolicy,
  type KernelChatResponse,
  type KernelChatSessionOptions,
  type KernelToolCall,
} from './kernel-session.js';
import { loadPersonality, type Personality } from './personality.js';
import { loadSkin, type Skin } from './skin.js';
import { TruthSessionGate, type ObservedToolCall } from './truth-gate.js';

export interface ChatMessage {
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly content: string;
  readonly timestamp: number;
  readonly tool_call_id?: string;
  readonly name?: string;
}

export interface CacheHitInfo {
  readonly cachedTokens: number;
  readonly totalPromptTokens: number;
  readonly hitPercent: string;
}

export interface ChatResponse {
  readonly content: string;
  readonly thinkingVerb?: string;
  readonly toolCalls?: readonly { readonly name: string; readonly args: Record<string, unknown>; readonly result: ToolResult }[];
  readonly cacheHit?: CacheHitInfo;
  readonly tokenUsage?: KernelChatResponse['tokenUsage'];
  readonly injectionDetected?: boolean;
}

export type StreamCallback = (chunk: string) => void;

export interface LegacyAgentChatOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly workspaceRoot?: string;
  readonly agentServerUrl?: string;
  readonly maxIterations?: number;
  /** Deterministic compatibility seam; production callers omit it. */
  readonly driver?: Driver;
  readonly repositoryRoot?: string;
}

function isKernelOptions(value: LegacyAgentChatOptions | KernelChatSessionOptions): value is KernelChatSessionOptions {
  return 'profile' in value && 'driver' in value && 'labStoreRoot' in value && 'toolNames' in value;
}

/**
 * Backward-compatible public facade over the one governed KernelChatSession.
 * This adapter owns no model/tool loop and cannot derive authority from registry presence.
 */
export class AgentChatSession {
  private readonly kernel: KernelChatSession;
  private readonly personality: Personality;
  private readonly skin: Skin;
  private readonly lane: readonly string[];
  private readonly startedAt = Date.now();
  /**
   * The mandatory authority boundary for this session, constructed before the model is
   * given tools so the trusted base it captures predates any change it could make.
   */
  private readonly truth: TruthSessionGate = new TruthSessionGate({
    agent: process.env.AGENT_ID ?? 'trio-agent',
    sessionId: `agent-${Date.now().toString(36)}`,
    taskId: `agent-${Date.now().toString(36)}`,
  });

  constructor(options: LegacyAgentChatOptions | KernelChatSessionOptions = {}) {
    if (isKernelOptions(options)) {
      this.kernel = new KernelChatSession(options);
      this.lane = Object.freeze([...options.toolNames]);
      const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
      this.personality = loadPersonality(join(root, 'personality'));
      this.skin = loadSkin(join(root, 'tui', 'skin.yaml'));
      return;
    }

    const repositoryRoot = options.repositoryRoot ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const config = loadAgentRuntimeConfiguration(repositoryRoot, agentProfile);
    const { capsule, deployment } = config;
    this.lane = Object.freeze(authorizedToolNames(config));
    this.personality = loadPersonality(join(repositoryRoot, capsule.personalityPath));
    this.skin = loadSkin(join(repositoryRoot, capsule.skinPath));
    const workspaceRoot = options.workspaceRoot ?? deployment.defaults.workspace;
    const driver = options.driver ?? new MimoDriver({
      baseUrl: options.baseUrl ?? capsule.providerDefaults.baseUrl,
      model: options.model ?? capsule.providerDefaults.model,
      ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    });
    const tools = createFullToolRegistry({
      workspaceRoot,
      agentServerUrl: options.agentServerUrl ?? `http://127.0.0.1:${deployment.defaults.port}`,
      agentId: capsule.identity.id,
      authorizedToolNames: this.lane,
      enableWorkOrders: capsule.requestedCapabilityPacks.includes('work-orders'),
      enableOccasio: capsule.requestedCapabilityPacks.includes('occasio'),
      routingTargets: deployment.routingTargets,
      ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    });
    this.kernel = new KernelChatSession({
      profile: { ...agentProfile, name: capsule.identity.displayName, role: capsule.identity.role, icon: capsule.identity.icon },
      driver,
      workspaceRoot,
      labStoreRoot: requiredDataRoot(...DATA_ROOT_VARIABLES.store),
      extraTools: tools,
      toolNames: this.lane,
      approvalCallback: defaultApprovalPolicy({ allowWrites: false }),
      ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
    });
  }

  getPersonality(): Personality { return this.personality; }
  getSkin(): Skin { return this.skin; }

  getHistory(): ChatMessage[] {
    return this.kernel.getHistory().map((message: Message) => ({
      role: message.role,
      content: message.content,
      timestamp: this.startedAt,
    }));
  }

  getToolNames(): string[] { return [...this.lane]; }

  getCacheStats(): { totalHits: number; totalPromptTokens: number; hitRate: string } {
    const summary = this.kernel.getTokenSummary() as unknown as { cachedTokens?: number; inputTokens?: number };
    const hits = summary.cachedTokens ?? 0;
    const total = summary.inputTokens ?? 0;
    return { totalHits: hits, totalPromptTokens: total, hitRate: `${total > 0 ? ((hits / total) * 100).toFixed(1) : '0.0'}%` };
  }

  getInfrastructureStatus(): {
    circuit: { state: string; failures: number };
    budget: { consumed: number; remaining: number; max: number };
    tokens: KernelChatResponse['tokenUsage'];
  } {
    return {
      circuit: { state: 'governed-driver', failures: 0 },
      budget: { consumed: 0, remaining: 0, max: 0 },
      tokens: this.kernel.getTokenSummary(),
    };
  }

  async send(userMessage: string, onStream?: StreamCallback): Promise<ChatResponse> {
    // The caller's callback receives transport liveness and never a model delta.
    const contained = this.truth.containStream(onStream);
    const response = await this.kernel.send(userMessage, onStream === undefined ? undefined : (event: AgentEvent) => {
      // `narrate` is model-authored, so it goes through containment. Tool status is
      // transport-level -- a tool name and whether it succeeded -- and carries no content
      // the model chose, so it is shown live. The tool's own output is deliberately not
      // included: that is content the model can influence.
      if (event.kind === 'narrate') contained?.(event.text);
      else if (event.kind === 'tool-result') onStream(`\n${event.tool}: ${event.ok ? 'ok' : 'failed'}\n`);
    });
    // The final answer crosses the boundary before it is streamed or returned. Host
    // events come from the tool calls the kernel actually ran, never from what the model
    // said about them.
    const decision = this.truth.finalize({
      userMessage,
      candidateNarrative: response.content,
      toolCalls: (response.toolCalls ?? []) as unknown as ObservedToolCall[],
      channel: 'tui',
      ...(response.partial === true ? { partial: true } : {}),
    });
    const authorized = decision.deliverable();
    contained?.(authorized);
    return {
      content: authorized,
      toolCalls: response.toolCalls.map((call: KernelToolCall) => ({
        name: call.name,
        args: (typeof call.args === 'object' && call.args !== null ? call.args : {}) as Record<string, unknown>,
        result: { ok: call.ok, output: call.output, ...(call.error !== undefined ? { error: call.error } : {}) },
      })),
      tokenUsage: response.tokenUsage,
      injectionDetected: response.injectionDetected,
    };
  }

  async ask(question: string): Promise<string> { return (await this.send(question)).content; }
  reset(): void { this.kernel.reset(); }
}

export {
  KernelChatSession,
  ResilientDriver,
  defaultApprovalPolicy,
  type KernelChatResponse,
  type KernelToolCall,
  type KernelChatSessionOptions,
};

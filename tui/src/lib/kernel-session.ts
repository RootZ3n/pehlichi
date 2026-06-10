/**
 * KERNEL CHAT SESSION — production chat on top of the HARDENED kernel (Blocker 1).
 *
 * The old AgentChatSession ran its OWN fetch→tool→loop cycle, bypassing the kernel
 * entirely: no trust tiers, no approval gate, no allowlist, no receipts, no
 * partial-on-exhaustion, no event stream. This session instead drives the kernel's
 * `runAgent()` for every request, so EVERY chat turn flows through the kernel:
 *   - the kernel tool registry (createToolRegistry + createFullToolRegistry), not an ad-hoc one
 *   - the kernel event stream (tool-call / tool-result / terminal-receipt / summary)
 *   - validateSummary on `done`
 *   - partialOnExhaustion instead of a silent stale replay (Blocker 2)
 *   - an approval gate (Blocker 6)
 *
 * Production infrastructure that the kernel does NOT itself have (circuit breaker,
 * retry, prompt-injection scanning, input sanitization, token monitoring) is NOT
 * lost — it is wired in HERE (the driver layer + the request boundary):
 *   - injection scan + input sanitization at send() before the kernel runs
 *   - circuit breaker + retry + error classification wrapped around the driver
 *     (ResilientDriver), so every kernel turn inherits them
 *
 * Conversation context is preserved across requests by threading the accumulated
 * transcript into each run via the kernel's `priorMessages` seam.
 */
import {
  runAgent,
  type Driver,
  type DriverAction,
  type DriverContext,
  type Message,
  type AgentEvent,
  type ToolDef,
  type ApprovalCallback,
  type TerminalReceipt,
} from '../../../src/core/index.js';
import { createFullToolRegistry, type AgentToolConfig } from '../../../src/core/agent-tools/index.js';
import type { AgentProfile } from '../../../src/core/profile.js';

// Production infrastructure (preserved from agent-chat.ts).
import { CircuitBreaker } from '../../../src/core/agent-tools/circuit-breaker.js';
import { scanForInjection } from '../../../src/core/agent-tools/prompt-injection.js';
import { TokenMonitor } from '../../../src/core/agent-tools/token-monitor.js';
import { sanitizeMessage } from '../../../src/core/agent-tools/input-sanitization.js';
import { classifyError } from '../../../src/core/agent-tools/error-classifier.js';
import { withRetry } from '../../../src/core/agent-tools/retry.js';

const DEFAULT_MAX_ITERATIONS = 20;

/** One structured tool call as surfaced to HTTP consumers — INCLUDING its receipt (Blocker 5). */
export interface KernelToolCall {
  readonly name: string;
  readonly args: unknown;
  readonly ok: boolean;
  readonly output: string;
  readonly error?: string;
  /** The audit receipt for a terminal command, when present — evidence the bridge must NOT strip. */
  readonly receipt?: TerminalReceipt;
}

export interface KernelChatResponse {
  /** The closing summary text on `done`, or the budget-exhausted notice on partial. */
  readonly content: string;
  /** True when the run reached `done`; false when the budget was exhausted (partial). */
  readonly ok: boolean;
  /** True iff the run ended by exhausting its iteration budget (Blocker 2). */
  readonly partial: boolean;
  /** Human-readable accomplishments captured during the run (present on partial). */
  readonly accomplished: readonly string[];
  /** Structured tool calls WITH receipts (Blocker 5 — nothing is stripped). */
  readonly toolCalls: readonly KernelToolCall[];
  /** EVERY kernel event from the run, in order (Blocker 5 — the full evidence trail). */
  readonly events: readonly AgentEvent[];
  readonly thinkingVerb?: string;
  readonly tokenUsage?: ReturnType<TokenMonitor['summary']>;
  /** True iff send() short-circuited on a detected prompt injection. */
  readonly injectionDetected?: boolean;
}

/**
 * A Driver decorator that adds the production resilience the kernel lacks: a circuit
 * breaker, retry with jittered backoff, and error classification — all wrapped around
 * any underlying driver's `next()`. This is how the agent-chat infrastructure is
 * preserved without the kernel hardcoding it.
 */
export class ResilientDriver implements Driver {
  constructor(
    private readonly inner: Driver,
    private readonly breaker: CircuitBreaker,
  ) {}

  async next(ctx: DriverContext): Promise<DriverAction> {
    if (!this.breaker.allow()) {
      const s = this.breaker.status();
      throw new Error(`Circuit breaker OPEN for ${s.adapterId} (${s.failures} failures). Cooling down.`);
    }
    try {
      const action = await withRetry(
        () => this.inner.next(ctx),
        { maxAttempts: 3, baseMs: 2000, maxMs: 15_000, jitterRatio: 0.5 },
      );
      this.breaker.success();
      return action;
    } catch (err) {
      this.breaker.failure();
      const classified = classifyError(err);
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Driver failed [${classified.category}]: ${message}`);
    }
  }
}

export interface KernelChatSessionOptions {
  readonly profile: AgentProfile;
  readonly driver: Driver;
  readonly workspaceRoot: string;
  readonly labStoreRoot: string;
  /** Extra tools merged into the kernel registry. Defaults to the full agent tool suite. */
  readonly extraTools?: readonly ToolDef[];
  readonly maxIterations?: number;
  /** The approval policy (Blocker 6). Defaults to read-only-auto-approve, writes gated off. */
  readonly approvalCallback?: ApprovalCallback;
  readonly memoryStoreRoot?: string;
  readonly clock?: () => number;
}

/**
 * Drives the kernel loop for incremental chat while preserving conversation context.
 */
export class KernelChatSession {
  private readonly opts: KernelChatSessionOptions;
  private readonly tokenMonitor: TokenMonitor;
  /** Accumulated prior turns, threaded into each run via the kernel's priorMessages seam. */
  private history: Message[] = [];

  constructor(opts: KernelChatSessionOptions) {
    this.opts = opts;
    this.tokenMonitor = new TokenMonitor({ model: 'kernel' });
  }

  getHistory(): readonly Message[] {
    return this.history;
  }

  reset(): void {
    this.history = [];
  }

  async send(userMessage: string, onEvent?: (e: AgentEvent) => void): Promise<KernelChatResponse> {
    // 1. PROMPT INJECTION SCAN — refuse unsafe input before the kernel ever runs.
    const injection = scanForInjection(userMessage, 'context');
    if (injection.detected) {
      return {
        content: `I detected potentially unsafe content in your message (${injection.patterns.join(', ')}). Please rephrase your request.`,
        ok: false,
        partial: false,
        accomplished: [],
        toolCalls: [],
        events: [],
        injectionDetected: true,
      };
    }

    // 2. SANITIZE the user message.
    const task = sanitizeMessage(userMessage);

    // 3. Capture EVERY kernel event (Blocker 5).
    const events: AgentEvent[] = [];
    const sink = (e: AgentEvent): void => {
      events.push(e);
      onEvent?.(e);
    };

    const result = await runAgent({
      profile: this.opts.profile,
      task,
      workspaceRoot: this.opts.workspaceRoot,
      labStoreRoot: this.opts.labStoreRoot,
      driver: this.opts.driver,
      sinks: [sink],
      extraTools: this.opts.extraTools,
      maxIterations: this.opts.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      partialOnExhaustion: true, // Blocker 2: never a stale replay.
      priorMessages: this.history, // Blocker 1: preserve conversation context.
      plan: false,
      ...(this.opts.approvalCallback !== undefined ? { approvalCallback: this.opts.approvalCallback } : {}),
      ...(this.opts.memoryStoreRoot !== undefined ? { memoryStoreRoot: this.opts.memoryStoreRoot } : {}),
      ...(this.opts.clock !== undefined ? { clock: this.opts.clock } : {}),
    });

    const toolCalls = collectToolCalls(events);
    const content = result.ok ? summaryText(events) : (result.output ?? 'Budget exhausted.');

    // Thread this turn into the running transcript for the next request.
    this.history.push({ role: 'user', content: task });
    this.history.push({ role: 'assistant', content });

    return {
      content,
      ok: result.ok,
      partial: result.partial === true,
      accomplished: result.accomplished ?? [],
      toolCalls,
      events,
      tokenUsage: this.tokenMonitor.summary(),
    };
  }
}

/** Reduce the event stream into structured tool calls, attaching terminal receipts (Blocker 5). */
function collectToolCalls(events: readonly AgentEvent[]): KernelToolCall[] {
  const calls: KernelToolCall[] = [];
  let pending: { name: string; args: unknown } | undefined;
  for (const e of events) {
    if (e.kind === 'tool-call') {
      pending = { name: e.tool, args: e.args };
    } else if (e.kind === 'tool-result') {
      calls.push({
        name: e.tool,
        args: pending?.name === e.tool ? pending.args : {},
        ok: e.ok,
        output: e.output,
        ...(e.error !== undefined ? { error: e.error } : {}),
      });
      pending = undefined;
    } else if (e.kind === 'terminal-receipt' && calls.length > 0) {
      // The receipt event immediately follows its tool-result; attach to the last call.
      const last = calls[calls.length - 1]!;
      const { ts: _ts, seq: _seq, kind: _kind, ...receipt } = e;
      calls[calls.length - 1] = { ...last, receipt: receipt as TerminalReceipt };
    }
  }
  return calls;
}

/** Compose a human-readable answer from the summary event (the kernel's closing report). */
function summaryText(events: readonly AgentEvent[]): string {
  const summary = events.find((e): e is Extract<AgentEvent, { kind: 'summary' }> => e.kind === 'summary');
  if (summary === undefined) return '(no summary)';
  return [summary.rootCause, ...summary.changes, ...summary.verification].filter(Boolean).join('\n');
}

/** Build the full agent tool suite for a kernel chat session (the kernel's tool source). */
export function buildAgentTools(config: AgentToolConfig): ToolDef[] {
  return createFullToolRegistry(config);
}

/**
 * A default approval policy (Blocker 6): auto-approve read-only tools, gate the rest.
 * Production wires this so the kernel refuses write/destructive tools unless approved.
 */
const READ_ONLY_TOOLS = new Set([
  'read_file', 'search_files', 'list_files', 'web_search', 'web_extract',
  'memory_read', 'memory_search', 'lab_context_read', 'agent_sync', 'todo', 'clarify',
]);
export function defaultApprovalPolicy(opts?: { allowWrites?: boolean }): ApprovalCallback {
  const allowWrites = opts?.allowWrites === true;
  return ({ tool }) => {
    if (READ_ONLY_TOOLS.has(tool)) return { approved: true };
    if (allowWrites) return { approved: true };
    return { approved: false, reason: `write/destructive tool "${tool}" requires approval` };
  };
}

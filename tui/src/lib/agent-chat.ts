/**
 * AGENT CHAT SESSION — cache-first tool-calling loop.
 *
 * Architecture (borrowed from Reasonix):
 * ┌──────────────────────────────────────┐
 * │ IMMUTABLE PREFIX  (frozen at start)   │ ← 85-95% cache target
 * │ system prompt + tool definitions      │   never changes mid-session
 * ├──────────────────────────────────────┤
 * │ APPEND-ONLY LOG  (monotonic growth)   │ ← grows each turn
 * │ [user₁][assistant₁][tool₁]...         │   never reordered, never mutated
 * ├──────────────────────────────────────┤
 * │ DYNAMIC CONTEXT  (per-turn)           │ ← injected as user message prefix
 * │ cwd, task context, instructions       │   NOT in system prompt
 * └──────────────────────────────────────┘
 *
 * Key invariants:
 * - System prompt is FROZEN at construction — never changes mid-session
 * - Messages are APPEND-ONLY — never reordered, never mutated
 * - Dynamic state (cwd, task context) rides in user messages, NOT system prompt
 * - Compaction is RARE — only at 80% context window, preserves head + tail
 * - Cache hit tracking on every API call
 */
import { loadPersonality, buildPersonalityPrompt, type Personality } from './personality.js';
import { loadSkin, type Skin } from './skin.js';
import { createToolRegistry, toolSpecs, type ToolRegistry, type ToolResult } from '../../../src/core/tools.js';
import { createFullToolRegistry, type AgentToolConfig } from '../../../src/core/agent-tools/index.js';
import { bridgeToolSpecs, createBridgeToolHandlers } from '../../../src/tools/bridge-tools.js';
import { ContextCompressor, type CompressResult } from '../../../src/core/context-compressor.js';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  tool_call_id?: string;
  name?: string;
}

export interface ChatResponse {
  content: string;
  thinkingVerb?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; result: ToolResult }>;
  cacheHit?: CacheHitInfo;
}

export interface CacheHitInfo {
  cachedTokens: number;
  totalPromptTokens: number;
  hitPercent: string;
}

export type StreamCallback = (chunk: string) => void;

const MAX_TOOL_ITERATIONS = 20;
const MAX_TOKENS = 4096;
const CONTEXT_WINDOW = 128_000; // MiMo v2.5 context window

/**
 * Full agent chat session with cache-first tool-calling loop.
 */
export class AgentChatSession {
  private messages: ChatMessage[] = [];
  private personality: Personality;
  private skin: Skin;
  private apiKey: string | undefined;
  private baseUrl: string;
  private model: string;
  private toolRegistry: ToolRegistry;
  private toolSchemas: Array<Record<string, unknown>>;
  private compressor: ContextCompressor;
  private workspaceRoot: string;

  // Cache tracking
  private totalCacheHits = 0;
  private totalPromptTokens = 0;

  constructor(opts?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    workspaceRoot?: string;
    agentServerUrl?: string;
  }) {
    this.personality = loadPersonality();
    this.skin = loadSkin();
    this.apiKey = opts?.apiKey ?? process.env.MIMO_API_KEY;
    this.baseUrl = opts?.baseUrl ?? 'https://api.xiaomimimo.com/v1';
    this.model = opts?.model ?? 'mimo-v2.5';
    this.workspaceRoot = opts?.workspaceRoot ?? process.cwd();

    // Build full tool registry
    const agentServerUrl = opts?.agentServerUrl ?? `http://localhost:${process.env.PORT || '18830'}`;

    const agentToolConfig: AgentToolConfig = {
      workspaceRoot: this.workspaceRoot,
      agentServerUrl,
      apiKey: this.apiKey,
    };

    const extraTools = createFullToolRegistry(agentToolConfig);

    // Add bridge tools
    const bridgeHandlers = createBridgeToolHandlers();
    for (const spec of bridgeToolSpecs) {
      const handler = bridgeHandlers.get(spec.name);
      if (handler) {
        extraTools.push({ spec, handler });
      }
    }

    this.toolRegistry = createToolRegistry(extraTools);
    this.toolSchemas = toolSpecs(this.toolRegistry).map((spec) => ({
      type: 'function',
      function: {
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
      },
    }));

    // Initialize context compressor
    this.compressor = new ContextCompressor({
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      model: this.model,
      protectFirstN: 2, // system + first user message
      protectLastN: 3,  // last 3 messages
      thresholdPercent: 0.80,
      maxRuntimeMs: 30_000,
    });

    // FROZEN SYSTEM PROMPT — never changes mid-session
    // This is the cache-stable prefix that stays identical across all API calls
    const frozenSystemPrompt = this.buildFrozenSystemPrompt();
    this.messages.push({
      role: 'system',
      content: frozenSystemPrompt,
      timestamp: Date.now(),
    });
  }

  getPersonality(): Personality {
    return this.personality;
  }

  getSkin(): Skin {
    return this.skin;
  }

  getHistory(): ChatMessage[] {
    return [...this.messages];
  }

  getToolNames(): string[] {
    return [...this.toolRegistry.keys()];
  }

  getCacheStats(): { totalHits: number; totalPromptTokens: number; hitRate: string } {
    const hitRate = this.totalPromptTokens > 0
      ? ((this.totalCacheHits / this.totalPromptTokens) * 100).toFixed(1)
      : '0.0';
    return {
      totalHits: this.totalCacheHits,
      totalPromptTokens: this.totalPromptTokens,
      hitRate: `${hitRate}%`,
    };
  }

  /**
   * Send a user message and get the agent's response.
   * Executes the full cache-first tool-calling loop.
   */
  async send(userMessage: string, onStream?: StreamCallback): Promise<ChatResponse> {
    // Dynamic context prefix — rides in user message, NOT system prompt
    // This keeps the system prompt frozen for cache hits
    const dynamicPrefix = this.buildDynamicPrefix();
    const fullUserMessage = dynamicPrefix
      ? `${dynamicPrefix}\n\n${userMessage}`
      : userMessage;

    // Add user message to append-only log
    this.messages.push({
      role: 'user',
      content: fullUserMessage,
      timestamp: Date.now(),
    });

    const verbs = this.skin.spinner.thinking_verbs;
    const thinkingVerb = verbs[Math.floor(Math.random() * verbs.length)] ?? 'thinking';
    const allToolCalls: ChatResponse['toolCalls'] = [];
    let lastCacheHit: CacheHitInfo | undefined;

    // Tool-calling loop
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      // Check if we need compression before sending
      await this.maybeCompress();

      const wireMessages = this.buildWireMessages();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.apiKey) {
        headers['api-key'] = this.apiKey;
      }

      const body: Record<string, unknown> = {
        model: this.model,
        messages: wireMessages,
        max_completion_tokens: MAX_TOKENS,
        temperature: 0.7,
        tools: this.toolSchemas,
        tool_choice: 'auto',
      };

      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120_000),
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'unknown error');
          throw new Error(`MiMo API error ${response.status}: ${errorText.slice(0, 300)}`);
        }

        const data = await response.json() as {
          choices?: Array<{
            message?: {
              content?: string;
              tool_calls?: Array<{
                id: string;
                type: 'function';
                function: { name: string; arguments: string };
              }>;
            };
          }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_tokens_details?: {
              cached_tokens?: number;
            };
          };
        };

        // Track cache hits (Reasonix pattern)
        const cachedTokens = data.usage?.prompt_tokens_details?.cached_tokens ?? 0;
        const promptTokens = data.usage?.prompt_tokens ?? 0;
        if (cachedTokens > 0) {
          const pct = promptTokens > 0 ? (cachedTokens / promptTokens * 100).toFixed(1) : '?';
          console.log(`[cache] Hit: ${cachedTokens} tokens (${pct}% of prompt)`);
          this.totalCacheHits += cachedTokens;
        }
        this.totalPromptTokens += promptTokens;
        lastCacheHit = {
          cachedTokens,
          totalPromptTokens: promptTokens,
          hitPercent: promptTokens > 0 ? (cachedTokens / promptTokens * 100).toFixed(1) : '0',
        };

        const choice = data.choices?.[0];
        if (!choice?.message) {
          throw new Error('No response from MiMo');
        }

        const assistantMessage = choice.message;

        // If there are tool calls, execute them
        if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
          // Append assistant message to log
          this.messages.push({
            role: 'assistant',
            content: assistantMessage.content ?? '',
            timestamp: Date.now(),
          });

          // Execute each tool call
          for (const toolCall of assistantMessage.tool_calls) {
            const toolName = toolCall.function.name;
            let toolArgs: Record<string, unknown> = {};
            try {
              toolArgs = JSON.parse(toolCall.function.arguments);
            } catch {
              // If JSON parse fails, try as-is
            }

            // Execute the tool
            const toolDef = this.toolRegistry.get(toolName);
            let result: ToolResult;
            if (toolDef) {
              try {
                result = await toolDef.handler(toolArgs, {
                  workspaceRoot: this.workspaceRoot,
                  labStoreRoot: process.env.LAB_STORE_ROOT ?? '/pehverse/repos/lab-store',
                  store: {} as any,
                });
              } catch (err) {
                result = {
                  ok: false,
                  output: '',
                  error: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`,
                };
              }
            } else {
              result = {
                ok: false,
                output: '',
                error: `Unknown tool: ${toolName}`,
              };
            }

            // Append tool result to log
            this.messages.push({
              role: 'tool',
              content: result.ok ? result.output : `Error: ${result.error ?? result.output}`,
              timestamp: Date.now(),
              tool_call_id: toolCall.id,
              name: toolName,
            });

            allToolCalls?.push({
              name: toolName,
              args: toolArgs,
              result,
            });

            // Stream tool execution status
            if (onStream) {
              onStream(`\n🔧 ${toolName}: ${result.ok ? '✅' : '❌'} ${result.output?.slice(0, 100) ?? result.error?.slice(0, 100) ?? ''}\n`);
            }
          }

          // Continue the loop
          continue;
        }

        // No tool calls — this is the final response
        const content = assistantMessage.content ?? '';
        this.messages.push({
          role: 'assistant',
          content,
          timestamp: Date.now(),
        });

        if (onStream) {
          onStream(content);
        }

        return { content, thinkingVerb, toolCalls: allToolCalls, cacheHit: lastCacheHit };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Chat failed: ${message}`);
      }
    }

    // Max iterations
    const lastAssistant = [...this.messages].reverse().find((m) => m.role === 'assistant');
    return {
      content: lastAssistant?.content ?? '(max tool iterations reached)',
      thinkingVerb,
      toolCalls: allToolCalls,
      cacheHit: lastCacheHit,
    };
  }

  /**
   * Get a quick response without streaming.
   */
  async ask(question: string): Promise<string> {
    const response = await this.send(question);
    return response.content;
  }

  /**
   * Reset conversation — preserves frozen system prompt.
   */
  reset(): void {
    const frozenSystemPrompt = this.buildFrozenSystemPrompt();
    this.messages = [{
      role: 'system',
      content: frozenSystemPrompt,
      timestamp: Date.now(),
    }];
    this.compressor.reset();
  }

  /**
   * Build frozen system prompt — NEVER changes mid-session.
   * This is the cache-stable prefix.
   */
  private buildFrozenSystemPrompt(): string {
    const personalityPrompt = buildPersonalityPrompt(this.personality);
    const toolList = this.getToolNames().join(', ');

    return [
      personalityPrompt,
      '',
      `Available tools: ${toolList}`,
      '',
      'Rules:',
      '- For simple questions, answer directly WITHOUT using tools',
      '- For file operations, use the appropriate tool (read_file, write_file, search_files, patch)',
      '- For web research, use web_search then web_extract',
      '- For browser interaction, use browser_* tools',
      '- When done, provide a clear summary of what you did',
      '- Keep changes minimal and focused',
    ].join('\n');
  }

  /**
   * Build dynamic context prefix — changes per-turn but rides in user message,
   * NOT in system prompt. This keeps the system prompt frozen.
   */
  private buildDynamicPrefix(): string {
    const lines: string[] = [];
    lines.push(`[Task context] Working directory: ${this.workspaceRoot}`);
    lines.push(`Agent: ${this.personality.name}`);
    return lines.join('\n');
  }

  /**
   * Maybe compress context if approaching limits.
   * Uses Reasonix-style rare compaction at 80% of context window.
   */
  private async maybeCompress(): Promise<void> {
    const shouldCompress = this.compressor.shouldCompress(this.messages, CONTEXT_WINDOW);
    if (!shouldCompress) return;

    console.log(`[compressor] Context approaching limit, compressing...`);

    const result: CompressResult = await this.compressor.compress(this.messages, {
      contextWindow: CONTEXT_WINDOW,
    });

    if (result.compressed) {
      this.messages = result.messages as ChatMessage[];
      console.log(`[compressor] Compressed: ${result.originalCount} → ${result.compressedCount} messages (${result.strategyUsed})`);
    }
  }

  /**
   * Build wire messages for the API.
   * Messages are append-only — never reordered, never mutated.
   */
  private buildWireMessages(): Array<{ role: string; content: string; tool_call_id?: string; name?: string }> {
    return this.messages.map((m) => {
      const wire: any = { role: m.role, content: m.content };
      if (m.tool_call_id) wire.tool_call_id = m.tool_call_id;
      if (m.name) wire.name = m.name;
      return wire;
    });
  }
}

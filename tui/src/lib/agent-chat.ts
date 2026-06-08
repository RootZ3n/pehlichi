/**
 * AGENT CHAT SESSION — tool-calling loop with full tool registry.
 *
 * This replaces the simple ChatSession with a proper agent loop that:
 * 1. Sends messages to MiMo with tool schemas
 * 2. When MiMo returns tool_calls, executes them
 * 3. Sends tool results back to MiMo
 * 4. Repeats until MiMo returns a text response (no more tool calls)
 *
 * This is how Hermes works — and now every lab agent works the same way.
 */
import { loadPersonality, buildPersonalityPrompt, type Personality } from './personality.js';
import { loadSkin, type Skin } from './skin.js';
import { createToolRegistry, toolSpecs, type ToolRegistry, type ToolResult } from '../../../src/core/tools.js';
import { createFullToolRegistry, type AgentToolConfig } from '../../../src/core/agent-tools/index.js';
import { bridgeToolSpecs, createBridgeToolHandlers } from '../../../src/tools/bridge-tools.js';

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
}

export type StreamCallback = (chunk: string) => void;

const MAX_TOOL_ITERATIONS = 20;
const MAX_TOKENS = 4096;

/**
 * Full agent chat session with tool-calling loop.
 */
export class AgentChatSession {
  private messages: ChatMessage[] = [];
  private personality: Personality;
  private skin: Skin;
  private systemPrompt: string;
  private apiKey: string | undefined;
  private baseUrl: string;
  private model: string;
  private toolRegistry: ToolRegistry;
  private toolSchemas: Array<Record<string, unknown>>;

  constructor(opts?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    workspaceRoot?: string;
    agentServerUrl?: string;
  }) {
    this.personality = loadPersonality();
    this.skin = loadSkin();
    this.systemPrompt = buildPersonalityPrompt(this.personality);
    this.apiKey = opts?.apiKey ?? process.env.MIMO_API_KEY;
    this.baseUrl = opts?.baseUrl ?? 'https://api.xiaomimimo.com/v1';
    this.model = opts?.model ?? 'mimo-v2.5';

    // Build full tool registry
    const workspaceRoot = opts?.workspaceRoot ?? process.cwd();
    const agentServerUrl = opts?.agentServerUrl ?? `http://localhost:${process.env.PORT || '18830'}`;

    const agentToolConfig: AgentToolConfig = {
      workspaceRoot,
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

    // Add system message
    this.messages.push({
      role: 'system',
      content: this.systemPrompt,
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

  /**
   * Send a user message and get the agent's response.
   * Executes the full tool-calling loop.
   */
  async send(userMessage: string, onStream?: StreamCallback): Promise<ChatResponse> {
    // Add user message to history
    this.messages.push({
      role: 'user',
      content: userMessage,
      timestamp: Date.now(),
    });

    const verbs = this.skin.spinner.thinking_verbs;
    const thinkingVerb = verbs[Math.floor(Math.random() * verbs.length)] ?? 'thinking';
    const allToolCalls: ChatResponse['toolCalls'] = [];

    // Tool-calling loop
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
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
      };

      // Only include tools if this is not a streaming request (some APIs don't support both)
      if (!onStream) {
        body.tools = this.toolSchemas;
        body.tool_choice = 'auto';
      }

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
        };

        const choice = data.choices?.[0];
        if (!choice?.message) {
          throw new Error('No response from MiMo');
        }

        const assistantMessage = choice.message;

        // If there are tool calls, execute them
        if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
          // Add assistant message with tool calls
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
                  workspaceRoot: process.cwd(),
                  labStoreRoot: process.env.LAB_STORE_ROOT ?? '/pehverse/repos/lab-store',
                  store: {} as any, // Will be wired properly later
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

            // Add tool result to messages
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

          // Continue the loop to get the next response
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

        return { content, thinkingVerb, toolCalls: allToolCalls };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Chat failed: ${message}`);
      }
    }

    // If we hit max iterations, return what we have
    const lastAssistant = [...this.messages].reverse().find((m) => m.role === 'assistant');
    return {
      content: lastAssistant?.content ?? '(max tool iterations reached)',
      thinkingVerb,
      toolCalls: allToolCalls,
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
   * Reset conversation.
   */
  reset(): void {
    this.messages = [{
      role: 'system',
      content: this.systemPrompt,
      timestamp: Date.now(),
    }];
  }

  /**
   * Build wire messages for the API.
   */
  private buildWireMessages(): Array<{ role: string; content: string; tool_call_id?: string; name?: string; tool_calls?: any[] }> {
    return this.messages.map((m) => {
      const wire: any = { role: m.role, content: m.content };
      if (m.tool_call_id) wire.tool_call_id = m.tool_call_id;
      if (m.name) wire.name = m.name;
      return wire;
    });
  }
}

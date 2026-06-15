// Chat Session — bridges the TUI to the agent runtime
// Maintains conversation history, loads personality, calls MiMo
import { loadPersonality, buildPersonalityPrompt, type Personality } from './personality.js';
import { loadSkin, type Skin } from './skin.js';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface ChatResponse {
  content: string;
  thinkingVerb?: string;
}

export type StreamCallback = (chunk: string) => void;

/**
 * A conversational chat session.
 * Unlike the task-oriented runAgent loop, this maintains ongoing conversation.
 */
export class ChatSession {
  private messages: ChatMessage[] = [];
  private personality: Personality;
  private skin: Skin;
  private systemPrompt: string;
  private apiKey: string | undefined;
  private baseUrl: string;
  private model: string;

  constructor(opts?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    /**
     * SELF-AWARENESS: a capability summary (tool names + what Peh can do + where his
     * memory lives) appended to the system prompt AFTER the personality sections. The
     * converse lane runs with NO tools, so without this Peh has no way to know what he
     * can actually do in the full /chat lane — he'd claim "my mind" or "I don't know".
     */
    capabilities?: string;
  }) {
    this.personality = loadPersonality();
    this.skin = loadSkin();
    this.systemPrompt = buildPersonalityPrompt(this.personality);
    if (opts?.capabilities) {
      this.systemPrompt += `\n\n---\n\n${opts.capabilities}`;
    }
    this.apiKey = opts?.apiKey ?? process.env.MIMO_API_KEY;
    this.baseUrl = opts?.baseUrl ?? 'https://api.xiaomimimo.com/v1';
    this.model = opts?.model ?? 'mimo-v2.5';

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

  /**
   * Send a user message and get the agent's response.
   * Calls MiMo directly via the OpenAI-compatible chat completions API.
   */
  async send(userMessage: string, onStream?: StreamCallback): Promise<ChatResponse> {
    // Add user message to history
    this.messages.push({
      role: 'user',
      content: userMessage,
      timestamp: Date.now(),
    });

    // Pick a thinking verb
    const verbs = this.skin.spinner.thinking_verbs;
    const thinkingVerb = verbs[Math.floor(Math.random() * verbs.length)] ?? 'thinking';

    // Build the API request
    const wireMessages = this.messages.map(m => ({
      role: m.role,
      content: m.content,
    }));

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      // MiMo uses 'api-key' header; standard OpenAI-compatible APIs use Bearer auth
      if (this.baseUrl.includes('xiaomimimo')) {
        headers['api-key'] = this.apiKey;
      } else {
        headers['Authorization'] = 'Bearer ' + this.apiKey;
      }
    }

    const body = {
      model: this.model,
      messages: wireMessages,
      max_completion_tokens: 4096,
      temperature: 0.7,
      stream: !!onStream,
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

      let content = '';

      if (onStream && response.body) {
        // Streaming response
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') break;

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                content += delta;
                onStream(delta);
              }
            } catch {
              // Skip malformed chunks
            }
          }
        }
      } else {
        // Non-streaming response
        const data = await response.json() as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        content = data.choices?.[0]?.message?.content ?? '';
      }

      // Add assistant message to history
      this.messages.push({
        role: 'assistant',
        content,
        timestamp: Date.now(),
      });

      return { content, thinkingVerb };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Chat failed: ${message}`);
    }
  }

  /**
   * Get a quick response without streaming.
   */
  async ask(question: string): Promise<string> {
    const response = await this.send(question);
    return response.content;
  }
}

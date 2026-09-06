// Chat Session — bridges the TUI to the agent runtime
// Maintains conversation history, loads personality, calls MiMo
import { loadPersonality, buildPersonalityPrompt, type Personality } from './personality.js';
import { loadSkin, type Skin } from './skin.js';
import { TruthSessionGate } from './truth-gate.js';
import { admitRunWork } from '../../src/core/operational-admission.js';
import { agentProfile } from '../../src/profiles/agent.js';
import { admitOrdinaryWork } from '../../src/core/ordinary-admission.js';
import { OperationalWorkRefused } from '../../src/core/loop.js';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface ChatResponse {
  content: string;
  thinkingVerb?: string;
  /** Real token usage from the provider (non-streaming responses expose it), for cost display. */
  usage?: { in: number; out: number };
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
  /**
   * The mandatory authority boundary for this session.
   *
   * Constructed here, before any message is sent, because the trusted base it captures
   * has to predate the model's first opportunity to change anything.
   */
  private truth: TruthSessionGate;

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
    personality?: Personality;
    skin?: Skin;
    /** Agent identity. The one thing that legitimately differs between the three. */
    agent?: string;
    sessionId?: string;
  }) {
    this.personality = opts?.personality ?? loadPersonality();
    this.skin = opts?.skin ?? loadSkin();
    this.systemPrompt = buildPersonalityPrompt(this.personality);
    if (opts?.capabilities) {
      this.systemPrompt += `\n\n---\n\n${opts.capabilities}`;
    }
    this.apiKey = opts?.apiKey ?? process.env.AGENT_API_KEY ?? process.env.MIMO_API_KEY;
    this.baseUrl = opts?.baseUrl ?? 'https://api.xiaomimimo.com/v1';
    this.model = opts?.model ?? 'mimo-v2.5';

    const agent = opts?.agent ?? this.personality.name?.toLowerCase() ?? 'trio-agent';
    const sessionId = opts?.sessionId ?? `chat-${Date.now().toString(36)}`;
    this.truth = new TruthSessionGate({ agent, sessionId, taskId: sessionId });

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
    // OPERATIONAL ADMISSION. The converse lane answers without tools, but it still calls a
    // model on a user's behalf, which is operational work: "it only talks" is not a category
    // of admission any more than "it only reads" is. This lane reaches a model without going
    // through `runAgent`, so it carries its own call to the same boundary rather than
    // inheriting one it never passes through.
    // The SAME external ordinary authorization the agent lane consults, differing only in the lane
    // it declares. Giving the two lanes different effective authority is how one of them quietly
    // becomes the soft way in; the record decides which lanes it covers.
    const admission = admitOrdinaryWork(admitRunWork('ordinary-work'), {
      // The agent's own validated profile, not the personality YAML: the authorization binds an
      // identity, and a display name from a data file is not one.
      agentName: agentProfile.name,
      agentRole: agentProfile.role,
      lane: 'converse',
    });
    if (!admission.admitted) throw new OperationalWorkRefused(admission.refusal);

    // The caller's callback receives transport liveness and never a model delta. Deltas
    // are still consumed below so the request shape and the accumulated content are
    // unchanged; what stops is delivery.
    const contained = this.truth.containStream(onStream);
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
      let usage: { in: number; out: number } | undefined;

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
                contained?.(delta);
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
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        content = data.choices?.[0]?.message?.content ?? '';
        if (data.usage) usage = { in: data.usage.prompt_tokens ?? 0, out: data.usage.completion_tokens ?? 0 };
      }

      // Add assistant message to history
      // Cross the authority boundary before anything is stored or returned. Writing the
      // raw content to history first would leave unverified prose in the transcript, where
      // a later turn or a resume would read it back as ordinary assistant content.
      const decision = this.truth.finalize({
        userMessage,
        candidateNarrative: content,
        channel: 'tui',
      });
      const authorized = decision.deliverable();

      this.messages.push({
        role: 'assistant',
        content: authorized,
        timestamp: Date.now(),
      });

      return { content: authorized, thinkingVerb, ...(usage ? { usage } : {}) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Even a transport failure goes through the boundary: an error path is exactly where
      // a half-formed model answer would otherwise be handed back unchecked.
      const decision = this.truth.finalize({
        userMessage,
        candidateNarrative: `Chat failed: ${message}`,
        channel: 'tui',
        partial: true,
      });
      throw new Error(decision.deliverable());
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

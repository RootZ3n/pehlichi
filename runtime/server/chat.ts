// Chat Session — bridges the TUI to the agent runtime
// Maintains conversation history, loads personality, calls MiMo
import { loadPersonality, buildPersonalityPrompt, type Personality } from './personality.js';
import { loadSkin, type Skin } from './skin.js';
import { TruthSessionGate } from './truth-gate.js';
import { admitRunWork } from '../../src/core/operational-admission.js';
import { agentProfile } from '../../src/profiles/agent.js';
import { authorizeLaneRequest } from '../../src/core/lane-authorization.js';
import { OperationalWorkRefused } from '../../src/core/loop.js';
import { providerProfile } from '../../src/core/provider-profile.js';
import { performCompletion, TransportError } from '../../src/core/drivers/transport.js';
import type { AttemptRecord } from '../../src/core/transport-policy.js';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  /**
   * The provider's own reasoning for an assistant turn, when it emitted one.
   *
   * A thinking model may REQUIRE it back: DeepSeek refuses any continuation of an assistant turn
   * whose reasoning was dropped, with "The `reasoning_content` in the thinking mode must be passed
   * back to the API". It is kept on the turn so the next request can return it.
   */
  reasoningContent?: string;
}

export interface ChatResponse {
  content: string;
  thinkingVerb?: string;
  /** Real token usage from the provider (non-streaming responses expose it), for cost display. */
  usage?: { in: number; out: number };
  /**
   * The VERIFIED principal this turn was authorised as, and the request it was authorised under.
   *
   * From the authorization decision, never from the presented header: recording what a client
   * claimed would make the audit trail a record of claims.
   */
  principalId?: string;
  requestId?: string;
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
  /**
   * The authenticated principal this session's client presented, if any.
   *
   * Held per session rather than per message only because the transport delivers it once; it is
   * re-verified on every turn, so a revoked or expired principal stops working mid-session rather
   * than surviving until the session ends.
   */
  private requestPrincipal: string | undefined;
  /** Which provider this lane talks to, for evidence. Never the key. */
  private readonly provider: string;
  private readonly authStyle: 'bearer' | 'api-key';
  private readonly requestExtras: Readonly<Record<string, unknown>>;
  private readonly streamingProfile: boolean;
  /** This session's id, so every attempt in it shares one run identity. */
  private readonly sessionRunId: string;
  /** Transport attempts recorded for the most recent turn. */
  private lastAttempts: readonly AttemptRecord[] = [];
  /** What the transport observed on the last turn, for the caller's evidence. */
  transportEvidence(): readonly AttemptRecord[] { return this.lastAttempts; }

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
    /** The signed request principal presented by this session's client. */
    requestPrincipal?: string;
  }) {
    this.requestPrincipal = opts?.requestPrincipal;
    this.personality = opts?.personality ?? loadPersonality();
    this.skin = opts?.skin ?? loadSkin();
    this.systemPrompt = buildPersonalityPrompt(this.personality);
    if (opts?.capabilities) {
      this.systemPrompt += `\n\n---\n\n${opts.capabilities}`;
    }
    /*
      ONE PROVIDER DECISION, shared with the agent lane.

      This lane used to hold its own endpoint, its own model and its own key read from the process
      environment — so a deployment could have a provider wired for `runAgent` and none here, which
      is exactly what happened: the agent lane was given a profile and every converse turn still
      failed at MiMo with 401. Two places deciding one thing is how they come to disagree.

      The profile is the same root-owned record the driver reads. Explicit options still win, for
      tests and embedders; what is gone is a second compiled-in default and a second key path.
    */
    const profile = providerProfile();
    this.apiKey = opts?.apiKey ?? profile?.apiKey ?? process.env.AGENT_API_KEY ?? process.env.MIMO_API_KEY;
    this.baseUrl = (opts?.baseUrl ?? profile?.baseUrl ?? 'https://api.xiaomimimo.com/v1').replace(/\/+$/, '');
    this.model = opts?.model ?? profile?.model ?? 'mimo-v2.5';
    this.provider = profile?.provider ?? (this.baseUrl.includes('xiaomimimo') ? 'xiaomi' : 'unknown');
    this.authStyle = profile?.authStyle ?? (this.baseUrl.includes('xiaomimimo') ? 'api-key' : 'bearer');
    this.requestExtras = profile?.requestExtras ?? {};
    this.streamingProfile = profile?.streaming ?? false;

    const agent = opts?.agent ?? this.personality.name?.toLowerCase() ?? 'trio-agent';
    const sessionId = opts?.sessionId ?? `chat-${Date.now().toString(36)}`;
    this.sessionRunId = sessionId;
    this.truth = new TruthSessionGate({ agent, sessionId, taskId: sessionId });

    // Add system message
    this.messages.push({
      role: 'system',
      content: this.systemPrompt,
      timestamp: Date.now(),
    });
  }

  /** Refresh the principal for the next turn. Adapters call this per request. */
  setRequestPrincipal(assertion: string | undefined): void {
    this.requestPrincipal = assertion;
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
    // The SAME authorization function the agent lane calls. Lane-specific PARSING is fine -- this
    // one arrives as an HTTP header rather than an in-process option -- but the enforcement
    // decision is made in exactly one place, so the two lanes cannot drift apart.
    const laneRequest = {
      // The agent's own validated profile, not the personality YAML: the authorization binds an
      // identity, and a display name from a data file is not one.
      agentName: agentProfile.name,
      agentRole: agentProfile.role,
      lane: 'converse' as const,
      requestedCapabilities: [] as readonly string[],
      principalAssertion: this.requestPrincipal,
    };
    const lane = authorizeLaneRequest(admitRunWork('ordinary-work'), laneRequest);
    if (!lane.authorized) throw new OperationalWorkRefused(lane.refusal);
    const authorised = { principalId: lane.authorization.principal.id, requestId: lane.authorization.requestId };

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
    /*
      Each assistant turn carries the reasoning that produced it back to the provider. The turn the
      user sees is the FIREWALL-AUTHORIZED text, not the model's raw answer, so the reasoning cannot
      be recovered from the content — it has to be kept alongside it. GLM and MiMo accept the field
      and ignore it, so this is not gated on a provider name.
    */
    const wireMessages = this.messages.map(m => ({
      role: m.role,
      content: m.content,
      ...(m.reasoningContent !== undefined && m.reasoningContent.length > 0
        ? { reasoning_content: m.reasoningContent } : {}),
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

    /*
      THE SAME TRANSPORT THE AGENT LANE USES.

      This lane had its own `fetch`, its own single 120-second abort, its own SSE reader and no
      retry at all. Two transports for one runtime means two answers to every timeout question and
      two places for a late response to land, and the one here was the weaker: a stream that went
      quiet was indistinguishable from one still arriving.

      Streaming is requested when the profile says the provider supports it OR when this turn has a
      stream callback to feed. The distinction matters: a caller asking for deltas is not evidence
      that the provider will send any, and what the transport reports is what it observed.
    */
    const wantsStream = this.streamingProfile || !!onStream;
    const body = {
      ...this.requestExtras,
      model: this.model,
      messages: wireMessages,
      max_completion_tokens: 4096,
      temperature: 0.7,
    };

    try {
      const result = await performCompletion({
        runId: `converse-${this.sessionRunId}`,
        requestId: `req-${Date.now().toString(36)}`,
        url: `${this.baseUrl}/chat/completions`,
        headers,
        payload: body,
        provider: this.provider,
        endpoint: this.baseUrl,
        configuredModel: this.model,
        driver: 'ChatSession',
        streamingRequested: wantsStream,
        /*
          The network call this module is responsible for, made here rather than handed over as a
          bare reference. The transport performs no request of its own — a caller supplies one —
          so this is the line that actually reaches the provider, and the effect inventory should
          be able to see it.
        */
        fetchImpl: ((url: string, init: never) => fetch(url, init)) as never,
        // A conversational turn runs no tools, so nothing it does is an effect a retry could
        // duplicate. That is a property of THIS lane and is stated rather than assumed.
        effectsObserved: false,
        onAttempt: (record) => { this.lastAttempts = [...this.lastAttempts, record]; },
      });

      const parsed = result.json as {
        choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      let content = parsed.choices?.[0]?.message?.content ?? '';
      const reasoningContent = parsed.choices?.[0]?.message?.reasoning_content;
      let usage: { in: number; out: number } | undefined;
      if (parsed.usage) usage = { in: parsed.usage.prompt_tokens ?? 0, out: parsed.usage.completion_tokens ?? 0 };
      // Deltas are delivered to the caller only when bytes genuinely arrived over time. Emitting
      // the whole answer as one "chunk" would be this process pretending the provider streamed.
      if (onStream && result.streamingObserved && content.length > 0) contained?.(content);

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

      /*
        HISTORY GETS THE INERT NARRATIVE, NOT THE DELIVERABLE.

        The deliverable is what the USER sees, and it contains the verifier's own report. Storing it
        as the assistant turn fed that report back to the model as its own prior words; the model
        repeated it, and the gate then rejected "consequential assertion(s) in prose outside the
        verifiable contract" — an ordinary supported answer refused because of how the previous
        answer had been rendered. That is the unstable false-refusal Phase 3B measured at 17-67%.
      */
      this.messages.push({
        role: 'assistant',
        content: decision.transcript(),
        timestamp: Date.now(),
        ...(reasoningContent !== undefined && reasoningContent.length > 0 ? { reasoningContent } : {}),
      });

      return { content: authorized, thinkingVerb, ...authorised, ...(usage ? { usage } : {}) };
    } catch (err) {
      const message = err instanceof TransportError
        ? `${this.provider} ${err.failure}: ${err.detail ?? err.message}`
        : err instanceof Error ? err.message : String(err);
      if (err instanceof TransportError) this.lastAttempts = err.attempts;
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

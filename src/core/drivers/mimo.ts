/**
 * THE MIMO DRIVER — the first real model behind the Driver interface.
 *
 * Implements Driver { next(ctx): Promise<DriverAction> } and drops into the
 * existing core loop unchanged. Talks DIRECT to MiMo's OpenAI-shaped
 * chat-completions endpoint:
 *   - base url https://api.xiaomimimo.com/v1, model mimo-v2.5
 *   - api-key HEADER auth (NOT Bearer); keyless when no key is configured
 *   - extraBody { thinking: { type: "disabled" } }
 *   - token limit under "max_completion_tokens" (default 12288)
 *
 * RELIABILITY (reasonix infrastructure): optional circuit-breaker protection
 * and retry with jittered backoff. When enabled, transient failures are
 * retried automatically and the circuit opens after repeated failures to
 * fast-fail and protect the provider.
 *
 * No OpenRouter, no token-plan host, no local model, no retries (fail loud).
 * The deterministic loop tests never touch this — the real-model proof is the
 * separate sanity:mimo entrypoint.
 */
import type { DriverAction, DriverContext, Message, ToolSpec, TokenUsage, UsageReportingDriver } from "../driver.js";
import type { Phase } from "../events.js";
import { CircuitBreaker, getCircuit } from "../agent-tools/circuit-breaker.js";
import { withRetry, type RetryConfig } from "../agent-tools/retry.js";
import { classifyError } from "../agent-tools/error-classifier.js";

const DEFAULT_BASE_URL = "https://api.xiaomimimo.com/v1";
const DEFAULT_MODEL = "mimo-v2.5";
const DEFAULT_MAX_COMPLETION_TOKENS = 12_288;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const MAX_ERROR_DETAIL = 300;

/** Minimal fetch signature (matches global fetch); injectable so tests stay offline. */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

/** A clear, loud error for every MiMo failure mode. */
export class MimoError extends Error {
  override readonly name = "MimoError";
  constructor(message: string) {
    super(message);
  }
}

export interface MimoDriverOptions {
  /** API key. Defaults to process.env.MIMO_API_KEY. Keyless when absent/empty. */
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly maxCompletionTokens?: number;
  readonly temperature?: number;
  readonly requestTimeoutMs?: number;
  /** Injectable fetch (default: global fetch). */
  readonly fetchImpl?: FetchLike;
  /**
   * RELIABILITY (reasonix infrastructure): enable circuit-breaker protection
   * for the provider. When set, repeated failures fast-fail to protect the
   * endpoint. Pass `true` for defaults, or a partial config to customize.
   * Default: disabled (backward compatible).
   */
  readonly circuitBreaker?: boolean | Partial<{ failureThreshold: number; cooldownMs: number; successThreshold: number }>;
  /**
   * RELIABILITY (reasonix infrastructure): enable retry with jittered backoff
   * for transient failures (timeout, 5xx, rate-limit). Pass `true` for defaults
   * or a partial RetryConfig to customize. Default: disabled (backward compatible).
   */
  readonly retry?: boolean | Partial<RetryConfig>;
}

/**
 * The response-protocol the driver asks the model to follow, on top of the
 * behavioral system prompt built in the loop. It makes narrate / root-cause / done
 * machine-parseable WITHOUT loosening the done-gate: a model that finishes
 * without real verification still produces an empty summary and is rejected.
 */
export const MIMO_RESPONSE_PROTOCOL = `RESPONSE PROTOCOL (machine-parsed — follow exactly).
Each turn, reply with EXACTLY ONE of:
1. A tool call (function call) — use this to actually read/search/write/run things.
   A tool call MUST go through the function/tool-call API. Writing a call as text
   in your message (e.g. read({...})) does NOT run it — it will be rejected.
2. Your diagnosis, as a single JSON object and nothing else:
   {"kind":"root-cause","text":"<the root cause in plain language>"}
3. When finished, a single JSON object and nothing else:
   {"kind":"done","summary":{"rootCause":"<one line>","changes":["<change>"],"verification":["<check you ran>"]}}
   A done whose rootCause is empty, or whose changes[] or verification[] is empty, will be REJECTED.
   You must actually act and verify (run the terminal) before finishing.
   Set noChangeRequired: true when the task requires no file changes (e.g., answering questions, running read-only commands, inspecting code). Then changes[] may be empty, but rootCause and verification[] are still required.
   IMPORTANT: if you did NOT modify any files — you only answered, read, searched, or ran read-only commands like pwd/ls/cat — you MUST include "noChangeRequired":true. For direct questions (e.g. "What year did X happen?"), rootCause MUST contain the actual answer, not a description of answering. Example for a question: {"kind":"done","summary":{"rootCause":"The Colosseum opened in 80 CE.","changes":[],"verification":[],"noChangeRequired":true}}. Example for a command: {"kind":"done","summary":{"rootCause":"ran pwd for the user","changes":[],"verification":["ran pwd, got /path"],"noChangeRequired":true}}.
4. Otherwise narrate your next step, as a single JSON object and nothing else:
   {"kind":"narrate","phase":"investigate"|"act"|"verify"|"other","text":"<one short line>"}
For kinds 2-4 emit ONLY the JSON object, no surrounding prose.`;

export class MimoDriver implements UsageReportingDriver {
  readonly baseUrl: string;
  readonly model: string;
  readonly keyed: boolean;
  private readonly apiKey: string | undefined;
  private readonly maxCompletionTokens: number;
  private readonly temperature: number | undefined;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: FetchLike;
  /** Circuit breaker for provider health protection (reasonix infrastructure). */
  private readonly breaker: CircuitBreaker | undefined;
  /** Retry policy for transient failures (reasonix infrastructure). */
  private readonly retryConfig: Partial<RetryConfig> | undefined;
  /** H4: token usage accumulated since the last drain (real numbers from the API). */
  private pendingUsage: TokenUsage[] = [];

  /** H4: return and clear usage recorded since the last call (UsageReportingDriver). */
  drainUsage(): TokenUsage[] {
    const drained = this.pendingUsage;
    this.pendingUsage = [];
    return drained;
  }

  constructor(opts: MimoDriverOptions = {}) {
    const key = opts.apiKey ?? process.env["MIMO_API_KEY"];
    this.apiKey = key !== undefined && key.length > 0 ? key : undefined;
    this.keyed = this.apiKey !== undefined;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = opts.model ?? DEFAULT_MODEL;
    this.maxCompletionTokens = opts.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS;
    this.temperature = opts.temperature;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    // Circuit breaker: opt-in via options (reasonix infrastructure)
    if (opts.circuitBreaker) {
      const config = typeof opts.circuitBreaker === "object" ? opts.circuitBreaker : undefined;
      this.breaker = getCircuit(`mimo-${this.baseUrl}`, config ?? {});
    }
    // Retry: opt-in via options (reasonix infrastructure)
    if (opts.retry) {
      this.retryConfig = typeof opts.retry === "object" ? opts.retry : {};
    }
  }

  async next(ctx: DriverContext): Promise<DriverAction> {
    const body = {
      // extraBody-style provider param FIRST; engine-controlled fields follow.
      thinking: { type: "disabled" },
      model: this.model,
      messages: toWireMessages(ctx.messages),
      max_completion_tokens: this.maxCompletionTokens,
      ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
      ...(ctx.tools.length > 0 ? { tools: toProviderTools(ctx.tools) } : {}),
    };

    // Circuit-breaker: fast-fail when provider is unhealthy
    if (this.breaker && !this.breaker.allow()) {
      throw new MimoError("circuit breaker open: mimo provider is temporarily unavailable");
    }

    // Execute the API call, optionally with retry for transient failures
    const doFetch = async (): Promise<ParsedCompletion> => {
      const signal = AbortSignal.timeout(this.requestTimeoutMs);
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // MiMo uses api-key header; DeepSeek/others use Bearer auth.
          ...(this.apiKey !== undefined
            ? (this.baseUrl.includes("xiaomimimo")
              ? { "api-key": this.apiKey }
              : { "authorization": "Bearer " + this.apiKey })
            : {}),
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        const detail = sanitizeDetail(await res.text().catch(() => ""), MAX_ERROR_DETAIL);
        // Use error classifier to enrich the error with actionable metadata
        const classified = classifyError(null, res.status, detail);
        const err = new MimoError(`mimo HTTP ${res.status}: ${detail}`);
        // Attach classification metadata for upstream consumers
        (err as any).classified = classified;
        throw err;
      }

      let json: unknown;
      try {
        json = await res.json();
      } catch (cause) {
        throw new MimoError(`malformed JSON from mimo: ${messageOf(cause)}`);
      }

      return parseChatCompletion(json);
    };

    let parsed: ParsedCompletion;
    try {
      if (this.retryConfig) {
        parsed = await withRetry(doFetch, this.retryConfig);
      } else {
        parsed = await doFetch();
      }
      // Record success with circuit breaker
      this.breaker?.success();
    } catch (err) {
      // Record failure with circuit breaker
      this.breaker?.failure();
      if (err instanceof MimoError) throw err;
      const aborted = err instanceof Error && err.name === "TimeoutError";
      throw new MimoError(`${aborted ? "timeout" : "network error"} calling mimo: ${messageOf(err)}`);
    }

    // H4: record the REAL token usage the provider reported, so the session's
    // TokenMonitor reflects actual consumption instead of staying at zero.
    if (parsed.usage !== undefined) this.pendingUsage.push(parsed.usage);
    return completionToAction(parsed, ctx.tools.map((t) => t.name));
  }
}

/** Extract OpenAI-shaped usage ({ prompt_tokens, completion_tokens, ... }) if present. */
export function parseUsage(json: unknown): TokenUsage | undefined {
  if (!isRecord(json) || !isRecord(json.usage)) return undefined;
  const u = json.usage;
  const input = typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0;
  const output = typeof u.completion_tokens === "number" ? u.completion_tokens : 0;
  // Cached-prompt tokens, when the provider reports them (prompt_tokens_details).
  const details = isRecord(u.prompt_tokens_details) ? u.prompt_tokens_details : undefined;
  const cached = details && typeof details.cached_tokens === "number" ? details.cached_tokens : 0;
  if (input === 0 && output === 0 && cached === 0) return undefined;
  return { input, output, cached };
}

// ── pure helpers (offline-testable) ──────────────────────────────────────────

/** Map our ToolSpec[] into the provider's tool/function format. */
export function toProviderTools(tools: readonly ToolSpec[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters ?? { type: "object", properties: {}, additionalProperties: true },
    },
  }));
}

/**
 * Map our textual Message[] to wire messages. Our transcript is plain text
 * (we don't round-trip native tool_call ids), so a "tool" role is sent as a
 * user turn labelled as tool output — robust across strict endpoints. The
 * response protocol is injected as a system message right after the first one.
 */
export function toWireMessages(messages: readonly Message[]): Array<Record<string, string>> {
  const wire: Array<Record<string, string>> = [];
  let protocolInjected = false;
  for (const m of messages) {
    if (m.role === "tool") {
      wire.push({ role: "user", content: `TOOL RESULT:\n${m.content}` });
    } else {
      wire.push({ role: m.role, content: m.content });
    }
    if (!protocolInjected && m.role === "system") {
      wire.push({ role: "system", content: MIMO_RESPONSE_PROTOCOL });
      protocolInjected = true;
    }
  }
  if (!protocolInjected) wire.unshift({ role: "system", content: MIMO_RESPONSE_PROTOCOL });
  return wire;
}

export interface ParsedCompletion {
  readonly content: string;
  readonly toolCalls: Array<{ id: string; name: string; arguments: string }>;
  readonly finishReason: string;
  /** H4: real token usage from the provider response, when present. */
  readonly usage?: TokenUsage;
}

/** Validate the provider JSON and extract content / tool calls / finish reason. */
export function parseChatCompletion(json: unknown): ParsedCompletion {
  if (!isRecord(json)) throw new MimoError("mimo response is not an object");
  const choices = json.choices;
  if (!Array.isArray(choices) || choices.length === 0) throw new MimoError("mimo response has no choices");
  const choice = choices[0];
  if (!isRecord(choice)) throw new MimoError("mimo choices[0] is not an object");
  const message = choice.message;
  if (!isRecord(message)) throw new MimoError("mimo choices[0].message is missing");

  const rawContent = message.content;
  if (rawContent !== undefined && rawContent !== null && typeof rawContent !== "string") {
    throw new MimoError("mimo message.content is not a string");
  }

  const toolCalls = parseToolCalls(message.tool_calls);
  const usage = parseUsage(json);
  return {
    content: typeof rawContent === "string" ? rawContent : "",
    toolCalls,
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : "unknown",
    ...(usage !== undefined ? { usage } : {}),
  };
}

/**
 * Map a parsed completion to exactly ONE DriverAction (or throw a clean error).
 *
 * `knownTools` enables textual-tool-call detection: when the model writes a tool
 * call as PROSE instead of using the function-call API, we return a
 * `textual-call-detected` action (never a tool action — the loop feeds back a
 * correction). The detector is heuristic and FAILS TOWARD FEEDBACK: a false
 * positive costs one cheap nudge; a miss merely degrades to narration. It NEVER
 * parses-and-runs. Default [] (off) so direct callers/tests keep prior behavior.
 */
export function completionToAction(parsed: ParsedCompletion, knownTools: readonly string[] = []): DriverAction {
  // finish_reason=length is a TRUNCATED turn — never treat it as a silent done.
  if (parsed.finishReason === "length") {
    throw new MimoError(
      "mimo stopped at the token cap (finish_reason=length); the turn was truncated — " +
        "raise max_completion_tokens or shorten the task, do not treat this as done",
    );
  }

  // A tool/function call is the action.
  const tc = parsed.toolCalls[0];
  if (tc !== undefined) {
    let args: Record<string, unknown>;
    try {
      args = tc.arguments.trim() === "" ? {} : (JSON.parse(tc.arguments) as unknown as Record<string, unknown>);
    } catch (cause) {
      throw new MimoError(`mimo tool call '${tc.name}' has non-JSON arguments: ${messageOf(cause)}`);
    }
    if (!isRecord(args)) throw new MimoError(`mimo tool call '${tc.name}' arguments are not an object`);
    return { kind: "tool", tool: tc.name, args };
  }

  // Otherwise the content carries a control JSON object (or plain narration).
  const obj = extractJsonObject(parsed.content);
  if (obj !== null) {
    if (obj.kind === "done") {
      const s = isRecord(obj.summary) ? obj.summary : {};
      return {
        kind: "done",
        summary: {
          rootCause: typeof s.rootCause === "string" ? s.rootCause : "",
          changes: stringArray(s.changes),
          verification: stringArray(s.verification),
          ...(s.noChangeRequired === true ? { noChangeRequired: true } : {}),
        },
      };
    }
    if (obj.kind === "root-cause") {
      return { kind: "root-cause", text: asString(obj.text) || parsed.content.trim() };
    }
    if (obj.kind === "narrate") {
      return { kind: "narrate", phase: asPhase(obj.phase), text: asString(obj.text) };
    }
  }

  // No recognizable control object. Before defaulting to narration, check
  // whether the content is actually a tool call written as PROSE — if so, it
  // must NOT vanish: surface it for the loop to correct (never execute it).
  const offending = detectTextualCall(parsed.content, knownTools);
  if (offending !== null) {
    return { kind: "textual-call-detected", offendingText: offending };
  }

  // Otherwise treat the whole turn as narration.
  return { kind: "narrate", phase: "other", text: parsed.content.trim() || "(empty response)" };
}

/**
 * NARROW detector for a tool call written as prose: a known tool name (optionally
 * prefixed with "call ") immediately followed by `({` — an explicit call-shape
 * with an object argument, e.g. `read({"path":"x"})` or `call terminal({...})`.
 * Returns a capped snippet of the offending text, or null. Deliberately strict:
 * it requires the `({` shape so mere DISCUSSION ("I will use read next") never
 * matches. Restricted to the known tool names.
 */
function detectTextualCall(content: string, knownTools: readonly string[]): string | null {
  if (knownTools.length === 0 || content.trim() === "") return null;
  const names = knownTools.map(escapeRegex).join("|");
  const re = new RegExp(`(?:\\bcall\\s+)?\\b(?:${names})\\s*\\(\\s*\\{`);
  return re.test(content) ? content.trim().slice(0, 400) : null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── small utilities ──────────────────────────────────────────────────────────

function parseToolCalls(raw: unknown): Array<{ id: string; name: string; arguments: string }> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new MimoError("mimo message.tool_calls is not an array");
  return raw.map((entry, i) => {
    if (!isRecord(entry)) throw new MimoError(`mimo tool_calls[${i}] is not an object`);
    const fn = entry.function;
    if (!isRecord(fn) || typeof fn.name !== "string" || fn.name.length === 0) {
      throw new MimoError(`mimo tool_calls[${i}].function.name is missing`);
    }
    const args = fn.arguments;
    if (args !== undefined && typeof args !== "string") {
      throw new MimoError(`mimo tool_calls[${i}].function.arguments must be a string`);
    }
    return { id: typeof entry.id === "string" ? entry.id : `call_${i}`, name: fn.name, arguments: args ?? "" };
  });
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const candidates: string[] = [];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1] !== undefined) candidates.push(fence[1].trim());
  candidates.push(trimmed);
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const v: unknown = JSON.parse(c);
      if (isRecord(v)) return v;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asPhase(v: unknown): Phase {
  return v === "investigate" || v === "act" || v === "verify" || v === "other" ? v : "other";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sanitizeDetail(raw: string, max: number): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, max);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

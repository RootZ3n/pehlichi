/**
 * THE LLAMA.CPP DRIVER — local GGUF inference behind the Driver interface.
 *
 * Implements Driver { next(ctx): Promise<DriverAction> } and drops into the
 * core loop unchanged. Talks to llama-server's OpenAI-compatible endpoint:
 *   - POST /v1/chat/completions
 *   - No auth header (local server)
 *   - Full llama.cpp parameter passthrough (temperature, top_p, top_k,
 *     repeat_penalty, min_p, typical_p, mirostat, n_ctx, n_gpu_layers, etc.)
 *
 * The response protocol is identical to MiMo — the model follows the same
 * JSON control-object format (narrate / root-cause / done / tool calls).
 *
 * Reference: https://github.com/ggml-org/llama.cpp
 */
import type { Driver, DriverAction, DriverContext, Message, ToolSpec } from "../driver.js";
import type { Phase } from "../events.js";

const DEFAULT_BASE_URL = "http://localhost:8080";
const DEFAULT_MODEL = "local";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000; // local models can be slow
const MAX_ERROR_DETAIL = 300;

/** Minimal fetch signature; injectable so tests stay offline. */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

export class LlamaCppError extends Error {
  override readonly name = "LlamaCppError";
  constructor(message: string) {
    super(message);
  }
}

/**
 * Full llama.cpp server parameters. Every field maps to a llama-server
 * parameter. See: https://github.com/ggml-org/llama.cpp/blob/master/examples/server/README.md
 */
export interface LlamaCppDriverOptions {
  /** llama-server base URL. Default: http://localhost:8080 */
  readonly baseUrl?: string;
  /** Model name. Default: "local" (llama-server loads one model at startup). */
  readonly model?: string;
  /** Max tokens to generate. Default: 4096. */
  readonly maxTokens?: number;
  /** Sampling temperature. Higher = more random. Default: 0.7. */
  readonly temperature?: number;
  /** Top-p (nucleus) sampling. Default: 0.9. */
  readonly topP?: number;
  /** Top-k sampling. Default: 40. */
  readonly topK?: number;
  /** Repeat penalty. Default: 1.1. */
  readonly repeatPenalty?: number;
  /** Min-p sampling. Default: 0.0 (disabled). */
  readonly minP?: number;
  /** Typical-p sampling. Default: 1.0 (disabled). */
  readonly typicalP?: number;
  /** Mirostat mode (0=off, 1=v1, 2=v2). Default: 0. */
  readonly mirostat?: number;
  /** Mirostat tau (target entropy). Default: 5.0. */
  readonly mirostatTau?: number;
  /** Mirostat eta (learning rate). Default: 0.1. */
  readonly mirostatEta?: number;
  /** Number of context tokens. Passed as n_ctx if server supports it. */
  readonly nCtx?: number;
  /** Number of GPU layers to offload. 0 = CPU only. */
  readonly nGpuLayers?: number;
  /** Number of threads for CPU inference. */
  readonly nThreads?: number;
  /** Seed for reproducibility. -1 = random. */
  readonly seed?: number;
  /** Request timeout in ms. Default: 300000 (5 min — local models are slow). */
  readonly requestTimeoutMs?: number;
  /** Injectable fetch (default: global fetch). */
  readonly fetchImpl?: FetchLike;
}

/**
 * The response protocol — identical to MiMo's. Local models may need
 * stronger prompting to follow it, but the format is the same.
 */
export const LLAMACPP_RESPONSE_PROTOCOL = `RESPONSE PROTOCOL (machine-parsed — follow exactly).
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
   IMPORTANT: if you did NOT modify any files — you only answered, read, searched, or ran read-only commands like pwd/ls/cat — you MUST include "noChangeRequired":true. Example: {"kind":"done","summary":{"rootCause":"ran pwd for the user","changes":[],"verification":["ran pwd, got /path"],"noChangeRequired":true}}.
4. Otherwise narrate your next step, as a single JSON object and nothing else:
   {"kind":"narrate","phase":"investigate"|"act"|"verify"|"other","text":"<one short line>"}
For kinds 2-4 emit ONLY the JSON object, no surrounding prose.`;

export class LlamaCppDriver implements Driver {
  readonly baseUrl: string;
  readonly model: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly topP: number;
  private readonly topK: number;
  private readonly repeatPenalty: number;
  private readonly minP: number;
  private readonly typicalP: number;
  private readonly mirostat: number;
  private readonly mirostatTau: number;
  private readonly mirostatEta: number;
  private readonly nCtx: number | undefined;
  private readonly nGpuLayers: number | undefined;
  private readonly nThreads: number | undefined;
  private readonly seed: number | undefined;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(opts: LlamaCppDriverOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = opts.model ?? DEFAULT_MODEL;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.temperature = opts.temperature ?? 0.7;
    this.topP = opts.topP ?? 0.9;
    this.topK = opts.topK ?? 40;
    this.repeatPenalty = opts.repeatPenalty ?? 1.1;
    this.minP = opts.minP ?? 0.0;
    this.typicalP = opts.typicalP ?? 1.0;
    this.mirostat = opts.mirostat ?? 0;
    this.mirostatTau = opts.mirostatTau ?? 5.0;
    this.mirostatEta = opts.mirostatEta ?? 0.1;
    this.nCtx = opts.nCtx;
    this.nGpuLayers = opts.nGpuLayers;
    this.nThreads = opts.nThreads;
    this.seed = opts.seed;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  async next(ctx: DriverContext): Promise<DriverAction> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toWireMessages(ctx.messages),
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      top_p: this.topP,
      top_k: this.topK,
      repeat_penalty: this.repeatPenalty,
      min_p: this.minP,
      typical_p: this.typicalP,
      mirostat: this.mirostat,
      mirostat_tau: this.mirostatTau,
      mirostat_eta: this.mirostatEta,
      stream: false,
      ...(this.nCtx !== undefined ? { n_ctx: this.nCtx } : {}),
      ...(this.nGpuLayers !== undefined ? { n_gpu_layers: this.nGpuLayers } : {}),
      ...(this.nThreads !== undefined ? { n_threads: this.nThreads } : {}),
      ...(this.seed !== undefined ? { seed: this.seed } : {}),
      ...(ctx.tools.length > 0 ? { tools: toProviderTools(ctx.tools) } : {}),
    };

    const signal = AbortSignal.timeout(this.requestTimeoutMs);
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (cause) {
      const aborted = cause instanceof Error && cause.name === "TimeoutError";
      throw new LlamaCppError(
        `${aborted ? "timeout" : "network error"} calling llama-server at ${this.baseUrl}: ${messageOf(cause)}`,
      );
    }

    if (!res.ok) {
      const detail = sanitizeDetail(await res.text().catch(() => ""), MAX_ERROR_DETAIL);
      throw new LlamaCppError(`llama-server HTTP ${res.status}: ${detail}`);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (cause) {
      throw new LlamaCppError(`malformed JSON from llama-server: ${messageOf(cause)}`);
    }

    return completionToAction(parseChatCompletion(json), ctx.tools.map((t) => t.name));
  }
}

// ── pure helpers (offline-testable) ──────────────────────────────────────────

/** Map our ToolSpec[] into the OpenAI tool/function format. */
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
 * Map our textual Message[] to wire messages. Same approach as MiMo driver:
 * tool role → user turn labelled as tool output. Response protocol injected
 * after the first system message.
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
      wire.push({ role: "system", content: LLAMACPP_RESPONSE_PROTOCOL });
      protocolInjected = true;
    }
  }
  if (!protocolInjected) wire.unshift({ role: "system", content: LLAMACPP_RESPONSE_PROTOCOL });
  return wire;
}

export interface ParsedCompletion {
  readonly content: string;
  readonly toolCalls: Array<{ id: string; name: string; arguments: string }>;
  readonly finishReason: string;
}

/** Validate the provider JSON and extract content / tool calls / finish reason. */
export function parseChatCompletion(json: unknown): ParsedCompletion {
  if (!isRecord(json)) throw new LlamaCppError("llama-server response is not an object");
  const choices = json.choices;
  if (!Array.isArray(choices) || choices.length === 0) throw new LlamaCppError("llama-server response has no choices");
  const choice = choices[0];
  if (!isRecord(choice)) throw new LlamaCppError("llama-server choices[0] is not an object");
  const message = choice.message;
  if (!isRecord(message)) throw new LlamaCppError("llama-server choices[0].message is missing");

  const rawContent = message.content;
  if (rawContent !== undefined && rawContent !== null && typeof rawContent !== "string") {
    throw new LlamaCppError("llama-server message.content is not a string");
  }

  const toolCalls = parseToolCalls(message.tool_calls);
  return {
    content: typeof rawContent === "string" ? rawContent : "",
    toolCalls,
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : "unknown",
  };
}

/**
 * Map a parsed completion to exactly ONE DriverAction. Same logic as MiMo
 * driver — the response protocol is identical.
 */
export function completionToAction(parsed: ParsedCompletion, knownTools: readonly string[] = []): DriverAction {
  if (parsed.finishReason === "length") {
    throw new LlamaCppError(
      "llama-server stopped at the token cap (finish_reason=length); the turn was truncated — " +
        "raise max_tokens or shorten the task, do not treat this as done",
    );
  }

  const tc = parsed.toolCalls[0];
  if (tc !== undefined) {
    let args: Record<string, unknown>;
    try {
      args = tc.arguments.trim() === "" ? {} : (JSON.parse(tc.arguments) as unknown as Record<string, unknown>);
    } catch (cause) {
      throw new LlamaCppError(`llama-server tool call '${tc.name}' has non-JSON arguments: ${messageOf(cause)}`);
    }
    if (!isRecord(args)) throw new LlamaCppError(`llama-server tool call '${tc.name}' arguments are not an object`);
    return { kind: "tool", tool: tc.name, args };
  }

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

  const offending = detectTextualCall(parsed.content, knownTools);
  if (offending !== null) {
    return { kind: "textual-call-detected", offendingText: offending };
  }

  return { kind: "narrate", phase: "other", text: parsed.content.trim() || "(empty response)" };
}

function detectTextualCall(content: string, knownTools: readonly string[]): string | null {
  if (knownTools.length === 0 || content.trim() === "") return null;
  const names = knownTools.map(escapeRegex).join("|");
  const re = new RegExp(`(?:\\bcall\\s+)?\\b(?:${names})\\s*\\(\\s*\\{`);
  return re.test(content) ? content.trim().slice(0, 400) : null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseToolCalls(raw: unknown): Array<{ id: string; name: string; arguments: string }> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new LlamaCppError("llama-server message.tool_calls is not an array");
  return raw.map((entry, i) => {
    if (!isRecord(entry)) throw new LlamaCppError(`llama-server tool_calls[${i}] is not an object`);
    const fn = entry.function;
    if (!isRecord(fn) || typeof fn.name !== "string" || fn.name.length === 0) {
      throw new LlamaCppError(`llama-server tool_calls[${i}].function.name is missing`);
    }
    const args = fn.arguments;
    if (args !== undefined && typeof args !== "string") {
      throw new LlamaCppError(`llama-server tool_calls[${i}].function.arguments must be a string`);
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
      // try next
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

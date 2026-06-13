/**
 * THE OLLAMA DRIVER — local Ollama inference behind the Driver interface.
 *
 * Implements Driver { next(ctx): Promise<DriverAction> } and drops into the
 * core loop unchanged. Talks to Ollama's native chat API:
 *   - POST /api/chat
 *   - No auth header (local server)
 *   - Full Ollama parameter passthrough via `options` (temperature, top_p,
 *     top_k, repeat_penalty, num_ctx, num_gpu, num_thread, mirostat, etc.)
 *
 * Uses Ollama's native API (not the OpenAI-compatible endpoint) because it
 * gives full access to Ollama-specific parameters and keep-alive controls.
 *
 * Reference: https://github.com/ollama/ollama/blob/main/docs/api.md
 */
import type { Driver, DriverAction, DriverContext, Message, ToolSpec } from "../driver.js";
import type { Phase } from "../events.js";

const DEFAULT_BASE_URL = "http://localhost:11434";
const DEFAULT_MODEL = "llama3.2";
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000; // local models can be slow
const MAX_ERROR_DETAIL = 300;

/** Minimal fetch signature; injectable so tests stay offline. */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

export class OllamaError extends Error {
  override readonly name = "OllamaError";
  constructor(message: string) {
    super(message);
  }
}

/**
 * Full Ollama parameters. The `options` field maps directly to Ollama's
 * request options object.
 */
export interface OllamaDriverOptions {
  /** Ollama base URL. Default: http://localhost:11434 */
  readonly baseUrl?: string;
  /** Model name (e.g. "llama3.2", "qwen2.5:7b"). Default: "llama3.2". */
  readonly model?: string;
  /** Sampling temperature. Default: 0.7. */
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
  /** Context window size. Default: model's default. */
  readonly numCtx?: number;
  /** Number of GPU layers to offload. Default: model's default. */
  readonly numGpu?: number;
  /** Number of CPU threads. Default: auto. */
  readonly numThread?: number;
  /** Seed for reproducibility. -1 = random. */
  readonly seed?: number;
  /** Keep-alive duration after request. Default: "5m". */
  readonly keepAlive?: string;
  /** Request timeout in ms. Default: 300000 (5 min). */
  readonly requestTimeoutMs?: number;
  /** Injectable fetch (default: global fetch). */
  readonly fetchImpl?: FetchLike;
}

/**
 * The response protocol — identical to MiMo and llama.cpp. Local models may
 * need stronger prompting to follow it.
 */
export const OLLAMA_RESPONSE_PROTOCOL = `RESPONSE PROTOCOL (machine-parsed — follow exactly).
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

export class OllamaDriver implements Driver {
  readonly baseUrl: string;
  readonly model: string;
  private readonly temperature: number;
  private readonly topP: number;
  private readonly topK: number;
  private readonly repeatPenalty: number;
  private readonly minP: number;
  private readonly typicalP: number;
  private readonly mirostat: number;
  private readonly mirostatTau: number;
  private readonly mirostatEta: number;
  private readonly numCtx: number | undefined;
  private readonly numGpu: number | undefined;
  private readonly numThread: number | undefined;
  private readonly seed: number | undefined;
  private readonly keepAlive: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(opts: OllamaDriverOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = opts.model ?? DEFAULT_MODEL;
    this.temperature = opts.temperature ?? 0.7;
    this.topP = opts.topP ?? 0.9;
    this.topK = opts.topK ?? 40;
    this.repeatPenalty = opts.repeatPenalty ?? 1.1;
    this.minP = opts.minP ?? 0.0;
    this.typicalP = opts.typicalP ?? 1.0;
    this.mirostat = opts.mirostat ?? 0;
    this.mirostatTau = opts.mirostatTau ?? 5.0;
    this.mirostatEta = opts.mirostatEta ?? 0.1;
    this.numCtx = opts.numCtx;
    this.numGpu = opts.numGpu;
    this.numThread = opts.numThread;
    this.seed = opts.seed;
    this.keepAlive = opts.keepAlive ?? "5m";
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  async next(ctx: DriverContext): Promise<DriverAction> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toWireMessages(ctx.messages),
      stream: false,
      keep_alive: this.keepAlive,
      options: {
        temperature: this.temperature,
        top_p: this.topP,
        top_k: this.topK,
        repeat_penalty: this.repeatPenalty,
        min_p: this.minP,
        typical_p: this.typicalP,
        mirostat: this.mirostat,
        mirostat_tau: this.mirostatTau,
        mirostat_eta: this.mirostatEta,
        ...(this.numCtx !== undefined ? { num_ctx: this.numCtx } : {}),
        ...(this.numGpu !== undefined ? { num_gpu: this.numGpu } : {}),
        ...(this.numThread !== undefined ? { num_thread: this.numThread } : {}),
        ...(this.seed !== undefined ? { seed: this.seed } : {}),
      },
      ...(ctx.tools.length > 0 ? { tools: toProviderTools(ctx.tools) } : {}),
    };

    const signal = AbortSignal.timeout(this.requestTimeoutMs);
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (cause) {
      const aborted = cause instanceof Error && cause.name === "TimeoutError";
      throw new OllamaError(
        `${aborted ? "timeout" : "network error"} calling Ollama at ${this.baseUrl}: ${messageOf(cause)}`,
      );
    }

    if (!res.ok) {
      const detail = sanitizeDetail(await res.text().catch(() => ""), MAX_ERROR_DETAIL);
      throw new OllamaError(`Ollama HTTP ${res.status}: ${detail}`);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (cause) {
      throw new OllamaError(`malformed JSON from Ollama: ${messageOf(cause)}`);
    }

    return completionToAction(parseOllamaResponse(json), ctx.tools.map((t) => t.name));
  }
}

// ── pure helpers (offline-testable) ──────────────────────────────────────────

/** Map our ToolSpec[] into Ollama's tool format. */
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
 * Map our textual Message[] to Ollama wire messages. Same approach: tool role
 * → user turn labelled as tool output. Response protocol injected after the
 * first system message.
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
      wire.push({ role: "system", content: OLLAMA_RESPONSE_PROTOCOL });
      protocolInjected = true;
    }
  }
  if (!protocolInjected) wire.unshift({ role: "system", content: OLLAMA_RESPONSE_PROTOCOL });
  return wire;
}

export interface ParsedCompletion {
  readonly content: string;
  readonly toolCalls: Array<{ id: string; name: string; arguments: string }>;
  readonly finishReason: string;
}

/**
 * Parse Ollama's native response format. Ollama returns:
 * { message: { role, content, tool_calls? }, done, ... }
 */
export function parseOllamaResponse(json: unknown): ParsedCompletion {
  if (!isRecord(json)) throw new OllamaError("Ollama response is not an object");

  const message = json.message;
  if (!isRecord(message)) throw new OllamaError("Ollama response has no message");

  const rawContent = message.content;
  if (rawContent !== undefined && rawContent !== null && typeof rawContent !== "string") {
    throw new OllamaError("Ollama message.content is not a string");
  }

  const toolCalls = parseToolCalls(message.tool_calls);
  const done = json.done === true;

  return {
    content: typeof rawContent === "string" ? rawContent : "",
    toolCalls,
    finishReason: done ? "stop" : "length",
  };
}

/**
 * Map a parsed completion to exactly ONE DriverAction. Same logic as the
 * other drivers — the response protocol is identical.
 */
export function completionToAction(parsed: ParsedCompletion, knownTools: readonly string[] = []): DriverAction {
  if (parsed.finishReason === "length") {
    throw new OllamaError(
      "Ollama did not complete (finish_reason=length); the turn was truncated — " +
        "the model may need more tokens or a shorter task",
    );
  }

  const tc = parsed.toolCalls[0];
  if (tc !== undefined) {
    let args: Record<string, unknown>;
    try {
      args = tc.arguments.trim() === "" ? {} : (JSON.parse(tc.arguments) as Record<string, unknown>);
    } catch (cause) {
      throw new OllamaError(`Ollama tool call '${tc.name}' has non-JSON arguments: ${messageOf(cause)}`);
    }
    if (!isRecord(args)) throw new OllamaError(`Ollama tool call '${tc.name}' arguments are not an object`);
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

/**
 * Parse Ollama tool calls. Ollama returns tool_calls as:
 * [{ function: { name, arguments } }]
 * Note: arguments can be an object (not a string like OpenAI).
 */
function parseToolCalls(raw: unknown): Array<{ id: string; name: string; arguments: string }> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new OllamaError("Ollama message.tool_calls is not an array");
  return raw.map((entry, i) => {
    if (!isRecord(entry)) throw new OllamaError(`Ollama tool_calls[${i}] is not an object`);
    const fn = entry.function;
    if (!isRecord(fn) || typeof fn.name !== "string" || fn.name.length === 0) {
      throw new OllamaError(`Ollama tool_calls[${i}].function.name is missing`);
    }
    const args = fn.arguments;
    // Ollama can return arguments as object or string — normalize to string
    const argsStr = typeof args === "string" ? args : (isRecord(args) ? JSON.stringify(args) : "");
    return { id: typeof entry.id === "string" ? entry.id : `call_${i}`, name: fn.name, arguments: argsStr };
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

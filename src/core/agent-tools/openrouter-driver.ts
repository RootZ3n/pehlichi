/**
 * OPENROUTER DRIVER — provider for hundreds of models via single API key.
 *
 * Implements the same Driver interface as MimoDriver. OpenRouter uses
 * standard OpenAI-compatible chat completions with Bearer auth.
 *
 * Features:
 * - Automatic model routing (just specify model ID)
 * - Response caching (via config)
 * - Provider fallback (OpenRouter handles internally)
 * - Streaming support (future)
 *
 * Usage:
 *   const driver = new OpenRouterDriver({ apiKey: "sk-or-...", model: "anthropic/claude-sonnet-4" });
 *   const action = await driver.next(ctx);
 */

import type { Driver, DriverAction, DriverContext, Message, ToolSpec } from "../driver.js";
import { sanitizeToolDefinitions } from "./schema-sanitizer.js";
import { classifyError } from "./error-classifier.js";
import { sanitizeMessage } from "./input-sanitization.js";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "anthropic/claude-sonnet-4";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export class OpenRouterError extends Error {
  override readonly name = "OpenRouterError";
  constructor(message: string) {
    super(message);
  }
}

export interface OpenRouterDriverOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly requestTimeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export class OpenRouterDriver implements Driver {
  readonly baseUrl: string;
  readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly maxTokens: number;
  private readonly temperature: number | undefined;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenRouterDriverOptions = {}) {
    const key = opts.apiKey ?? process.env["OPENROUTER_API_KEY"];
    if (!key) throw new OpenRouterError("OpenRouter requires an API key (OPENROUTER_API_KEY)");
    this.apiKey = key;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = opts.model ?? DEFAULT_MODEL;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.temperature = opts.temperature;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async next(ctx: DriverContext): Promise<DriverAction> {
    const messages = toWireMessages(ctx.messages);

    // Sanitize tool schemas for provider compatibility
    const tools = ctx.tools.length > 0
      ? sanitizeToolDefinitions(toProviderTools(ctx.tools))
      : undefined;

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: this.maxTokens,
      ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
      ...(tools ? { tools } : {}),
    };

    const signal = AbortSignal.timeout(this.requestTimeoutMs);
    let res: Response;

    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${this.apiKey}`,
          "http-referer": "https://pehverse.ai",
          "x-title": "Pehverse Lab Agent",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (cause) {
      const classified = classifyError(cause);
      throw new OpenRouterError(`${classified.category}: ${messageOf(cause)}`);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const classified = classifyError(new Error(`HTTP ${res.status}`), res.status, detail);
      throw new OpenRouterError(`${classified.category}: HTTP ${res.status} — ${detail.slice(0, 300)}`);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (cause) {
      throw new OpenRouterError(`parse_error: malformed JSON — ${messageOf(cause)}`);
    }

    return completionToAction(parseChatCompletion(json));
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function toProviderTools(
  tools: readonly ToolSpec[],
): Array<{ type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters ?? { type: "object", properties: {}, additionalProperties: true },
    },
  }));
}

function toWireMessages(messages: readonly Message[]): Array<Record<string, string>> {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "user" as const, content: `[Tool Result]\n${sanitizeMessage(m.content)}` };
    }
    return { role: m.role, content: sanitizeMessage(m.content) };
  });
}

interface ParsedCompletion {
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason: string;
}

function parseChatCompletion(json: unknown): ParsedCompletion {
  if (!isRecord(json)) throw new OpenRouterError("response is not an object");
  const choices = json["choices"];
  if (!Array.isArray(choices) || choices.length === 0) throw new OpenRouterError("no choices in response");
  const choice = choices[0];
  if (!isRecord(choice)) throw new OpenRouterError("choice is not an object");
  const message = choice["message"];
  if (!isRecord(message)) throw new OpenRouterError("message is missing");

  const content = typeof message["content"] === "string" ? message["content"] : "";
  const toolCalls = parseToolCalls(message["tool_calls"]);
  const finishReason = typeof choice["finish_reason"] === "string" ? choice["finish_reason"] : "unknown";

  return { content, toolCalls, finishReason };
}

function parseToolCalls(raw: unknown): Array<{ id: string; name: string; arguments: string }> {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry, i) => {
    if (!isRecord(entry)) return { id: `call_${i}`, name: "unknown", arguments: "{}" };
    const fn = entry["function"];
    if (!isRecord(fn)) return { id: `call_${i}`, name: "unknown", arguments: "{}" };
    return {
      id: typeof entry["id"] === "string" ? entry["id"] : `call_${i}`,
      name: typeof fn["name"] === "string" ? fn["name"] : "unknown",
      arguments: typeof fn["arguments"] === "string" ? fn["arguments"] : "{}",
    };
  });
}

function completionToAction(parsed: ParsedCompletion): DriverAction {
  if (parsed.finishReason === "length") {
    throw new OpenRouterError("truncated: finish_reason=length — raise max_tokens or shorten the task");
  }

  const tc = parsed.toolCalls[0];
  if (tc) {
    let args: Record<string, unknown>;
    try {
      args = tc.arguments.trim() === "" ? {} : JSON.parse(tc.arguments);
    } catch {
      throw new OpenRouterError(`tool call '${tc.name}' has non-JSON arguments`);
    }
    if (!isRecord(args)) throw new OpenRouterError(`tool call '${tc.name}' arguments are not an object`);
    return { kind: "tool", tool: tc.name, args };
  }

  // Try to parse as control JSON (narrate/root-cause/done)
  const obj = extractJsonObject(parsed.content);
  if (obj) {
    if (obj["kind"] === "done") {
      const s = isRecord(obj["summary"]) ? obj["summary"] : {};
      return {
        kind: "done",
        summary: {
          rootCause: typeof s["rootCause"] === "string" ? s["rootCause"] : "",
          changes: Array.isArray(s["changes"]) ? s["changes"].filter((x: unknown) => typeof x === "string") : [],
          verification: Array.isArray(s["verification"]) ? s["verification"].filter((x: unknown) => typeof x === "string") : [],
          ...(s["noChangeRequired"] === true ? { noChangeRequired: true } : {}),
        },
      };
    }
    if (obj["kind"] === "root-cause") {
      return { kind: "root-cause", text: typeof obj["text"] === "string" ? obj["text"] : parsed.content.trim() };
    }
    if (obj["kind"] === "narrate") {
      return { kind: "narrate", phase: "other", text: typeof obj["text"] === "string" ? obj["text"] : parsed.content.trim() };
    }
  }

  return { kind: "narrate", phase: "other", text: parsed.content.trim() || "(empty response)" };
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  try {
    const v = JSON.parse(trimmed.slice(first, last + 1));
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

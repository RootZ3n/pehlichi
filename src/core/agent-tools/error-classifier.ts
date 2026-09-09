/**
 * ERROR CLASSIFIER — simplified error taxonomy for model API calls.
 *
 * Ported from Hermes' error_classifier.py (1319 lines → ~150 lines).
 * Classifies errors into actionable categories with hints for the retry loop.
 *
 * Usage:
 *   const classified = classifyError(error, response);
 *   if (classified.retryable) await retry();
 *   if (classified.shouldFallback) switchProvider();
 */

export type ErrorCategory =
  | "auth"
  | "billing"
  | "rate_limit"
  | "timeout"
  /** The CALLER stopped the work. Not a provider fault, and never retried as if it were. */
  | "cancelled"
  | "context_overflow"
  | "server_error"
  | "model_not_found"
  | "content_policy"
  | "network"
  | "parse_error"
  | "truncated"
  | "unknown";

/**
 * Facts a caller already KNOWS, rather than sentences it hopes to recognise.
 *
 * The classifier's prose rules are a last resort: a provider that hands back a typed code, or
 * a driver that already knows it cancelled its own request, should say so instead of writing a
 * message and asking this function to guess what it meant. Everything here outranks text.
 */
export interface StructuredErrorFacts {
  /** Provider-issued machine code, e.g. `context_length_exceeded`, `rate_limit_exceeded`. */
  readonly providerCode?: string;
  /** Provider-issued error type, where the dialect has one distinct from the code. */
  readonly providerType?: string;
  /** The response's own `finish_reason`. `"length"` HERE is truncation; the word in prose is not. */
  readonly finishReason?: string;
  /** True when this process aborted the request — a cancellation, never a provider timeout. */
  readonly callerCancelled?: boolean;
  /** True when a deadline this process armed elapsed. */
  readonly deadlineElapsed?: boolean;
}

/**
 * Whole-word match.
 *
 * Substring matching is what made two rules unsound: `"abort"` matched an ordinary sentence
 * about aborting, and `"length"` matched `content-length`, `Invalid length`, and any prose
 * mentioning the word. A word boundary is not a cure for guessing from text, but it stops the
 * two collisions that were actually observed.
 */
function hasWord(haystack: string, word: string): boolean {
  return new RegExp(`(^|[^a-z0-9_])${word}([^a-z0-9_]|$)`, "i").test(haystack);
}

export interface ClassifiedError {
  category: ErrorCategory;
  retryable: boolean;
  shouldFallback: boolean;
  shouldRotateCredential: boolean;
  shouldCompress: boolean;
  message: string;
  raw?: string;
}

/**
 * Classify an error from a model API call.
 * Accepts Error objects, HTTP status codes, and raw response text.
 */
export function classifyError(
  error: unknown,
  statusCode?: number,
  responseBody?: string,
  structured?: StructuredErrorFacts,
): ClassifiedError {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  const body = (responseBody ?? "").toLowerCase();
  const combined = `${lower} ${body}`;
  const name = error instanceof Error ? error.name : "";

  /*
    STRUCTURED FIRST, ALWAYS.

    Everything below the ladder reads prose, and reading prose is guessing. When the caller or
    the provider already stated the fact, that statement wins outright and no text is consulted.
  */
  if (structured?.callerCancelled === true) {
    // A cancellation is not a provider failure: retrying it would re-run work somebody stopped.
    return make("cancelled", { retryable: false, shouldFallback: false, message: msg });
  }
  if (structured?.deadlineElapsed === true) {
    return make("timeout", { retryable: true, shouldFallback: true, message: msg });
  }
  if (structured?.finishReason === "length") {
    return make("truncated", { retryable: false, shouldFallback: false, shouldCompress: true, message: msg });
  }
  const code = `${structured?.providerCode ?? ""} ${structured?.providerType ?? ""}`.toLowerCase().trim();
  if (code.length > 0) {
    const byCode = classifyProviderCode(code, msg, statusCode);
    if (byCode !== undefined) return byCode;
  }

  /*
    A CANCEL IS NOT A TIMEOUT, and the difference is visible without prose: the platform names
    an abort `AbortError`, and `AbortSignal.timeout` is the one that carries `TimeoutError`.
    The old rule read the word "abort" out of any message and called every one a provider
    timeout, which made caller-cancelled work look retriable.
  */
  if (name === "AbortError") {
    return make("cancelled", { retryable: false, shouldFallback: false, message: msg });
  }
  if (name === "TimeoutError") {
    return make("timeout", { retryable: true, shouldFallback: true, message: msg });
  }

  // Auth errors
  if (statusCode === 401 || statusCode === 403 || combined.includes("unauthorized") || combined.includes("invalid api key") || combined.includes("authentication")) {
    return make("auth", { retryable: false, shouldFallback: true, shouldRotateCredential: true, message: msg });
  }

  // Billing
  if (statusCode === 402 || combined.includes("billing") || combined.includes("insufficient funds") || combined.includes("quota exceeded") || combined.includes("out of credits")) {
    return make("billing", { retryable: false, shouldFallback: true, shouldRotateCredential: true, message: msg });
  }

  // Rate limiting
  if (statusCode === 429 || combined.includes("rate limit") || combined.includes("too many requests") || combined.includes("rate_limit_exceeded")) {
    return make("rate_limit", { retryable: true, shouldFallback: true, message: msg });
  }

  // Context overflow
  if (combined.includes("context length") || combined.includes("context window") || combined.includes("too many tokens") || combined.includes("max_model_len") || combined.includes("context_length_exceeded") || combined.includes("token limit")) {
    return make("context_overflow", { retryable: false, shouldFallback: false, shouldCompress: true, message: msg });
  }

  // Model not found
  if (statusCode === 404 || combined.includes("model not found") || combined.includes("model_not_found") || combined.includes("no such model")) {
    return make("model_not_found", { retryable: false, shouldFallback: true, message: msg });
  }

  // Content policy
  if (statusCode === 451 || combined.includes("content policy") || combined.includes("safety") || combined.includes("blocked") || combined.includes("harmful")) {
    return make("content_policy", { retryable: false, shouldFallback: false, message: msg });
  }

  // Timeout. `abort` is NOT here: it is the caller's verb as often as the provider's, and the
  // typed `AbortError`/`TimeoutError` check above already separates the two cases that matter.
  if (statusCode === 408 || combined.includes("timeout") || combined.includes("timed out")) {
    return make("timeout", { retryable: true, shouldFallback: true, message: msg });
  }

  // Network errors
  if (combined.includes("econnrefused") || combined.includes("econnreset") || combined.includes("enotfound") || combined.includes("network") || combined.includes("fetch failed") || combined.includes("ssl") || combined.includes("tls")) {
    return make("network", { retryable: true, shouldFallback: true, message: msg });
  }

  // Server errors (5xx)
  if (statusCode !== undefined && statusCode >= 500) {
    return make("server_error", { retryable: true, shouldFallback: true, message: msg });
  }

  // Parse errors (malformed JSON response)
  if (combined.includes("json") || combined.includes("parse") || combined.includes("unexpected token") || combined.includes("malformed")) {
    return make("parse_error", { retryable: true, shouldFallback: false, message: msg });
  }

  /*
    Truncation.

    A bare `length` used to land here, which matched `content-length`, `Invalid length`, and any
    sentence containing the word — so ordinary prose was classified as a truncated completion
    and sent to the compressor. Truncation is a STRUCTURED fact (`finish_reason`), handled at
    the top; what remains is the narrow prose form that actually names it.
  */
  if (hasWord(combined, "truncated") || combined.includes("finish_reason=length") || combined.includes('"finish_reason": "length"')) {
    return make("truncated", { retryable: false, shouldFallback: false, shouldCompress: true, message: msg });
  }

  // Unknown
  return make("unknown", { retryable: false, shouldFallback: false, message: msg });
}

/**
 * Map a provider's own machine code, keeping DIALECTS DISTINCT.
 *
 * Providers do not share a denial vocabulary, and a union of everyone's strings claims
 * detection coverage for a provider that never emits those forms. These are the codes the
 * OpenAI-compatible dialect our adapters actually speak does emit; an unrecognised code
 * returns `undefined` and falls through to the ladder rather than being forced into a
 * category that happens to share a word.
 */
function classifyProviderCode(code: string, msg: string, statusCode?: number): ClassifiedError | undefined {
  if (code.includes("context_length_exceeded") || code.includes("string_above_max_length")) {
    return make("context_overflow", { retryable: false, shouldFallback: false, shouldCompress: true, message: msg });
  }
  if (code.includes("rate_limit_exceeded")) {
    return make("rate_limit", { retryable: true, shouldFallback: true, message: msg });
  }
  if (code.includes("insufficient_quota") || code.includes("billing_hard_limit_reached")) {
    return make("billing", { retryable: false, shouldFallback: true, shouldRotateCredential: true, message: msg });
  }
  if (code.includes("invalid_api_key") || code.includes("authentication_error")) {
    return make("auth", { retryable: false, shouldFallback: true, shouldRotateCredential: true, message: msg });
  }
  if (code.includes("model_not_found")) {
    return make("model_not_found", { retryable: false, shouldFallback: true, message: msg });
  }
  if (code.includes("content_filter") || code.includes("content_policy_violation")) {
    return make("content_policy", { retryable: false, shouldFallback: false, message: msg });
  }
  if (code.includes("server_error") || code.includes("service_unavailable")) {
    return make("server_error", { retryable: true, shouldFallback: true, message: msg });
  }
  void statusCode;
  return undefined;
}

function make(
  category: ErrorCategory,
  opts: { retryable: boolean; shouldFallback: boolean; shouldRotateCredential?: boolean; shouldCompress?: boolean; message: string },
): ClassifiedError {
  return {
    category,
    retryable: opts.retryable,
    shouldFallback: opts.shouldFallback,
    shouldRotateCredential: opts.shouldRotateCredential ?? false,
    shouldCompress: opts.shouldCompress ?? false,
    message: opts.message,
  };
}

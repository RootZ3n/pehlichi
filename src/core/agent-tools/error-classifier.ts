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
  | "context_overflow"
  | "server_error"
  | "model_not_found"
  | "content_policy"
  | "network"
  | "parse_error"
  | "truncated"
  | "unknown";

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
): ClassifiedError {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  const body = (responseBody ?? "").toLowerCase();
  const combined = `${lower} ${body}`;

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

  // Timeout
  if (combined.includes("timeout") || combined.includes("timed out") || combined.includes("abort") || statusCode === 408) {
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

  // Truncated (finish_reason=length)
  if (combined.includes("truncated") || combined.includes("finish_reason") || combined.includes("length")) {
    return make("truncated", { retryable: false, shouldFallback: false, shouldCompress: true, message: msg });
  }

  // Unknown
  return make("unknown", { retryable: false, shouldFallback: false, message: msg });
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

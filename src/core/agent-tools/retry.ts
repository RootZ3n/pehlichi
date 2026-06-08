/**
 * RETRY — decorrelated exponential backoff with jitter.
 *
 * Ported from Hermes' retry_utils.py. Thread-safe counter.
 *
 * Usage:
 *   const retry = new RetryPolicy({ baseMs: 2000, maxMs: 30_000 });
 *   for (let attempt = 0; attempt < retry.maxAttempts; attempt++) {
 *     try { return await fn(); } catch (e) {
 *       if (!isRetryable(e) || attempt === retry.maxAttempts - 1) throw e;
 *       await sleep(retry.delay(attempt));
 *     }
 *   }
 */

export interface RetryConfig {
  /** Base delay in ms (default: 2000) */
  baseMs: number;
  /** Maximum delay in ms (default: 30_000) */
  maxMs: number;
  /** Maximum attempts (default: 4) */
  maxAttempts: number;
  /** Jitter ratio 0-1 (default: 0.5) */
  jitterRatio: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  baseMs: 2_000,
  maxMs: 30_000,
  maxAttempts: 4,
  jitterRatio: 0.5,
};

export class RetryPolicy {
  private readonly config: RetryConfig;
  private lastDelay = 0;

  constructor(config?: Partial<RetryConfig>) {
    this.config = { ...DEFAULT_RETRY_CONFIG, ...config };
  }

  get maxAttempts(): number {
    return this.config.maxAttempts;
  }

  /**
   * Calculate delay for the given attempt (0-indexed).
   * Uses decorrelated exponential: each delay is based on the previous one,
   * not the base. This prevents thundering herd after concurrent failures.
   */
  delay(attempt: number): number {
    const { baseMs, maxMs, jitterRatio } = this.config;
    // Decorrelated: delay = min(max, base + prev * random(1, 3))
    const raw = attempt === 0
      ? baseMs
      : Math.min(maxMs, baseMs + this.lastDelay * (1 + Math.random() * 2));
    // Apply jitter
    const jitter = raw * jitterRatio * Math.random();
    const delay = Math.min(maxMs, Math.round(raw + jitter));
    this.lastDelay = delay;
    return delay;
  }

  /** Reset the delay chain (e.g., after a successful call). */
  reset(): void {
    this.lastDelay = 0;
  }
}

/** Classify whether an error is retryable. */
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();

  // Timeouts are retryable
  if (msg.includes("timeout") || msg.includes("timed out")) return true;
  // Network errors
  if (msg.includes("econnrefused") || msg.includes("econnreset") || msg.includes("enotfound")) return true;
  if (msg.includes("network error") || msg.includes("fetch failed")) return true;
  // Rate limits (retryable with backoff)
  if (msg.includes("429") || msg.includes("rate limit")) return true;
  // Server errors (5xx)
  if (/\b5\d{2}\b/.test(msg) || msg.includes("server error") || msg.includes("503") || msg.includes("502")) return true;
  // Circuit breaker open (retryable after cooldown)
  if (msg.includes("circuit breaker")) return true;

  return false;
}

/** Sleep utility. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a function with retry logic.
 * Returns the result of the first successful call, or throws the last error.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config?: Partial<RetryConfig>,
  onRetry?: (attempt: number, error: Error, delayMs: number) => void,
): Promise<T> {
  const policy = new RetryPolicy(config);
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
    try {
      const result = await fn();
      policy.reset();
      return result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (!isRetryable(err) || attempt === policy.maxAttempts - 1) break;
      const delay = policy.delay(attempt);
      if (onRetry) onRetry(attempt, lastError, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}

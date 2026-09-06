/**
 * TRANSPORT POLICY — one provider-neutral answer to "how long, how often, and what counts as
 * worth trying again".
 *
 * The driver had a single 120-second abort and nothing else: no connect timeout, no header
 * timeout, no idle timeout, no run deadline, and retry that was off unless a caller opted in. That
 * is not a timeout policy, it is one number standing in for five different questions, and the
 * questions have different answers:
 *
 *   - a connection that never opens is broken NOW and there is no reason to wait two minutes;
 *   - a provider that accepts the connection and sends no headers is thinking, or is wedged, and
 *     only a header timeout can tell the difference in bounded time;
 *   - a stream that has sent bytes and then stops is a different failure from one that never
 *     started, and an IDLE timeout catches it while a total timeout cannot;
 *   - a single attempt may legitimately take a long time; a whole RUN may not, and a run deadline
 *     is the only thing that survives retries.
 *
 * Two rules are load-bearing and are the reason retry is not simply "on":
 *
 *   RETRY ONLY WHAT IS TRANSIENT. An authentication failure retried is an authentication failure
 *   three times; a malformed request retried is the same malformed request; a model that
 *   deterministically refuses will refuse again. Retrying those burns the run deadline and turns
 *   one clear error into a slow one. Only a connection failure, a timeout before any output, a
 *   5xx or an explicit rate limit is worth another attempt.
 *
 *   NEVER RETRY AFTER AN EFFECT. Once a turn has produced a tool call, a retry would propose it
 *   again, and a duplicated durable effect is not a reliability improvement. The decision is made
 *   with `effectsObserved` and the answer is not negotiable.
 *
 * Nothing here performs a request. It decides, and it records — every attempt carries its own id,
 * its parent run id, and a terminal outcome, so a late response can be recognised as belonging to
 * an attempt that is already over.
 */

/** Every distinct clock a request is measured against. Milliseconds. */
export interface TransportTimeouts {
  /** Opening the socket. A connection that will not open is broken now. */
  readonly connectMs: number;
  /** First response header after the request is sent. Distinguishes "thinking" from "wedged". */
  readonly headerMs: number;
  /** Longest silence BETWEEN bytes once a response has started. Only meaningful when streaming. */
  readonly idleMs: number;
  /** One attempt, end to end. */
  readonly attemptMs: number;
  /** The whole run, across every attempt. Survives retries; never reset by one. */
  readonly runMs: number;
}

export interface RetryPolicy {
  /** Attempts after the first. 0 disables retry without disabling the rest of the policy. */
  readonly maxRetries: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  /** Jitter fraction, 0..1, applied symmetrically so a fleet does not retry in lockstep. */
  readonly jitter: number;
}

export interface TransportPolicy {
  readonly timeouts: TransportTimeouts;
  readonly retry: RetryPolicy;
}

/**
 * The default policy.
 *
 * Chosen so that every number answers its own question rather than inheriting another's:
 * connecting to a cloud endpoint is a few seconds or it is broken; a reasoning model may take a
 * minute to produce its first header; a stream that goes quiet for a minute has stopped; one
 * attempt is bounded well under the run; and the run bound is what a caller actually waits for.
 */
export const DEFAULT_TRANSPORT_POLICY: TransportPolicy = Object.freeze({
  timeouts: Object.freeze({
    connectMs: 10_000,
    headerMs: 90_000,
    idleMs: 60_000,
    attemptMs: 180_000,
    runMs: 600_000,
  }),
  retry: Object.freeze({ maxRetries: 2, baseBackoffMs: 500, maxBackoffMs: 8_000, jitter: 0.25 }),
});

export type FailureClass =
  | 'connect'
  | 'header-timeout'
  | 'idle-timeout'
  | 'attempt-timeout'
  | 'run-deadline'
  | 'rate-limit'
  | 'server-error'
  | 'authentication'
  | 'authorization'
  | 'malformed-request'
  | 'model-error'
  | 'malformed-response'
  | 'aborted'
  | 'unknown';

/** Exactly the classes worth another attempt. Everything absent from this set is terminal. */
const TRANSIENT: ReadonlySet<FailureClass> = new Set<FailureClass>([
  'connect', 'header-timeout', 'idle-timeout', 'attempt-timeout', 'rate-limit', 'server-error',
]);

/**
 * Classify a failure from what the transport actually saw.
 *
 * `status` is the HTTP status when there was one. `errorName` is the error's own name, which is
 * how an abort and a timeout are told apart without parsing a message string — messages change
 * with the runtime, names do not.
 */
export function classifyFailure(input: {
  readonly status?: number | undefined;
  readonly errorName?: string | undefined;
  readonly errorCode?: string | undefined;
  readonly phase?: 'connect' | 'header' | 'body' | undefined;
}): FailureClass {
  const { status, errorName, errorCode, phase } = input;
  if (status !== undefined) {
    if (status === 401) return 'authentication';
    if (status === 403) return 'authorization';
    if (status === 429) return 'rate-limit';
    if (status === 400 || status === 404 || status === 405 || status === 413 || status === 422)
      return 'malformed-request';
    if (status >= 500) return 'server-error';
    if (status >= 400) return 'model-error';
  }
  if (errorCode === 'ECONNREFUSED' || errorCode === 'ENOTFOUND' || errorCode === 'ECONNRESET'
      || errorCode === 'EAI_AGAIN' || errorCode === 'UND_ERR_CONNECT_TIMEOUT') return 'connect';
  if (errorCode === 'UND_ERR_HEADERS_TIMEOUT') return 'header-timeout';
  if (errorCode === 'UND_ERR_BODY_TIMEOUT') return 'idle-timeout';
  if (errorName === 'TimeoutError') return phase === 'header' ? 'header-timeout' : 'attempt-timeout';
  if (errorName === 'AbortError') return 'aborted';
  return 'unknown';
}

/**
 * Whether to try again.
 *
 * Four independent reasons to stop, and the effects one is absolute: a turn that has already
 * proposed or performed a tool call must never be replayed, because the second attempt would
 * propose it again and a duplicated durable effect is not a reliability improvement.
 */
export function shouldRetry(input: {
  readonly failure: FailureClass;
  readonly attempt: number;
  readonly policy: RetryPolicy;
  readonly effectsObserved: boolean;
  readonly runDeadlineRemainingMs: number;
}): { readonly retry: boolean; readonly reason: string } {
  if (input.effectsObserved) return { retry: false, reason: 'effects-observed' };
  if (!TRANSIENT.has(input.failure)) return { retry: false, reason: `terminal:${input.failure}` };
  if (input.attempt > input.policy.maxRetries) return { retry: false, reason: 'retries-exhausted' };
  if (input.runDeadlineRemainingMs <= 0) return { retry: false, reason: 'run-deadline' };
  return { retry: true, reason: `transient:${input.failure}` };
}

/** Exponential backoff with symmetric jitter, clamped to what the run deadline still allows. */
export function backoffMs(attempt: number, policy: RetryPolicy, remainingMs: number,
                          random: () => number = Math.random): number {
  const base = Math.min(policy.baseBackoffMs * 2 ** Math.max(0, attempt - 1), policy.maxBackoffMs);
  const spread = base * policy.jitter;
  const withJitter = Math.max(0, base + (random() * 2 - 1) * spread);
  return Math.max(0, Math.min(Math.round(withJitter), Math.max(0, remainingMs - 1)));
}

/**
 * One attempt's record. Every field Phase 3 requires be recorded separately, and no field that
 * could carry a secret: the endpoint and the model are published, the key never is.
 */
export interface AttemptRecord {
  readonly runId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly attempt: number;
  readonly provider: string;
  readonly endpoint: string;
  readonly configuredModel: string;
  /** What the provider said it actually ran. A silent substitution is a finding, not a detail. */
  readonly wireModel?: string;
  readonly driver: string;
  readonly streamingRequested: boolean;
  readonly streamingNegotiated: boolean;
  readonly streamingObserved: boolean;
  readonly timeouts: TransportTimeouts;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly timeToFirstByteMs?: number;
  readonly httpStatus?: number;
  readonly failure?: FailureClass;
  readonly retryDecision?: string;
  readonly backoffMs?: number;
  readonly effectsObserved: boolean;
  readonly outcome: 'ok' | 'retrying' | 'failed';
}

/** A run's deadline, shared by every attempt in it. A retry does not extend it. */
export class RunDeadline {
  private readonly endsAt: number;
  constructor(runMs: number, private readonly now: () => number = Date.now) {
    this.endsAt = now() + runMs;
  }
  remainingMs(): number { return this.endsAt - this.now(); }
  expired(): boolean { return this.remainingMs() <= 0; }
  /** The budget one attempt may use: never more than the attempt cap, never past the run. */
  attemptBudgetMs(attemptMs: number): number { return Math.max(0, Math.min(attemptMs, this.remainingMs())); }
}

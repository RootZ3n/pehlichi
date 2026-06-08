/**
 * CIRCUIT BREAKER — thread-safe provider failure protection.
 *
 * Ported from Hermes' openrouter_hardened.py. Same pattern: closed → open → half-open → closed.
 *
 * States:
 *   closed:   normal operation, counting failures
 *   open:     fast-fail for cooldown period (30s default)
 *   half-open: allowing probe requests after cooldown
 *
 * Usage:
 *   const breaker = new CircuitBreaker("mimo");
 *   if (!breaker.allow()) throw new Error("Circuit open");
 *   try { const result = await call(); breaker.success(); return result; }
 *   catch (e) { breaker.failure(); throw e; }
 */

export interface CircuitConfig {
  failureThreshold: number;   // failures before opening (default: 5)
  cooldownMs: number;         // how long to stay open (default: 30_000)
  successThreshold: number;   // successes in half-open to close (default: 3)
}

const DEFAULT_CONFIG: CircuitConfig = {
  failureThreshold: 5,
  cooldownMs: 30_000,
  successThreshold: 3,
};

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitStatus {
  adapterId: string;
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureAt: number | null;
  openedAt: number | null;
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private successes = 0;
  private lastFailureAt: number | null = null;
  private openedAt: number | null = null;
  private readonly config: CircuitConfig;

  constructor(
    public readonly adapterId: string,
    config?: Partial<CircuitConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Is the circuit allowing requests through? */
  allow(): boolean {
    if (this.state === "closed") return true;
    if (this.state === "open") {
      const now = Date.now();
      if (this.openedAt !== null && now - this.openedAt >= this.config.cooldownMs) {
        this.state = "half-open";
        this.successes = 0;
        return true;
      }
      return false;
    }
    // half-open: allow probe
    return true;
  }

  /** Record a successful call. */
  success(): void {
    if (this.state === "half-open") {
      this.successes++;
      if (this.successes >= this.config.successThreshold) {
        this.state = "closed";
        this.failures = 0;
        this.successes = 0;
        this.openedAt = null;
      }
    } else {
      this.failures = 0;
    }
  }

  /** Record a failed call. */
  failure(): void {
    this.failures++;
    this.lastFailureAt = Date.now();
    if (this.state === "half-open") {
      this.state = "open";
      this.openedAt = Date.now();
    } else if (this.failures >= this.config.failureThreshold) {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }

  /** Force-reset the circuit to closed. */
  reset(): void {
    this.state = "closed";
    this.failures = 0;
    this.successes = 0;
    this.lastFailureAt = null;
    this.openedAt = null;
  }

  /** Get current status snapshot. */
  status(): CircuitStatus {
    return {
      adapterId: this.adapterId,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailureAt: this.lastFailureAt,
      openedAt: this.openedAt,
    };
  }
}

/** Global registry of circuit breakers by adapter ID. */
const circuits = new Map<string, CircuitBreaker>();

export function getCircuit(adapterId: string, config?: Partial<CircuitConfig>): CircuitBreaker {
  let cb = circuits.get(adapterId);
  if (!cb) {
    cb = new CircuitBreaker(adapterId, config);
    circuits.set(adapterId, cb);
  }
  return cb;
}

export function allCircuits(): Record<string, CircuitStatus> {
  const result: Record<string, CircuitStatus> = {};
  for (const [id, cb] of circuits) {
    result[id] = cb.status();
  }
  return result;
}

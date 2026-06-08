/**
 * PROVIDER CHAIN — deterministic model routing with fallback.
 *
 * Tries providers in order: primary → fallback₁ → fallback₂ → ... → fail.
 * Each provider has a circuit breaker. If a provider's circuit is open,
 * it's skipped immediately (fast-fail). On success, the working provider
 * is promoted to primary for future calls.
 *
 * Usage:
 *   const chain = new ProviderChain([
 *     { id: "mimo", driver: mimoDriver },
 *     { id: "llamacpp", driver: llamacppDriver },
 *     { id: "ollama", driver: ollamaDriver },
 *   ]);
 *   const action = await chain.execute(ctx);
 */

import type { Driver, DriverAction, DriverContext } from "../driver.js";
import { CircuitBreaker, getCircuit, type CircuitConfig } from "./circuit-breaker.js";
import { withRetry, isRetryable, type RetryConfig } from "./retry.js";

export interface ProviderEntry {
  id: string;
  driver: Driver;
  circuitConfig?: Partial<CircuitConfig>;
  retryConfig?: Partial<RetryConfig>;
  /** If true, skip this provider for complex tasks (tool-heavy, long context). */
  lightweight?: boolean;
}

export interface ChainStatus {
  providers: Array<{
    id: string;
    circuit: string;
    failures: number;
    isPrimary: boolean;
  }>;
  activeProvider: string;
}

export class ProviderChain implements Driver {
  private readonly providers: ProviderEntry[];
  private primaryIndex = 0;
  private readonly circuits: Map<string, CircuitBreaker> = new Map();

  constructor(providers: ProviderEntry[]) {
    if (providers.length === 0) throw new Error("ProviderChain requires at least one provider");
    this.providers = providers;
    // Initialize circuit breakers for each provider
    for (const p of providers) {
      this.circuits.set(p.id, getCircuit(p.id, p.circuitConfig));
    }
  }

  /** Get the ID of the currently active (primary) provider. */
  get activeProvider(): string {
    return this.providers[this.primaryIndex]!.id;
  }

  /**
   * Execute a driver call with fallback chain.
   * Tries primary first, falls back through the chain on failure.
   * On success, promotes the working provider to primary.
   */
  async next(ctx: DriverContext): Promise<DriverAction> {
    const errors: Array<{ id: string; error: Error }> = [];

    // Build the try order: primary first, then remaining in order
    const tryOrder = [
      this.providers[this.primaryIndex]!,
      ...this.providers.filter((_, i) => i !== this.primaryIndex),
    ];

    for (let i = 0; i < tryOrder.length; i++) {
      const provider = tryOrder[i]!;
      const circuit = this.circuits.get(provider.id)!;

      // Fast-fail if circuit is open
      if (!circuit.allow()) {
        errors.push({ id: provider.id, error: new Error(`Circuit breaker OPEN for ${provider.id}`) });
        continue;
      }

      try {
        // Use retry with the provider's config
        const result = await withRetry(
          () => provider.driver.next(ctx),
          provider.retryConfig,
        );
        circuit.success();

        // Promote this provider to primary if it wasn't already
        const realIndex = this.providers.indexOf(provider);
        if (realIndex !== this.primaryIndex) {
          this.primaryIndex = realIndex;
        }

        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        circuit.failure();
        errors.push({ id: provider.id, error });

        // If not retryable, don't try other providers for this type of error
        if (!isRetryable(err)) {
          throw error;
        }
      }
    }

    // All providers failed
    const summary = errors.map((e) => `${e.id}: ${e.error.message}`).join("; ");
    throw new Error(`All providers failed: ${summary}`);
  }

  /** Get chain status for monitoring. */
  status(): ChainStatus {
    return {
      providers: this.providers.map((p, i) => ({
        id: p.id,
        circuit: this.circuits.get(p.id)!.status().state,
        failures: this.circuits.get(p.id)!.status().failures,
        isPrimary: i === this.primaryIndex,
      })),
      activeProvider: this.activeProvider,
    };
  }

  /** Force-reset all circuits. */
  resetAll(): void {
    for (const cb of this.circuits.values()) {
      cb.reset();
    }
    this.primaryIndex = 0;
  }
}

/**
 * Build a default provider chain from environment config.
 * Order: MiMo (direct API) → llama.cpp (local) → Ollama (local)
 */
export function buildDefaultChain(drivers: {
  mimo?: Driver;
  llamacpp?: Driver;
  ollama?: Driver;
}): ProviderChain {
  const entries: ProviderEntry[] = [];

  if (drivers.mimo) {
    entries.push({
      id: "mimo",
      driver: drivers.mimo,
      retryConfig: { maxAttempts: 3, baseMs: 3000, maxMs: 20_000 },
    });
  }
  if (drivers.llamacpp) {
    entries.push({
      id: "llamacpp",
      driver: drivers.llamacpp,
      retryConfig: { maxAttempts: 2, baseMs: 1000, maxMs: 10_000 },
    });
  }
  if (drivers.ollama) {
    entries.push({
      id: "ollama",
      driver: drivers.ollama,
      retryConfig: { maxAttempts: 2, baseMs: 1000, maxMs: 10_000 },
    });
  }

  return new ProviderChain(entries);
}

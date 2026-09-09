/**
 * TOKEN MONITOR — usage tracking and cost estimation.
 *
 * Tracks token consumption per session and estimates costs.
 * No external dependencies — pure counting from API responses.
 *
 * Usage:
 *   const monitor = new TokenMonitor({ model: "mimo-v2.5" });
 *   monitor.recordUsage({ input: 1500, output: 800, cached: 1200 });
 *   console.log(monitor.summary());
 */

export interface UsageRecord {
  inputTokens: number;
  outputTokens: number;
  /**
   * Cached prompt tokens the PROVIDER reported, or `null` when it reported none.
   *
   * `null` and `0` are different findings and must stay different: `null` says our instruments
   * are blind here, `0` says the provider measured its prompt cache and nothing hit. Folding
   * the first into the second is how a deployment convinces itself it has a measurement it has
   * never actually taken.
   */
  cachedTokens: number | null;
  timestamp: number;
  model: string;
}

export interface TokenSummary {
  model: string;
  totalInput: number;
  totalOutput: number;
  totalCached: number;
  callCount: number;
  /** How many of those calls carried a provider cache figure. `0` means the rate is unmeasured. */
  measuredCallCount: number;
  estimatedCostUsd: string;
  /** A percentage over the measured calls, or the literal `"unreported"` when none were. */
  cacheHitRate: string;
  avgInputPerCall: number;
  avgOutputPerCall: number;
}

/** Cost per 1M tokens for known models (approximate). */
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  "mimo-v2.5": { input: 0.0, output: 0.0 }, // free tier / token plan
  "mimo-v2.5-pro": { input: 0.0, output: 0.0 },
  "deepseek-v4-pro": { input: 0.27, output: 1.10 },
  "deepseek-chat": { input: 0.14, output: 0.28 },
  "gpt-4o": { input: 2.50, output: 10.00 },
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  "claude-sonnet-4": { input: 3.00, output: 15.00 },
  "claude-haiku": { input: 0.25, output: 1.25 },
  "llama-3.3-70b": { input: 0.0, output: 0.0 }, // local
  "qwen-2.5-72b": { input: 0.0, output: 0.0 },  // local
};

export interface TokenMonitorConfig {
  model: string;
  /** Override cost per 1M tokens. */
  costPerMillion?: { input: number; output: number };
}

export class TokenMonitor {
  private records: UsageRecord[] = [];
  private readonly model: string;
  private readonly cost: { input: number; output: number };

  constructor(config: TokenMonitorConfig) {
    this.model = config.model;
    this.cost = config.costPerMillion ?? MODEL_COSTS[config.model] ?? { input: 0, output: 0 };
  }

  /** Record a single API call's token usage. */
  recordUsage(usage: { input: number; output: number; cached?: number | null }): void {
    this.records.push({
      inputTokens: usage.input,
      outputTokens: usage.output,
      // An absent `cached` is recorded as `null` — unreported — never silently as zero.
      cachedTokens: usage.cached ?? null,
      timestamp: Date.now(),
      model: this.model,
    });
  }

  /** Get total input tokens. */
  get totalInput(): number {
    return this.records.reduce((sum, r) => sum + r.inputTokens, 0);
  }

  /** Get total output tokens. */
  get totalOutput(): number {
    return this.records.reduce((sum, r) => sum + r.outputTokens, 0);
  }

  /**
   * Total cached tokens across the calls that REPORTED one. Calls that reported nothing
   * contribute nothing rather than a fabricated zero.
   */
  get totalCached(): number {
    return this.records.reduce((sum, r) => sum + (r.cachedTokens ?? 0), 0);
  }

  /** Input tokens from calls whose provider actually reported a cache figure. */
  get measuredInput(): number {
    return this.records.reduce((sum, r) => sum + (r.cachedTokens === null ? 0 : r.inputTokens), 0);
  }

  /** How many calls reported a cache figure at all — the denominator of any honest claim. */
  get measuredCallCount(): number {
    return this.records.reduce((sum, r) => sum + (r.cachedTokens === null ? 0 : 1), 0);
  }

  /** Get call count. */
  get callCount(): number {
    return this.records.length;
  }

  /** Estimate cost in USD. */
  estimateCost(): number {
    // Cached tokens are typically free or discounted — subtract from input
    const effectiveInput = Math.max(0, this.totalInput - this.totalCached);
    const inputCost = (effectiveInput / 1_000_000) * this.cost.input;
    const outputCost = (this.totalOutput / 1_000_000) * this.cost.output;
    return inputCost + outputCost;
  }

  /**
   * Cache hit rate over the MEASURED calls, or `null` when nothing was measured.
   *
   * The denominator is measured input, not all input: dividing by calls whose provider never
   * reported a cache figure would silently dilute a real rate toward zero and read as "the
   * cache is not working" when the truth is "we did not look".
   */
  cacheHitRate(): number | null {
    const measured = this.measuredInput;
    if (measured === 0) return null;
    return this.totalCached / measured;
  }

  /** Get a human-readable summary. */
  summary(): TokenSummary {
    const callCount = this.callCount || 1; // avoid div by zero
    const rate = this.cacheHitRate();
    return {
      model: this.model,
      totalInput: this.totalInput,
      totalOutput: this.totalOutput,
      totalCached: this.totalCached,
      callCount: this.callCount,
      measuredCallCount: this.measuredCallCount,
      estimatedCostUsd: `$${this.estimateCost().toFixed(4)}`,
      // "unreported" is a legible answer; "0.0%" would be a claim we cannot support.
      cacheHitRate: rate === null ? "unreported" : `${(rate * 100).toFixed(1)}%`,
      avgInputPerCall: Math.round(this.totalInput / callCount),
      avgOutputPerCall: Math.round(this.totalOutput / callCount),
    };
  }

  /** Reset all records. */
  reset(): void {
    this.records = [];
  }

  /** Get raw records for export. */
  getRecords(): readonly UsageRecord[] {
    return [...this.records];
  }
}

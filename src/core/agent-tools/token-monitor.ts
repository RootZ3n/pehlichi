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
  cachedTokens: number;
  timestamp: number;
  model: string;
}

export interface TokenSummary {
  model: string;
  totalInput: number;
  totalOutput: number;
  totalCached: number;
  callCount: number;
  estimatedCostUsd: string;
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
  recordUsage(usage: { input: number; output: number; cached?: number }): void {
    this.records.push({
      inputTokens: usage.input,
      outputTokens: usage.output,
      cachedTokens: usage.cached ?? 0,
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

  /** Get total cached tokens. */
  get totalCached(): number {
    return this.records.reduce((sum, r) => sum + r.cachedTokens, 0);
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

  /** Get cache hit rate as a fraction. */
  cacheHitRate(): number {
    if (this.totalInput === 0) return 0;
    return this.totalCached / this.totalInput;
  }

  /** Get a human-readable summary. */
  summary(): TokenSummary {
    const callCount = this.callCount || 1; // avoid div by zero
    return {
      model: this.model,
      totalInput: this.totalInput,
      totalOutput: this.totalOutput,
      totalCached: this.totalCached,
      callCount: this.callCount,
      estimatedCostUsd: `$${this.estimateCost().toFixed(4)}`,
      cacheHitRate: `${(this.cacheHitRate() * 100).toFixed(1)}%`,
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

/**
 * RECEIPT STORE — lightweight in-memory receipt log with TTL auto-cleanup.
 *
 * Every /chat turn produces a receipt. Receipts are noisy but necessary for
 * audit. They auto-expire after a configurable TTL (default 1 hour) so they
 * don't fill up memory on long-running processes.
 *
 * Shared across Pehlichi, Ptah, Luna — identical file in each repo.
 */

export interface Receipt {
  readonly id: string;
  readonly agent: string;
  readonly timestamp: number;
  readonly taskId?: string;
  readonly workspaceId?: string;
  readonly roomKey?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly cost?: number;
  readonly status: 'success' | 'partial' | 'failed' | 'injection_blocked' | 'error';
  readonly toolCallCount: number;
  readonly contentSummary?: string;
  readonly injectionDetected?: boolean;
  readonly partial?: boolean;
  readonly durationMs?: number;
  /** Receipt ID alias for Kokuli/Ittunaha compatibility. */
  readonly receipt_id?: string;
}

export interface ReceiptStoreOptions {
  /** How long receipts live before auto-expiry. Default 1 hour. */
  readonly ttlMs?: number;
  /** How often the cleanup sweep runs. Default 5 minutes. */
  readonly cleanupIntervalMs?: number;
  /** Injectable clock (ms). Default Date.now. */
  readonly clock?: () => number;
}

export class ReceiptStore {
  private readonly receipts: Map<string, Receipt> = new Map();
  private readonly ttlMs: number;
  private readonly clock: () => number;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private idCounter = 0;

  constructor(opts: ReceiptStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 60 * 60 * 1000; // 1 hour default
    this.clock = opts.clock ?? Date.now;
    const intervalMs = opts.cleanupIntervalMs ?? 5 * 60 * 1000; // 5 min default
    this.cleanupTimer = setInterval(() => this.sweep(), intervalMs);
    this.cleanupTimer.unref(); // Don't keep process alive
  }

  /** Record a new receipt. */
  record(data: Omit<Receipt, 'id' | 'timestamp'>): Receipt {
    const receipt: Receipt = {
      ...data,
      id: `r-${this.clock()}-${(++this.idCounter).toString(36)}`,
      timestamp: this.clock(),
      receipt_id: `r-${this.clock()}-${this.idCounter.toString(36)}`,
    };
    this.receipts.set(receipt.id, receipt);
    return receipt;
  }

  /** Get the most recent N receipts (newest first). */
  recent(limit = 20): Receipt[] {
    const all = [...this.receipts.values()].sort((a, b) => b.timestamp - a.timestamp);
    return all.slice(0, limit);
  }

  /** Get receipts for a specific task. */
  byTask(taskId: string): Receipt[] {
    return [...this.receipts.values()].filter((r) => r.taskId === taskId);
  }

  /** Get receipts for a specific workspace. */
  byWorkspace(workspaceId: string): Receipt[] {
    return [...this.receipts.values()].filter((r) => r.workspaceId === workspaceId);
  }

  /** Get failed/blocked receipts only. */
  failures(): Receipt[] {
    return [...this.receipts.values()].filter(
      (r) => r.status === 'failed' || r.status === 'error' || r.status === 'injection_blocked'
    );
  }

  /** Get a specific receipt by id. */
  get(id: string): Receipt | undefined {
    return this.receipts.get(id);
  }

  /** Total count of live receipts. */
  get size(): number {
    return this.receipts.size;
  }

  /** Summary stats for /health. */
  summary(): { total: number; failures: number; oldestMs: number | null } {
    const all = [...this.receipts.values()];
    if (all.length === 0) return { total: 0, failures: 0, oldestMs: null };
    const failures = all.filter((r) => r.status !== 'success').length;
    const oldest = Math.min(...all.map((r) => r.timestamp));
    return { total: all.length, failures, oldestMs: this.clock() - oldest };
  }

  /** Remove expired receipts. Called automatically on the cleanup interval. */
  private sweep(): void {
    const cutoff = this.clock() - this.ttlMs;
    let swept = 0;
    for (const [id, receipt] of this.receipts) {
      if (receipt.timestamp < cutoff) {
        this.receipts.delete(id);
        swept++;
      }
    }
    if (swept > 0) {
      console.log(`[receipts] swept ${swept} expired receipt(s); ${this.receipts.size} remaining`);
    }
  }

  /** Stop the cleanup timer (for tests). */
  destroy(): void {
    clearInterval(this.cleanupTimer);
  }
}

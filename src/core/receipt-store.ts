/**
 * RECEIPT STORE — a durable receipt journal with an in-memory cache over it.
 *
 * Every /chat turn produces a receipt, and callers hand those receipt IDs onward as the record of
 * what a run did. That contract was previously unkeepable: the store was a Map with a one-hour TTL,
 * `loop.ts` built a fresh one per run and the server built another, so an ID could be returned to a
 * caller and then be unretrievable after the TTL, after the run, or after a restart. `/health`
 * reported zero receipts against a non-empty conversation history for exactly that reason.
 *
 * DURABILITY. When a journal path is configured, `record()` appends one JSON line and only then
 * returns. An ID a caller holds therefore always corresponds to a line already on disk, including
 * when the process is killed immediately afterwards. The Map is a CACHE over that journal, not the
 * record itself: the TTL sweep evicts from the cache and never from the journal, and a read that
 * misses the cache falls back to the journal.
 *
 * FORMAT. Append-only JSONL, one receipt per line, the same single-writer discipline
 * `lab-transcript.ts` already uses. This is deliberately not a second logging subsystem.
 *
 * TORN TAILS. A process killed mid-write can leave a partial final line. `readJournal` skips lines
 * that do not parse rather than throwing, because losing the interrupted record is acceptable and
 * losing every record before it is not.
 *
 * NOT A SECRET STORE. A receipt carries the VERIFIED principal id and a content summary. It never
 * carries an assertion, a token or a key, and making the journal durable does not change that.
 *
 * Shared across the trio (Peh, Ptah, Luna) — identical file in each repo.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateFindingMetadata, type PublicFindingMetadata } from './agent-tools/restricted-evidence.js';

export interface Receipt {
  readonly id: string;
  readonly agent: string;
  readonly timestamp: number;
  readonly taskId?: string;
  readonly workspaceId?: string;
  readonly roomKey?: string;
  /**
   * The VERIFIED principal this turn was authorised as.
   *
   * Written from the authorization decision, never from what the client presented, and it is what
   * scopes a later read: a receipt with no principal is visible only to an operator. Never the
   * assertion itself, which would make the audit log a place to steal credentials from.
   */
  readonly principalId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly cost?: number;
  readonly status: 'success' | 'partial' | 'failed' | 'injection_blocked' | 'injection_quarantined' | 'error';
  readonly toolCallCount: number;
  readonly contentSummary?: string;
  readonly injectionDetected?: boolean;
  readonly injectionFindings?: number;
  readonly findingMetadata?: readonly PublicFindingMetadata[];
  readonly partial?: boolean;
  readonly durationMs?: number;
  /**
   * What the PROVIDER reported this turn cost, in tokens.
   *
   * Durable because it was not durable anywhere: the driver parsed a cache figure on every
   * call and it lived only in an in-memory monitor, so after a restart no evidence survived
   * that any prompt-cache reuse had ever happened. A claim about caching that cannot be
   * checked after a restart is not a measurement.
   *
   * ADDITIVE AND OPTIONAL. Older receipts have no `usage`, and absence keeps meaning
   * "not recorded" — never zero.
   */
  readonly usage?: ReceiptUsage;
  /**
   * Identity of the request's stable prefix, as a HASH.
   *
   * This exists to answer one question — "did the part of the request that should not have
   * changed actually stay the same?" — without keeping the bytes that would answer it by
   * being readable. The prompt itself is never stored here.
   */
  readonly prefix?: ReceiptPrefixIdentity;
  /** Receipt ID alias for Kokuli/Ittunaha compatibility. */
  readonly receipt_id?: string;
}

/** Provider-reported token usage for one model turn. */
export interface ReceiptUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * Cached prompt tokens the provider reported, or `null` when it reported none.
   *
   * The distinction is the whole point of persisting this: `null` is "we could not see",
   * `0` is "the provider looked and nothing hit". Collapsing them would make a blind
   * deployment indistinguishable from one with a cold cache.
   */
  readonly cachedTokens: number | null;
  readonly totalTokens: number;
}

/**
 * A versioned hash of the request prefix that is supposed to be stable across a session.
 *
 * NO PROMPT BYTES. The hash is one-way and the algorithm is named so a later reader knows what
 * was hashed and can recompute it from the same inputs; nothing here can be read back into the
 * prompt, so turning this on cannot leak system-prompt or skill content into the audit log.
 *
 * The version exists because the DEFINITION of "the stable prefix" may change. Comparing two
 * hashes computed under different definitions would be meaningless, so a reader must be able to
 * see that they are not comparable rather than conclude the prefix changed.
 */
export interface ReceiptPrefixIdentity {
  /** Hash algorithm and scheme version, e.g. `sha256/1`. */
  readonly scheme: string;
  /** Hex digest of the stable prefix under that scheme. */
  readonly digest: string;
}

/** The closed set of terminal statuses a stored receipt may claim. */
const RECEIPT_STATUSES: ReadonlySet<string> = new Set([
  'success', 'partial', 'failed', 'injection_blocked', 'injection_quarantined', 'error',
]);

export interface ReceiptStoreOptions {
  /** How long receipts live before auto-expiry. Default 1 hour. */
  readonly ttlMs?: number;
  /** How often the cleanup sweep runs. Default 5 minutes. */
  readonly cleanupIntervalMs?: number;
  /** Injectable clock (ms). Default Date.now. */
  readonly clock?: () => number;
  /**
   * Append-only JSONL journal. When set, every recorded receipt is on disk before `record()`
   * returns, and reads fall back to it on a cache miss. When unset the store is cache-only and
   * `durable` is false, which is what a caller must check before treating an ID as retrievable.
   */
  readonly journalPath?: string;
}

/** Does a parsed journal line carry the fields a receipt is defined by? */
function isReceiptRecord(value: unknown): value is Receipt {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r['id'] === 'string' && r['id'].length > 0
    && typeof r['agent'] === 'string'
    && typeof r['timestamp'] === 'number' && Number.isFinite(r['timestamp'])
    && typeof r['toolCallCount'] === 'number'
    && RECEIPT_STATUSES.has(r['status'] as string);
}

export class ReceiptStore {
  private readonly receipts: Map<string, Receipt> = new Map();
  private readonly ttlMs: number;
  private readonly clock: () => number;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private idCounter = 0;
  private readonly journalPath: string | undefined;

  constructor(opts: ReceiptStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 60 * 60 * 1000; // 1 hour default
    this.clock = opts.clock ?? Date.now;
    const intervalMs = opts.cleanupIntervalMs ?? 5 * 60 * 1000; // 5 min default
    this.cleanupTimer = setInterval(() => this.sweep(), intervalMs);
    this.cleanupTimer.unref(); // Don't keep process alive
    this.journalPath = opts.journalPath;
    if (this.journalPath !== undefined) mkdirSync(dirname(this.journalPath), { recursive: true });
  }

  /** Whether a receipt ID handed to a caller survives TTL, run end and restart. */
  get durable(): boolean {
    return this.journalPath !== undefined;
  }

  /** Record a new receipt. */
  record(data: Omit<Receipt, 'id' | 'timestamp'>): Receipt {
    const findingMetadata = data.findingMetadata?.map(validateFindingMetadata) ?? [];
    const findingCount = data.injectionFindings ?? 0;
    if (!Number.isSafeInteger(findingCount) || findingCount < 0 || findingCount !== findingMetadata.length) {
      throw new Error('receipt finding count does not match validated finding metadata');
    }
    if (findingCount > 0 && data.injectionDetected !== true) throw new Error('receipt finding metadata requires injectionDetected');
    if (data.injectionDetected !== true && findingCount !== 0) throw new Error('receipt injectionDetected contradicts finding metadata');
    if (findingCount > 0 && data.status !== 'injection_blocked' && data.status !== 'injection_quarantined') {
      throw new Error('receipt with a security finding cannot claim a clean terminal status');
    }
    if (findingCount > 0 && data.status === 'injection_blocked') {
      throw new Error('input-blocked status cannot carry tool-output finding metadata');
    }
    if (findingCount === 0 && data.status === 'injection_quarantined') throw new Error('receipt quarantine status requires validated finding metadata');
    if (data.injectionDetected === true && findingCount === 0 && data.status !== 'injection_blocked') {
      throw new Error('receipt metadata-free input detection must be injection_blocked');
    }
    const receipt: Receipt = {
      ...data,
      ...(data.findingMetadata !== undefined ? { findingMetadata: Object.freeze(findingMetadata) } : {}),
      id: `r-${this.clock()}-${(++this.idCounter).toString(36)}`,
      timestamp: this.clock(),
      receipt_id: `r-${this.clock()}-${this.idCounter.toString(36)}`,
    };
    // ON DISK BEFORE THE CALLER HOLDS THE ID. A crash between these two statements loses nothing
    // a caller could later be asked to retrieve, which is the property the previous store lacked.
    if (this.journalPath !== undefined) {
      appendFileSync(this.journalPath, `${JSON.stringify(receipt)}\n`);
    }
    this.receipts.set(receipt.id, receipt);
    return receipt;
  }

  /**
   * Read a receipt journal from disk, skipping any torn final line.
   *
   * Static so recovery does not require constructing a store, and so an operator or a later run
   * can read the record of a process that is gone.
   */
  static readJournal(path: string): Receipt[] {
    let raw: string;
    try { raw = readFileSync(path, 'utf8'); } catch { return []; }
    const out: Receipt[] = [];
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }  // torn tail: keep everything before it
      // A journal line is a file on disk, and these records are projected into audit answers. A
      // record that does not carry the fields a receipt is defined by is discarded rather than
      // trusted into that projection, so the declared `validated-runtime-state` is true of it.
      if (isReceiptRecord(parsed)) out.push(parsed);
    }
    return out;
  }

  /** Every receipt this store can still account for: the journal when durable, else the cache. */
  private all(): Receipt[] {
    if (this.journalPath === undefined) return [...this.receipts.values()];
    const journal = ReceiptStore.readJournal(this.journalPath);
    const seen = new Set(journal.map((r) => r.id));
    // A cached receipt absent from the journal cannot occur while durable, but preferring the
    // union keeps a read correct rather than merely consistent if it ever does.
    return [...journal, ...[...this.receipts.values()].filter((r) => !seen.has(r.id))];
  }

  /** Get the most recent N receipts (newest first). */
  recent(limit = 20): Receipt[] {
    return this.all().sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }

  /** Get receipts for a specific task. */
  byTask(taskId: string): Receipt[] {
    return this.all().filter((r) => r.taskId === taskId);
  }

  /** Get receipts for a specific workspace. */
  byWorkspace(workspaceId: string): Receipt[] {
    return this.all().filter((r) => r.workspaceId === workspaceId);
  }

  /** Get failed/blocked receipts only. */
  failures(): Receipt[] {
    return this.all().filter(
      (r) => r.status === 'failed' || r.status === 'error' || r.status === 'injection_blocked' || r.status === 'injection_quarantined'
    );
  }

  /** Get a specific receipt by id. */
  get(id: string): Receipt | undefined {
    const cached = this.receipts.get(id);
    if (cached !== undefined) return cached;
    // A cache miss is not an absence: the TTL sweep evicts, the journal does not.
    if (this.journalPath === undefined) return undefined;
    return ReceiptStore.readJournal(this.journalPath).find((r) => r.id === id);
  }

  /** Total count of live receipts. */
  get size(): number {
    return this.all().length;
  }

  /** Summary stats for /health. */
  summary(): { total: number; failures: number; oldestMs: number | null } {
    const all = this.all();
    if (all.length === 0) return { total: 0, failures: 0, oldestMs: null };
    const failures = all.filter((r) => r.status !== 'success').length;
    const oldest = Math.min(...all.map((r) => r.timestamp));
    return { total: all.length, failures, oldestMs: this.clock() - oldest };
  }

  /**
   * Evict expired receipts FROM THE CACHE. Called automatically on the cleanup interval.
   *
   * The journal is never swept. Expiry is a memory bound, not a retention policy, and conflating
   * the two is what made receipt IDs unretrievable.
   */
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
      // Operational log → structured record on stderr. stdout is reserved for
      // protocol/user output; background sweeps must never pollute it.
      process.stderr.write(
        `${JSON.stringify({ level: 'info', component: 'receipts', msg: 'evicted expired receipts from cache', swept, remaining: this.receipts.size })}\n`,
      );
    }
  }

  /** Stop the cleanup timer (for tests). */
  destroy(): void {
    clearInterval(this.cleanupTimer);
  }
}

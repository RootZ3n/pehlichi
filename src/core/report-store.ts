/**
 * REPORT STORE — a persistent ledger of multi-model comparison reports.
 *
 * Ptah runs multi-model comparison reports (latency / tokens / quality per model).
 * Historically these were written ad-hoc into work-order attachments, so historical
 * model performance was NOT queryable — which undermined occasio's own
 * `provider-degradation` detector ("mimo-v2.5 latency increased 40% this week").
 *
 * This store writes each comparison as one structured JSONL record and exposes a
 * trend query so one-off reports become a model-performance ledger that feeds
 * reliability detection. Records carry an optional `role` (e.g. "validation-model")
 * so a report can be resolved through Miko Nous role assignment when querying.
 */
import { appendFile, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface ModelResult {
  readonly model: string;
  readonly latencyMs: number;
  readonly tokens: number;
  readonly success: boolean;
  /** 0..1 quality score (model-judged or rubric-based). Optional. */
  readonly qualityScore?: number;
}

export interface ReportRecord {
  readonly id: string;
  readonly timestamp: number;
  /** The task/benchmark this comparison ran. */
  readonly taskId: string;
  /** Optional Nous role this comparison was run under (e.g. "validation-model"). */
  readonly role?: string;
  readonly results: readonly ModelResult[];
  /** Optional human/winner summary. */
  readonly summary?: string;
}

export type ReportInput = Omit<ReportRecord, "id" | "timestamp">;

/** Per-model aggregate over the queried window, with a per-day trend series. */
export interface ModelTrend {
  readonly model: string;
  readonly count: number;
  readonly avgLatencyMs: number;
  readonly avgTokens: number;
  readonly successRate: number;
  readonly avgQuality: number | null;
  /** Per-day buckets (UTC date) so a caller can plot latency/quality over time. */
  readonly series: ReadonlyArray<{
    readonly day: string;
    readonly count: number;
    readonly avgLatencyMs: number;
    readonly avgQuality: number | null;
  }>;
}

export interface TrendsQuery {
  /** Restrict to reports run under this Nous role. */
  readonly role?: string;
  /** Restrict to reports for this exact model. */
  readonly model?: string;
  /** Only include reports from the last N days. Default 30. */
  readonly days?: number;
}

export interface TrendsResult {
  readonly windowDays: number;
  readonly role: string | null;
  readonly reportCount: number;
  readonly models: readonly ModelTrend[];
}

const DEFAULT_PATH = process.env.MODEL_REPORTS_PATH ?? "/pehverse/state/ptah/model-reports.jsonl";

export interface ReportStoreOptions {
  /** JSONL file the reports are appended to. Defaults to $MODEL_REPORTS_PATH or the lab path. */
  readonly path?: string;
  /** Injectable clock (ms). Tests pass a fixed clock for deterministic timestamps. */
  readonly clock?: () => number;
}

export class ReportStore {
  private readonly path: string;
  private readonly clock: () => number;
  private idCounter = 0;

  constructor(opts: ReportStoreOptions = {}) {
    this.path = opts.path ?? DEFAULT_PATH;
    this.clock = opts.clock ?? Date.now;
  }

  get filePath(): string {
    return this.path;
  }

  /** Append one comparison report as a JSONL record. */
  async record(input: ReportInput): Promise<ReportRecord> {
    const ts = this.clock();
    const rec: ReportRecord = {
      id: `mr-${ts}-${(++this.idCounter).toString(36)}`,
      timestamp: ts,
      taskId: input.taskId,
      ...(input.role !== undefined ? { role: input.role } : {}),
      results: input.results,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
    };
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(rec) + "\n", "utf-8");
    return rec;
  }

  /** Read all records (newest first). Missing file ⇒ empty list. */
  async all(): Promise<ReportRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf-8");
    } catch {
      return [];
    }
    const records: ReportRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as ReportRecord);
      } catch {
        /* skip malformed line */
      }
    }
    return records.sort((a, b) => b.timestamp - a.timestamp);
  }

  async recent(limit = 20): Promise<ReportRecord[]> {
    return (await this.all()).slice(0, limit);
  }

  /** Aggregate a per-model trend series over the query window. */
  async trends(query: TrendsQuery = {}): Promise<TrendsResult> {
    const windowDays = query.days && query.days > 0 ? query.days : 30;
    const cutoff = this.clock() - windowDays * 24 * 60 * 60 * 1000;
    const all = await this.all();

    // One accumulator per model.
    interface Acc {
      count: number;
      latency: number;
      tokens: number;
      successes: number;
      quality: number;
      qualityCount: number;
      days: Map<string, { count: number; latency: number; quality: number; qualityCount: number }>;
    }
    const byModel = new Map<string, Acc>();
    let reportCount = 0;

    for (const rep of all) {
      if (rep.timestamp < cutoff) continue;
      if (query.role !== undefined && rep.role !== query.role) continue;
      reportCount++;
      const day = new Date(rep.timestamp).toISOString().slice(0, 10);
      for (const r of rep.results) {
        if (query.model !== undefined && r.model !== query.model) continue;
        let acc = byModel.get(r.model);
        if (acc === undefined) {
          acc = { count: 0, latency: 0, tokens: 0, successes: 0, quality: 0, qualityCount: 0, days: new Map() };
          byModel.set(r.model, acc);
        }
        acc.count++;
        acc.latency += r.latencyMs;
        acc.tokens += r.tokens;
        if (r.success) acc.successes++;
        if (typeof r.qualityScore === "number") { acc.quality += r.qualityScore; acc.qualityCount++; }
        let bucket = acc.days.get(day);
        if (bucket === undefined) { bucket = { count: 0, latency: 0, quality: 0, qualityCount: 0 }; acc.days.set(day, bucket); }
        bucket.count++;
        bucket.latency += r.latencyMs;
        if (typeof r.qualityScore === "number") { bucket.quality += r.qualityScore; bucket.qualityCount++; }
      }
    }

    const models: ModelTrend[] = [...byModel.entries()].map(([model, a]) => ({
      model,
      count: a.count,
      avgLatencyMs: a.count ? Math.round(a.latency / a.count) : 0,
      avgTokens: a.count ? Math.round(a.tokens / a.count) : 0,
      successRate: a.count ? Math.round((a.successes / a.count) * 1000) / 1000 : 0,
      avgQuality: a.qualityCount ? Math.round((a.quality / a.qualityCount) * 1000) / 1000 : null,
      series: [...a.days.entries()]
        .sort(([d1], [d2]) => d1.localeCompare(d2))
        .map(([day, b]) => ({
          day,
          count: b.count,
          avgLatencyMs: b.count ? Math.round(b.latency / b.count) : 0,
          avgQuality: b.qualityCount ? Math.round((b.quality / b.qualityCount) * 1000) / 1000 : null,
        })),
    })).sort((a, b) => a.model.localeCompare(b.model));

    return { windowDays, role: query.role ?? null, reportCount, models };
  }
}

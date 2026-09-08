/**
 * THE DURABLE DELEGATION JOURNAL.
 *
 * SAME MECHANISM, DIFFERENT SHAPE. This is not a second database. It uses the receipt journal's
 * discipline — an append-only JSONL file under `LAB_RECEIPT_ROOT`, written and fsync-ordered
 * BEFORE the call returns — and lives beside the turn receipts as a sibling file, the way
 * lane receipts already do. A delegation is not a turn: it has a route, an authority, a foreign
 * run id and a supervisor verdict, and flattening that into a turn receipt's `contentSummary`
 * would make the audit unreadable exactly when it matters.
 *
 * WHY IT IS ON DISK. A restart must not turn interrupted work into success, and must not lose
 * completed work either. Anything held only in memory answers "what happened?" with "nothing",
 * which is the one answer that is never true.
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Route, RouteReason } from './route.js';
import type { SupervisorVerdict, EvidenceRejection, LocalAdvisoryFact } from './supervisor.js';

export interface DelegationRecord {
  readonly schema: 'pehverse-trio-delegation/1';
  readonly delegationId: string;
  readonly timestamp: number;
  /** The conversation/request this came from, and who asked. */
  readonly parentRequestId: string;
  readonly principalId: string;
  readonly agent: string;
  /** What the operator asked for, as stated. */
  readonly goal: string;
  readonly route: Route;
  readonly routeReason: RouteReason;
  readonly routeExplanation: string;
  /** The authority actually issued. Absent for DIRECT and REFUSE_OR_CLARIFY. */
  readonly repository?: string;
  readonly startingCommit?: string;
  readonly allowedPaths?: readonly string[];
  readonly checks?: readonly string[];
  readonly localMode?: string;
  readonly profile?: string;
  readonly attemptId?: string;
  /** What came back. */
  readonly runId?: string;
  readonly goalSha256?: string;
  readonly verdict?: SupervisorVerdict;
  readonly rejection?: EvidenceRejection;
  readonly verdictExplanation?: string;
  readonly resultingCommit?: string;
  readonly changedPaths?: readonly string[];
  readonly localAdvisories?: readonly LocalAdvisoryFact[];
  readonly bokahliInvoked?: boolean;
  readonly humanReviewRequired?: boolean;
  /** Where the raw evidence lives, so a reader can check rather than believe this record. */
  readonly evidence?: { readonly sessionJsonPath?: string; readonly receiptsNdjsonPath?: string };
  /** The one sentence an operator sees. */
  readonly operatorState: string;
}

export class DelegationJournal {
  constructor(private readonly journalPath: string | undefined) {
    if (journalPath !== undefined) mkdirSync(dirname(journalPath), { recursive: true });
  }

  /** True when this journal can actually answer a later question. */
  get durable(): boolean { return this.journalPath !== undefined; }

  /** Append one record. It is on disk before this returns, or it throws. */
  record(rec: DelegationRecord): DelegationRecord {
    if (this.journalPath === undefined) return rec;
    appendFileSync(this.journalPath, `${JSON.stringify(rec)}\n`, { encoding: 'utf8', flush: true });
    return rec;
  }

  /**
   * Every record on disk. A torn final line loses only itself: a crash mid-append must not make
   * the whole history unreadable, which is what a single JSON.parse of the file would do.
   */
  all(): DelegationRecord[] {
    if (this.journalPath === undefined || !existsSync(this.journalPath)) return [];
    const out: DelegationRecord[] = [];
    for (const line of readFileSync(this.journalPath, 'utf8').split('\n')) {
      const t = line.trim();
      if (t.length === 0) continue;
      try {
        const v = JSON.parse(t) as DelegationRecord;
        if (v.schema === 'pehverse-trio-delegation/1' && typeof v.delegationId === 'string') out.push(v);
      } catch { /* a torn or foreign line is skipped, never trusted */ }
    }
    return out;
  }

  find(delegationId: string): DelegationRecord | undefined {
    return this.all().find((r) => r.delegationId === delegationId);
  }
}

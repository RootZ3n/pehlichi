/**
 * Universal Ikbi adapter.
 *
 * This is a capability ADAPTER, not a reimplementation: Ikbi is an external
 * mechanic and is never modified from here. What this file owns is the
 * governance around the call — correlation, scope, and the ledger record.
 *
 * The central rule: no correlation means no invocation. An Ikbi run that
 * cannot name the project, ticket, work order, service attempt, invoking agent
 * and authority is not evidence of anything, so it is refused before it starts.
 */

export interface Correlation {
  projectId: string;
  ticketId?: string | null;
  workOrderId: string;
  serviceAttemptId: string;
  invokingAgent: string;
  authorityRef: string;
}

export type IkbiOperation = "recon" | "audit" | "build" | "fix" | "status" | "receipts";

export interface IkbiRequest {
  operation: IkbiOperation;
  /** Repository and paths the work order authorized. */
  scope: { repository: string; paths: string[] };
  instructions?: string;
}

export interface IkbiReceipt {
  receiptRef: string;
  receiptDigest: string;
  commitSha?: string | null;
  treeSha?: string | null;
  changedPaths: string[];
  tests: string[];
  rollbackRef?: string | null;
}

export type FailureDomain = "TOOL" | "SCOPE" | "TARGET" | "AUTHORITY" | "HARNESS" | "UNKNOWN";

export interface IkbiResult {
  result: "OK" | "FAILED" | "UNAVAILABLE" | "UNKNOWN";
  failureDomain?: FailureDomain | null;
  receipt?: IkbiReceipt | null;
  detail?: string;
}

/** What the adapter needs from its host. Injected so tests need no network. */
export interface IkbiPort {
  invoke(req: IkbiRequest, corr: Correlation): Promise<IkbiResult>;
}

export interface LedgerSink {
  recordMechanicRun(run: Record<string, unknown>): Promise<unknown> | unknown;
}

const REQUIRED: (keyof Correlation)[] =
  ["projectId", "workOrderId", "serviceAttemptId", "invokingAgent", "authorityRef"];

export function assertCorrelated(corr: Partial<Correlation>): asserts corr is Correlation {
  const missing = REQUIRED.filter((k) => !String(corr[k] ?? "").trim());
  if (missing.length) {
    throw Object.assign(
      new Error(`Ikbi invocation refused: missing correlation ${missing.join(", ")}. ` +
                `An uncorrelated mechanic run is not evidence of anything.`),
      { code: "UNCORRELATED_INVOCATION", missing });
  }
}

/** Scope may be narrowed by the worker, never widened. */
export function assertScope(authorized: string[], requested: string[]): void {
  const outside = requested.filter(
    (p) => !authorized.some((a) => p === a || p.startsWith(a.replace(/\/*$/, "/"))));
  if (outside.length) {
    throw Object.assign(
      new Error(`Ikbi invocation refused: paths outside authorized scope: ${outside.join(", ")}`),
      { code: "SCOPE_EXPANSION_REFUSED", outside });
  }
}

export class IkbiCapability {
  port: IkbiPort;
  ledger: LedgerSink;
  constructor(port: IkbiPort, ledger: LedgerSink) { this.port = port; this.ledger = ledger; }

  async run(req: IkbiRequest, corr: Partial<Correlation>, authorizedPaths: string[]) {
    assertCorrelated(corr);
    assertScope(authorizedPaths, req.scope.paths);

    let out: IkbiResult;
    try {
      out = await this.port.invoke(req, corr);
    } catch (e: any) {
      // A mechanic that throws is still a run that happened, and it is recorded
      // as an honest failure rather than quietly dropped.
      out = { result: "FAILED", failureDomain: "TOOL", detail: String(e?.message ?? e) };
    }

    await this.ledger.recordMechanicRun({
      workOrderId: corr.workOrderId, serviceAttemptId: corr.serviceAttemptId,
      ticketId: corr.ticketId ?? null,
      invokingAgent: corr.invokingAgent, authorityRef: corr.authorityRef,
      mechanic: "IKBI", operation: req.operation,
      scope: `${req.scope.repository}:${req.scope.paths.join(",")}`,
      result: out.result, failureDomain: out.failureDomain ?? null,
      changedPaths: out.receipt?.changedPaths ?? [],
      commitSha: out.receipt?.commitSha ?? null, treeSha: out.receipt?.treeSha ?? null,
      tests: out.receipt?.tests ?? [],
      receiptRef: out.receipt?.receiptRef ?? null,
      receiptDigest: out.receipt?.receiptDigest ?? null,
      rollbackRef: out.receipt?.rollbackRef ?? null,
    });
    return out;
  }
}

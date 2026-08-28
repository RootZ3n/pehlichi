/**
 * Universal Bokahli adapter.
 *
 * There is no mandatory default route. An agent is not a model: the route is
 * chosen per task and bounded by the work order's route authority, which may
 * permit local, cloud, or both.
 *
 * The honesty rules are the point of this file: requested and served models are
 * separate facts, every run records WHY its route was chosen, an unobservable
 * served model is UNKNOWN rather than OK, and a substitution is only acceptable
 * when the fallback was authorized and its reason recorded.
 */

import type { Correlation, LedgerSink } from "../../ikbi/v1/adapter.ts";

export interface RouteAuthority {
  /** Routes this work order permits. "local" is the default everywhere. */
  allowedRoutes: string[];
}

export interface BokahliRequest {
  route: string;
  prompt: string;
  purpose: string;
  /** Why this route, against SELECTION_FACTORS. Required: no reason means a hidden default. */
  selectionReason: string;
  routeClass: "LOCAL" | "CLOUD";
  qualificationRef?: string | null;
}

export interface BokahliResult {
  result: "OK" | "FAILED" | "UNAVAILABLE" | "UNKNOWN";
  modelRequested: string;
  /** Null when the provider does not report it. That is UNKNOWN, not success. */
  modelServed?: string | null;
  provider?: string | null;
  runtime?: string | null;
  host?: string | null;
  receiptRef?: string | null;
  receiptDigest?: string | null;
  detail?: string;
}

export interface BokahliPort {
  reason(req: BokahliRequest, corr: Correlation): Promise<BokahliResult>;
}

/**
 * Deliberately absent: there is no DEFAULT_ROUTE. Selection is a judgement made
 * per task against the factors below, and a constant here would quietly become
 * the policy.
 */
export const SELECTION_FACTORS = [
  "demonstrated_qualification", "task_type", "risk", "context_requirements",
  "tool_use_reliability", "structured_output_reliability", "evidence_quality",
  "availability", "latency", "cost", "operator_policy",
] as const;

export function assertRouteAuthorized(route: string, authority: RouteAuthority): void {
  if (!authority.allowedRoutes.includes(route)) {
    throw Object.assign(
      new Error(`Bokahli route '${route}' is not authorized by this work order. ` +
                `Permitted: ${authority.allowedRoutes.join(", ") || "(none)"}.`),
      { code: "ROUTE_NOT_AUTHORIZED" });
  }
}

export function assertSelectionExplained(req: BokahliRequest): void {
  if (!String(req.selectionReason ?? "").trim()) {
    throw Object.assign(
      new Error("a Bokahli run must record why this route was chosen; " +
                `selection weighs ${SELECTION_FACTORS.join(", ")}`),
      { code: "SELECTION_REASON_REQUIRED" });
  }
}

export class BokahliCapability {
  port: BokahliPort;
  ledger: LedgerSink;
  constructor(port: BokahliPort, ledger: LedgerSink) { this.port = port; this.ledger = ledger; }

  async reason(req: BokahliRequest, corr: Correlation, authority: RouteAuthority) {
    assertRouteAuthorized(req.route, authority);
    assertSelectionExplained(req);

    let out: BokahliResult;
    try {
      out = await this.port.reason(req, corr);
    } catch (e: any) {
      out = { result: "UNAVAILABLE", modelRequested: req.route,
              detail: String(e?.message ?? e) };
    }

    // Honesty normalisation, applied before anything downstream can read it.
    if (out.result === "OK" && !out.modelServed) {
      out = { ...out, result: "UNKNOWN",
              detail: (out.detail ? out.detail + "; " : "") +
                      "served model not observable, so the outcome is UNKNOWN rather than OK" };
    }

    await this.ledger.recordMechanicRun({
      workOrderId: corr.workOrderId, serviceAttemptId: corr.serviceAttemptId,
      ticketId: corr.ticketId ?? null,
      invokingAgent: corr.invokingAgent, authorityRef: corr.authorityRef,
      mechanic: "BOKAHLI", operation: req.purpose, scope: `route:${req.route}`,
      result: out.result,
      selectionReason: req.selectionReason, routeClass: req.routeClass,
      qualificationRef: req.qualificationRef ?? null,
      modelRequested: out.modelRequested, modelServed: out.modelServed ?? null,
      provider: out.provider ?? null, runtime: out.runtime ?? null,
      receiptRef: out.receiptRef ?? null, receiptDigest: out.receiptDigest ?? null,
    });
    return out;
  }
}

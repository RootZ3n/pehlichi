/**
 * Universal Bokahli adapter.
 *
 * Local reasoning by default; cloud only with explicit route authority carried
 * by the work order. The honesty rules are the point of this file: requested
 * and served models are separate facts, an unobservable served model is
 * UNKNOWN rather than OK, and there is no silent fallback.
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

export const DEFAULT_ROUTE = "local";

export function assertRouteAuthorized(route: string, authority: RouteAuthority): void {
  if (!authority.allowedRoutes.includes(route)) {
    throw Object.assign(
      new Error(`Bokahli route '${route}' is not authorized by this work order. ` +
                `Permitted: ${authority.allowedRoutes.join(", ") || "(none)"}. ` +
                `Cloud escalation requires explicit route authority.`),
      { code: "ROUTE_NOT_AUTHORIZED" });
  }
}

export class BokahliCapability {
  port: BokahliPort;
  ledger: LedgerSink;
  constructor(port: BokahliPort, ledger: LedgerSink) { this.port = port; this.ledger = ledger; }

  async reason(req: BokahliRequest, corr: Correlation, authority: RouteAuthority) {
    assertRouteAuthorized(req.route, authority);

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
      modelRequested: out.modelRequested, modelServed: out.modelServed ?? null,
      provider: out.provider ?? null, runtime: out.runtime ?? null,
      receiptRef: out.receiptRef ?? null, receiptDigest: out.receiptDigest ?? null,
    });
    return out;
  }
}

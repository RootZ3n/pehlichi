/**
 * Universal Johnny Five contract client.
 *
 * Installed byte-identically for all three Trio agents. Nothing here knows
 * which agent it is running inside: the acting identity arrives from the
 * capsule at construction time, so moving a role between agents needs no edit
 * to this file.
 *
 * This capability speaks the protocol. It does not decide authority — Johnny
 * Five does — and it never marks its own work complete.
 */

export const CONTRACT_SCHEMA_VERSION = 1;

export type MessageKind =
  | "WorkRequest" | "WorkOrderDispatch" | "WorkOrderAcknowledgement" | "ProgressUpdate"
  | "BlockerReport" | "CompletionSubmission" | "VerificationRequest" | "VerificationVerdict";

export interface Envelope {
  schemaVersion: number;
  messageId: string;
  kind: MessageKind;
  sender: string;
  recipient: string;
  projectId?: string | null;
  workOrderId?: string | null;
  correlationId?: string | null;
  authorityRef?: string | null;
  sentAt: string;
  contentDigest?: string;
  body: Record<string, unknown>;
}

/** Provenance is three separate facts. Conflating them is how audit trails lie. */
export interface Provenance {
  authorizedBy?: string | null;
  performedBy?: string | null;
  verifiedBy?: string | null;
}

export interface Transport {
  /** Deliver an envelope to Johnny Five and return his structured reply. */
  send(envelope: Envelope): Promise<{ outcome: string; detail?: string; [k: string]: unknown }>;
}

export interface Clock { nowIso(): string }
export interface IdSource { next(prefix: string): string }
export interface Digest { of(value: unknown): string }

export interface ClientOptions {
  /** This deployment's identity, supplied by the capsule. Never hardcoded. */
  selfId: string;
  johnnyId: string;
  transport: Transport;
  clock: Clock;
  ids: IdSource;
  digest: Digest;
}

export class JohnnyFiveClient {
  selfId: string;
  johnnyId: string;
  transport: Transport;
  clock: Clock;
  ids: IdSource;
  digest: Digest;
  /** Envelopes already sent, so a retry replays rather than duplicates. */
  private sent: Map<string, { outcome: string; [k: string]: unknown }>;

  constructor(o: ClientOptions) {
    this.selfId = o.selfId;
    this.johnnyId = o.johnnyId;
    this.transport = o.transport;
    this.clock = o.clock;
    this.ids = o.ids;
    this.digest = o.digest;
    this.sent = new Map();
  }

  private envelope(
    kind: MessageKind, body: Record<string, unknown>,
    ref: { projectId?: string; workOrderId?: string; correlationId?: string; authorityRef?: string } = {},
  ): Envelope {
    const e: Envelope = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      messageId: this.ids.next("MSG"),
      kind, sender: this.selfId, recipient: this.johnnyId,
      projectId: ref.projectId ?? null,
      workOrderId: ref.workOrderId ?? null,
      correlationId: ref.correlationId ?? null,
      authorityRef: ref.authorityRef ?? null,
      sentAt: this.clock.nowIso(), body,
    };
    e.contentDigest = this.digest.of(e);
    return e;
  }

  /**
   * Replay protection on the sending side too. Johnny is authoritative, but a
   * client that resends after a timeout should not depend on that to avoid
   * creating a second order.
   */
  private async deliver(e: Envelope) {
    const key = e.contentDigest!;
    const prior = this.sent.get(key);
    if (prior) return { ...prior, replayed: true };
    const res = await this.transport.send(e);
    this.sent.set(key, res);
    return { ...res, replayed: false };
  }

  submitWorkRequest(input: {
    projectId?: string; title: string; requestedWork: string; rationale: string;
    workType?: string; evidenceRefs?: string[]; constraints?: string[];
  }) {
    return this.deliver(this.envelope("WorkRequest", {
      title: input.title, requestedWork: input.requestedWork, rationale: input.rationale,
      workType: input.workType ?? "FIX",
      evidenceRefs: input.evidenceRefs ?? [], constraints: input.constraints ?? [],
    }, { projectId: input.projectId }));
  }

  acknowledge(workOrderId: string, accepted: boolean, note?: string) {
    return this.deliver(this.envelope("WorkOrderAcknowledgement",
      { accepted, note: note ?? null }, { workOrderId, authorityRef: workOrderId }));
  }

  reportProgress(workOrderId: string, note: string, evidenceRefs: string[] = []) {
    return this.deliver(this.envelope("ProgressUpdate",
      { note, evidenceRefs }, { workOrderId, authorityRef: workOrderId }));
  }

  reportBlocker(workOrderId: string, reason: string, resolutionOwner: string, proposedNextStep: string) {
    return this.deliver(this.envelope("BlockerReport",
      { reason, resolutionOwner, proposedNextStep }, { workOrderId, authorityRef: workOrderId }));
  }

  /**
   * A completion submission is a CLAIM. It carries receipts because the
   * recipient's gate refuses to close work that only asserts success.
   */
  submitCompletion(workOrderId: string, input: {
    summary: string; commits?: string[]; tests?: string[]; receipts?: string[];
    observations?: string[]; risks?: string[]; recommendedNextAction?: string;
  }) {
    return this.deliver(this.envelope("CompletionSubmission", {
      summary: input.summary,
      commits: input.commits ?? [], tests: input.tests ?? [], receipts: input.receipts ?? [],
      observations: input.observations ?? [], risks: input.risks ?? [],
      recommendedNextAction: input.recommendedNextAction ?? null,
    }, { workOrderId, authorityRef: workOrderId }));
  }

  /**
   * Deliberately absent: there is no verify() and no markComplete(). A worker
   * requesting verification of its own submission is refused by Johnny, and
   * providing the method here would only move the refusal later.
   */
  requestVerificationOfOwnWork(): never {
    throw Object.assign(
      new Error("a worker may not request or issue verification of its own submission"),
      { code: "SELF_VERIFICATION_FORBIDDEN" });
  }

  /** Bounded context only. This capability never asks for a whole database. */
  getBoundedContext(workOrderId: string) {
    return this.deliver(this.envelope("WorkOrderDispatch",
      { requestContextOnly: true }, { workOrderId, authorityRef: workOrderId }));
  }
}

/** Scope is what the order says. A worker may narrow it, never widen it. */
export function assertWithinScope(authorized: string[], requested: string[]): void {
  const outside = requested.filter((p) => !authorized.some((a) => p === a || p.startsWith(a.replace(/\/*$/, "/"))));
  if (outside.length) {
    throw Object.assign(
      new Error(`requested paths outside the authorized scope: ${outside.join(", ")}`),
      { code: "SCOPE_EXPANSION_REFUSED" });
  }
}

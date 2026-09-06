/**
 * RECEIPT ACCESS — who may read the evidence, and how much of it.
 *
 * `/receipts` was anonymous. Anyone who could reach the port could list every turn the agent had
 * taken: task ids, workspace ids, room keys, models, costs, content summaries and security
 * findings, plus a global total that answered "how busy is this agent" whether or not you were
 * entitled to a single receipt in it. Evidence exists to be audited, but an audit surface with no
 * caller identity is not an audit surface, it is a disclosure.
 *
 * Reading receipts is now a lane like any other, decided by the same authorization function the
 * agent, conversational and delegated lanes use, and constrained by the same intersection. What
 * this module adds is only the SCOPE question, which is genuinely specific to reading evidence:
 *
 *   - an OPERATOR principal reads every receipt this agent holds. That is the role's purpose;
 *   - a BRIDGE or SERVICE principal reads only the receipts its own principal produced. The
 *     Matrix bridge sees the bridge's turns; it does not see an operator's;
 *   - anything else reads nothing, which is a scope, not an error.
 *
 * Two properties matter as much as the scope itself:
 *
 *   - NO ENUMERATION OUTSIDE SCOPE. A lookup by task or workspace is filtered by the same scope
 *     as a listing, so "no such task" and "that task is not yours" produce the identical answer.
 *     A caller cannot map what exists by watching which queries come back differently;
 *   - THE SUMMARY IS SCOPED TOO. A count computed over every receipt leaks the size of the set a
 *     caller was refused. The summary here is computed over the receipts the caller may actually
 *     see, so it can never describe one it may not.
 *
 * Nothing here decides admission. It receives a principal that has already been verified and
 * answers a narrower question about it.
 */

/** The receipt fields this surface will ever return. A projection, not the stored object. */
export interface PublicReceiptFields {
  readonly id: string;
  readonly agent: string;
  readonly timestamp: number;
  readonly status: string;
  readonly toolCallCount: number;
  readonly taskId?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly roomKey?: string | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly cost?: number | undefined;
  readonly durationMs?: number | undefined;
  readonly partial?: boolean | undefined;
  readonly principalId?: string | undefined;
  readonly injectionDetected?: boolean | undefined;
  readonly injectionFindings?: number | undefined;
  readonly contentSummary?: string | undefined;
  readonly findingMetadata?: readonly unknown[] | undefined;
  readonly receipt_id?: string | undefined;
}

/**
 * The exact key set a receipt may carry out of this process.
 *
 * An allowlist rather than a denylist: a field added to the store later is invisible here until
 * someone decides it may be published, which is the safe direction for a surface whose whole
 * failure mode is saying too much.
 */
export const PUBLISHABLE_RECEIPT_KEYS: readonly string[] = Object.freeze([
  'id', 'receipt_id', 'agent', 'timestamp', 'status', 'toolCallCount', 'taskId', 'workspaceId',
  'roomKey', 'provider', 'model', 'cost', 'durationMs', 'partial', 'principalId',
  'injectionDetected', 'injectionFindings', 'contentSummary', 'findingMetadata',
]);

/**
 * Substrings that must never appear in a published receipt, in a key or in a value.
 *
 * A receipt records that a decision happened; it must never carry the material that authorised it.
 * The guard is checked by a test over real projected receipts rather than assumed from the fact
 * that nobody meant to put one there.
 */
export const FORBIDDEN_RECEIPT_MARKERS: readonly string[] = Object.freeze([
  'authorization', 'bearer', 'private key', 'begin ec private', 'begin private',
  'pehverse-request-principal/', 'pehverse-delegation/', 'pehverse-ordinary-authorization/',
  'x-pehverse-principal', 'x-pehverse-delegation', 'ikbi_chat_token',
]);

export interface AccessPrincipal {
  readonly id: string;
  readonly kind: string;
}

export type ReceiptScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'own'; readonly principalId: string }
  | { readonly kind: 'none' };

/**
 * What this principal may see.
 *
 * `operator` is the only role that reads another principal's evidence, and it reads it because
 * auditing is what the role is for. Every other kind is confined to what it produced itself, and
 * an unrecognised kind is confined to nothing.
 */
export function receiptAccessScope(principal: AccessPrincipal): ReceiptScope {
  if (principal.kind === 'operator') return { kind: 'all' };
  if (principal.kind === 'bridge' || principal.kind === 'service')
    return { kind: 'own', principalId: principal.id };
  return { kind: 'none' };
}

/** Whether one stored receipt is inside a scope. The only place that comparison is made. */
export function withinScope(scope: ReceiptScope, receipt: { readonly principalId?: string | undefined }): boolean {
  if (scope.kind === 'all') return true;
  if (scope.kind === 'none') return false;
  return receipt.principalId !== undefined && receipt.principalId === scope.principalId;
}

/**
 * Project one stored receipt down to its publishable fields.
 *
 * Unknown fields are dropped rather than passed through, and `undefined` values are omitted so a
 * projected receipt does not advertise which optional fields the store happens to have.
 */
export function projectReceipt(receipt: Record<string, unknown>): PublicReceiptFields {
  const out: Record<string, unknown> = {};
  for (const key of PUBLISHABLE_RECEIPT_KEYS) {
    const value = receipt[key];
    if (value !== undefined) out[key] = value;
  }
  return out as unknown as PublicReceiptFields;
}

/**
 * Filter, then project. Never the other way round: projecting first would compute the answer for
 * receipts the caller may not see, and a filter applied afterwards is one refactor away from
 * being applied to the wrong list.
 */
export function scopedReceipts(
  scope: ReceiptScope,
  receipts: readonly Record<string, unknown>[],
): PublicReceiptFields[] {
  return receipts.filter((r) => withinScope(scope, r as { principalId?: string })).map(projectReceipt);
}

/** A summary computed over exactly what the caller may see, and never over what it may not. */
export function scopedSummary(receipts: readonly PublicReceiptFields[]): {
  total: number; failures: number; oldestMs: number | null;
} {
  const failed = receipts.filter((r) =>
    r.status === 'failed' || r.status === 'error'
    || r.status === 'injection_blocked' || r.status === 'injection_quarantined').length;
  const oldest = receipts.reduce<number | null>(
    (acc, r) => (acc === null || r.timestamp < acc ? r.timestamp : acc), null);
  return { total: receipts.length, failures: failed, oldestMs: oldest };
}

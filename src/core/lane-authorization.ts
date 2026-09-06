/**
 * THE ONE AUTHORIZATION DECISION, shared by every lane.
 *
 * The agent lane and the conversational lane used to reach the boundary by two similar-looking
 * routes that were maintained separately. Similar is not identical, and two enforcement paths for
 * one policy is how the softer of them eventually becomes the way in. The delegated-shadow lane
 * was the same story one level down: while both request lanes were being bound to an externally
 * issued principal, a cron job and a delegated sub-agent still started real work on the committed
 * status gate alone. And reading the evidence had no caller identity at all.
 *
 * Four lanes now compute their verdict here. Lane-specific PARSING is fine -- one arrives as an
 * HTTP header, one as an in-process option, one as a delegation handed down from a parent run --
 * but there is exactly one place where the answer is decided.
 *
 * The effective authority is an intersection, evaluated in this order, each stage able only to
 * narrow the last:
 *
 *     external deployment identity      which verified code is running   (startup, external-identity)
 *   ∩ external service activation      may this deployment work at all  (ordinary-admission)
 *   ∩ authenticated request principal  who is asking                    (request-principal)
 *     OR derived delegation            on whose already-proved behalf   (delegated-authorization)
 *   ∩ requested work type              what kind of work is this
 *   ∩ capability ceiling               which tools survive every ceiling
 *
 * Three properties are worth stating plainly, because all three were absent before:
 *
 *   - There is NO anonymous fallback for privileged work. A request that presents no principal and
 *     no delegation is refused; it does not quietly degrade to "the shared bearer was fine".
 *   - There is NO bare-local gate left. Every lane that can reach a model, a tool or the evidence
 *     passes through this function, and this function requires the external documents.
 *   - Refusal happens BEFORE a model call and before a tool call. Everything here is pure
 *     verification over documents that already exist.
 *
 * Nothing in this module mints, renews, broadens or promotes an EXTERNAL authority. It does mint
 * one DERIVED authority -- a delegation for the children of a request that has already been
 * authorised -- and that minting can only narrow: it is fed the parent's effective capabilities
 * and the parent's own expiry, it is unreachable from tool-handler code, and the function that
 * performs it is not exported from the package. The trusted principal issuer is not a parameter a
 * caller supplies: it is read out of the verified service lease.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  mintDelegation, verifyDelegation,
  type DelegationRefusalReason, type VerifiedDelegation,
} from './delegated-authorization.js';
import type { AdmissionDecision, AdmissionRefusal, OperationalState, WorkCategory } from './operational-admission.js';
import { admitOrdinaryWork, type OrdinaryGrant, type OrdinaryRequest } from './ordinary-admission.js';
import { verifyRequestPrincipal, type PrincipalRefusalReason, type VerifiedPrincipal } from './request-principal.js';

/**
 * The deployment this module belongs to, resolved from its own location.
 *
 * Never `process.cwd()`: a caller chooses the working directory, and an audience check a caller can
 * satisfy by running from a different folder is not an audience check.
 */
const REPOSITORY_ROOT = (() => {
  const raw = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  try { return realpathSync(raw); } catch { return raw; }
})();

/** The workspace policy every delegated shadow run is bound to. A shadow is disposable or nothing. */
const SHADOW_WORKSPACE_POLICY = 'disposable-shadow';

export type LaneName = 'agent-run' | 'converse' | 'delegated-shadow' | 'receipts';

export type LaneRefusalCode =
  | 'ORDINARY_WORK_NOT_EXTERNALLY_AUTHORIZED'
  | 'REQUEST_PRINCIPAL_NOT_AUTHORIZED'
  | 'DELEGATED_WORK_NOT_AUTHORIZED'
  | 'EFFECTIVE_CAPABILITY_EMPTY';

/** What a lane states about the request it is about to run. */
export interface LaneRequest {
  readonly agentName: string;
  readonly agentRole: string;
  readonly lane: LaneName;
  /** Tools the request wants. A converse turn and a receipts read legitimately want none. */
  readonly requestedCapabilities?: readonly string[];
  /** The principal assertion the client presented, verbatim. Absent means refused. */
  readonly principalAssertion?: string | undefined;
  /**
   * The delegation a parent run handed down, verbatim. Only the delegated-shadow lane accepts one,
   * and presenting both a delegation and a principal is refused rather than resolved: an authority
   * question with two answers has no answer.
   */
  readonly delegationAssertion?: string | undefined;
  /** What the shadow will be seeded from, if anything. Bound into the delegation. */
  readonly seedFrom?: string | undefined;
  /**
   * Whether this request needs a principal at all.
   *
   * Status and description surfaces start no work and stay anonymous; every lane request that can
   * reach a model, a tool or the evidence requires one. Defaults to requiring it: a new caller
   * that forgets to say so is refused rather than admitted.
   */
  readonly privileged?: boolean;
}

export interface LaneAuthorization {
  /** This request's own identifier. What a delegation binds to, and what a receipt is filed under. */
  readonly requestId: string;
  readonly lane: LaneName;
  readonly workType: WorkCategory;
  readonly state: OperationalState;
  readonly service: OrdinaryGrant;
  readonly principal: VerifiedPrincipal;
  /** What survived every intersection. This, and nothing wider, is what the run may use. */
  readonly effectiveCapabilities: readonly string[];
  readonly requestedCapabilities: readonly string[];
  /** How many delegations deep this request already is. 0 when authorised by a principal. */
  readonly depth: number;
  /** The delegation this request was admitted on, when it was admitted on one. */
  readonly delegation?: VerifiedDelegation;
  /**
   * A delegation this request may hand to a child run, already narrowed to its own effective
   * capabilities and its own expiry. Absent when nothing may be delegated: an unprivileged
   * surface, a non-work lane, an exhausted depth, or a deployment with no readable lease.
   */
  readonly childDelegation?: string;
}

export type LaneDecision =
  | { readonly authorized: true; readonly authorization: LaneAuthorization }
  | {
      readonly authorized: false;
      readonly refusal: AdmissionRefusal;
      /** Why, for the receipt. Never returned to a caller as prose. */
      readonly reason: PrincipalRefusalReason | DelegationRefusalReason
        | 'SERVICE_NOT_ACTIVATED' | 'EMPTY_INTERSECTION' | 'AMBIGUOUS_AUTHORITY';
      /** This refusal's own identifier, so a refusal receipt is as addressable as an admission. */
      readonly requestId: string;
    };

/** Which category of work each lane performs. A literal mapping, never a caller-supplied value. */
function workCategory(lane: LaneName): WorkCategory {
  switch (lane) {
    case 'converse': return 'ordinary-work';
    case 'receipts': return 'receipt-access';
    default: return 'agent-run';
  }
}

function refusal(code: LaneRefusalCode, state: OperationalState, category: WorkCategory): AdmissionRefusal {
  const nextAction = code === 'REQUEST_PRINCIPAL_NOT_AUTHORIZED'
    ? 'an authenticated request principal issued outside this repository is required; no anonymous fallback exists'
    : code === 'DELEGATED_WORK_NOT_AUTHORIZED'
      ? 'delegated work requires a delegation derived from an authorised parent request; no bare local gate exists'
      : 'externally governed activation and an authorized principal are both required; no runtime override exists';
  return { code: code as AdmissionRefusal['code'], state, category, nextAction };
}

/**
 * Decide one lane request, completely.
 *
 * `localDecision` is the committed status gate's answer, passed in rather than read here so that
 * every lane hands this function the same shape and none can skip it.
 */
export function authorizeLaneRequest(
  localDecision: AdmissionDecision,
  request: LaneRequest,
): LaneDecision {
  const decision = decideLaneRequest(localDecision, request);
  // The receipt is written HERE, not by each caller. Evidence that depends on every call site
  // remembering to record it is evidence that goes missing exactly when it matters.
  writeLaneReceipt(decision, request);
  return decision;
}

function decideLaneRequest(
  localDecision: AdmissionDecision,
  request: LaneRequest,
): LaneDecision {
  const requestId = randomUUID();
  const workType = workCategory(request.lane);
  const requested = request.requestedCapabilities ?? [];

  // 1-2. deployment identity (already bound at startup) ∩ external service activation.
  const ordinaryRequest: OrdinaryRequest = {
    agentName: request.agentName,
    agentRole: request.agentRole,
    lane: request.lane,
    toolNames: requested,
  };
  const service = admitOrdinaryWork(localDecision, ordinaryRequest);
  if (!service.admitted)
    return { authorized: false, refusal: service.refusal, reason: 'SERVICE_NOT_ACTIVATED', requestId };

  const grant = service.ordinaryGrant;
  if (grant === undefined) {
    // Admitted with no grant means the local gate admitted on its own, which after Phase 1 can
    // only happen if the external record vanished between decisions. Fail closed.
    return {
      authorized: false,
      refusal: refusal('ORDINARY_WORK_NOT_EXTERNALLY_AUTHORIZED', service.state, workType),
      reason: 'SERVICE_NOT_ACTIVATED',
      requestId,
    };
  }

  // 3. the authenticated request principal, or the delegation derived from one.
  if (request.privileged === false) {
    // A non-privileged surface starts no work and reads no evidence; it never reaches a model, a
    // tool or a receipt. It is still subject to service activation above, so a deactivated
    // deployment describes nothing either. It delegates nothing, because it holds nothing.
    return {
      authorized: true,
      authorization: {
        requestId, lane: request.lane, workType, state: service.state, service: grant,
        principal: {
          id: 'anonymous', kind: 'operator', displayName: 'unprivileged surface',
          lanes: [request.lane], workTypes: [workType], capabilityCeiling: [],
          expiresAt: grant.expiresAt, replay: 'REUSABLE_WITHIN_WINDOW', fingerprint: 'none',
        },
        effectiveCapabilities: [], requestedCapabilities: requested, depth: 0,
      },
    };
  }

  const hasPrincipal = typeof request.principalAssertion === 'string' && request.principalAssertion.length > 0;
  const hasDelegation = typeof request.delegationAssertion === 'string' && request.delegationAssertion.length > 0;
  if (hasPrincipal && hasDelegation)
    return {
      authorized: false,
      refusal: refusal('DELEGATED_WORK_NOT_AUTHORIZED', service.state, workType),
      reason: 'AMBIGUOUS_AUTHORITY',
      requestId,
    };
  // A delegation is only ever an answer for the delegated lane. Presenting one anywhere else is
  // not a near miss to be tolerated; it is an attempt to spend derived authority in a lane that
  // was never delegated.
  if (hasDelegation && request.lane !== 'delegated-shadow')
    return {
      authorized: false,
      refusal: refusal('DELEGATED_WORK_NOT_AUTHORIZED', service.state, workType),
      reason: 'LANE_NOT_PERMITTED',
      requestId,
    };

  let principal: VerifiedPrincipal;
  let delegation: VerifiedDelegation | undefined;
  let depth = 0;
  let ceiling: readonly string[];

  if (hasDelegation) {
    const verified = verifyDelegation({
      agent: request.agentName,
      codeRoot: REPOSITORY_ROOT,
      lane: 'delegated-shadow',
      workType,
      workspacePolicy: SHADOW_WORKSPACE_POLICY,
      ledgerRoot: grant.principalIssuer?.ledgerRoot,
      assertion: request.delegationAssertion,
    });
    if (!verified.verified)
      return {
        authorized: false,
        refusal: refusal('DELEGATED_WORK_NOT_AUTHORIZED', service.state, workType),
        reason: verified.reason,
        requestId,
      };
    delegation = verified.delegation;
    depth = verified.delegation.depth;
    ceiling = verified.delegation.capabilityCeiling;
    // The delegated run acts as the parent's principal, one level down and never wider. The id
    // records both, so a receipt says who authorised the work and how it got here.
    principal = {
      id: `${verified.delegation.parentPrincipalId}#delegated${verified.delegation.depth}`,
      kind: 'delegate',
      displayName: `delegated from ${verified.delegation.parentPrincipalId}`,
      lanes: ['delegated-shadow'],
      workTypes: ['agent-run'],
      capabilityCeiling: verified.delegation.capabilityCeiling,
      expiresAt: verified.delegation.expiresAt,
      replay: verified.delegation.replay,
      fingerprint: verified.delegation.fingerprint,
    };
  } else {
    const verified = verifyRequestPrincipal(grant.principalIssuer, {
      agent: request.agentName,
      codeRoot: REPOSITORY_ROOT,
      lane: request.lane,
      workType,
      assertion: request.principalAssertion,
    });
    if (!verified.verified)
      return {
        authorized: false,
        refusal: refusal('REQUEST_PRINCIPAL_NOT_AUTHORIZED', service.state, workType),
        reason: verified.reason,
        requestId,
      };
    principal = verified.principal;
    ceiling = verified.principal.capabilityCeiling;
  }

  // 4-5. work type is already checked on every document; capabilities intersect all of them.
  const serviceCeiling = new Set(grant.toolNames ?? []);
  const authorityCeiling = new Set(ceiling);
  const effective = requested.filter((name) => serviceCeiling.has(name) && authorityCeiling.has(name));

  // An empty intersection is only a refusal when the request actually wanted something. A converse
  // turn and a receipts read ask for no tools and must not be refused for successfully being
  // given none.
  if (requested.length > 0 && effective.length === 0)
    return {
      authorized: false,
      refusal: refusal('EFFECTIVE_CAPABILITY_EMPTY', service.state, workType),
      reason: 'EMPTY_INTERSECTION',
      requestId,
    };

  // A lane that cannot start work cannot hand any down either.
  const childDelegation = request.lane === 'receipts' ? undefined : mintDelegation({
    requestId,
    agent: request.agentName,
    codeRoot: REPOSITORY_ROOT,
    principalId: principal.id,
    principalFingerprint: principal.fingerprint,
    leaseGeneration: grant.generation,
    leaseFingerprint: grant.fingerprint,
    effectiveCapabilities: effective,
    expiresAt: principal.expiresAt,
    depth,
  }, { workspacePolicy: SHADOW_WORKSPACE_POLICY, ...(request.seedFrom !== undefined ? { seedFrom: request.seedFrom } : {}) });

  return {
    authorized: true,
    authorization: {
      requestId, lane: request.lane, workType, state: service.state, service: grant,
      principal, effectiveCapabilities: effective, requestedCapabilities: requested, depth,
      ...(delegation !== undefined ? { delegation } : {}),
      ...(childDelegation !== undefined ? { childDelegation } : {}),
    },
  };
}

/**
 * The receipt body for one lane decision.
 *
 * Binds request id, principal, service lease, lane, work type, requested and effective
 * capabilities, delegation lineage and the outcome. Carries fingerprints and identifiers only:
 * never the assertion, never the delegation, never the bearer, never key material, and never
 * anything that could be replayed by whoever reads the receipt.
 */
export function laneReceipt(decision: LaneDecision, request: LaneRequest): Record<string, unknown> {
  const common = {
    time: new Date().toISOString(),
    requestId: decision.authorized ? decision.authorization.requestId : decision.requestId,
    lane: request.lane,
    workType: workCategory(request.lane),
    requestedCapabilities: [...(request.requestedCapabilities ?? [])].sort(),
    modelCalls: 0, toolCalls: 0, mutations: 0,
  };
  if (decision.authorized) {
    const a = decision.authorization;
    return {
      ...common,
      decision: 'AUTHORIZED',
      principalId: a.principal.id,
      principalKind: a.principal.kind,
      principalFingerprint: a.principal.fingerprint,
      serviceLeaseGeneration: a.service.generation,
      serviceLeaseFingerprint: a.service.fingerprint,
      localStatusPolicy: a.service.localStatusPolicy,
      state: a.state,
      depth: a.depth,
      ...(a.delegation !== undefined
        ? {
            delegationId: a.delegation.id,
            delegationParentRequestId: a.delegation.parentRequestId,
            delegationFingerprint: a.delegation.fingerprint,
            delegationReplay: a.delegation.replay,
          }
        : {}),
      delegatedDown: a.childDelegation !== undefined,
      effectiveCapabilities: [...a.effectiveCapabilities].sort(),
    };
  }
  return {
    ...common,
    decision: 'REFUSED',
    refusalCode: decision.refusal.code,
    reason: decision.reason,
    state: decision.refusal.state,
    depth: 0,
    delegatedDown: false,
    effectiveCapabilities: [],
  };
}

/**
 * Persist one lane decision, durably, outside every repository.
 *
 * Every lane writes through this, so an admission on one and a refusal on another are the same
 * shape of evidence. A receipt that cannot be written never turns a refusal into an admission and
 * never crashes a refusal; it is evidence, not a decision.
 */
export function writeLaneReceipt(decision: LaneDecision, request: LaneRequest): void {
  const supplied = process.env['TRIO_LANE_RECEIPT_ROOT']
    ?? process.env['TRIO_ORDINARY_RECEIPT_ROOT']
    ?? process.env['TRIO_QUALIFICATION_RECEIPT_ROOT'];
  if (supplied === undefined || supplied.length === 0 || !isAbsolute(supplied)) return;
  try {
    const target = resolve(supplied);
    const rel = relative(REPOSITORY_ROOT, target);
    // Never inside the repository being authorised.
    if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) return;
    mkdirSync(target, { recursive: true });
    const body = laneReceipt(decision, request);
    /*
      The REQUEST ID is in the filename, and it has to be.

      The name used to be a timestamp, the lane and the outcome. Three agents share one receipt
      directory, and a live run caught them answering the same kind of request in the same
      millisecond: identical name, last writer wins, and two decisions vanished with nothing to
      indicate anything had been lost. Evidence that silently drops rows under concurrency is worse
      than no evidence, because the gap is invisible.

      The id is unique per decision, so no two receipts can name the same file however close
      together they happen or however many processes are writing.
    */
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const id = String(body.requestId ?? 'no-request-id');
    writeFileSync(join(target, `${stamp}-lane-${request.lane}-${String(body.decision)}-${id}.json`),
      `${JSON.stringify(body, null, 1)}\n`);
  } catch {
    // Deliberately silent: evidence, never a decision.
  }
}

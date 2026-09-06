/**
 * THE ONE AUTHORIZATION DECISION, shared by both lanes.
 *
 * The agent lane and the conversational lane used to reach the boundary by two similar-looking
 * routes that were maintained separately. Similar is not identical, and two enforcement paths for
 * one policy is how the softer of them eventually becomes the way in. Both lanes now compute their
 * verdict here. Lane-specific PARSING is fine -- one arrives as an HTTP header, the other as an
 * in-process option -- but there is exactly one place where the answer is decided.
 *
 * The effective authority is an intersection, evaluated in this order, each stage able only to
 * narrow the last:
 *
 *     external deployment identity      which verified code is running   (startup, external-identity)
 *   ∩ external service activation      may this deployment work at all  (ordinary-admission)
 *   ∩ authenticated request principal  who is asking                    (request-principal)
 *   ∩ requested work type              what kind of work is this
 *   ∩ capability ceiling               which tools survive every ceiling
 *
 * Two properties are worth stating plainly, because both were absent before:
 *
 *   - There is NO anonymous fallback for privileged work. A request that presents no principal is
 *     refused; it does not quietly degrade to "the shared bearer was fine, carry on".
 *   - Refusal happens BEFORE a model call and before a tool call. Everything here is pure
 *     verification over documents that already exist.
 *
 * Nothing in this module mints, renews, broadens, verifies or promotes an authority. The trusted
 * principal issuer is not a parameter a caller supplies: it is read out of the verified service
 * lease, so a caller who could name their own issuer does not exist.
 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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

export type LaneRefusalCode =
  | 'ORDINARY_WORK_NOT_EXTERNALLY_AUTHORIZED'
  | 'REQUEST_PRINCIPAL_NOT_AUTHORIZED'
  | 'EFFECTIVE_CAPABILITY_EMPTY';

/** What a lane states about the request it is about to run. */
export interface LaneRequest {
  readonly agentName: string;
  readonly agentRole: string;
  readonly lane: 'agent-run' | 'converse';
  /** Tools the request wants. A converse turn legitimately wants none. */
  readonly requestedCapabilities?: readonly string[];
  /** The principal assertion the client presented, verbatim. Absent means refused. */
  readonly principalAssertion?: string | undefined;
  /**
   * Whether this request needs a principal at all.
   *
   * Status and description surfaces start no work and stay anonymous; every lane request that can
   * reach a model or a tool requires one. Defaults to requiring it: a new caller that forgets to
   * say so is refused rather than admitted.
   */
  readonly privileged?: boolean;
}

export interface LaneAuthorization {
  readonly lane: string;
  readonly workType: WorkCategory;
  readonly state: OperationalState;
  readonly service: OrdinaryGrant;
  readonly principal: VerifiedPrincipal;
  /** What survived every intersection. This, and nothing wider, is what the run may use. */
  readonly effectiveCapabilities: readonly string[];
  readonly requestedCapabilities: readonly string[];
}

export type LaneDecision =
  | { readonly authorized: true; readonly authorization: LaneAuthorization }
  | {
      readonly authorized: false;
      readonly refusal: AdmissionRefusal;
      /** Why, for the receipt. Never returned to a caller as prose. */
      readonly reason: PrincipalRefusalReason | 'SERVICE_NOT_ACTIVATED' | 'EMPTY_INTERSECTION';
    };

function refusal(code: LaneRefusalCode, state: OperationalState, category: WorkCategory): AdmissionRefusal {
  return {
    code: code as AdmissionRefusal['code'],
    state,
    category,
    nextAction: code === 'REQUEST_PRINCIPAL_NOT_AUTHORIZED'
      ? 'an authenticated request principal issued outside this repository is required; no anonymous fallback exists'
      : 'externally governed activation and an authorized principal are both required; no runtime override exists',
  };
}

/**
 * Decide one lane request, completely.
 *
 * `localDecision` is the committed status gate's answer, passed in rather than read here so that
 * the two lanes hand this function the same shape and neither can skip it.
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
  const workType: WorkCategory = request.lane === 'converse' ? 'ordinary-work' : 'agent-run';
  const requested = request.requestedCapabilities ?? [];

  // 1-2. deployment identity (already bound at startup) ∩ external service activation.
  const ordinaryRequest: OrdinaryRequest = {
    agentName: request.agentName,
    agentRole: request.agentRole,
    lane: request.lane,
    toolNames: requested,
  };
  const service = admitOrdinaryWork(localDecision, ordinaryRequest);
  if (!service.admitted) return { authorized: false, refusal: service.refusal, reason: 'SERVICE_NOT_ACTIVATED' };

  const grant = service.ordinaryGrant;
  if (grant === undefined) {
    // Admitted with no grant means the local gate admitted on its own, which after Phase 1 can
    // only happen if the external record vanished between decisions. Fail closed.
    return {
      authorized: false,
      refusal: refusal('ORDINARY_WORK_NOT_EXTERNALLY_AUTHORIZED', service.state, workType),
      reason: 'SERVICE_NOT_ACTIVATED',
    };
  }

  // 3. the authenticated request principal.
  if (request.privileged === false) {
    // A non-privileged surface starts no work; it never reaches a model or a tool. It is still
    // subject to service activation above, so a deactivated deployment describes nothing either.
    return {
      authorized: true,
      authorization: {
        lane: request.lane, workType, state: service.state, service: grant,
        principal: {
          id: 'anonymous', kind: 'operator', displayName: 'unprivileged surface',
          lanes: [request.lane], workTypes: [workType], capabilityCeiling: [],
          expiresAt: grant.expiresAt, replay: 'REUSABLE_WITHIN_WINDOW', fingerprint: 'none',
        },
        effectiveCapabilities: [], requestedCapabilities: requested,
      },
    };
  }

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
    };

  // 4-5. work type is already checked on both documents; capabilities intersect all three.
  const serviceCeiling = new Set(grant.toolNames ?? []);
  const principalCeiling = new Set(verified.principal.capabilityCeiling);
  const effective = requested.filter((name) => serviceCeiling.has(name) && principalCeiling.has(name));

  // An empty intersection is only a refusal when the request actually wanted something. A converse
  // turn asks for no tools and must not be refused for successfully being given none.
  if (requested.length > 0 && effective.length === 0)
    return {
      authorized: false,
      refusal: refusal('EFFECTIVE_CAPABILITY_EMPTY', service.state, workType),
      reason: 'EMPTY_INTERSECTION',
    };

  return {
    authorized: true,
    authorization: {
      lane: request.lane, workType, state: service.state, service: grant,
      principal: verified.principal,
      effectiveCapabilities: effective, requestedCapabilities: requested,
    },
  };
}

/**
 * The receipt body for one lane decision.
 *
 * Binds principal, service lease, lane, work type, requested and effective capabilities and the
 * outcome. Carries fingerprints and identifiers only -- never the assertion, never the bearer,
 * never key material, and never anything that could be replayed by whoever reads the receipt.
 */
export function laneReceipt(decision: LaneDecision, request: LaneRequest): Record<string, unknown> {
  const common = {
    time: new Date().toISOString(),
    lane: request.lane,
    workType: request.lane === 'converse' ? 'ordinary-work' : 'agent-run',
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
      effectiveCapabilities: [...a.effectiveCapabilities].sort(),
    };
  }
  return {
    ...common,
    decision: 'REFUSED',
    refusalCode: decision.refusal.code,
    reason: decision.reason,
    state: decision.refusal.state,
    effectiveCapabilities: [],
  };
}

/**
 * Persist one lane decision, durably, outside every repository.
 *
 * Both lanes write through this, so an admission on one and a refusal on the other are the same
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
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeFileSync(join(target, `${stamp}-lane-${request.lane}-${String(body.decision)}.json`),
      `${JSON.stringify(body, null, 1)}\n`);
  } catch {
    // Deliberately silent: evidence, never a decision.
  }
}

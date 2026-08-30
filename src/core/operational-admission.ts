/**
 * The operational-work admission boundary.
 *
 * `trio/governance/boundary-manifest.json` has carried `state: PRE_PRODUCTION` and
 * `authorization: NOT_AUTHORIZED_FOR_OPERATIONAL_WORK` for as long as the Trio has existed.
 * Nothing read them. They were a sentence in a manifest, and an agent that is declared
 * unavailable for real work but will do real work when asked is available for real work.
 *
 * This is the executable form of that declaration. Every agent run passes through
 * `admitRun` before any model is called or any tool is registered, and while the committed
 * status is locked the only runs that proceed are the ones that name themselves qualification,
 * audit or self-test *and* carry the exact authority for it.
 *
 * What deliberately does not appear anywhere below: role, capability pack, model, route,
 * service health, and Matrix identity. Authorization is a property of the committed governed
 * status and the declared purpose of the run, and of nothing else. A gate that could be
 * satisfied by "but this agent is the coordinator" or "but the request came over Matrix"
 * would be a gate that the first operational request talks its way through.
 *
 * The Trio may stay online while locked -- health, UI and Matrix connectivity are not
 * operational work and never reach this boundary.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** src/core -> repository root. The governed status is committed; it is never configurable. */
const REPOSITORY_ROOT = join(here, '..', '..');
export const GOVERNED_STATUS_PATH = 'trio/governance/boundary-manifest.json';

export type OperationalState = 'PRE_PRODUCTION' | 'PRODUCTION';
export type OperationalAuthorization = 'NOT_AUTHORIZED_FOR_OPERATIONAL_WORK' | 'AUTHORIZED_FOR_OPERATIONAL_WORK';

export interface OperationalStatus {
  readonly state: OperationalState;
  readonly authorization: OperationalAuthorization;
  readonly productionAgent: string;
  readonly clearedBy: string;
  readonly reason: string;
}

/**
 * What a run says it is for.
 *
 * `ordinary-work` is the default everywhere precisely because omitting the field must not be a
 * way through: a caller that says nothing is asking to do real work.
 */
export type RunPurpose =
  | 'ordinary-work'
  | 'repair'
  | 'build'
  | 'maintenance'
  | 'commissioning'
  | 'qualification'
  | 'audit'
  | 'self-test';

/** The purposes that may proceed while locked, and only with the exact authority below. */
export const QUALIFICATION_PURPOSES: readonly RunPurpose[] = Object.freeze(['qualification', 'audit', 'self-test']);

/**
 * The exact authority a qualification run must carry.
 *
 * Naming it is the point. A run cannot reach a qualification lane by having the right role or
 * by leaving a field blank; it has to state this string, which means every such run is
 * greppable and every one of them is deliberate.
 */
export const QUALIFICATION_AUTHORITY = 'trio-qualification/pre-production-self-test/1';

export interface AdmissionRequest {
  /** What is being attempted, for the refusal record. Never interpreted as authorization. */
  readonly operation: string;
  readonly purpose?: RunPurpose;
  readonly authority?: string;
}

export interface AdmissionRefusal {
  readonly category:
    | 'OPERATIONAL_WORK_NOT_AUTHORIZED'
    | 'QUALIFICATION_AUTHORITY_REQUIRED'
    | 'OPERATIONAL_STATUS_UNREADABLE';
  readonly operation: string;
  readonly purpose: RunPurpose;
  readonly state: OperationalState | 'UNKNOWN';
  readonly authorization: OperationalAuthorization | 'UNKNOWN';
  readonly productionAgent: string | null;
  readonly reason: string;
}

export type AdmissionDecision =
  | { readonly admitted: true; readonly purpose: RunPurpose; readonly state: OperationalState }
  | { readonly admitted: false; readonly refusal: AdmissionRefusal };

export class OperationalStatusUnreadable extends Error {
  constructor(public readonly detail: string) {
    super(`governed operational status is unreadable: ${detail}`);
    this.name = 'OperationalStatusUnreadable';
  }
}

const NON_EMPTY = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/**
 * Read and validate the committed governed status.
 *
 * Every failure path throws. A status that is missing, unparseable, or shaped wrongly must
 * not resolve to "probably fine": not knowing whether operational work is authorized is the
 * same as it not being authorized.
 */
export function readOperationalStatus(repositoryRoot: string = REPOSITORY_ROOT): OperationalStatus {
  let raw: string;
  try {
    raw = readFileSync(join(repositoryRoot, GOVERNED_STATUS_PATH), 'utf8');
  } catch {
    throw new OperationalStatusUnreadable('the governed boundary manifest could not be read');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OperationalStatusUnreadable('the governed boundary manifest is not valid JSON');
  }
  const status = (parsed as { operationalStatus?: unknown } | null)?.operationalStatus as Partial<OperationalStatus> | undefined;
  if (status === undefined || status === null || typeof status !== 'object') {
    throw new OperationalStatusUnreadable('the governed boundary manifest declares no operationalStatus');
  }
  if (status.state !== 'PRE_PRODUCTION' && status.state !== 'PRODUCTION') {
    throw new OperationalStatusUnreadable('operationalStatus.state is not a recognized state');
  }
  if (status.authorization !== 'NOT_AUTHORIZED_FOR_OPERATIONAL_WORK' && status.authorization !== 'AUTHORIZED_FOR_OPERATIONAL_WORK') {
    throw new OperationalStatusUnreadable('operationalStatus.authorization is not a recognized authorization');
  }
  if (!NON_EMPTY(status.productionAgent) || !NON_EMPTY(status.clearedBy) || !NON_EMPTY(status.reason)) {
    throw new OperationalStatusUnreadable('operationalStatus is missing required declarative fields');
  }
  return {
    state: status.state,
    authorization: status.authorization,
    productionAgent: status.productionAgent,
    clearedBy: status.clearedBy,
    reason: status.reason
  };
}

/**
 * Decide whether a run may proceed.
 *
 * Takes the request and the status, and nothing else. There is no context parameter for a
 * reason: a boundary that accepts a context is a boundary somebody will eventually put an
 * override in.
 */
export function admitOperation(request: AdmissionRequest, status: OperationalStatus): AdmissionDecision {
  const purpose: RunPurpose = request.purpose ?? 'ordinary-work';
  const refuse = (category: AdmissionRefusal['category'], reason: string): AdmissionDecision => ({
    admitted: false,
    refusal: {
      category,
      operation: request.operation,
      purpose,
      state: status.state,
      authorization: status.authorization,
      productionAgent: status.productionAgent,
      reason
    }
  });

  if (status.authorization === 'AUTHORIZED_FOR_OPERATIONAL_WORK') {
    return { admitted: true, purpose, state: status.state };
  }
  if (!QUALIFICATION_PURPOSES.includes(purpose)) {
    return refuse('OPERATIONAL_WORK_NOT_AUTHORIZED',
      `this agent is ${status.state} and not authorized for operational work; ${status.productionAgent} is the production agent`);
  }
  if (request.authority !== QUALIFICATION_AUTHORITY) {
    return refuse('QUALIFICATION_AUTHORITY_REQUIRED',
      'a qualification, audit or self-test run must carry the exact qualification authority');
  }
  return { admitted: true, purpose, state: status.state };
}

/**
 * The boundary as a run gate: read the committed status, decide, fail closed.
 *
 * An unreadable or malformed status produces a refusal rather than an exception escaping into
 * the caller, so the caller cannot accidentally treat "the gate crashed" as "the gate passed".
 */
export function admitRun(request: AdmissionRequest, repositoryRoot: string = REPOSITORY_ROOT): AdmissionDecision {
  let status: OperationalStatus;
  try {
    status = readOperationalStatus(repositoryRoot);
  } catch (error) {
    return {
      admitted: false,
      refusal: {
        category: 'OPERATIONAL_STATUS_UNREADABLE',
        operation: request.operation,
        purpose: request.purpose ?? 'ordinary-work',
        state: 'UNKNOWN',
        authorization: 'UNKNOWN',
        productionAgent: null,
        reason: error instanceof OperationalStatusUnreadable
          ? error.detail
          : 'the governed operational status could not be established'
      }
    };
  }
  return admitOperation(request, status);
}

/** A one-line refusal for logs and transcripts. Carries identity and reason, never secrets. */
export function describeRefusal(refusal: AdmissionRefusal): string {
  return `${refusal.category}: ${refusal.operation} refused (purpose=${refusal.purpose}, state=${refusal.state}) — ${refusal.reason}`;
}

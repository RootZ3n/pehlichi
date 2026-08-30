/**
 * The operational-work admission boundary.
 *
 * While the committed governed status is PRE_PRODUCTION or NOT_AUTHORIZED_FOR_OPERATIONAL_WORK,
 * there is no way to execute work. Not a flag, not a purpose, not a token, not an environment
 * variable, not a role, not a route. There is no branch below that can return an admission
 * while the status is locked, which is a stronger statement than "the branch is hard to reach".
 *
 * The first attempt at this gate was bypassable and an independent audit said so plainly. It
 * accepted a caller-supplied `purpose` and a caller-supplied `authority`, and the authority was
 * a plaintext constant exported from shared core. Any in-process caller could import it, label
 * operational work `self-test`, and be admitted -- and reuse the same string for a different
 * operation tomorrow. A secret that every caller can read is not an authority; a claim the
 * caller makes about itself is not an authorization.
 *
 * So nothing the caller says is consulted. `admitWork` reads the committed status and compares
 * it against the one state in which work is permitted. Everything else refuses. The request's
 * category exists to make the refusal legible, never to influence it.
 *
 * A future commissioning capability -- externally issued, bound to an authenticated actor, an
 * exact work order, a scope, a nonce, an expiry and a single use -- is deliberately not built
 * here. Adding a weaker placeholder now would be the same defect wearing a different name.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/**
 * src/core -> repository root.
 *
 * Not a parameter on the production path. If a caller could name the repository whose
 * governance is consulted, it could point at one that says PRODUCTION, and the whole gate
 * would be a suggestion. Tests that need a different status build a fixture root and call
 * `readOperationalStatus`/`admitWork` directly -- below this boundary, never through it.
 */
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
 * How a request is described in a refusal.
 *
 * Every member is work. There is no privileged member, and adding one would not help: the
 * category is not consulted when deciding, only when explaining. `qualification` and
 * `self-test` appear here precisely so that a request labelled either of them is visibly
 * refused rather than quietly special-cased.
 */
export type WorkCategory =
  | 'agent-run'
  | 'ordinary-work'
  | 'repair'
  | 'build'
  | 'maintenance'
  | 'cleanup'
  | 'reconnaissance'
  | 'commissioning'
  | 'qualification'
  | 'self-test'
  | 'matrix-originated'
  | 'cli-originated'
  | 'role-pack-operation'
  | 'model-route-operation';

/**
 * Surfaces that are not work.
 *
 * The Trio stays online while locked: it reports health, renders its UI, holds its Matrix
 * connection and displays its own identity. None of these executes work, none of them carries
 * tools, and none of them routes through the work gate -- they are listed here so that "the
 * service is up" is never mistaken for "the service is admitted".
 */
export type NonWorkSurface =
  | 'service-startup'
  | 'health-report'
  | 'status-display'
  | 'ui-render'
  | 'matrix-connectivity'
  | 'identity-display';

export type RefusalCode = 'OPERATIONAL_WORK_NOT_AUTHORIZED' | 'OPERATIONAL_STATUS_UNREADABLE';

/**
 * A refusal carries four fields and nothing else.
 *
 * No operation label, no prose from the manifest, no configuration, no prompt, no model data.
 * A refusal is emitted on paths that may have been reached by hostile input, so the safe
 * shape is the small one.
 */
export interface AdmissionRefusal {
  readonly code: RefusalCode;
  readonly state: OperationalState | 'UNKNOWN';
  readonly category: WorkCategory;
  readonly nextAction: string;
}

export type AdmissionDecision =
  | { readonly admitted: true; readonly state: OperationalState }
  | { readonly admitted: false; readonly refusal: AdmissionRefusal };

export class OperationalStatusUnreadable extends Error {
  constructor(public readonly detail: string) {
    super(`governed operational status is unreadable: ${detail}`);
    this.name = 'OperationalStatusUnreadable';
  }
}

/** The one next action there is. Stated once so every refusal says the same thing. */
const NEXT_ACTION = 'a separately authorized governance transition is required; no runtime override exists';

const NON_EMPTY = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/**
 * Read and validate the committed governed status.
 *
 * Every failure path throws. Not knowing whether operational work is authorized is the same
 * as it not being authorized, so there is no shape of unreadable input that resolves to
 * "probably fine".
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
  // The two fields must agree. A manifest that says PRODUCTION while withholding authorization
  // -- or the reverse -- describes no coherent state, and guessing which half to believe is
  // exactly the kind of reconciliation that turns a gate into a negotiation.
  const cleared = status.state === 'PRODUCTION' && status.authorization === 'AUTHORIZED_FOR_OPERATIONAL_WORK';
  const locked = status.state === 'PRE_PRODUCTION' && status.authorization === 'NOT_AUTHORIZED_FOR_OPERATIONAL_WORK';
  if (!cleared && !locked) {
    throw new OperationalStatusUnreadable('operationalStatus.state and operationalStatus.authorization contradict each other');
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
 * Decide whether work may execute.
 *
 * There is exactly one condition under which this returns an admission, and it is a property
 * of the committed status alone. The `category` argument reaches the refusal and nothing else;
 * no value of it, and no other argument, can produce an admission while the status is locked.
 */
export function admitWork(category: WorkCategory, status: OperationalStatus): AdmissionDecision {
  if (status.state === 'PRODUCTION' && status.authorization === 'AUTHORIZED_FOR_OPERATIONAL_WORK') {
    return { admitted: true, state: status.state };
  }
  return {
    admitted: false,
    refusal: { code: 'OPERATIONAL_WORK_NOT_AUTHORIZED', state: status.state, category, nextAction: NEXT_ACTION }
  };
}

/**
 * The production work gate: read the committed status, decide, fail closed.
 *
 * An unreadable, missing, malformed or self-contradictory status becomes a refusal rather
 * than an exception escaping into the caller, so "the gate crashed" can never be handled as
 * "the gate passed".
 */
export function admitRunWork(category: WorkCategory): AdmissionDecision {
  let status: OperationalStatus;
  try {
    status = readOperationalStatus();
  } catch {
    return {
      admitted: false,
      refusal: { code: 'OPERATIONAL_STATUS_UNREADABLE', state: 'UNKNOWN', category, nextAction: NEXT_ACTION }
    };
  }
  return admitWork(category, status);
}

/**
 * Whether a non-work surface may serve.
 *
 * Always yes. Health, status, UI and Matrix connectivity are not gated because refusing them
 * would take the agent offline rather than keep it from working, and an agent nobody can ask
 * "what state are you in?" is worse than one that answers "locked". Deliberately a separate
 * function: the work path has no branch that a surface name could reach.
 */
export function admitNonWorkSurface(_surface: NonWorkSurface): { readonly admitted: true } {
  return { admitted: true };
}

/** A one-line refusal for logs and transcripts. Carries the four fields, nothing else. */
export function describeRefusal(refusal: AdmissionRefusal): string {
  return `${refusal.code}: ${refusal.category} refused (state=${refusal.state}) — ${refusal.nextAction}`;
}

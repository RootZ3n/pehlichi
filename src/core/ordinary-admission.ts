/**
 * ORDINARY PRODUCTION AUTHORIZATION — the local manifest stops being sufficient.
 *
 * An independent hostile case, H03a, copied this repository, edited one field of
 * `trio/governance/boundary-manifest.json` to say PRODUCTION, and ran an agent. It was admitted.
 * `admitWork` reads the manifest out of whichever tree the module happens to live in, so a tree
 * that says it is authorised is authorised. That is self-attestation with extra steps, and it is
 * the same defect the deployment-identity chain already had before its root moved outside the
 * repository.
 *
 * The correction is not a better manifest check. It is a second, external condition that a copy
 * cannot satisfy:
 *
 *     ordinary work admitted  ⟺  the committed status says PRODUCTION
 *                             ∧  a root-owned authorization, delivered on the systemd credential
 *                                channel, names THIS agent, THIS code root, THIS commit and tree,
 *                                THIS policy digest, THIS closure, this lane and this work type,
 *                                inside its validity window
 *
 * `admitOrdinaryWork` can only ever NARROW the decision it is handed. A local refusal passes
 * through untouched, so the single-use qualification path downstream is unaffected. A local
 * admission now REQUIRES the external record — which is the inversion that closes H03a, because a
 * copied tree has no authorization naming its path, its commit or its edited policy.
 *
 * WHAT IT IS NOT. It is not a nonce. Ordinary production work is a lease: reusable, concurrent,
 * never consumed, bounded by a validity window and a generation counter rather than by a ledger.
 * Making it single-use would mean every ordinary request needed a freshly minted document, which
 * is the blanket-grant-or-nothing trap in the other direction. It is also not interchangeable with
 * a qualification: the schemas differ and each verifier refuses the other's document.
 *
 * Nothing here mints, renews, broadens, verifies or promotes an authorization. There is no signing
 * key in this repository and no function that could create one of these records. The authority is
 * the kernel's ownership of `/run/credentials` and root's ownership of the source file.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readOrdinaryAuthorizationRecord } from '../../scripts/trio/external-identity.mjs';
import type { AdmissionDecision, AdmissionRefusal, OperationalState, WorkCategory } from './operational-admission.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(here, '..', '..');

/** The only schema this verifier understands. Distinct from the qualification schema on purpose. */
const SCHEMA = 'pehverse-ordinary-authorization/1';

/** The exact key set. Unknown or missing fields are a refusal, never a default. */
const REQUIRED_KEYS: readonly string[] = Object.freeze([
  'schema', 'generation', 'agent', 'role', 'codeRoot', 'subject', 'closureSha256', 'policySha256',
  'operationalAuthorization', 'lanes', 'workTypes', 'capabilityCeiling', 'workspacePolicyId',
  'notBefore', 'expiresAt', 'renewalSeconds',
]);

/**
 * Fields a lease MAY carry. Absent means the Phase-1 behaviour, unchanged.
 *
 * `localStatusPolicy` is what makes external activation possible without a repository edit, and it
 * lives in the lease rather than in the code so that turning it on is a root-owned act and turning
 * it off again is another one. `principalIssuer` names the key whose assertions this deployment
 * will accept as request principals -- delivering the anchor here rather than committing it means
 * revoking every principal at once is a lease change, not a release.
 */
const OPTIONAL_KEYS: readonly string[] = Object.freeze([
  'localStatusPolicy', 'principalIssuer', 'principalIssuerGeneration', 'principalLedgerRoot',
]);

/** How the committed local status participates. Absent ⇒ REQUIRE_LOCAL_PRODUCTION. */
export type LocalStatusPolicy = 'REQUIRE_LOCAL_PRODUCTION' | 'EXTERNAL_ACTIVATION';

/** The governance document whose bytes the authorization pins. */
const POLICY_PATH = 'trio/governance/boundary-manifest.json';

/**
 * The files whose executing bytes the authorization pins.
 *
 * The admission decision, both authorization verifiers and the loop that calls them. Binding the
 * commit alone would prove only that git agrees with itself; a working tree edited after the
 * record was issued has the same commit and different behaviour.
 */
const CLOSURE_FILES: readonly string[] = Object.freeze([
  'src/core/operational-admission.ts',
  'src/core/ordinary-admission.ts',
  'src/core/qualification-admission.ts',
  'src/core/loop.ts',
]);

const FULL_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export type OrdinaryRefusalReason =
  | 'NO_AUTHORIZATION_PRESENTED'
  | 'CHANNEL_REFUSED'
  | 'MALFORMED_AUTHORIZATION'
  | 'UNKNOWN_SCHEMA'
  | 'NOT_AUTHORIZED_FOR_ORDINARY_WORK'
  | 'AGENT_MISMATCH'
  | 'CODE_ROOT_MISMATCH'
  | 'SUBJECT_MISMATCH'
  | 'SUBJECT_TREE_DIRTY'
  | 'SUBJECT_UNREADABLE'
  | 'POLICY_DIGEST_MISMATCH'
  | 'CLOSURE_DIGEST_MISMATCH'
  | 'LANE_NOT_PERMITTED'
  | 'WORK_TYPE_NOT_PERMITTED'
  | 'CAPABILITY_BROADENED'
  | 'NOT_YET_VALID'
  | 'EXPIRED'
  | 'GENERATION_INVALID';

/** What a run must state about itself before an authorization can be checked against it. */
export interface OrdinaryRequest {
  readonly agentName: string;
  readonly agentRole: string;
  readonly lane: 'agent-run' | 'converse';
  readonly toolNames?: readonly string[];
}

/** The narrowing a verified authorization imposes. */
export interface OrdinaryGrant {
  readonly generation: number;
  /** How the committed local status participated in this decision. */
  readonly localStatusPolicy: LocalStatusPolicy;
  /** The principal issuer this deployment trusts, if its lease names one. */
  readonly principalIssuer?: {
    readonly id: string; readonly keyId: string; readonly publicKeyPem: string;
    readonly generation: number; readonly ledgerRoot?: string | undefined;
  };
  readonly lane: string;
  readonly workspacePolicyId: string;
  readonly expiresAt: string;
  readonly fingerprint: string;
  readonly toolNames?: readonly string[];
}

export type OrdinaryDecision =
  | { readonly admitted: true; readonly state: OperationalState; readonly ordinaryGrant?: OrdinaryGrant }
  | { readonly admitted: false; readonly refusal: AdmissionRefusal };

interface Authorization {
  readonly schema: string;
  readonly localStatusPolicy?: LocalStatusPolicy;
  readonly principalIssuer?: { readonly id: string; readonly keyId: string; readonly publicKeyPem: string };
  readonly principalIssuerGeneration?: number;
  readonly principalLedgerRoot?: string;
  readonly generation: number;
  readonly agent: string;
  readonly role: string;
  readonly codeRoot: string;
  readonly subject: { readonly commit: string; readonly tree: string };
  readonly closureSha256: string;
  readonly policySha256: string;
  readonly operationalAuthorization: string;
  readonly lanes: readonly string[];
  readonly workTypes: readonly string[];
  readonly capabilityCeiling: readonly string[];
  readonly workspacePolicyId: string;
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly renewalSeconds: number;
}

function digestOf(...parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

/** The digest of the bytes that will execute, taken from the working tree, not from git. */
export function closureDigest(root: string = REPOSITORY_ROOT): string {
  const parts: string[] = [];
  for (const rel of [...CLOSURE_FILES].sort()) {
    parts.push(rel, readFileSync(join(root, rel), 'utf8'));
  }
  return digestOf(...parts);
}

/** The digest of the governance document the authorization pins. */
export function policyDigest(root: string = REPOSITORY_ROOT): string {
  return digestOf(POLICY_PATH, readFileSync(join(root, POLICY_PATH), 'utf8'));
}

function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * The durable record of a pre-model decision.
 *
 * Never inside a repository, and never carrying the authorization itself — only a truncated
 * digest of it, so a receipt proves which document was presented without reproducing one.
 */
function writeReceipt(body: Record<string, unknown>): void {
  const supplied = process.env['TRIO_ORDINARY_RECEIPT_ROOT']
    ?? process.env['TRIO_QUALIFICATION_RECEIPT_ROOT'];
  if (supplied === undefined || supplied.length === 0 || !isAbsolute(supplied)) return;
  try {
    if (within(realpathSync(REPOSITORY_ROOT), resolve(supplied))) return;
    mkdirSync(supplied, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeFileSync(join(supplied, `${stamp}-ordinary-${String(body.fingerprint ?? 'none')}.json`),
      `${JSON.stringify({ ...body, modelCalls: 0, toolCalls: 0, mutations: 0 }, null, 1)}\n`);
  } catch {
    // Evidence, never a decision: a receipt that cannot be written must not admit anything and
    // must not crash a refusal.
  }
}

function refuse(
  category: WorkCategory,
  state: OperationalState,
  reason: OrdinaryRefusalReason,
  detail: Record<string, unknown>,
): OrdinaryDecision {
  writeReceipt({ time: new Date().toISOString(), decision: 'REFUSED',
    refusalCode: 'ORDINARY_WORK_NOT_EXTERNALLY_AUTHORIZED', reason, state, category, ...detail });
  return {
    admitted: false,
    refusal: {
      code: 'ORDINARY_WORK_NOT_EXTERNALLY_AUTHORIZED',
      state,
      category,
      nextAction: 'ordinary work requires a root-owned external authorization for this exact deployment; no runtime override exists',
    },
  };
}

/** Read the subject's own identity from the checkout this code lives in, never from a caller. */
function subjectIdentity(): { commit: string; tree: string; dirty: string } {
  const run = (args: readonly string[]): string =>
    execFileSync('git', ['-C', REPOSITORY_ROOT, ...args], { encoding: 'utf8' }).trim();
  return {
    commit: run(['rev-parse', 'HEAD']),
    tree: run(['rev-parse', 'HEAD^{tree}']),
    dirty: run(['status', '--porcelain']),
  };
}

function malformed(record: Record<string, unknown>): string | undefined {
  const keys = Object.keys(record).sort();
  for (const key of REQUIRED_KEYS) if (!keys.includes(key)) return `the authorization is missing ${key}`;
  for (const key of keys)
    if (!REQUIRED_KEYS.includes(key) && !OPTIONAL_KEYS.includes(key))
      return `the authorization carries an unknown field ${key}`;
  const policy = (record as { localStatusPolicy?: unknown }).localStatusPolicy;
  if (policy !== undefined && policy !== 'REQUIRE_LOCAL_PRODUCTION' && policy !== 'EXTERNAL_ACTIVATION')
    return 'localStatusPolicy is not a recognised policy';
  const anchor = (record as { principalIssuer?: unknown }).principalIssuer;
  if (anchor !== undefined) {
    if (anchor === null || typeof anchor !== 'object' || Array.isArray(anchor))
      return 'principalIssuer is not an object';
    const a = anchor as Record<string, unknown>;
    if (typeof a['id'] !== 'string' || typeof a['keyId'] !== 'string' || typeof a['publicKeyPem'] !== 'string')
      return 'principalIssuer is missing id, keyId or publicKeyPem';
    if (String(a['publicKeyPem']).includes('PRIVATE KEY'))
      return 'principalIssuer carries private key material';
  }
  const generation = (record as { principalIssuerGeneration?: unknown }).principalIssuerGeneration;
  if (generation !== undefined && (!Number.isInteger(generation) || (generation as number) < 1))
    return 'principalIssuerGeneration is not a positive integer';
  const a = record as unknown as Authorization;
  if (typeof a.generation !== 'number' || !Number.isInteger(a.generation) || a.generation < 1)
    return 'generation is not a positive integer';
  if (typeof a.agent !== 'string' || typeof a.role !== 'string') return 'agent or role is not a string';
  if (typeof a.codeRoot !== 'string' || !isAbsolute(a.codeRoot)) return 'codeRoot is not an absolute path';
  if (a.subject === null || typeof a.subject !== 'object') return 'subject is not an object';
  if (!FULL_SHA.test(a.subject.commit ?? '') || !FULL_SHA.test(a.subject.tree ?? ''))
    return 'subject.commit or subject.tree is not a full 40-character id';
  if (!DIGEST.test(a.closureSha256 ?? '') || !DIGEST.test(a.policySha256 ?? ''))
    return 'a digest field is not a sha256 digest';
  for (const list of ['lanes', 'workTypes', 'capabilityCeiling'] as const) {
    const value = a[list];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
      return `${list} is not an array of strings`;
    if (new Set(value).size !== value.length) return `${list} contains a duplicate`;
  }
  if (typeof a.workspacePolicyId !== 'string' || a.workspacePolicyId.length === 0)
    return 'workspacePolicyId is empty';
  if (!Number.isFinite(Date.parse(a.notBefore)) || !Number.isFinite(Date.parse(a.expiresAt)))
    return 'notBefore or expiresAt is not a timestamp';
  if (typeof a.renewalSeconds !== 'number' || !Number.isFinite(a.renewalSeconds) || a.renewalSeconds <= 0)
    return 'renewalSeconds is not a positive number';
  return undefined;
}

/**
 * Decide whether ordinary work may proceed, given the local gate's answer.
 *
 * `decision` is returned UNCHANGED when the local gate refused. That is deliberate and load
 * bearing: this function exists to remove sufficiency from the local manifest, not to add a second
 * way to be admitted, and the qualification path downstream must keep seeing the refusal it
 * already knows how to handle.
 */
export function admitOrdinaryWork(decision: AdmissionDecision, request: OrdinaryRequest): OrdinaryDecision {
  /*
    EXTERNAL ACTIVATION.

    Phase 1 required BOTH a local PRODUCTION manifest and this lease, which made external
    activation impossible without editing the repository -- the exact self-authorization the
    boundary exists to prevent. A lease may now carry `localStatusPolicy: EXTERNAL_ACTIVATION`,
    which says: the authority outside this tree has looked at THIS commit, tree, policy digest and
    closure and activated it, so the committed status is descriptive rather than decisive.

    A copied repository gains nothing from this. Activation is not read from the repository at all,
    and a tree that edits its own manifest changes its policy digest, which no lease names. The
    local status can still narrow; it can no longer grant, and it can no longer veto an authority
    that outranks it.

    Absent the field, the Phase-1 conjunction is unchanged -- so nothing changes until a
    root-owned record says so.
  */
  const state: OperationalState = decision.admitted ? decision.state
    : (decision.refusal.state === 'UNKNOWN' ? 'PRE_PRODUCTION' : decision.refusal.state);
  const category: WorkCategory = request.lane === 'converse' ? 'ordinary-work' : 'agent-run';
  const base = { subject: request.agentName, lane: request.lane };

  // The record is read FIRST, because whether a local refusal is final depends on what the
  // external authority says about this deployment -- and that question cannot be answered from
  // inside the repository being asked about.
  let record: Record<string, unknown>;
  try {
    record = readOrdinaryAuthorizationRecord(process.env) as Record<string, unknown>;
  } catch (error) {
    // No readable external authority: a local refusal stands exactly as it did, unchanged, so the
    // qualification path downstream still sees the refusal it knows how to handle.
    if (!decision.admitted) return decision;
    const code = (error as { code?: string }).code ?? 'unknown';
    const reason: OrdinaryRefusalReason = code === 'missing_credential' || code === 'no_credential_channel'
      ? 'NO_AUTHORIZATION_PRESENTED'
      : code === 'malformed_record' ? 'MALFORMED_AUTHORIZATION' : 'CHANNEL_REFUSED';
    return refuse(category, state, reason, { ...base, channel: code });
  }

  const declaredPolicy = (record as { localStatusPolicy?: unknown }).localStatusPolicy;
  const externallyActivated = declaredPolicy === 'EXTERNAL_ACTIVATION';
  // A local refusal is final unless a root-owned lease has explicitly activated THIS deployment.
  // Absent the field the Phase-1 conjunction is unchanged, so nothing moves until root says so.
  if (!decision.admitted && !externallyActivated) return decision;

  const fingerprint = createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 16);
  const identified = { ...base, fingerprint };

  const shapeError = malformed(record);
  if (shapeError !== undefined)
    return refuse(category, state, 'MALFORMED_AUTHORIZATION', { ...identified, detail: shapeError });

  const auth = record as unknown as Authorization;
  if (auth.schema !== SCHEMA) return refuse(category, state, 'UNKNOWN_SCHEMA', identified);
  if (auth.operationalAuthorization !== 'AUTHORIZED_FOR_ORDINARY_WORK')
    return refuse(category, state, 'NOT_AUTHORIZED_FOR_ORDINARY_WORK', identified);
  if (auth.agent !== request.agentName || auth.role !== request.agentRole)
    return refuse(category, state, 'AGENT_MISMATCH', identified);

  let codeRoot: string;
  try {
    codeRoot = realpathSync(REPOSITORY_ROOT);
  } catch {
    return refuse(category, state, 'SUBJECT_UNREADABLE', identified);
  }
  // Resolved on both sides: a symlinked or `..`-built path cannot impersonate the admitted root.
  let declaredRoot: string;
  try {
    declaredRoot = realpathSync(auth.codeRoot);
  } catch {
    return refuse(category, state, 'CODE_ROOT_MISMATCH', identified);
  }
  if (declaredRoot !== codeRoot) return refuse(category, state, 'CODE_ROOT_MISMATCH', identified);

  let subject: { commit: string; tree: string; dirty: string };
  try {
    subject = subjectIdentity();
  } catch {
    return refuse(category, state, 'SUBJECT_UNREADABLE', identified);
  }
  if (auth.subject.commit !== subject.commit || auth.subject.tree !== subject.tree)
    return refuse(category, state, 'SUBJECT_MISMATCH', identified);
  if (subject.dirty !== '') return refuse(category, state, 'SUBJECT_TREE_DIRTY', identified);

  let policy: string;
  let closure: string;
  try {
    policy = policyDigest();
    closure = closureDigest();
  } catch {
    return refuse(category, state, 'SUBJECT_UNREADABLE', identified);
  }
  if (auth.policySha256 !== policy) return refuse(category, state, 'POLICY_DIGEST_MISMATCH', identified);
  if (auth.closureSha256 !== closure) return refuse(category, state, 'CLOSURE_DIGEST_MISMATCH', identified);

  if (!auth.lanes.includes(request.lane)) return refuse(category, state, 'LANE_NOT_PERMITTED', identified);
  if (!auth.workTypes.includes(category)) return refuse(category, state, 'WORK_TYPE_NOT_PERMITTED', identified);

  const now = Date.now();
  if (now < Date.parse(auth.notBefore)) return refuse(category, state, 'NOT_YET_VALID', identified);
  if (now >= Date.parse(auth.expiresAt)) return refuse(category, state, 'EXPIRED', identified);

  const requested = request.toolNames ?? [];
  const ceiling = new Set(auth.capabilityCeiling);
  const broadened = requested.filter((name) => !ceiling.has(name));
  if (broadened.length > 0)
    return refuse(category, state, 'CAPABILITY_BROADENED', { ...identified, broadened });

  writeReceipt({ time: new Date().toISOString(), decision: 'ADMITTED', refusalCode: null,
    reason: 'ORDINARY_WORK_EXTERNALLY_AUTHORIZED', state, category, ...identified,
    generation: auth.generation, expiresAt: auth.expiresAt, workspacePolicyId: auth.workspacePolicyId });

  return {
    admitted: true,
    state,
    ordinaryGrant: {
      generation: auth.generation,
      localStatusPolicy: auth.localStatusPolicy ?? 'REQUIRE_LOCAL_PRODUCTION',
      ...(auth.principalIssuer !== undefined
        ? { principalIssuer: {
            id: auth.principalIssuer.id, keyId: auth.principalIssuer.keyId,
            publicKeyPem: auth.principalIssuer.publicKeyPem,
            generation: auth.principalIssuerGeneration ?? 1,
            ledgerRoot: auth.principalLedgerRoot,
          } }
        : {}),
      lane: request.lane,
      workspacePolicyId: auth.workspacePolicyId,
      expiresAt: auth.expiresAt,
      fingerprint,
      // An intersection, never a union: an authorization can only narrow a lane.
      ...(request.toolNames !== undefined
        ? { toolNames: requested.filter((name) => ceiling.has(name)) } : {}),
    },
  };
}

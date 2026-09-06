/**
 * THE QUALIFICATION ADMISSION — the one narrow way a locked agent may execute, and only to be
 * measured.
 *
 * The governed manifest names its clearing condition as an independent Hermes-equivalence
 * audit. That audit has to run the agent to produce evidence, and the agent will not run until
 * the audit clears it, so the condition could not be satisfied as written. This module is the
 * smallest correction to that: not a relaxation of the boundary, and not a second boundary, but
 * a capability the boundary can be handed that it can check rather than believe.
 *
 * WHAT MAKES IT DIFFERENT FROM THE GATE THAT WAS REMOVED.
 *
 * The first attempt at admission took a caller-supplied `purpose` and a caller-supplied
 * `authority`, and the authority was a plaintext constant exported from shared core. Every
 * in-process caller could read it, label its work `self-test`, and be admitted -- and reuse the
 * same string tomorrow for something else. That is why nothing the caller says is consulted on
 * the production path, and why nothing here reintroduces it:
 *
 *   - The admission is minted OUTSIDE this repository, by an issuer holding a private key that
 *     exists nowhere in this tree. This module carries the public half and can therefore verify
 *     and NARROW an admission. There is no function here, reachable or otherwise, that creates
 *     one, and no value in this repository from which one could be derived.
 *   - It is not a label. Every field that decides is bound into a signed document: the agent,
 *     the exact commit and tree of the subject, the task, the fixture directory, the tool set,
 *     a validity window and a nonce. Changing one byte of any of them invalidates the
 *     signature, so a caller cannot broaden what it was given.
 *   - It is spent, not held. One admission authorises one run. Consumption is an atomic
 *     exclusive create in a ledger outside this repository, performed BEFORE the run reaches a
 *     model or a tool, and never rolled back -- so a crashed, failed or interrupted run has
 *     still spent it.
 *   - It cannot become a production credential. It is consulted only when the committed status
 *     is locked, its permitted operation set is a literal that names no production category,
 *     and a manifest claiming PRODUCTION refuses it outright rather than compounding with it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not unlock the agent, it does not persist, it does
 * not survive the run that spends it, and it grants no capability the run did not already ask
 * for -- the tool lane it produces is an intersection, never a union. A refusal here is
 * indistinguishable, from the caller's side, from the ordinary locked refusal.
 */
import { execFileSync } from 'node:child_process';
import { createPublicKey, createHash, verify as edVerify } from 'node:crypto';
import { openSync, closeSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AdmissionDecision, AdmissionRefusal, OperationalState, WorkCategory } from './operational-admission.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(here, '..', '..');

/**
 * The committed trust anchor: the issuer's PUBLIC half and nothing else.
 *
 * Deliberately not exported. A guard in this repository refuses any exported value whose
 * literal reads as a capability, and it is right to: an exported constant is something a
 * caller can obtain, and nothing about admission should be obtainable. The verifier needs
 * the path; nobody else does.
 */
const ISSUER_ANCHOR_PATH = 'trio/governance/qualification-issuer.json';

/** The only schema this verifier understands. A different one is a refusal, not a negotiation. */
const SCHEMA = 'trio-qualification-admission/1';

/** The only operation a qualification admission may name. No production category appears here. */
const PERMITTED_OPERATIONS: readonly string[] = Object.freeze(['agent-run']);

/**
 * Directory roots a qualification run may never be pointed at.
 *
 * A qualification exists to run an agent against a disposable fixture. If a fixture root
 * resolves inside a source repository, the agent's own tree, the production agent's home or a
 * system path, the admission is refused whatever it is signed with -- a correctly signed
 * admission naming a production path is exactly the shape this must not honour.
 */
const FORBIDDEN_FIXTURE_ROOTS: readonly string[] = Object.freeze([
  '/pehverse/repos', '/home/zen/.hermes', '/etc', '/usr', '/var', '/boot', '/bin', '/sbin', '/lib', '/opt', '/root'
]);

/** Why a qualification was not admitted. The detail lands in the receipt, never in the refusal. */
export type QualificationRefusalReason =
  | 'NO_ADMISSION_PRESENTED'
  | 'MALFORMED_ADMISSION'
  | 'UNKNOWN_SCHEMA'
  | 'UNKNOWN_ISSUER'
  | 'TRUST_ANCHOR_UNREADABLE'
  | 'SIGNATURE_INVALID'
  | 'MULTI_USE_REQUESTED'
  | 'OPERATION_NOT_PERMITTED'
  | 'STATUS_NOT_LOCKED'
  | 'AGENT_MISMATCH'
  | 'SUBJECT_MISMATCH'
  | 'SUBJECT_TREE_DIRTY'
  | 'SUBJECT_UNREADABLE'
  | 'TASK_MISMATCH'
  | 'WORK_ORDER_MISMATCH'
  | 'FIXTURE_MISMATCH'
  | 'FIXTURE_FORBIDDEN'
  | 'FIXTURE_UNRESOLVABLE'
  | 'NOT_YET_VALID'
  | 'EXPIRED'
  | 'CAPABILITY_BROADENED'
  | 'ALREADY_CONSUMED'
  | 'LEDGER_UNAVAILABLE';

/** What a run must state about itself before an admission can be checked against it. */
export interface QualificationRequest {
  readonly agentName: string;
  readonly agentRole: string;
  readonly taskId: string;
  /**
   * The work order this run believes it is executing.
   *
   * A narrowing check only. A caller that lies about it gains nothing -- the admission still
   * binds the agent, the commit, the tree, the task and the fixture -- but a launcher that
   * states the truth cannot spend an admission issued for different work.
   */
  readonly workOrderId?: string | undefined;
  readonly workspaceRoot: string;
  readonly toolNames: readonly string[];
  /** The presented admission, exactly as the issuer produced it. Absent means refused. */
  readonly admission?: string | undefined;
}

/** The narrowing a verified admission imposes on the run that spends it. */
export interface QualificationGrant {
  readonly workOrderId: string;
  readonly auditId: string;
  readonly taskId: string;
  readonly nonce: string;
  readonly fingerprint: string;
  readonly fixtureRoot: string;
  readonly toolNames: readonly string[];
  readonly expiresAt: string;
}

export type QualifiedDecision =
  | { readonly admitted: true; readonly state: OperationalState; readonly grant?: QualificationGrant }
  | { readonly admitted: false; readonly refusal: AdmissionRefusal };

interface Claims {
  readonly schema: string;
  readonly issuer: { readonly id: string; readonly version: string; readonly keyId: string };
  readonly auditId: string;
  readonly workOrderId: string;
  readonly agent: { readonly name: string; readonly role: string };
  readonly subject: { readonly commit: string; readonly tree: string };
  readonly taskId: string;
  readonly fixtureRoot: string;
  readonly capabilities: readonly string[];
  readonly operations: readonly string[];
  readonly issuedAt: string;
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly maxUses: number;
  readonly ledgerRoot: string;
  readonly receiptRoot: string;
}

/** Canonical JSON: sorted keys, no insignificant whitespace. The issuer signs exactly this. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record).sort().map((k) => JSON.stringify(k) + ':' + canonical(record[k])).join(',') + '}';
}

/**
 * The durable record of a pre-model decision.
 *
 * An exception handed back to the caller is not an audit trail: it exists only in the process
 * that raised it, and a caller is free to swallow it. Every decision this module makes leaves a
 * file instead, carrying the fingerprint of what was presented and never the admission itself.
 */
function writeReceipt(root: string | undefined, body: Record<string, unknown>): void {
  const supplied = root ?? process.env['TRIO_QUALIFICATION_RECEIPT_ROOT'];
  // No writable record location, no record. A receipt is evidence, never a decision: its
  // absence must not turn a refusal into an admission, and it must never be written into a
  // repository, which is the one place a durable audit record does not belong.
  if (supplied === undefined || supplied.length === 0 || !isAbsolute(supplied)) return;
  if (within(realpathSync(REPOSITORY_ROOT), resolve(supplied))) return;
  const target = supplied;
  try {
    mkdirSync(target, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${stamp}-${String(body.fingerprint ?? 'unparseable')}.json`;
    writeFileSync(join(target, name), JSON.stringify({ ...body, modelCalls: 0, toolCalls: 0, mutations: 0 }, null, 1) + '\n');
  } catch {
    // A receipt that cannot be written must not turn a refusal into an admission, and must not
    // turn an admission into a crash. The decision stands either way.
  }
}

function fingerprintOf(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/** Read the subject's own identity. Not from the caller: from the checkout this code lives in. */
function subjectIdentity(): { commit: string; tree: string; dirty: string } {
  const run = (args: readonly string[]): string =>
    execFileSync('git', ['-C', REPOSITORY_ROOT, ...args], { encoding: 'utf8' }).trim();
  return { commit: run(['rev-parse', 'HEAD']), tree: run(['rev-parse', 'HEAD^{tree}']), dirty: run(['status', '--porcelain']) };
}

/** True when `child` is `parent` or lives beneath it. Both sides are already resolved. */
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Spend the admission, atomically, before anything else happens.
 *
 * `wx` fails if the file exists, and that failure is the whole of the single-use property: two
 * processes racing the same nonce cannot both create it, and a run that dies after this point
 * has still spent it, because nothing here ever removes it.
 */
function consume(claims: Claims): boolean {
  try {
    mkdirSync(claims.ledgerRoot, { recursive: true });
  } catch {
    return false;
  }
  try {
    closeSync(openSync(join(claims.ledgerRoot, `${claims.nonce}.used`), 'wx'));
    return true;
  } catch {
    return false;
  }
}

/** Record a decision without making one. Used where the decision has already been taken. */
function record(
  decisionLabel: string,
  reason: QualificationRefusalReason,
  state: OperationalState | 'UNKNOWN',
  category: WorkCategory,
  detail: Record<string, unknown>,
): void {
  writeReceipt(undefined, {
    time: new Date().toISOString(),
    decision: decisionLabel,
    refusalCode: 'OPERATIONAL_WORK_NOT_AUTHORIZED',
    reason,
    state,
    category,
    ...detail,
  });
}

function refuse(
  category: WorkCategory,
  state: OperationalState | 'UNKNOWN',
  reason: QualificationRefusalReason,
  receiptRoot: string | undefined,
  detail: Record<string, unknown>,
): QualifiedDecision {
  writeReceipt(receiptRoot, {
    time: new Date().toISOString(),
    decision: 'REFUSED',
    refusalCode: 'QUALIFICATION_NOT_ADMITTED',
    reason,
    state,
    category,
    ...detail,
  });
  return {
    admitted: false,
    refusal: {
      code: 'QUALIFICATION_NOT_ADMITTED',
      state,
      category,
      nextAction: 'a qualification admission issued outside this repository is required; no runtime override exists',
    },
  };
}

/**
 * Decide whether a locked run may proceed as a qualification.
 *
 * `decision` is the ordinary gate's answer and is returned untouched when it admits: a
 * qualification never competes with, augments or overrides a production admission. Everything
 * below runs only because the ordinary gate said no.
 */
export function qualifyRun(decision: AdmissionDecision, request: QualificationRequest): QualifiedDecision {
  if (decision.admitted) return decision;
  const state = decision.refusal.state;
  const category = decision.refusal.category;
  const token = request.admission;

  // Presenting nothing is not a qualification failure -- it is the ordinary locked refusal,
  // and it must stay byte-for-byte the answer it was before this module existed. A caller who
  // never heard of qualification sees no new code, no new shape and no new behaviour.
  if (typeof token !== 'string' || token.length === 0) {
    record('REFUSED', 'NO_ADMISSION_PRESENTED', state, category, { subject: request.agentName, taskId: request.taskId });
    return decision;
  }

  const fingerprint = fingerprintOf(token);
  const base = { subject: request.agentName, taskId: request.taskId, fingerprint };

  let claims: Claims;
  let signature: string;
  try {
    const envelope = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as { claims: Claims; signature: string };
    claims = envelope.claims;
    signature = envelope.signature;
    if (typeof signature !== 'string' || claims === null || typeof claims !== 'object') throw new Error('shape');
  } catch {
    return refuse(category, state, 'MALFORMED_ADMISSION', undefined, base);
  }

  const receiptRoot = typeof claims.receiptRoot === 'string' ? claims.receiptRoot : undefined;
  const identified = { ...base, workOrderId: claims.workOrderId, auditId: claims.auditId, nonce: claims.nonce };

  if (claims.schema !== SCHEMA) return refuse(category, state, 'UNKNOWN_SCHEMA', receiptRoot, identified);

  let anchor: { issuer: string; keyId: string; publicKeyPem: string; algorithm: string };
  try {
    anchor = JSON.parse(readFileSync(join(REPOSITORY_ROOT, ISSUER_ANCHOR_PATH), 'utf8')) as typeof anchor;
  } catch {
    return refuse(category, state, 'TRUST_ANCHOR_UNREADABLE', receiptRoot, identified);
  }
  if (claims.issuer?.id !== anchor.issuer || claims.issuer?.keyId !== anchor.keyId || anchor.algorithm !== 'ed25519')
    return refuse(category, state, 'UNKNOWN_ISSUER', receiptRoot, identified);

  let signatureValid = false;
  try {
    signatureValid = edVerify(
      null,
      Buffer.from(canonical(claims), 'utf8'),
      createPublicKey(anchor.publicKeyPem),
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) return refuse(category, state, 'SIGNATURE_INVALID', receiptRoot, identified);

  // --- everything below is checked against a document that cannot have been altered ---------

  if (claims.maxUses !== 1) return refuse(category, state, 'MULTI_USE_REQUESTED', receiptRoot, identified);
  if (!Array.isArray(claims.operations) || claims.operations.length !== 1
      || !PERMITTED_OPERATIONS.includes(claims.operations[0] ?? ''))
    return refuse(category, state, 'OPERATION_NOT_PERMITTED', receiptRoot, identified);

  // A qualification is meaningful only while the subject is locked. A manifest claiming
  // PRODUCTION -- including a copied one -- refuses here rather than compounding.
  if (state !== 'PRE_PRODUCTION') return refuse(category, state, 'STATUS_NOT_LOCKED', receiptRoot, identified);

  if (claims.agent?.name !== request.agentName || claims.agent?.role !== request.agentRole)
    return refuse(category, state, 'AGENT_MISMATCH', receiptRoot, identified);

  let subject: { commit: string; tree: string; dirty: string };
  try {
    subject = subjectIdentity();
  } catch {
    return refuse(category, state, 'SUBJECT_UNREADABLE', receiptRoot, identified);
  }
  if (claims.subject?.commit !== subject.commit || claims.subject?.tree !== subject.tree)
    return refuse(category, state, 'SUBJECT_MISMATCH', receiptRoot, identified);
  if (subject.dirty !== '') return refuse(category, state, 'SUBJECT_TREE_DIRTY', receiptRoot, identified);

  if (claims.taskId !== request.taskId) return refuse(category, state, 'TASK_MISMATCH', receiptRoot, identified);
  if (request.workOrderId !== undefined && claims.workOrderId !== request.workOrderId)
    return refuse(category, state, 'WORK_ORDER_MISMATCH', receiptRoot, identified);

  let fixtureRoot: string;
  let workspaceRoot: string;
  try {
    fixtureRoot = realpathSync(claims.fixtureRoot);
    workspaceRoot = realpathSync(resolve(request.workspaceRoot));
  } catch {
    return refuse(category, state, 'FIXTURE_UNRESOLVABLE', receiptRoot, identified);
  }
  if (fixtureRoot !== workspaceRoot) return refuse(category, state, 'FIXTURE_MISMATCH', receiptRoot, identified);
  if (within(realpathSync(REPOSITORY_ROOT), fixtureRoot)
      || FORBIDDEN_FIXTURE_ROOTS.some((root) => within(root, fixtureRoot)))
    return refuse(category, state, 'FIXTURE_FORBIDDEN', receiptRoot, identified);

  const now = Date.now();
  const notBefore = Date.parse(claims.notBefore);
  const expiresAt = Date.parse(claims.expiresAt);
  if (!Number.isFinite(notBefore) || !Number.isFinite(expiresAt))
    return refuse(category, state, 'MALFORMED_ADMISSION', receiptRoot, identified);
  if (now < notBefore) return refuse(category, state, 'NOT_YET_VALID', receiptRoot, identified);
  if (now >= expiresAt) return refuse(category, state, 'EXPIRED', receiptRoot, identified);

  const granted = new Set(claims.capabilities ?? []);
  const broadened = request.toolNames.filter((name) => !granted.has(name));
  if (broadened.length > 0)
    return refuse(category, state, 'CAPABILITY_BROADENED', receiptRoot, { ...identified, broadened });

  // Spend it. Nothing below this line can give it back.
  if (!consume(claims)) return refuse(category, state, 'ALREADY_CONSUMED', receiptRoot, identified);

  writeReceipt(receiptRoot, {
    time: new Date().toISOString(),
    decision: 'ADMITTED',
    refusalCode: null,
    reason: 'QUALIFICATION_CONSUMED',
    state,
    category,
    ...identified,
    fixtureRoot,
    capabilities: [...request.toolNames].sort(),
  });

  return {
    admitted: true,
    state,
    grant: {
      workOrderId: claims.workOrderId,
      auditId: claims.auditId,
      taskId: claims.taskId,
      nonce: claims.nonce,
      fingerprint,
      fixtureRoot,
      // An intersection, never a union: an admission can only ever narrow the lane.
      toolNames: request.toolNames.filter((name) => granted.has(name)),
      expiresAt: claims.expiresAt,
    },
  };
}

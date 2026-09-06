/**
 * DELEGATED AUTHORITY — a child run's authority is a narrowing of its parent's, and nothing else.
 *
 * `runAgentInShadow` is how cron jobs and delegated sub-agents start real work: a real driver, a
 * real tool lane, a real model. Until now it consulted the committed status gate alone, so while
 * the agent and conversational lanes were being bound to an externally issued principal, the
 * delegated lane kept the old, softer answer. Two enforcement paths for one policy is how the
 * softer one becomes the way in, and this was that path.
 *
 * A delegation is NOT a second kind of authority. It is a derived, narrowed, cryptographically
 * bound statement about an authorization that already happened:
 *
 *   - it is MINTED only from a completed lane authorization, which required an externally issued
 *     principal. There is no way to produce one from a service lease alone, and no way to produce
 *     one from a qualification admission: a different schema, a different verifier, a different
 *     anchor, and a MAC that will not check out;
 *   - it can only NARROW. Its capability ceiling is the parent's EFFECTIVE capabilities, its
 *     expiry is no later than the parent's, and the child's request is intersected with it again
 *     at use time. A child that asks for more gets less, never more;
 *   - the child cannot MINT, RENEW or BROADEN. Minting requires a completed parent authorization
 *     value, which a tool handler never holds, and `mintDelegation` is not exported from the
 *     package. Each generation may hand down a delegation one level deeper, bounded by `maxDepth`;
 *   - the parent can REVOKE. A cancellation marker in the shared ledger stops every new admission
 *     under that parent request, immediately, without touching a run already in flight;
 *   - replay is EXPLICIT. `SINGLE_USE` is spent once, `REUSABLE_WITHIN_WINDOW` is spent at most
 *     `maxUses` times, and both are settled by `openSync(..., 'wx')` before the delegation
 *     authorises anything, so two concurrent children cannot both spend the last use, and a
 *     crash after consumption leaves it spent.
 *
 * WHERE THE KEY COMES FROM, and what that does and does not buy.
 *
 * The MAC key is derived from the root-owned service lease this deployment was activated with:
 * never from the repository, never from the environment, never from anything a caller supplies.
 * A process that cannot read this deployment's lease cannot mint or verify a delegation, so a
 * copied repository, a foreign agent and an outside attacker are all excluded, and rotating the
 * lease invalidates every outstanding delegation at once.
 *
 * What it does NOT buy: separation between a parent and a child that run as the SAME user. Any key
 * a same-uid child can read to verify, it could also have read to mint. That is a property of the
 * uid boundary, not of this construction, and it is stated here rather than papered over. The
 * binding that survives it is the one that matters in practice: a delegation is useless outside
 * the exact parent request, agent, code root, lane, work type, capability subset, workspace policy
 * and validity window it names.
 */
import { createHash, createHmac, hkdfSync, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { readOrdinaryAuthorizationRecord } from '../../scripts/trio/external-identity.mjs';

/** The only schema this verifier understands. Distinct from the lease, principal and qualification. */
const SCHEMA = 'pehverse-delegation/1';

/** Domain separation. The lease digest is used for nothing else, and this key for nothing else. */
const KEY_SALT = 'pehverse-delegation-key/1';

/** How deep a chain of delegations may go before it is refused outright. */
export const MAX_DELEGATION_DEPTH = 3;

/** How long a minted delegation lives, unless the parent's own expiry is sooner. */
const DEFAULT_TTL_SECONDS = 900;

const REQUIRED_KEYS: readonly string[] = Object.freeze([
  'schema', 'id', 'parent', 'audience', 'lane', 'workTypes', 'capabilityCeiling',
  'workspacePolicy', 'seedFrom', 'depth', 'maxDepth', 'notBefore', 'expiresAt', 'replay', 'maxUses',
]);

const REPLAY_POLICIES: readonly string[] = Object.freeze(['SINGLE_USE', 'REUSABLE_WITHIN_WINDOW']);

export type DelegationRefusalReason =
  | 'NO_DELEGATION_PRESENTED'
  | 'MALFORMED_DELEGATION'
  | 'UNKNOWN_SCHEMA'
  | 'NO_DELEGATION_KEY'
  | 'MAC_INVALID'
  | 'AUDIENCE_MISMATCH'
  | 'LANE_NOT_PERMITTED'
  | 'WORK_TYPE_NOT_PERMITTED'
  | 'DEPTH_EXCEEDED'
  | 'WORKSPACE_POLICY_MISMATCH'
  | 'NOT_YET_VALID'
  | 'EXPIRED'
  | 'PARENT_REVOKED'
  | 'UNKNOWN_REPLAY_POLICY'
  | 'ALREADY_CONSUMED'
  | 'LEDGER_UNAVAILABLE';

/** What a completed lane authorization states about itself when it hands authority down. */
export interface DelegationParent {
  readonly requestId: string;
  readonly agent: string;
  readonly codeRoot: string;
  readonly principalId: string;
  readonly principalFingerprint: string;
  readonly leaseGeneration: number;
  readonly leaseFingerprint: string;
  /** The parent's EFFECTIVE capabilities. A delegation ceiling is never wider than this. */
  readonly effectiveCapabilities: readonly string[];
  readonly expiresAt: string;
  /** 0 for a request authorised by a principal; n for one authorised by a depth-n delegation. */
  readonly depth: number;
}

export interface DelegationMintOptions {
  readonly workspacePolicy?: string;
  readonly seedFrom?: string | undefined;
  readonly ttlSeconds?: number;
  readonly replay?: 'SINGLE_USE' | 'REUSABLE_WITHIN_WINDOW';
  readonly maxUses?: number;
  readonly clock?: () => number;
}

export interface DelegationRequest {
  readonly agent: string;
  readonly codeRoot: string;
  readonly lane: string;
  readonly workType: string;
  readonly workspacePolicy: string;
  /** Where SINGLE_USE and bounded-reuse delegations are spent, and where revocation is recorded. */
  readonly ledgerRoot?: string | undefined;
  readonly assertion?: string | undefined;
  readonly clock?: () => number;
}

export interface VerifiedDelegation {
  readonly id: string;
  readonly parentRequestId: string;
  readonly parentPrincipalId: string;
  readonly capabilityCeiling: readonly string[];
  readonly depth: number;
  readonly maxDepth: number;
  readonly expiresAt: string;
  readonly replay: string;
  readonly workspacePolicy: string;
  readonly seedFrom: string | null;
  /** A digest of the delegation. Enough to tie a receipt to a document, never to reproduce one. */
  readonly fingerprint: string;
}

export type DelegationDecision =
  | { readonly verified: true; readonly delegation: VerifiedDelegation }
  | { readonly verified: false; readonly reason: DelegationRefusalReason; readonly fingerprint?: string };

interface Claims {
  readonly schema: string;
  readonly id: string;
  readonly parent: {
    readonly requestId: string; readonly principalId: string; readonly principalFingerprint: string;
    readonly leaseGeneration: number; readonly leaseFingerprint: string;
  };
  readonly audience: { readonly agent: string; readonly codeRoot: string };
  readonly lane: string;
  readonly workTypes: readonly string[];
  readonly capabilityCeiling: readonly string[];
  readonly workspacePolicy: string;
  readonly seedFrom: string | null;
  readonly depth: number;
  readonly maxDepth: number;
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly replay: string;
  readonly maxUses: number;
}

/** Canonical JSON: sorted keys, no insignificant whitespace. The MAC covers exactly this. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(',')}}`;
}

/**
 * The MAC key for THIS deployment, derived from the lease that activated it.
 *
 * Returns undefined when no lease can be read, which refuses rather than falling back: a
 * deployment with no external activation has no delegated authority to hand down either.
 *
 * The derivation is deliberately unrelated to the lease fingerprint that appears in receipts:
 * that is a truncated sha256 of the record, this is HKDF over a sha512 of it under a distinct
 * salt, and neither yields the other.
 */
function delegationKey(): Buffer | undefined {
  let record: unknown;
  try {
    record = readOrdinaryAuthorizationRecord(process.env);
  } catch {
    return undefined;
  }
  const lease = record as { agent?: unknown; codeRoot?: unknown; generation?: unknown };
  const info = `${String(lease.agent)} ${String(lease.codeRoot)} ${String(lease.generation)}`;
  const ikm = createHash('sha512').update(canonical(record), 'utf8').digest();
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.from(KEY_SALT, 'utf8'), Buffer.from(info, 'utf8'), 32));
}

function mac(key: Buffer, claims: Claims): string {
  return createHmac('sha256', key).update(canonical(claims), 'utf8').digest('base64url');
}

function shapeError(record: Record<string, unknown>): string | undefined {
  const keys = Object.keys(record).sort();
  const required = [...REQUIRED_KEYS].sort();
  for (const key of required) if (!keys.includes(key)) return `missing ${key}`;
  for (const key of keys) if (!required.includes(key)) return `unknown field ${key}`;

  const c = record as unknown as Claims;
  for (const [name, value] of [['parent', c.parent], ['audience', c.audience]] as const) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return `${name} is not an object`;
  }
  if (typeof c.id !== 'string' || c.id.length === 0) return 'id is empty';
  if (typeof c.parent.requestId !== 'string' || c.parent.requestId.length === 0) return 'parent.requestId is empty';
  if (typeof c.parent.principalId !== 'string' || c.parent.principalId.length === 0) return 'parent.principalId is empty';
  if (typeof c.parent.principalFingerprint !== 'string') return 'parent.principalFingerprint is not a string';
  if (typeof c.parent.leaseFingerprint !== 'string') return 'parent.leaseFingerprint is not a string';
  if (!Number.isInteger(c.parent.leaseGeneration) || c.parent.leaseGeneration < 1)
    return 'parent.leaseGeneration is not a positive integer';
  if (typeof c.audience.agent !== 'string' || typeof c.audience.codeRoot !== 'string')
    return 'audience is not two strings';
  if (!isAbsolute(c.audience.codeRoot)) return 'audience.codeRoot is not absolute';
  if (typeof c.lane !== 'string' || c.lane.length === 0) return 'lane is empty';
  for (const list of ['workTypes', 'capabilityCeiling'] as const) {
    const value = c[list];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
      return `${list} is not an array of strings`;
    if (new Set(value).size !== value.length) return `${list} contains a duplicate`;
  }
  if (typeof c.workspacePolicy !== 'string' || c.workspacePolicy.length === 0) return 'workspacePolicy is empty';
  if (c.seedFrom !== null && typeof c.seedFrom !== 'string') return 'seedFrom is neither null nor a string';
  if (!Number.isInteger(c.depth) || c.depth < 1) return 'depth is not a positive integer';
  if (!Number.isInteger(c.maxDepth) || c.maxDepth < 1) return 'maxDepth is not a positive integer';
  if (!Number.isFinite(Date.parse(c.notBefore)) || !Number.isFinite(Date.parse(c.expiresAt)))
    return 'notBefore or expiresAt is not a timestamp';
  if (!Number.isInteger(c.maxUses) || c.maxUses < 1) return 'maxUses is not a positive integer';
  return undefined;
}

/** Where revocation is recorded for one parent request. Checked before every delegated admission. */
function cancellationMarker(ledgerRoot: string, parentRequestId: string): string {
  const safe = createHash('sha256').update(parentRequestId, 'utf8').digest('hex').slice(0, 32);
  return join(ledgerRoot, `delegation-cancelled-${safe}`);
}

/**
 * Spend one use of a delegation, atomically, BEFORE it authorises anything.
 *
 * `wx` fails when the file exists, and that failure is the whole of the property: two concurrent
 * children racing for the last use cannot both create the same marker, and nothing here removes
 * one, so a crash after consumption leaves it spent.
 */
function consume(ledgerRoot: string, id: string, maxUses: number): boolean {
  try {
    mkdirSync(ledgerRoot, { recursive: true });
  } catch {
    return false;
  }
  const safe = createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 32);
  for (let use = 1; use <= maxUses; use += 1) {
    try {
      closeSync(openSync(join(ledgerRoot, `delegation-${safe}.use-${use}`), 'wx'));
      return true;
    } catch {
      // This use is already spent; try the next one. Exhausting them all is ALREADY_CONSUMED.
    }
  }
  return false;
}

/**
 * Stop every future delegated admission under one parent request.
 *
 * Deliberately one-way and idempotent: there is no un-cancel, because a revocation a caller can
 * undo is not a revocation. A run already executing is not interrupted: this governs admission,
 * and admission has already happened for that one.
 */
export function cancelDelegationScope(ledgerRoot: string | undefined, parentRequestId: string): boolean {
  if (ledgerRoot === undefined || !isAbsolute(ledgerRoot)) return false;
  try {
    mkdirSync(ledgerRoot, { recursive: true });
    const path = cancellationMarker(ledgerRoot, parentRequestId);
    if (existsSync(path)) return true;
    closeSync(openSync(path, 'wx'));
    return true;
  } catch {
    return existsSync(cancellationMarker(ledgerRoot, parentRequestId));
  }
}

/**
 * Mint one delegation from a COMPLETED parent authorization.
 *
 * Not exported from the package: minting requires a `DelegationParent`, which only the
 * authorization function assembles, and which no tool handler, no sub-agent and no caller of the
 * public API ever holds. The child receives the token and nothing else.
 *
 * Every ceiling here is the parent's own: capabilities are the parent's EFFECTIVE set, expiry is
 * the earlier of the parent's expiry and the requested TTL, and depth is one deeper than the
 * parent's. Nothing in this function can produce a delegation wider than the authority it derives
 * from, and a depth at or beyond `maxDepth` produces none at all.
 */
export function mintDelegation(parent: DelegationParent, options: DelegationMintOptions = {}): string | undefined {
  const key = delegationKey();
  if (key === undefined) return undefined;
  const depth = parent.depth + 1;
  const maxDepth = MAX_DELEGATION_DEPTH;
  if (depth > maxDepth) return undefined;

  const now = (options.clock ?? Date.now)();
  const ttl = Math.max(1, options.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
  const parentExpiry = Date.parse(parent.expiresAt);
  const expires = Number.isFinite(parentExpiry) ? Math.min(now + ttl, parentExpiry) : now + ttl;
  if (expires <= now) return undefined;

  const claims: Claims = {
    schema: SCHEMA,
    id: randomUUID(),
    parent: {
      requestId: parent.requestId,
      principalId: parent.principalId,
      principalFingerprint: parent.principalFingerprint,
      leaseGeneration: parent.leaseGeneration,
      leaseFingerprint: parent.leaseFingerprint,
    },
    audience: { agent: parent.agent, codeRoot: parent.codeRoot },
    lane: 'delegated-shadow',
    workTypes: ['agent-run'],
    // The parent's EFFECTIVE capabilities, sorted and de-duplicated. Never its requested set.
    capabilityCeiling: [...new Set(parent.effectiveCapabilities)].sort(),
    workspacePolicy: options.workspacePolicy ?? 'disposable-shadow',
    seedFrom: options.seedFrom ?? null,
    depth,
    maxDepth,
    notBefore: new Date(now).toISOString(),
    expiresAt: new Date(expires).toISOString(),
    replay: options.replay ?? 'REUSABLE_WITHIN_WINDOW',
    maxUses: Math.max(1, options.maxUses ?? 16),
  };
  return Buffer.from(JSON.stringify({ claims, mac: mac(key, claims) }), 'utf8').toString('base64url');
}

/**
 * Verify one presented delegation against this deployment's lease-derived key.
 *
 * Pure verification over a document that already exists: no model call, no tool call, no
 * filesystem effect beyond the atomic ledger marker that settles replay before the answer is
 * returned. A refusal here happens before anything the child could have started.
 */
export function verifyDelegation(request: DelegationRequest): DelegationDecision {
  const presented = request.assertion;
  if (typeof presented !== 'string' || presented.length === 0)
    return { verified: false, reason: 'NO_DELEGATION_PRESENTED' };

  const fingerprint = createHash('sha256').update(presented, 'utf8').digest('hex').slice(0, 16);

  /*
    SHAPE BEFORE KEY, deliberately.

    Parsing and shape-checking an untrusted document reveals nothing about the key and grants
    nothing, and doing it first means a malformed document is refused as malformed on a deployment
    that has no lease as well as on one that has. The ordering also keeps this half of the verifier
    provable by an ordinary committed test: a suite that could only ever reach `NO_DELEGATION_KEY`
    would register cases without asserting anything about them.
  */
  let claims: Claims;
  let presentedMac: string;
  try {
    const envelope = JSON.parse(Buffer.from(presented, 'base64url').toString('utf8')) as
      { claims: Claims; mac: string };
    claims = envelope.claims;
    presentedMac = envelope.mac;
    if (typeof presentedMac !== 'string' || claims === null || typeof claims !== 'object') throw new Error('shape');
  } catch {
    return { verified: false, reason: 'MALFORMED_DELEGATION', fingerprint };
  }

  const malformed = shapeError(claims as unknown as Record<string, unknown>);
  if (malformed !== undefined) return { verified: false, reason: 'MALFORMED_DELEGATION', fingerprint };
  if (claims.schema !== SCHEMA) return { verified: false, reason: 'UNKNOWN_SCHEMA', fingerprint };

  // Nothing below here is decided without the lease. A deployment that cannot read the authority
  // it was activated with has no delegated authority to hand down or to honour.
  const key = delegationKey();
  if (key === undefined) return { verified: false, reason: 'NO_DELEGATION_KEY', fingerprint };

  // Constant time, and length-safe: a comparison that returns early on the first differing byte
  // leaks the shared prefix to anyone who can time the refusal.
  const expected = Buffer.from(mac(key, claims), 'utf8');
  const actual = Buffer.from(presentedMac, 'utf8');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return { verified: false, reason: 'MAC_INVALID', fingerprint };

  // --- everything below is checked against a document that cannot have been altered -----------

  if (claims.audience.agent !== request.agent || claims.audience.codeRoot !== request.codeRoot)
    return { verified: false, reason: 'AUDIENCE_MISMATCH', fingerprint };
  if (claims.lane !== request.lane) return { verified: false, reason: 'LANE_NOT_PERMITTED', fingerprint };
  if (!claims.workTypes.includes(request.workType))
    return { verified: false, reason: 'WORK_TYPE_NOT_PERMITTED', fingerprint };
  if (claims.depth > claims.maxDepth || claims.depth > MAX_DELEGATION_DEPTH)
    return { verified: false, reason: 'DEPTH_EXCEEDED', fingerprint };
  if (claims.workspacePolicy !== request.workspacePolicy)
    return { verified: false, reason: 'WORKSPACE_POLICY_MISMATCH', fingerprint };

  const now = (request.clock ?? Date.now)();
  if (now < Date.parse(claims.notBefore)) return { verified: false, reason: 'NOT_YET_VALID', fingerprint };
  if (now >= Date.parse(claims.expiresAt)) return { verified: false, reason: 'EXPIRED', fingerprint };

  if (!REPLAY_POLICIES.includes(claims.replay))
    return { verified: false, reason: 'UNKNOWN_REPLAY_POLICY', fingerprint };

  const ledgerRoot = request.ledgerRoot;
  if (ledgerRoot === undefined || !isAbsolute(ledgerRoot))
    return { verified: false, reason: 'LEDGER_UNAVAILABLE', fingerprint };
  // Revocation is checked before consumption: a cancelled scope must not burn a use.
  if (existsSync(cancellationMarker(ledgerRoot, claims.parent.requestId)))
    return { verified: false, reason: 'PARENT_REVOKED', fingerprint };
  const uses = claims.replay === 'SINGLE_USE' ? 1 : claims.maxUses;
  if (!consume(ledgerRoot, claims.id, uses))
    return { verified: false, reason: 'ALREADY_CONSUMED', fingerprint };

  return {
    verified: true,
    delegation: {
      id: claims.id,
      parentRequestId: claims.parent.requestId,
      parentPrincipalId: claims.parent.principalId,
      capabilityCeiling: claims.capabilityCeiling,
      depth: claims.depth,
      maxDepth: claims.maxDepth,
      expiresAt: claims.expiresAt,
      replay: claims.replay,
      workspacePolicy: claims.workspacePolicy,
      seedFrom: claims.seedFrom,
      fingerprint,
    },
  };
}

/**
 * THE REQUEST PRINCIPAL — who is asking, proved per request.
 *
 * Service admission answers "may this deployment work?". It does not answer "who is asking?", and
 * until now nothing did. Every client of both lanes presented the same shared bearer secret, so the
 * server could not distinguish the Matrix bridge from a browser tab from another service. That is
 * authentication, and authentication alone is not authorization: possession of one secret is not a
 * statement about identity, scope, expiry or revocation.
 *
 * The chat token is deliberately NOT overloaded to carry those bindings. Its contract is a
 * constant-time comparison against one shared value; it has no issuer, no audience, no lane, no
 * capability set and no expiry, and stretching it to mean all of those would be a broader authority
 * wearing a narrower one's clothes. It stays exactly what it is. This module carries the rest.
 *
 * A principal assertion is signed OUTSIDE every subject repository, by an issuer whose public half
 * is named in the service lease — so the trust anchor is itself externally controlled, revoking
 * every principal at once is a lease generation bump, and nothing in this tree can mint one. There
 * is no signing primitive here, and a test asserts that rather than assuming it.
 *
 * A principal can only ever NARROW. Its lanes, work types and capability ceiling are intersected
 * with the service lease's; the result is never a union, and an empty intersection is a refusal
 * rather than a silently harmless run.
 */
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** The only schema this verifier understands. Distinct from the lease and the qualification. */
const SCHEMA = 'pehverse-request-principal/1';

const REQUIRED_KEYS: readonly string[] = Object.freeze([
  'schema', 'issuer', 'principal', 'audience', 'lanes', 'workTypes', 'capabilityCeiling',
  'notBefore', 'expiresAt', 'nonce', 'replay',
]);
const OPTIONAL_KEYS: readonly string[] = Object.freeze(['maxRequests']);

const PRINCIPAL_KINDS: readonly string[] = Object.freeze(['service', 'bridge', 'operator']);
const REPLAY_POLICIES: readonly string[] = Object.freeze(['REUSABLE_WITHIN_WINDOW', 'SINGLE_USE']);

export type PrincipalRefusalReason =
  | 'NO_PRINCIPAL_PRESENTED'
  | 'MALFORMED_PRINCIPAL'
  | 'UNKNOWN_SCHEMA'
  | 'NO_TRUSTED_ISSUER'
  | 'UNKNOWN_ISSUER'
  | 'ISSUER_GENERATION_REVOKED'
  | 'SIGNATURE_INVALID'
  | 'UNKNOWN_PRINCIPAL_KIND'
  | 'AUDIENCE_MISMATCH'
  | 'LANE_NOT_PERMITTED'
  | 'WORK_TYPE_NOT_PERMITTED'
  | 'NOT_YET_VALID'
  | 'EXPIRED'
  | 'UNKNOWN_REPLAY_POLICY'
  | 'ALREADY_CONSUMED'
  | 'LEDGER_UNAVAILABLE';

/** The issuer this deployment trusts, as named by its service lease. Never by the caller. */
export interface TrustedPrincipalIssuer {
  readonly id: string;
  readonly keyId: string;
  readonly publicKeyPem: string;
  readonly generation: number;
  /** Where SINGLE_USE assertions are spent. Outside every repository. */
  readonly ledgerRoot?: string | undefined;
}

export interface PrincipalRequest {
  readonly agent: string;
  readonly codeRoot: string;
  readonly lane: 'agent-run' | 'converse';
  readonly workType: string;
  /** The assertion exactly as the client presented it. Absent means refused. */
  readonly assertion?: string | undefined;
}

export interface VerifiedPrincipal {
  readonly id: string;
  readonly kind: string;
  readonly displayName: string;
  readonly lanes: readonly string[];
  readonly workTypes: readonly string[];
  readonly capabilityCeiling: readonly string[];
  readonly expiresAt: string;
  readonly replay: string;
  /** A digest of the assertion. Enough to tie a receipt to a document, never to reproduce one. */
  readonly fingerprint: string;
}

export type PrincipalDecision =
  | { readonly verified: true; readonly principal: VerifiedPrincipal }
  | { readonly verified: false; readonly reason: PrincipalRefusalReason; readonly fingerprint?: string };

interface Assertion {
  readonly schema: string;
  readonly issuer: { readonly id: string; readonly keyId: string; readonly generation: number };
  readonly principal: { readonly id: string; readonly kind: string; readonly displayName: string };
  readonly audience: { readonly agent: string; readonly codeRoot: string };
  readonly lanes: readonly string[];
  readonly workTypes: readonly string[];
  readonly capabilityCeiling: readonly string[];
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly replay: string;
  readonly maxRequests?: number;
}

/** Canonical JSON: sorted keys, no insignificant whitespace. The issuer signs exactly this. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(',')}}`;
}

function shapeError(record: Record<string, unknown>): string | undefined {
  const keys = Object.keys(record).sort();
  const required = [...REQUIRED_KEYS].sort();
  for (const key of required) if (!keys.includes(key)) return `missing ${key}`;
  for (const key of keys) if (!required.includes(key) && !OPTIONAL_KEYS.includes(key)) return `unknown field ${key}`;

  const a = record as unknown as Assertion;
  for (const [name, value] of [['issuer', a.issuer], ['principal', a.principal], ['audience', a.audience]] as const) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return `${name} is not an object`;
  }
  if (typeof a.issuer.id !== 'string' || typeof a.issuer.keyId !== 'string') return 'issuer id or keyId is not a string';
  if (!Number.isInteger(a.issuer.generation) || a.issuer.generation < 1) return 'issuer.generation is not a positive integer';
  if (typeof a.principal.id !== 'string' || a.principal.id.length === 0) return 'principal.id is empty';
  if (typeof a.principal.displayName !== 'string') return 'principal.displayName is not a string';
  if (typeof a.audience.agent !== 'string' || typeof a.audience.codeRoot !== 'string') return 'audience is not two strings';
  if (!isAbsolute(a.audience.codeRoot)) return 'audience.codeRoot is not absolute';
  for (const list of ['lanes', 'workTypes', 'capabilityCeiling'] as const) {
    const value = a[list];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return `${list} is not an array of strings`;
    if (new Set(value).size !== value.length) return `${list} contains a duplicate`;
  }
  if (typeof a.nonce !== 'string' || a.nonce.length === 0) return 'nonce is empty';
  if (!Number.isFinite(Date.parse(a.notBefore)) || !Number.isFinite(Date.parse(a.expiresAt)))
    return 'notBefore or expiresAt is not a timestamp';
  if (a.maxRequests !== undefined && (!Number.isInteger(a.maxRequests) || a.maxRequests < 1))
    return 'maxRequests is not a positive integer';
  return undefined;
}

/**
 * Spend a SINGLE_USE assertion, atomically, before it authorises anything.
 *
 * `wx` fails when the file exists, and that failure is the whole of the property: two concurrent
 * requests cannot both create it, and nothing here ever removes one, so a crash after consumption
 * leaves it spent.
 */
function consume(ledgerRoot: string, nonce: string): boolean {
  try {
    mkdirSync(ledgerRoot, { recursive: true });
  } catch {
    return false;
  }
  try {
    closeSync(openSync(join(ledgerRoot, `principal-${nonce}.used`), 'wx'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify one presented principal against the issuer this deployment's lease names.
 *
 * `issuer` is not a parameter a request can influence: callers obtain it from the verified service
 * lease. A caller who could name the issuer could name their own.
 */
export function verifyRequestPrincipal(
  issuer: TrustedPrincipalIssuer | undefined,
  request: PrincipalRequest,
): PrincipalDecision {
  const presented = request.assertion;
  if (typeof presented !== 'string' || presented.length === 0)
    return { verified: false, reason: 'NO_PRINCIPAL_PRESENTED' };

  const fingerprint = createHash('sha256').update(presented).digest('hex').slice(0, 16);
  if (issuer === undefined) return { verified: false, reason: 'NO_TRUSTED_ISSUER', fingerprint };

  let claims: Assertion;
  let signature: string;
  try {
    const envelope = JSON.parse(Buffer.from(presented, 'base64url').toString('utf8')) as
      { claims: Assertion; signature: string };
    claims = envelope.claims;
    signature = envelope.signature;
    if (typeof signature !== 'string' || claims === null || typeof claims !== 'object') throw new Error('shape');
  } catch {
    return { verified: false, reason: 'MALFORMED_PRINCIPAL', fingerprint };
  }

  const malformed = shapeError(claims as unknown as Record<string, unknown>);
  if (malformed !== undefined) return { verified: false, reason: 'MALFORMED_PRINCIPAL', fingerprint };
  if (claims.schema !== SCHEMA) return { verified: false, reason: 'UNKNOWN_SCHEMA', fingerprint };
  if (claims.issuer.id !== issuer.id || claims.issuer.keyId !== issuer.keyId)
    return { verified: false, reason: 'UNKNOWN_ISSUER', fingerprint };
  // Revocation of every principal at once: the lease raises its generation, older ones stop.
  if (claims.issuer.generation !== issuer.generation)
    return { verified: false, reason: 'ISSUER_GENERATION_REVOKED', fingerprint };

  let signatureValid = false;
  try {
    signatureValid = edVerify(null, Buffer.from(canonical(claims), 'utf8'),
      createPublicKey(issuer.publicKeyPem), Buffer.from(signature, 'base64url'));
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) return { verified: false, reason: 'SIGNATURE_INVALID', fingerprint };

  // --- everything below is checked against a document that cannot have been altered -----------

  if (!PRINCIPAL_KINDS.includes(claims.principal.kind))
    return { verified: false, reason: 'UNKNOWN_PRINCIPAL_KIND', fingerprint };
  if (claims.audience.agent !== request.agent || claims.audience.codeRoot !== request.codeRoot)
    return { verified: false, reason: 'AUDIENCE_MISMATCH', fingerprint };
  if (!claims.lanes.includes(request.lane))
    return { verified: false, reason: 'LANE_NOT_PERMITTED', fingerprint };
  if (!claims.workTypes.includes(request.workType))
    return { verified: false, reason: 'WORK_TYPE_NOT_PERMITTED', fingerprint };

  const now = Date.now();
  if (now < Date.parse(claims.notBefore)) return { verified: false, reason: 'NOT_YET_VALID', fingerprint };
  if (now >= Date.parse(claims.expiresAt)) return { verified: false, reason: 'EXPIRED', fingerprint };

  if (!REPLAY_POLICIES.includes(claims.replay))
    return { verified: false, reason: 'UNKNOWN_REPLAY_POLICY', fingerprint };
  if (claims.replay === 'SINGLE_USE') {
    if (issuer.ledgerRoot === undefined || !isAbsolute(issuer.ledgerRoot))
      return { verified: false, reason: 'LEDGER_UNAVAILABLE', fingerprint };
    if (!consume(issuer.ledgerRoot, claims.nonce))
      return { verified: false, reason: 'ALREADY_CONSUMED', fingerprint };
  }

  return {
    verified: true,
    principal: {
      id: claims.principal.id,
      kind: claims.principal.kind,
      displayName: claims.principal.displayName,
      lanes: claims.lanes,
      workTypes: claims.workTypes,
      capabilityCeiling: claims.capabilityCeiling,
      expiresAt: claims.expiresAt,
      replay: claims.replay,
      fingerprint,
    },
  };
}

/**
 * DELEGATED AUTHORITY — what a committed test can and cannot prove, stated up front.
 *
 * The MAC key is derived from a root-owned service lease on the systemd credential channel. A test
 * process cannot create one (that is the entire point of the channel), so a committed suite CANNOT
 * mint a valid delegation and therefore cannot exercise the admitted path, the binding checks
 * behind the MAC, the ledger or revocation. Pretending otherwise -- by injecting a key, by making
 * the reader overridable, by asserting on `NO_DELEGATION_KEY` and calling it coverage -- would be a
 * suite that registers cases without asserting anything about the property they are named after.
 *
 * So this file proves exactly two things, honestly:
 *
 *   1. THE UNTRUSTED HALF. Everything decidable before the key is consulted: parsing, the closed
 *      key set, the field types, the schema. These run identically on a deployment with a lease and
 *      one without, so they are real here.
 *   2. THE STRUCTURE. That the minting function is unreachable from the package, that the verifier
 *      holds no signing primitive, that the delegated entry point consults the one authorization
 *      function rather than the bare local gate, and that no key material can leave this module.
 *
 * The admitted path, the bindings, replay, concurrency and revocation are proved against a REAL
 * root-owned lease by the Phase-2 hostile suite, with real positive controls. This file does not
 * claim them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_DELEGATION_DEPTH,
  verifyDelegation,
  cancelDelegationScope,
  type DelegationRequest,
} from './delegated-authorization.js';
import * as publicIndex from './index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, 'delegated-authorization.ts');
const LOOP = join(HERE, 'loop.ts');
const LANE = join(HERE, 'lane-authorization.ts');

const CODE_ROOT = join(HERE, '..', '..');

/** A well-formed claim set. Individual tests break exactly one thing about it. */
function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'pehverse-delegation/1',
    id: 'd-1',
    parent: {
      requestId: 'r-1', principalId: 'operator-cli@agent', principalFingerprint: 'abc',
      leaseGeneration: 2, leaseFingerprint: 'def',
    },
    audience: { agent: 'Agent', codeRoot: CODE_ROOT },
    lane: 'delegated-shadow',
    workTypes: ['agent-run'],
    capabilityCeiling: ['read_file'],
    workspacePolicy: 'disposable-shadow',
    seedFrom: null,
    depth: 1,
    maxDepth: MAX_DELEGATION_DEPTH,
    notBefore: '2026-01-01T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
    replay: 'REUSABLE_WITHIN_WINDOW',
    maxUses: 4,
    ...overrides,
  };
}

function envelope(body: unknown, mac: unknown = 'not-a-real-mac'): string {
  return Buffer.from(JSON.stringify({ claims: body, mac }), 'utf8').toString('base64url');
}

const request = (assertion: string | undefined): DelegationRequest => ({
  agent: 'Agent',
  codeRoot: CODE_ROOT,
  lane: 'delegated-shadow',
  workType: 'agent-run',
  workspacePolicy: 'disposable-shadow',
  assertion,
});

function reasonFor(body: unknown, mac: unknown = 'not-a-real-mac'): string {
  const decision = verifyDelegation(request(envelope(body, mac)));
  assert.equal(decision.verified, false, 'a crafted delegation verified');
  return decision.verified ? '' : decision.reason;
}

// ── 1. the untrusted half: decided before the key, so decidable here ────────────────────────

test('an absent delegation is refused as absent, not as malformed', () => {
  for (const absent of [undefined, '']) {
    const decision = verifyDelegation(request(absent));
    assert.equal(decision.verified, false);
    assert.equal(decision.verified ? '' : decision.reason, 'NO_DELEGATION_PRESENTED');
  }
});

test('anything that is not a delegation envelope is malformed', () => {
  for (const junk of ['not-base64url-@@@', Buffer.from('{}', 'utf8').toString('base64url'),
    Buffer.from('[]', 'utf8').toString('base64url'),
    Buffer.from('{"claims":null,"mac":"x"}', 'utf8').toString('base64url'),
    Buffer.from('{"claims":{},"mac":7}', 'utf8').toString('base64url')]) {
    const decision = verifyDelegation(request(junk));
    assert.equal(decision.verified, false, `${junk.slice(0, 24)} verified`);
    assert.equal(decision.verified ? '' : decision.reason, 'MALFORMED_DELEGATION');
  }
});

test('the claim set is closed: a missing field and an unknown field are both malformed', () => {
  for (const field of ['schema', 'id', 'parent', 'audience', 'lane', 'workTypes', 'capabilityCeiling',
    'workspacePolicy', 'seedFrom', 'depth', 'maxDepth', 'notBefore', 'expiresAt', 'replay', 'maxUses']) {
    const body = claims();
    delete body[field];
    assert.equal(reasonFor(body), 'MALFORMED_DELEGATION', `a delegation without ${field} was not malformed`);
  }
  // An unknown field is refused rather than ignored: a verifier that skips fields it does not
  // recognise is a verifier whose document can be extended by whoever presents it.
  assert.equal(reasonFor(claims({ elevated: true })), 'MALFORMED_DELEGATION');
  assert.equal(reasonFor(claims({ maxRequests: 99 })), 'MALFORMED_DELEGATION');
});

test('every field is type-checked, and a duplicate in a list is refused', () => {
  const bad: Record<string, unknown>[] = [
    claims({ parent: 'r-1' }),
    claims({ audience: ['Agent', CODE_ROOT] }),
    claims({ audience: { agent: 'Agent', codeRoot: 'relative/path' } }),
    claims({ parent: { requestId: '', principalId: 'p', principalFingerprint: 'a', leaseGeneration: 1, leaseFingerprint: 'b' } }),
    claims({ parent: { requestId: 'r', principalId: '', principalFingerprint: 'a', leaseGeneration: 1, leaseFingerprint: 'b' } }),
    claims({ parent: { requestId: 'r', principalId: 'p', principalFingerprint: 'a', leaseGeneration: 0, leaseFingerprint: 'b' } }),
    claims({ lane: '' }),
    claims({ workTypes: 'agent-run' }),
    claims({ workTypes: ['agent-run', 'agent-run'] }),
    claims({ capabilityCeiling: [1, 2] }),
    claims({ capabilityCeiling: ['read_file', 'read_file'] }),
    claims({ workspacePolicy: '' }),
    claims({ seedFrom: 42 }),
    claims({ depth: 0 }),
    claims({ depth: 1.5 }),
    claims({ maxDepth: 0 }),
    claims({ notBefore: 'yesterday' }),
    claims({ expiresAt: 'soon' }),
    claims({ maxUses: 0 }),
    claims({ maxUses: 2.5 }),
  ];
  for (const body of bad) assert.equal(reasonFor(body), 'MALFORMED_DELEGATION', JSON.stringify(body).slice(0, 90));
});

test('a document of another schema is refused as a foreign schema, not accepted as near enough', () => {
  // The three authorities in this deployment are deliberately distinct documents. A qualification
  // admission or a request principal presented HERE must not be usable as delegated authority,
  // and the schema check is the first place that is settled.
  for (const foreign of ['pehverse-request-principal/1', 'pehverse-ordinary-authorization/1',
    'pehverse-qualification/1', 'pehverse-delegation/2', '']) {
    assert.equal(reasonFor(claims({ schema: foreign })), 'UNKNOWN_SCHEMA', `${foreign} was not refused`);
  }
});

test('a well-formed delegation still needs the lease, and says so rather than admitting', () => {
  // This process holds no root-owned lease, so a perfectly shaped document gets exactly as far as
  // the key and stops. It is the fail-closed direction: no lease, no delegated authority.
  assert.equal(reasonFor(claims()), 'NO_DELEGATION_KEY');
});

test('revocation refuses to operate on a path that is not an absolute ledger', () => {
  assert.equal(cancelDelegationScope(undefined, 'r-1'), false);
  assert.equal(cancelDelegationScope('relative/ledger', 'r-1'), false);
});

// ── 2. the structure: what cannot be reached, and what must be consulted ────────────────────

test('the package exports no way to mint a delegation', () => {
  const exported = Object.keys(publicIndex);
  for (const name of exported) {
    assert.equal(/mint/i.test(name), false, `${name} is exported and mints something`);
  }
  assert.equal(exported.includes('mintDelegation'), false, 'mintDelegation is reachable from the package');
  // Verifying and revoking are operator actions and are exported on purpose.
  assert.ok(exported.includes('verifyDelegation'));
  assert.ok(exported.includes('cancelDelegationScope'));
});

test('nothing in the module can return, log or write key material', () => {
  const source = readFileSync(MODULE, 'utf8');
  // The key is a local value in two functions and never leaves either.
  assert.equal(/export\s+(async\s+)?function\s+delegationKey/.test(source), false,
    'the key derivation is exported');
  assert.equal(/return\s+key\b/.test(source), false, 'a function returns the key');
  for (const sink of ['console.log', 'console.error', 'console.warn', 'process.stdout', 'process.stderr']) {
    assert.equal(source.includes(sink), false, `the module writes to ${sink}`);
  }
  // No asymmetric signing primitive: a delegation is derived authority, not issued authority.
  for (const primitive of ['generateKeyPair', 'createPrivateKey', 'createSign', 'privateKey']) {
    assert.equal(source.includes(primitive), false, `the module holds ${primitive}`);
  }
  /*
    The environment appears exactly once, and only as the argument that names the systemd
    credential channel to the reader that validates it. Nothing here reads an environment variable
    AS authority -- no key, no issuer, no ledger path, no override -- and asserting the count
    rather than the absence is what keeps that true: a second occurrence is a new decision made
    from something a caller can set.
  */
  const envUses = [...source.matchAll(/process\.env/g)].length;
  assert.equal(envUses, 1, `the module reads the environment ${envUses} times`);
  assert.match(source, /readOrdinaryAuthorizationRecord\(process\.env\)/,
    'the single environment use is not the credential channel');
  assert.equal(source.includes('process.cwd'), false, 'the module trusts the working directory');
});

test('the delegated entry point consults the one authorization function, with no local fallback', () => {
  const loop = readFileSync(LOOP, 'utf8');
  const start = loop.indexOf('export async function runAgentInShadow(');
  assert.ok(start > 0, 'runAgentInShadow is not where the guard expects it');
  const body = loop.slice(start, loop.indexOf('\n}\n', start));

  assert.match(body, /authorizeLaneRequest\(/, 'the delegated lane does not reach the authorization function');
  assert.match(body, /lane: 'delegated-shadow'/, 'the delegated lane does not declare itself');
  assert.match(body, /delegationAssertion:/, 'the delegated lane never presents its delegation');
  assert.match(body, /throw new OperationalWorkRefused/, 'the delegated lane does not refuse on a negative decision');

  // The bare gate must be an ARGUMENT to the authorization function, never an answer on its own:
  // exactly one call, and it appears inside the authorizeLaneRequest call.
  assert.equal(body.split('admitRunWork(').length - 1, 1, 'the delegated lane consults the gate more than once');
  assert.match(body, /authorizeLaneRequest\(admitRunWork\('agent-run'\)/,
    'the delegated lane uses the local gate as a decision rather than as an input');

  // No escape hatches of any kind on this path.
  for (const hatch of ['process.env', 'trusted', 'bypass', 'internal', 'skipAuth', 'allowAnonymous']) {
    assert.equal(body.toLowerCase().includes(hatch.toLowerCase()), false,
      `the delegated lane carries a ${hatch} escape`);
  }
});

test('the authorization function refuses to spend a delegation in a lane that was never delegated', () => {
  const lane = readFileSync(LANE, 'utf8');
  assert.match(lane, /hasDelegation && request\.lane !== 'delegated-shadow'/,
    'a delegation is accepted outside the delegated lane');
  assert.match(lane, /hasPrincipal && hasDelegation/,
    'presenting both a principal and a delegation is resolved rather than refused');
  // The delegation ceiling, not the request, is what the intersection uses.
  assert.match(lane, /effectiveCapabilities: effective/, 'the intersection is not what is carried forward');
});

test('a delegated run is confined to the intersection, and never carries the document it spent', () => {
  const loop = readFileSync(LOOP, 'utf8');
  const start = loop.indexOf('function confineToAuthorization');
  assert.ok(start > 0, 'the confinement function is absent');
  const body = loop.slice(start, loop.indexOf('\n}\n', start));
  assert.match(body, /toolNames: effectiveCapabilities/, 'a run is not confined to what survived');
  assert.match(body, /delegation: _spent/, 'the spent delegation is carried into the run');
  assert.match(body, /childDelegation/, 'no narrowed delegation is handed to children');
});

test('depth is bounded by a constant, not by a caller', () => {
  assert.equal(Number.isInteger(MAX_DELEGATION_DEPTH), true);
  assert.ok(MAX_DELEGATION_DEPTH >= 1 && MAX_DELEGATION_DEPTH <= 8);
  const source = readFileSync(MODULE, 'utf8');
  // maxDepth on a minted delegation is the constant, never an option a caller supplies.
  assert.match(source, /const maxDepth = MAX_DELEGATION_DEPTH;/);
  assert.equal(/maxDepth:\s*options\./.test(source), false, 'a caller can choose its own depth ceiling');
});

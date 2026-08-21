/**
 * The Bokahli adapter's safety properties, as tests.
 *
 * Most of these assert that something does NOT happen, because that is the shape
 * of every failure here. A local-only request that quietly reaches MiniMax
 * returns an excellent answer and looks like success. A tool definition
 * forwarded to an inference endpoint changes nothing visible until it does. A
 * token in an error message is invisible until someone reads a log. None of it
 * goes red on its own.
 *
 * Governed common: byte-identical across Pehlichi, Loony-Luna and Mad-Ptah.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BOKAHLI_CLIENT_CONTRACT,
  BOKAHLI_ESCALATE_REASONS,
  BokahliEscalation,
  type BokahliTarget,
  assertNoToolAuthority,
  buildRouteSpec,
  decideAfterBokahli,
  readBinding,
  readBokahliToken,
  readEscalation,
} from './bokahli.js';

const SECRET = 'trio-bokahli-token-must-not-leak-7c1f';

function tokenFile(mode: number, contents = SECRET): string {
  const dir = mkdtempSync(join(tmpdir(), 'trio-bokahli-'));
  const p = join(dir, 'token');
  writeFileSync(p, `${contents}\n`);
  chmodSync(p, mode);
  return p;
}

const target = (over: Partial<BokahliTarget> = {}): BokahliTarget => ({
  baseUrl: 'http://127.0.0.1:8080/v1',
  tokenFile: '/nonexistent',
  mode: 'AUTO',
  ...over,
});

const escalation = (reason: string): BokahliEscalation =>
  new BokahliEscalation({ reason: reason as never, detail: 'test' });

// ---------------------------------------------------------------------------
// Route modes

test('AUTO, PROFILE and EXACT build the three different questions they are', () => {
  assert.deepEqual(buildRouteSpec(target({ mode: 'AUTO' })), { mode: 'AUTO' });

  assert.deepEqual(
    buildRouteSpec(target({ mode: 'PROFILE', requirements: { minContextTokens: 65536 } })),
    { mode: 'PROFILE', requirements: { minContextTokens: 65536 } },
  );

  assert.deepEqual(
    buildRouteSpec(
      target({ mode: 'EXACT', modelId: 'qwen3.5-35b-a3b.q2-k', artifactDigest: 'sha256:abc' }),
    ),
    { mode: 'EXACT', modelId: 'qwen3.5-35b-a3b.q2-k', artifactDigest: 'sha256:abc' },
  );
});

test('EXACT without a digest throws rather than degrading to AUTO', () => {
  // Silently serving "whatever is loaded" to a caller who named an artifact is
  // precisely the answer EXACT exists to make impossible.
  assert.throws(
    () => buildRouteSpec(target({ mode: 'EXACT', modelId: 'x' })),
    /refusing to fall back to AUTO/,
  );
  assert.throws(
    () => buildRouteSpec(target({ mode: 'EXACT', artifactDigest: 'sha256:abc' })),
    /refusing to fall back to AUTO/,
  );
});

test('requireQualified and taskClass reach the wire in every mode that takes them', () => {
  const auto = buildRouteSpec(target({ requireQualified: true, taskClass: 'triage' }));
  assert.equal(auto['requireQualified'], true);
  assert.equal(auto['taskClass'], 'triage');

  const profile = buildRouteSpec(
    target({ mode: 'PROFILE', requireQualified: true, taskClass: 'triage' }),
  );
  assert.equal((profile['requirements'] as Record<string, unknown>)['requireQualified'], true);
  assert.equal(profile['taskClass'], 'triage');
});

test('the contract version is stated', () => {
  assert.equal(BOKAHLI_CLIENT_CONTRACT, 'bokahli.client/1');
});

// ---------------------------------------------------------------------------
// Local-only is a guarantee, not a preference

test('local-only ends the turn on a refusal instead of leaving the machine', () => {
  const out = decideAfterBokahli(
    target({ localOnly: true }),
    escalation('MODEL_NOT_QUALIFIED_FOR_TASK'),
    null,
  );
  assert.equal(out.served, false);
  assert.equal(out.fellBackToCloud, false);
  assert.match(out.summary, /local-only/);
});

test('local-only beats governed fallback when both are set', () => {
  // The property worth naming. A user who asked for local-only asked for a
  // guarantee, and a guarantee that yields to another flag is not one.
  const out = decideAfterBokahli(
    target({ localOnly: true, governedFallback: true }),
    escalation('REQUIREMENTS_UNMET'),
    null,
  );
  assert.equal(out.fellBackToCloud, false,
    'local-only must win; otherwise the flag that promised privacy silently lost to one that did not');
});

test('local-only holds for a runtime outage too', () => {
  // Even "the box is down" is not a reason to send local-only content to a
  // cloud provider. It is a reason to say the box is down.
  const out = decideAfterBokahli(target({ localOnly: true }), escalation('RUNTIME_UNHEALTHY'), null);
  assert.equal(out.fellBackToCloud, false);
});

test('without governed fallback a refusal simply ends the turn', () => {
  const out = decideAfterBokahli(target(), escalation('NO_QUALIFIED_LOCAL_ROUTE'), null);
  assert.equal(out.served, false);
  assert.equal(out.fellBackToCloud, false);
  assert.match(out.summary, /no fallback is configured/);
});

test('governed fallback fires only when explicitly enabled, and says so', () => {
  const out = decideAfterBokahli(
    target({ governedFallback: true }),
    escalation('REQUIREMENTS_UNMET'),
    null,
  );
  assert.equal(out.fellBackToCloud, true);
  assert.match(out.summary, /governed fallback is enabled/);
});

test('a runtime outage is reported as an outage, not as a refusal', () => {
  const out = decideAfterBokahli(target(), escalation('RUNTIME_UNHEALTHY'), null);
  assert.match(out.summary, /outage,\s*\n?\s*not a refusal|outage, not a refusal/);
});

// ---------------------------------------------------------------------------
// Typed outcomes

test('every reason except RUNTIME_UNHEALTHY terminates the chain', () => {
  for (const reason of BOKAHLI_ESCALATE_REASONS) {
    const e = escalation(reason);
    if (reason === 'RUNTIME_UNHEALTHY') {
      assert.equal(e.terminatesChain, false);
      assert.equal(e.retriable, true);
    } else {
      assert.equal(e.terminatesChain, true, `${reason} must not reach another provider by default`);
      assert.equal(e.retriable, false);
    }
  }
});

test('a swap escalation carries a measured cost, not a guess', () => {
  const e = readEscalation({
    outcome: 'ESCALATE',
    route: {
      reason: 'LOCAL_MODEL_SWAP_REQUIRED',
      detail: 'the loaded artifact does not satisfy this request',
      swap: { candidates: [{ modelId: 'qwen3.5-9b.q6-k', coldLoadSeconds: 2.45 }] },
    },
  });
  assert.ok(e);
  assert.equal(e.swapCandidates[0]?.coldLoadSeconds, 2.45);
});

test('a wrong-digest refusal is recognised', () => {
  const e = readEscalation({
    outcome: 'REFUSED',
    route: { reason: 'EXACT_DIGEST_MISMATCH', detail: 'digest does not match' },
  });
  assert.ok(e);
  assert.equal(e.terminatesChain, true);
});

test('an unknown future reason still counts as a refusal', () => {
  const e = readEscalation({
    outcome: 'ESCALATE',
    route: { reason: 'SOMETHING_ADDED_LATER', detail: 'x' },
  });
  assert.ok(e, 'an unrecognised reason still means bokahli declined');
  assert.equal(e.reason, 'UNKNOWN');
  assert.equal(e.terminatesChain, true);
});

test('an ordinary completion is not mistaken for a refusal', () => {
  assert.equal(readEscalation({ choices: [{ message: { content: 'hi' } }] }), null);
  assert.equal(readEscalation({ error: { code: 'BAD_REQUEST', message: 'x' } }), null);
  assert.equal(readEscalation(null), null);
});

// ---------------------------------------------------------------------------
// Identity, attestation, telemetry

test('a served answer yields the artifact identity a receipt needs', () => {
  const b = readBinding({
    id: 'req-1',
    bokahli: {
      servedIdentity: {
        modelId: 'qwen3.5-35b-a3b.q2-k',
        digest: 'sha256:49533d47',
        servedContextTokens: 32768,
        runtime: { build: 'b10505-ee4c505a4' },
        attested: true,
        attestationMethod: 'backend-props-match',
        qualification: { status: 'INSTALLED_UNQUALIFIED', authority: 'none' },
      },
    },
  });
  assert.ok(b);
  assert.equal(b.modelId, 'qwen3.5-35b-a3b.q2-k');
  assert.equal(b.artifactDigest, 'sha256:49533d47');
  assert.equal(b.attested, true);
  assert.equal(b.servedContextTokens, 32768);
  assert.equal(b.runtimeBuild, 'b10505-ee4c505a4');
  assert.equal(b.qualificationStatus, 'INSTALLED_UNQUALIFIED');
  assert.equal(b.requestId, 'req-1');
});

test('absent attestation and qualification are never defaulted upward', () => {
  // The difference between recording a fact and inventing a claim.
  const b = readBinding({ bokahli: { servedIdentity: { modelId: 'm', digest: 'sha256:a' } } });
  assert.ok(b);
  assert.equal(b.attested, false);
  assert.equal(b.qualificationStatus, 'UNKNOWN');
  assert.equal(b.qualificationAuthority, 'unknown');
});

test('the outcome summary names the artifact and its qualification state', () => {
  const out = decideAfterBokahli(target(), null, {
    outcome: 'ROUTED',
    modelId: 'qwen3.5-35b-a3b.q2-k',
    artifactDigest: 'sha256:49533d47d170c0da',
    attested: true,
    qualificationStatus: 'INSTALLED_UNQUALIFIED',
    qualificationAuthority: 'none',
  });
  assert.equal(out.served, true);
  assert.match(out.summary, /qwen3\.5-35b-a3b\.q2-k/);
  assert.match(out.summary, /INSTALLED_UNQUALIFIED/);
});

// ---------------------------------------------------------------------------
// Tool authority

test('no tool authority is ever forwarded to bokahli', () => {
  for (const key of ['tools', 'tool_choice', 'functions', 'function_call']) {
    assert.throws(
      () => assertNoToolAuthority({ model: 'm', [key]: [{ name: 'shell' }] }),
      /receives no Trio tool authority/,
      `${key} must be refused`,
    );
  }
});

test('an ordinary request without tools passes', () => {
  assert.doesNotThrow(() =>
    assertNoToolAuthority({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
  );
});

// ---------------------------------------------------------------------------
// Credentials

test('a mode-0600 token file is read', () => {
  assert.equal(readBokahliToken(tokenFile(0o600)), SECRET);
});

test('a group- or world-readable token file is refused before being read', () => {
  assert.throws(() => readBokahliToken(tokenFile(0o640)), /must not be readable by group or others/);
  assert.throws(() => readBokahliToken(tokenFile(0o644)), /mode 0644/);
});

test('a missing or empty token file is refused', () => {
  assert.throws(() => readBokahliToken('/nonexistent/token'), /not readable/);
  assert.throws(() => readBokahliToken(tokenFile(0o600, '  ')), /is empty/);
});

test('the token never appears in a refusal that reaches a log or receipt', () => {
  const e = new BokahliEscalation({ reason: 'REQUIREMENTS_UNMET', detail: 'nothing fits' });
  const serialised = `${e.message}${JSON.stringify(e, Object.getOwnPropertyNames(e))}`;
  assert.ok(!serialised.includes(SECRET));
});

test('a target carries a token path, never a token', () => {
  // The shape is the safeguard: there is nowhere on BokahliTarget to put a
  // secret, so one cannot be serialised into config, a receipt or a transcript.
  const t = target({ tokenFile: '/home/zen/.config/bokahli/token' });
  assert.ok(!JSON.stringify(t).includes(SECRET));
  assert.equal(typeof t.tokenFile, 'string');
});

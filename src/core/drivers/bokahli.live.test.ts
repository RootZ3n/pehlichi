/**
 * The Trio's Bokahli driver against a real deployment on Mushin.
 *
 * `bokahli.test.ts` covers the logic against fixtures, which is the right shape
 * for a decision table and the wrong shape for a wire contract: those fixtures
 * were written by reading Bokahli's source, so they would keep passing after a
 * rename on the other side of the socket. The list of escalation reasons in the
 * driver is a hand-maintained copy of a list that lives in another repository,
 * and this is what keeps the copy honest.
 *
 * Skipped when no deployment is reachable, because a laptop with no Mushin
 * behind it should still be able to run the suite. Set
 * `BOKAHLI_REQUIRE_LIVE=true` and every reason to skip becomes a named failure
 * instead — verification runs set it, developer checkouts do not. A green run
 * reporting "all skipped" is the worst possible outcome for a test whose only
 * job is catching drift between repositories.
 *
 * Nothing here invokes a paid provider. Every request is a health probe or a
 * routing decision Bokahli answers without generating tokens, except one small
 * completion that confirms the served identity is bound.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  BOKAHLI_ESCALATE_REASONS,
  type BokahliTarget,
  buildRouteSpec,
  decideAfterBokahli,
  readBinding,
  readBokahliToken,
  readEscalation,
} from './bokahli.js';

const BASE = process.env['BOKAHLI_BASE_URL'] ?? 'http://100.115.140.2:8080';
const TOKEN_FILE =
  process.env['BOKAHLI_TOKEN_FILE'] ?? join(process.env['HOME'] ?? '', '.config/bokahli/token');
const REQUIRE_LIVE = process.env['BOKAHLI_REQUIRE_LIVE'] === 'true';
const EXPECT_MODEL = process.env['BOKAHLI_EXPECT_MODEL'] ?? null;

const skipReason: string | null = await (async (): Promise<string | null> => {
  if (!existsSync(TOKEN_FILE)) return `no token file at ${TOKEN_FILE}`;
  if ((statSync(TOKEN_FILE).mode & 0o077) !== 0) return `${TOKEN_FILE} is not mode 0600`;
  try {
    const r = await fetch(`${BASE}/health/live`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return `${BASE}/health/live returned ${r.status}`;
  } catch (e) {
    return `${BASE} unreachable: ${e instanceof Error ? e.message : String(e)}`;
  }
  // Reachability is not identity: reaching *a* Bokahli says nothing about which.
  try {
    const tok = readBokahliToken(TOKEN_FILE);
    const r = await fetch(`${BASE}/health/ready`, {
      headers: { authorization: `Bearer ${tok}` },
      signal: AbortSignal.timeout(180_000),
    });
    if (!r.ok) return `/health/ready returned ${r.status} (authentication?)`;
    const d = (await r.json()) as Record<string, any>;
    if (d['status'] !== 'ready') return `deployment status is ${d['status']}`;
    if (d['runtime']?.['attested'] !== true) return 'deployment runtime is not attested';
    const served = d['attestation']?.['binding']?.['modelId'];
    if (EXPECT_MODEL !== null && served !== EXPECT_MODEL) {
      return `deployment is serving ${served}, expected ${EXPECT_MODEL}`;
    }
  } catch (e) {
    return `identity probe failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  return null;
})();

if (skipReason !== null && REQUIRE_LIVE) {
  throw new Error(`BOKAHLI_REQUIRE_LIVE=true but the live check failed: ${skipReason}`);
}
if (skipReason !== null) console.log(`# bokahli live: skipping — ${skipReason}`);

const skip = (): false | string => skipReason ?? false;
const token = skipReason === null ? readBokahliToken(TOKEN_FILE) : '';

const base = (over: Partial<BokahliTarget> = {}): BokahliTarget => ({
  baseUrl: `${BASE}/v1`,
  tokenFile: TOKEN_FILE,
  mode: 'AUTO',
  ...over,
});

async function route(t: BokahliTarget, body: Record<string, unknown> = {}): Promise<unknown> {
  const r = await fetch(`${BASE}/v1/bokahli/chat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      route: buildRouteSpec(t),
      messages: [{ role: 'user', content: 'Say OK.' }],
      maxTokens: 4,
      ...body,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  return r.json();
}

// ---------------------------------------------------------------------------

test('AUTO serves, and binds the artifact that served it', { skip: skip() }, async () => {
  const body = await route(base());
  const escalation = readEscalation(body);
  assert.equal(escalation, null, 'AUTO on a healthy deployment should serve');

  const b = readBinding({
    ...(body as Record<string, unknown>),
    bokahli: { servedIdentity: (body as any).route?.selected },
    id: (body as any).requestId,
  });
  assert.ok(b, 'a served turn must bind an artifact identity');
  assert.match(b.artifactDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(b.attested, true, 'never accept an answer from an unattested runtime');
  // Nothing on this deployment is qualified. The adapter must report that
  // faithfully rather than softening it.
  assert.equal(b.qualificationStatus, 'INSTALLED_UNQUALIFIED');
  assert.equal(b.qualificationAuthority, 'none');
});

test('requiring qualification escalates with a reason the driver knows', { skip: skip() }, async () => {
  const body = await route(base({ requireQualified: true }));
  const e = readEscalation(body);
  assert.ok(e, 'requireQualified must escalate; nothing here is qualified');
  assert.notEqual(
    e.reason,
    'UNKNOWN',
    `Bokahli returned ${(body as any).route?.reason}, which is not in the driver's copy of ` +
      'BOKAHLI_ESCALATE_REASONS — the wire contract moved and the duplicate did not',
  );
  assert.ok((BOKAHLI_ESCALATE_REASONS as readonly string[]).includes(e.reason));
  assert.equal(e.terminatesChain, true);
});

test('a named task class escalates rather than being granted', { skip: skip() }, async () => {
  const body = await route(base({ requireQualified: true, taskClass: 'cited-extraction' }));
  const e = readEscalation(body);
  assert.ok(e);
  assert.equal(e.reason, 'MODEL_NOT_QUALIFIED_FOR_TASK');
});

test('PROFILE refuses an impossible context floor instead of truncating', { skip: skip() }, async () => {
  const body = await route(base({ mode: 'PROFILE', requirements: { minContextTokens: 1_000_000 } }));
  const e = readEscalation(body);
  assert.ok(e, 'a deployment that quietly served a smaller context would be the real failure');
  assert.equal(e.terminatesChain, true);
});

test('PROFILE that is satisfiable serves', { skip: skip() }, async () => {
  const body = await route(base({ mode: 'PROFILE', requirements: { minContextTokens: 8192 } }));
  assert.equal(readEscalation(body), null);
});

test('EXACT with a wrong digest refuses and never substitutes', { skip: skip() }, async () => {
  const catalog = (await (
    await fetch(`${BASE}/v1/catalog`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60_000),
    })
  ).json()) as Record<string, any>;
  const modelId = catalog['catalog'][0]['modelId'] as string;

  const body = await route(
    base({ mode: 'EXACT', modelId, artifactDigest: `sha256:${'0'.repeat(64)}` }),
  );
  assert.notEqual((body as any).outcome, 'ROUTED', 'a wrong digest must never be served anyway');
  assert.ok(readEscalation(body));
});

test('EXACT with an unknown identity refuses', { skip: skip() }, async () => {
  const body = await route(
    base({ mode: 'EXACT', modelId: 'not-installed', artifactDigest: `sha256:${'0'.repeat(64)}` }),
  );
  assert.notEqual((body as any).outcome, 'ROUTED');
  assert.ok(readEscalation(body));
});

test('a bad token is refused', { skip: skip() }, async () => {
  const r = await fetch(`${BASE}/health/ready`, {
    headers: { authorization: 'Bearer definitely-not-the-token' },
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(r.status, 401);
});

test('an unauthenticated request is refused', { skip: skip() }, async () => {
  const r = await fetch(`${BASE}/v1/catalog`, { signal: AbortSignal.timeout(30_000) });
  assert.equal(r.status, 401);
});

test('local-only turns a real refusal into an end, not a fallback', { skip: skip() }, async () => {
  // The decision is pure and already unit-tested; this feeds it a genuine
  // escalation from the live deployment rather than a hand-built one.
  const body = await route(base({ requireQualified: true, localOnly: true, governedFallback: true }));
  const e = readEscalation(body);
  assert.ok(e);
  const outcome = decideAfterBokahli(
    base({ requireQualified: true, localOnly: true, governedFallback: true }),
    e,
    null,
  );
  assert.equal(outcome.served, false);
  assert.equal(outcome.fellBackToCloud, false, 'local-only must not reach a cloud provider');
});

test('streaming serves and terminates', { skip: skip() }, async () => {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'auto',
      messages: [{ role: 'user', content: 'Say OK.' }],
      max_tokens: 8,
      stream: true,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  assert.equal(r.ok, true);
  const text = await r.text();
  assert.match(text, /data:/, 'a streamed response should be server-sent events');
  assert.match(text, /\[DONE\]/, 'the stream must terminate rather than hang');
});

test('cancellation is reported honestly, not as an answer', { skip: skip() }, async () => {
  // Abort mid-flight. What must NOT happen is a completion appearing anyway;
  // an aborted turn has no answer and saying otherwise would be fabrication.
  const ac = new AbortController();
  const p = fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'auto',
      messages: [{ role: 'user', content: 'Count slowly to fifty.' }],
      max_tokens: 400,
    }),
    signal: ac.signal,
  });
  setTimeout(() => ac.abort(), 150);
  await assert.rejects(p, (e: unknown) => (e as Error).name === 'AbortError');
});

test('no response carries a host path or an artifact filename', { skip: skip() }, async () => {
  const body = await route(base({ requireQualified: true }));
  const s = JSON.stringify(body);
  assert.ok(!s.includes('/home/'), 'a host path reached the client');
  assert.ok(!s.includes('.gguf'), 'an artifact filename reached the client');
});

test('no response echoes the token', { skip: skip() }, async () => {
  const body = await route(base());
  assert.ok(token.length > 0);
  assert.ok(!JSON.stringify(body).includes(token));
});

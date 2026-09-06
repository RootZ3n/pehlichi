/**
 * TRANSPORT POLICY AND PROVIDER PROFILE — the questions the old driver answered with one number.
 *
 * The driver used to have a single 120-second abort, retry that was off unless a caller opted in,
 * no streaming, and no record of what happened on the wire. Each of those is a separate property
 * and each is asserted separately here, because the failure they cause looks the same from outside
 * — "it did not answer" — and the fix for each is different.
 *
 * Everything in this file is offline. No provider is called; the transport is driven with a fake
 * fetch so that a retry, a timeout and a late body are exercised deterministically rather than
 * hoped for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_TRANSPORT_POLICY, RunDeadline, backoffMs, classifyFailure, shouldRetry,
} from './transport-policy.js';
import { performCompletion, readSseCompletion, sanitizeDetail, TransportError } from './drivers/transport.js';
import { describe, providerProfile, resetProviderProfileCache } from './provider-profile.js';

// ── classification: what is worth another attempt, and what is the same twice ────────────────

test('a failure is classified from what the transport saw, not from a message string', () => {
  assert.equal(classifyFailure({ status: 401 }), 'authentication');
  assert.equal(classifyFailure({ status: 403 }), 'authorization');
  assert.equal(classifyFailure({ status: 429 }), 'rate-limit');
  assert.equal(classifyFailure({ status: 400 }), 'malformed-request');
  assert.equal(classifyFailure({ status: 422 }), 'malformed-request');
  assert.equal(classifyFailure({ status: 500 }), 'server-error');
  assert.equal(classifyFailure({ status: 503 }), 'server-error');
  assert.equal(classifyFailure({ errorCode: 'ECONNRESET' }), 'connect');
  assert.equal(classifyFailure({ errorCode: 'UND_ERR_CONNECT_TIMEOUT' }), 'connect');
  assert.equal(classifyFailure({ errorCode: 'UND_ERR_HEADERS_TIMEOUT' }), 'header-timeout');
  assert.equal(classifyFailure({ errorCode: 'UND_ERR_BODY_TIMEOUT' }), 'idle-timeout');
  // A timeout in the header phase is a different fact from one in the body phase, and only the
  // phase distinguishes them: the error is the same object either way.
  assert.equal(classifyFailure({ errorName: 'TimeoutError', phase: 'header' }), 'header-timeout');
  assert.equal(classifyFailure({ errorName: 'TimeoutError', phase: 'body' }), 'attempt-timeout');
  assert.equal(classifyFailure({ errorName: 'AbortError' }), 'aborted');
});

test('only transient failures are retried; everything else is the same on the second attempt', () => {
  const policy = DEFAULT_TRANSPORT_POLICY.retry;
  const ask = (failure: Parameters<typeof shouldRetry>[0]['failure']) =>
    shouldRetry({ failure, attempt: 1, policy, effectsObserved: false, runDeadlineRemainingMs: 60_000 });
  for (const transient of ['connect', 'header-timeout', 'idle-timeout', 'attempt-timeout', 'rate-limit', 'server-error'] as const)
    assert.equal(ask(transient).retry, true, `${transient} should be retried`);
  for (const terminal of ['authentication', 'authorization', 'malformed-request', 'model-error',
    'malformed-response', 'aborted', 'run-deadline', 'unknown'] as const) {
    const verdict = ask(terminal);
    assert.equal(verdict.retry, false, `${terminal} must not be retried`);
    assert.equal(verdict.reason, `terminal:${terminal}`);
  }
});

test('a turn that has had effects is never retried, whatever the failure', () => {
  const policy = DEFAULT_TRANSPORT_POLICY.retry;
  const verdict = shouldRetry({
    failure: 'server-error', attempt: 1, policy, effectsObserved: true, runDeadlineRemainingMs: 60_000,
  });
  assert.equal(verdict.retry, false);
  assert.equal(verdict.reason, 'effects-observed');
});

test('retries stop at the limit and at the run deadline, whichever comes first', () => {
  const policy = { ...DEFAULT_TRANSPORT_POLICY.retry, maxRetries: 2 };
  const base = { failure: 'server-error' as const, policy, effectsObserved: false };
  assert.equal(shouldRetry({ ...base, attempt: 2, runDeadlineRemainingMs: 60_000 }).retry, true);
  assert.equal(shouldRetry({ ...base, attempt: 3, runDeadlineRemainingMs: 60_000 }).reason, 'retries-exhausted');
  assert.equal(shouldRetry({ ...base, attempt: 1, runDeadlineRemainingMs: 0 }).reason, 'run-deadline');
});

test('backoff grows, is jittered, and never outlives the run deadline', () => {
  const policy = { maxRetries: 5, baseBackoffMs: 500, maxBackoffMs: 8_000, jitter: 0.25 };
  const mid = backoffMs(3, policy, 60_000, () => 0.5);
  assert.equal(mid, 2_000, 'the un-jittered value is the exponential one');
  for (const r of [0, 0.5, 1]) {
    const value = backoffMs(3, policy, 60_000, () => r);
    assert.ok(value >= 1_500 && value <= 2_500, `jitter left the band: ${value}`);
  }
  assert.ok(backoffMs(10, policy, 60_000, () => 0.5) <= policy.maxBackoffMs, 'backoff exceeded its cap');
  // A backoff that outlasts the deadline would spend the run waiting to fail.
  assert.ok(backoffMs(10, policy, 300, () => 0.5) < 300);
});

test('a run deadline is not extended by a retry', () => {
  let clock = 1_000;
  const deadline = new RunDeadline(10_000, () => clock);
  assert.equal(deadline.remainingMs(), 10_000);
  clock += 4_000;
  assert.equal(deadline.remainingMs(), 6_000);
  // An attempt may never budget more than the run has left, however large its own cap.
  assert.equal(deadline.attemptBudgetMs(180_000), 6_000);
  clock += 7_000;
  assert.equal(deadline.expired(), true);
  assert.equal(deadline.attemptBudgetMs(180_000), 0);
});

// ── streaming: three separate facts ──────────────────────────────────────────────────────────

function sse(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) { controller.close(); return; }
      controller.enqueue(encoder.encode(chunks[index] as string));
      index += 1;
    },
  });
}

test('a streamed completion is aggregated from its deltas', async () => {
  const read = await readSseCompletion(sse([
    'data: {"model":"m1","choices":[{"delta":{"content":"Hel"}}]}\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
    'data: [DONE]\n',
  ]), { idleMs: 5_000, signal: new AbortController().signal });
  const json = read.json as { model: string; choices: Array<{ finish_reason: string; message: { content: string } }> };
  assert.equal(json.model, 'm1');
  assert.equal(json.choices[0]?.message.content, 'Hello');
  assert.equal(json.choices[0]?.finish_reason, 'stop');
  assert.equal(read.sawMultipleChunks, true);
});

test('tool calls split across deltas are reassembled by index', async () => {
  const read = await readSseCompletion(sse([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":"{\\"pa"}}]}}]}\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a\\"}"}}]}}]}\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n',
  ]), { idleMs: 5_000, signal: new AbortController().signal });
  const call = (read.json as { choices: Array<{ message: { tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> } }> })
    .choices[0]?.message.tool_calls[0];
  assert.equal(call?.id, 'c1');
  assert.equal(call?.function.name, 'read');
  assert.deepEqual(JSON.parse(call?.function.arguments ?? '{}'), { path: 'a' });
});

test('one chunk is not streaming, however it was framed', async () => {
  const read = await readSseCompletion(sse([
    'data: {"choices":[{"delta":{"content":"all at once"},"finish_reason":"stop"}]}\n',
  ]), { idleMs: 5_000, signal: new AbortController().signal });
  assert.equal(read.sawMultipleChunks, false,
    'a single frame must not be reported as an observed stream');
});

// ── the transport itself, driven with a fake fetch ───────────────────────────────────────────

const body = (o: unknown) => ({
  ok: true, status: 200,
  json: async () => o,
  text: async () => JSON.stringify(o),
  headers: { get: () => 'application/json' },
});
const failure = (status: number, detail = 'x') => ({
  ok: false, status,
  json: async () => ({}),
  text: async () => detail,
  headers: { get: () => 'application/json' },
});

function request(fetchImpl: Parameters<typeof performCompletion>[0]['fetchImpl'], over: Record<string, unknown> = {}) {
  const attempts: unknown[] = [];
  return {
    attempts,
    input: {
      runId: 'run-1', requestId: 'req-1', url: 'https://example.invalid/v1/chat/completions',
      headers: {}, payload: { model: 'm' }, provider: 'test', endpoint: 'https://example.invalid/v1',
      configuredModel: 'm', driver: 'TestDriver', streamingRequested: false, fetchImpl,
      policy: { timeouts: DEFAULT_TRANSPORT_POLICY.timeouts,
        retry: { maxRetries: 2, baseBackoffMs: 1, maxBackoffMs: 2, jitter: 0 } },
      onAttempt: (r: unknown) => { attempts.push(r); },
      ...over,
    } as Parameters<typeof performCompletion>[0],
  };
}

test('a transient failure is retried and the attempts are recorded in order', async () => {
  let call = 0;
  const { attempts, input } = request(async () => {
    call += 1;
    return call < 3 ? failure(503, 'upstream') as never : body({ model: 'm', choices: [] }) as never;
  });
  const result = await performCompletion(input);
  assert.equal(call, 3, 'the transport did not retry twice');
  assert.equal(result.attempts.length, 3);
  assert.deepEqual(result.attempts.map((a) => a.outcome), ['retrying', 'retrying', 'ok']);
  assert.deepEqual(result.attempts.map((a) => a.attempt), [1, 2, 3]);
  assert.equal(new Set(result.attempts.map((a) => a.attemptId)).size, 3, 'attempt ids collided');
  assert.ok(result.attempts.every((a) => a.runId === 'run-1' && a.requestId === 'req-1'),
    'an attempt was not bound to its run');
  assert.equal(attempts.length, 3, 'the observer did not see every attempt');
});

test('an authentication failure is not retried, and says so', async () => {
  let call = 0;
  const { input } = request(async () => { call += 1; return failure(401, 'Invalid API Key') as never; });
  const error = await performCompletion(input).catch((e: unknown) => e);
  assert.ok(error instanceof TransportError);
  assert.equal((error as TransportError).failure, 'authentication');
  assert.equal(call, 1, 'an authentication failure was retried');
  assert.equal((error as TransportError).attempts[0]?.retryDecision, 'terminal:authentication');
});

test('a turn with effects is not retried even when the failure is transient', async () => {
  let call = 0;
  const { input } = request(async () => { call += 1; return failure(503) as never; }, { effectsObserved: true });
  await performCompletion(input).catch(() => undefined);
  assert.equal(call, 1, 'a turn that had already acted was replayed');
});

test('the request carries stream only when streaming was requested', async () => {
  let sent: Record<string, unknown> = {};
  const { input } = request(async (_u, init) => {
    sent = JSON.parse(init.body) as Record<string, unknown>;
    return body({ choices: [] }) as never;
  });
  await performCompletion(input);
  assert.equal('stream' in sent, false);
  await performCompletion({ ...input, streamingRequested: true });
  assert.equal(sent['stream'], true, 'streaming was requested but not sent');
});

test('a provider that ignores stream is not recorded as having streamed', async () => {
  const { input } = request(async () => body({ model: 'm', choices: [] }) as never, { streamingRequested: true });
  const result = await performCompletion(input);
  assert.equal(result.attempts[0]?.streamingRequested, true);
  assert.equal(result.attempts[0]?.streamingNegotiated, false, 'a JSON answer was called a negotiated stream');
  assert.equal(result.streamingObserved, false);
});

test('the wire model is recorded beside the configured one', async () => {
  const { input } = request(async () => body({ model: 'something-else', choices: [] }) as never);
  const result = await performCompletion(input);
  assert.equal(result.attempts[0]?.configuredModel, 'm');
  assert.equal(result.attempts[0]?.wireModel, 'something-else',
    'a silent model substitution would be invisible');
});

test('an error detail never carries anything key-shaped out of the transport', () => {
  assert.equal(sanitizeDetail('bad key sk-abcdefghijklmnop'), 'bad key sk-<redacted>');
  assert.equal(sanitizeDetail('Authorization: Bearer abcdefghijklmnop'), 'Authorization: Bearer <redacted>');
  assert.equal(sanitizeDetail('{"api_key":"abcdefghijklmnop"}'), '{"api_key":"<redacted>"}');
  assert.equal(sanitizeDetail('x'.repeat(900)).length, 400);
});

// ── the provider profile ─────────────────────────────────────────────────────────────────────

function withProfile<T>(record: unknown, run: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'profile-'));
  writeFileSync(join(dir, 'provider-profile'), typeof record === 'string' ? record : JSON.stringify(record));
  const previous = process.env['CREDENTIALS_DIRECTORY'];
  process.env['CREDENTIALS_DIRECTORY'] = dir;
  resetProviderProfileCache();
  try { return run(); } finally {
    if (previous === undefined) delete process.env['CREDENTIALS_DIRECTORY'];
    else process.env['CREDENTIALS_DIRECTORY'] = previous;
    resetProviderProfileCache();
  }
}

test('a provider profile is read from the credential channel and nowhere else', () => {
  const profile = withProfile({
    schema: 'pehverse-provider-profile/1', provider: 'zai',
    baseUrl: 'https://api.z.ai/api/paas/v4/', model: 'glm-5.3-flash',
    authStyle: 'bearer', streaming: true, apiKey: 'secret-value-here',
    requestExtras: { thinking: { type: 'disabled' } },
  }, () => providerProfile());
  assert.equal(profile?.provider, 'zai');
  assert.equal(profile?.baseUrl, 'https://api.z.ai/api/paas/v4', 'a trailing slash was not normalised');
  assert.equal(profile?.streaming, true);
  assert.deepEqual(profile?.requestExtras, { thinking: { type: 'disabled' } });

  resetProviderProfileCache();
  assert.equal(providerProfile(), undefined, 'a profile was invented without a credential channel');
});

test('a profile of the wrong schema or shape is refused rather than partly believed', () => {
  for (const bad of [
    { schema: 'something-else', provider: 'p', baseUrl: 'u', model: 'm' },
    { schema: 'pehverse-provider-profile/1', provider: '', baseUrl: 'u', model: 'm' },
    { schema: 'pehverse-provider-profile/1', provider: 'p', baseUrl: '', model: 'm' },
    { schema: 'pehverse-provider-profile/1', provider: 'p', baseUrl: 'u', model: '' },
    'not json at all',
  ]) assert.equal(withProfile(bad, () => providerProfile()), undefined, JSON.stringify(bad).slice(0, 50));
});

test('describing a profile can never describe its key', () => {
  const described = withProfile({
    schema: 'pehverse-provider-profile/1', provider: 'zai', baseUrl: 'https://x/v1',
    model: 'm', authStyle: 'bearer', streaming: false, apiKey: 'the-actual-secret',
  }, () => describe(providerProfile()));
  const text = JSON.stringify(described);
  assert.equal(text.includes('the-actual-secret'), false, 'the descriptor carried the key');
  assert.equal(described?.keyed, true);
  assert.equal(described?.keyFingerprint.length, 16, 'a fingerprint should identify, not reproduce');
  assert.equal(described?.endpoint, 'https://x/v1');
  assert.equal(described?.configuredModel, 'm');
  assert.equal(describe(undefined), undefined);
});

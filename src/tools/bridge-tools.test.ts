/**
 * BRIDGE TOOLS — BLOCKER-2 caller-side tests.
 *
 * These exercise the retry / no-retry classification and the X-Task-Id contract on
 * bridge.request with an INJECTED fetch (no network) and a no-op sleep (no wall-clock).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBridgeToolHandlers } from './bridge-tools.js';

/** Build a fake successful JSON Response. */
function okResponse(data: unknown): Response {
  return { ok: true, status: 200, json: async () => data } as unknown as Response;
}

/** Build a fake non-2xx Response. */
function errResponse(status: number, data: unknown = { error: 'nope' }): Response {
  return { ok: false, status, json: async () => data } as unknown as Response;
}

/** An AbortError, exactly as AbortSignal.timeout() raises on a real timeout. */
function abortError(): Error {
  const e = new Error('The operation was aborted due to timeout');
  e.name = 'AbortError';
  return e;
}

const noSleep = (): Promise<void> => Promise.resolve();

test('B2. bridge.request RETRIES on timeout (transient) then succeeds', async () => {
  const calls: RequestInit[] = [];
  let n = 0;
  const fetchImpl = (async (_url: string, opts: RequestInit) => {
    calls.push(opts);
    n++;
    if (n <= 2) throw abortError(); // time out twice…
    return okResponse({ done: true }); // …succeed on the 3rd
  }) as unknown as typeof fetch;

  const handlers = createBridgeToolHandlers({ agentId: 'peh', fetchImpl, sleep: noSleep, retryBackoffMs: [1, 1] });
  const res = await handlers.get('bridge.request')!({ service: 'ptah', method: 'POST', path: '/chat', body: { message: 'hi' } }, {} as never);

  assert.equal(n, 3, 'first attempt + 2 retries');
  assert.equal(res.ok, true);
  assert.match(res.output, /done/);
});

test('B2. bridge.request does NOT retry on a 4xx (permanent client error)', async () => {
  let n = 0;
  const fetchImpl = (async () => { n++; return errResponse(404); }) as unknown as typeof fetch;

  const handlers = createBridgeToolHandlers({ agentId: 'peh', fetchImpl, sleep: noSleep, retryBackoffMs: [1, 1] });
  const res = await handlers.get('bridge.request')!({ service: 'ptah', method: 'GET', path: '/missing' }, {} as never);

  assert.equal(n, 1, '4xx is permanent — exactly one attempt');
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /HTTP 404/);
  assert.match(res.error ?? '', /not retried/);
});

test('B2. bridge.request RETRIES on a 5xx (transient server error)', async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    return n <= 1 ? errResponse(503) : okResponse({ recovered: true });
  }) as unknown as typeof fetch;

  const handlers = createBridgeToolHandlers({ agentId: 'peh', fetchImpl, sleep: noSleep, retryBackoffMs: [1, 1] });
  const res = await handlers.get('bridge.request')!({ service: 'ptah', method: 'GET', path: '/flaky' }, {} as never);

  assert.equal(n, 2);
  assert.equal(res.ok, true);
  assert.match(res.output, /recovered/);
});

test('B2. bridge.request EXHAUSTS retries and surfaces the taskId for polling', async () => {
  let n = 0;
  const fetchImpl = (async () => { n++; throw abortError(); }) as unknown as typeof fetch;

  const handlers = createBridgeToolHandlers({ agentId: 'peh', fetchImpl, sleep: noSleep, retryBackoffMs: [1, 1] });
  const res = await handlers.get('bridge.request')!({ service: 'ptah', method: 'POST', path: '/chat', body: { message: 'x' } }, {} as never);

  assert.equal(n, 3, 'first attempt + 2 retries, then give up');
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /failed after 3 attempts/);
  // The operator/model can recover the orphaned work via the status endpoint.
  assert.match(res.error ?? '', /\/task\/[0-9a-f-]{36}\/status/);
});

test('B2. the SAME X-Task-Id is stamped across every retry of one logical call', async () => {
  const taskIds: string[] = [];
  let n = 0;
  const fetchImpl = (async (_url: string, opts: RequestInit) => {
    const headers = opts.headers as Record<string, string>;
    taskIds.push(headers['X-Task-Id'] ?? '');
    n++;
    if (n <= 2) throw abortError();
    return okResponse({ ok: true });
  }) as unknown as typeof fetch;

  const handlers = createBridgeToolHandlers({ agentId: 'peh', fetchImpl, sleep: noSleep, retryBackoffMs: [1, 1] });
  await handlers.get('bridge.request')!({ service: 'ptah', method: 'POST', path: '/chat', body: { message: 'x' } }, {} as never);

  assert.equal(taskIds.length, 3);
  assert.ok(taskIds[0] && /[0-9a-f-]{36}/.test(taskIds[0]), 'a UUID task id is present');
  assert.equal(new Set(taskIds).size, 1, 'one task identity across all retries');
});

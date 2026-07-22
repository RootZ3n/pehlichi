/**
 * LUAK TOOLS tests — stub global.fetch to record the (url, method, body) each tool sends and return a
 * scripted response, so we assert endpoint + payload construction without a live Luak.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createLuakToolHandlers, luakToolSpecs, luakToolNames } from './luak-tools.js';
import { createFullToolRegistry } from './index.js';
import { agentToolNames } from '../../profiles/agent.js';
import { READ_ONLY_TOOLS } from '../approval-policy.js';

const handlers = createLuakToolHandlers();

interface Call { url: string; method: string; body: unknown }
async function withFetch(status: number, payload: unknown, fn: (calls: Call[]) => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: typeof input === 'string' ? input : input.toString(),
      method: init?.method ?? 'GET',
      body: init?.body !== undefined ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try { await fn(calls); } finally { globalThis.fetch = original; }
}

async function withHost<T>(host: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prevBridge = process.env.LAB_BRIDGE_HOST;
  const prevUrl = process.env.LUAK_API_URL;
  delete process.env.LUAK_API_URL;
  if (host === undefined) delete process.env.LAB_BRIDGE_HOST; else process.env.LAB_BRIDGE_HOST = host;
  try { return await fn(); } finally {
    if (prevBridge === undefined) delete process.env.LAB_BRIDGE_HOST; else process.env.LAB_BRIDGE_HOST = prevBridge;
    if (prevUrl === undefined) delete process.env.LUAK_API_URL; else process.env.LUAK_API_URL = prevUrl;
  }
}

test('all 8 luak specs registered + on allowlist; only reads are auto-approved', () => {
  assert.equal(luakToolSpecs.length, 8);
  for (const spec of luakToolSpecs) {
    assert.ok(handlers.get(spec.name), `handler ${spec.name}`);
    assert.ok(agentToolNames.includes(spec.name), `${spec.name} allowlisted`);
    assert.ok(luakToolNames.has(spec.name));
  }
  const names = new Set(createFullToolRegistry({ workspaceRoot: '/tmp', agentServerUrl: 'http://127.0.0.1:0' }).map((t) => t.spec.name));
  for (const spec of luakToolSpecs) assert.ok(names.has(spec.name), `${spec.name} in registry`);
  assert.ok(READ_ONLY_TOOLS.has('luak_registry') && READ_ONLY_TOOLS.has('luak_leaderboard'));
  for (const t of ['luak_add_model', 'luak_update_model', 'luak_remove_model', 'luak_run']) assert.ok(!READ_ONLY_TOOLS.has(t), `${t} gated`);
});

test('base URL follows LAB_BRIDGE_HOST (Tailscale reach), LUAK_API_URL overrides', async () => {
  await withHost('100.84.209.89', () => withFetch(200, { presets: [], providers: [], models: [] }, async (calls) => {
    await handlers.get('luak_registry')!({}, {} as never);
    assert.equal(calls[0]!.url, 'http://100.84.209.89:18795/api/registry/state');
  }));
});

test('luak_add_model posts the provider + model with optional fields', async () => {
  await withHost('localhost', () => withFetch(201, { model: { id: 'mdl-1' } }, async (calls) => {
    const res = await handlers.get('luak_add_model')!({ providerConfigId: 'deepseek-x', modelId: 'deepseek-v4-pro', displayName: 'DS Pro', enabled: true }, {} as never);
    assert.equal(res.ok, true);
    assert.equal(calls[0]!.method, 'POST');
    assert.equal(calls[0]!.url, 'http://localhost:18795/api/registry/models');
    assert.deepEqual(calls[0]!.body, { providerConfigId: 'deepseek-x', modelId: 'deepseek-v4-pro', displayName: 'DS Pro', enabled: true });
  }));
});

test('luak_add_model requires providerConfigId + modelId', async () => {
  const res = await handlers.get('luak_add_model')!({ modelId: 'x' }, {} as never);
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /providerConfigId/);
});

test('luak_update_model PATCHes only the given edit fields, and encodes the id', async () => {
  await withHost('localhost', () => withFetch(200, { model: {} }, async (calls) => {
    await handlers.get('luak_update_model')!({ id: 'mdl-1781112507620', enabled: false, tags: ['slow'] }, {} as never);
    assert.equal(calls[0]!.method, 'PATCH');
    assert.equal(calls[0]!.url, 'http://localhost:18795/api/registry/models/mdl-1781112507620');
    assert.deepEqual(calls[0]!.body, { enabled: false, tags: ['slow'] });
  }));
});

test('luak_remove_model DELETEs by id', async () => {
  await withHost('localhost', () => withFetch(200, { ok: true }, async (calls) => {
    await handlers.get('luak_remove_model')!({ id: 'mdl-9' }, {} as never);
    assert.equal(calls[0]!.method, 'DELETE');
    assert.equal(calls[0]!.url, 'http://localhost:18795/api/registry/models/mdl-9');
  }));
});

test('luak_add_provider posts presetId + optional overrides', async () => {
  await withHost('localhost', () => withFetch(201, { provider: {} }, async (calls) => {
    await handlers.get('luak_add_provider')!({ presetId: 'openrouter', apiKeyEnv: 'OPENROUTER_KEY' }, {} as never);
    assert.equal(calls[0]!.url, 'http://localhost:18795/api/registry/providers');
    assert.deepEqual(calls[0]!.body, { presetId: 'openrouter', apiKeyEnv: 'OPENROUTER_KEY' });
  }));
});

test('luak_run posts a trial; requires task+adapter+model', async () => {
  const bad = await handlers.get('luak_run')!({ task: 't' }, {} as never);
  assert.equal(bad.ok, false);
  await withHost('localhost', () => withFetch(200, { ok: true }, async (calls) => {
    await handlers.get('luak_run')!({ task: 'code-1', adapter: 'openrouter', model: 'mimo-v2.5' }, {} as never);
    assert.equal(calls[0]!.url, 'http://localhost:18795/api/run');
    assert.deepEqual(calls[0]!.body, { task: 'code-1', adapter: 'openrouter', model: 'mimo-v2.5' });
  }));
});

test('an HTTP error from Luak surfaces the message', async () => {
  await withHost('localhost', () => withFetch(400, { error: 'unknown provider' }, async () => {
    const res = await handlers.get('luak_add_model')!({ providerConfigId: 'x', modelId: 'y' }, {} as never);
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /unknown provider/);
  }));
});

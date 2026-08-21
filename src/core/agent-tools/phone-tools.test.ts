/**
 * PHONE TOOLS tests — Peh's Android body. No device needed: a fake PhoneRunner
 * captures the exact (binary, args) each tool would run and returns a scripted
 * outcome, so we assert wiring, confinement, arg coercion, and result rendering.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createPhoneToolHandlers,
  phoneToolSpecs,
  phoneToolNames,
  resolvePhoneTransport,
  buildPhoneEnv,
  type PhoneRunner,
  type PhoneRunResult,
} from './phone-tools.js';
import { createFullToolRegistry } from './index.js';
import { agentToolNames } from '../../profile.js';
import type { ToolContext } from '../tools.js';

const ctx = (dir: string): ToolContext => ({ workspaceRoot: dir, labStoreRoot: dir, store: {} });
const workspace = (): string => mkdtempSync(join(tmpdir(), 'peh-phone-'));

/** A runner that records calls and replays a fixed outcome. */
function fakeRunner(outcome: Partial<PhoneRunResult> = {}): { run: PhoneRunner; calls: Array<{ binary: string; args: readonly string[] }> } {
  const calls: Array<{ binary: string; args: readonly string[] }> = [];
  const run: PhoneRunner = (binary, args) => {
    calls.push({ binary, args });
    return { code: 0, stdout: '', stderr: '', ...outcome };
  };
  return { run, calls };
}

test('all 9 phone specs have handlers and are on the persona allowlist', () => {
  assert.equal(phoneToolSpecs.length, 9);
  const { run } = fakeRunner();
  const handlers = createPhoneToolHandlers({ run });
  for (const spec of phoneToolSpecs) {
    assert.ok(handlers.get(spec.name), `handler for ${spec.name}`);
    assert.ok(agentToolNames.includes(spec.name), `${spec.name} in agentToolNames`);
    assert.ok(phoneToolNames.has(spec.name));
  }
});

test('phone tools are registered in the full tool registry', () => {
  const dir = workspace();
  const tools = createFullToolRegistry({ workspaceRoot: dir, agentServerUrl: 'http://127.0.0.1:0', agentId: 'test-agent' });
  const names = new Set(tools.map((t) => t.spec.name));
  for (const spec of phoneToolSpecs) assert.ok(names.has(spec.name), `${spec.name} registered`);
});

test('phone_take_photo picks the lens, confines the save path, and points to vision_analyze', async () => {
  const dir = workspace();
  const { run, calls } = fakeRunner();
  const h = createPhoneToolHandlers({ run });
  const res = await h.get('phone_take_photo')!({ lens: 'front' }, ctx(dir));
  assert.equal(res.ok, true);
  assert.equal(calls[0]!.binary, 'termux-camera-photo');
  assert.deepEqual(calls[0]!.args.slice(0, 2), ['-c', '1']); // front = camera 1
  assert.ok((calls[0]!.args[2] as string).startsWith(dir), 'save path confined to workspace');
  assert.match(res.output, /vision_analyze/);
});

test('phone_take_photo defaults to the back lens', async () => {
  const dir = workspace();
  const { run, calls } = fakeRunner();
  const h = createPhoneToolHandlers({ run });
  await h.get('phone_take_photo')!({}, ctx(dir));
  assert.deepEqual(calls[0]!.args.slice(0, 2), ['-c', '0']);
});

test('capture paths that escape the workspace are refused', async () => {
  const dir = workspace();
  const { run, calls } = fakeRunner();
  const h = createPhoneToolHandlers({ run });
  const res = await h.get('phone_take_photo')!({ save_path: '../escape.jpg' }, ctx(dir));
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /escape/i);
  assert.equal(calls.length, 0, 'no device command runs when confinement fails');
});

test('phone_record_audio clamps seconds into range', async () => {
  const dir = workspace();
  const { run, calls } = fakeRunner();
  const h = createPhoneToolHandlers({ run });
  await h.get('phone_record_audio')!({ seconds: 9999 }, ctx(dir));
  assert.deepEqual(calls[0]!.args.slice(0, 2), ['-l', '300']); // clamped to MAX
});

test('phone_read_sensor lists when sensor omitted, reads a named sensor otherwise', async () => {
  const dir = workspace();
  const { run, calls } = fakeRunner({ stdout: 'accelerometer\nlight' });
  const h = createPhoneToolHandlers({ run });
  const list = await h.get('phone_read_sensor')!({}, ctx(dir));
  assert.equal(calls[0]!.binary, 'termux-sensor');
  assert.deepEqual(calls[0]!.args, ['-l']);
  assert.match(list.output, /accelerometer/); // stdout folded into the read

  await h.get('phone_read_sensor')!({ sensor: 'light', samples: 3 }, ctx(dir));
  assert.deepEqual(calls[1]!.args, ['-s', 'light', '-n', '3']);
});

test('phone_battery folds device JSON into the output', async () => {
  const dir = workspace();
  const { run } = fakeRunner({ stdout: '{"percentage":53,"health":"GOOD"}' });
  const h = createPhoneToolHandlers({ run });
  const res = await h.get('phone_battery')!({}, ctx(dir));
  assert.equal(res.ok, true);
  assert.match(res.output, /"percentage":53/);
});

test('phone_speak and phone_notify require their text; torch defaults ON', async () => {
  const dir = workspace();
  const { run, calls } = fakeRunner();
  const h = createPhoneToolHandlers({ run });

  const empty = await h.get('phone_speak')!({ text: '   ' }, ctx(dir));
  assert.equal(empty.ok, false);

  await h.get('phone_notify')!({ content: 'hi' }, ctx(dir));
  const notify = calls.find((c) => c.binary === 'termux-notification')!;
  assert.deepEqual(notify.args, ['--title', 'Agent', '--content', 'hi']); // identity-neutral default title

  await h.get('phone_torch')!({}, ctx(dir));
  const torch = calls.find((c) => c.binary === 'termux-torch')!;
  assert.deepEqual(torch.args, ['on']);
});

test('a non-zero device exit renders a helpful failure', async () => {
  const dir = workspace();
  const { run } = fakeRunner({ code: 1, stderr: 'permission denied' });
  const h = createPhoneToolHandlers({ run });
  const res = await h.get('phone_battery')!({}, ctx(dir));
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /permission denied/);
  assert.match(res.error ?? '', /Termux:API/);
});

test('a spawn failure (binary not found off-device) fails cleanly, never throws', async () => {
  const dir = workspace();
  const { run } = fakeRunner({ code: -1, error: 'termux-battery-status not found' });
  const h = createPhoneToolHandlers({ run });
  const res = await h.get('phone_battery')!({}, ctx(dir));
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /not found/);
});

test('resolvePhoneTransport reads AGENT_PHONE_SSH_HOST', () => {
  assert.deepEqual(resolvePhoneTransport({}), { kind: 'local' });
  assert.deepEqual(resolvePhoneTransport({ AGENT_PHONE_SSH_HOST: 'pixel' }), { kind: 'ssh', host: 'pixel' });
});

test('buildPhoneEnv passes Termux/Android wiring through but never secrets', () => {
  const env = buildPhoneEnv({
    PATH: '/x/bin',
    HOME: '/home/peh',
    PREFIX: '/data/data/com.termux/files/usr',
    ANDROID_DATA: '/data',
    TERMUX_VERSION: '0.118',
    MIMO_API_KEY: 'sk-secret',
    IKBI_API_TOKEN: 'tok-secret',
  });
  assert.equal(env.PREFIX, '/data/data/com.termux/files/usr');
  assert.equal(env.ANDROID_DATA, '/data');
  assert.equal(env.TERMUX_VERSION, '0.118');
  assert.equal(env.MIMO_API_KEY, undefined, 'API key not leaked into the subprocess env');
  assert.equal(env.IKBI_API_TOKEN, undefined, 'token not leaked into the subprocess env');
});

test('AGENT_PHONE_ENV_ALLOWLIST can add extra passthrough keys', () => {
  const env = buildPhoneEnv({ PATH: '/x', FOO_VAR: 'v', AGENT_PHONE_ENV_ALLOWLIST: 'FOO_VAR' });
  assert.equal(env.FOO_VAR, 'v');
});

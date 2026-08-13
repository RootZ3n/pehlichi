/**
 * MODEL SWITCH tests — the on-the-fly model hot-swap lib. Pure: no network, no server.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SwappableDriver,
  availableModelTargets,
  initialActive,
  resolveTargetRequest,
  buildDriverForTarget,
  type ModelTarget,
} from './lib/model-switch.js';
import type { Driver, DriverContext, DriverAction } from '../../src/core/index.js';

const target = (over: Partial<ModelTarget> = {}): ModelTarget =>
  ({ id: 'm', label: 'm', model: 'm', baseUrl: 'https://api.xiaomimimo.com/v1', keyKind: 'mimo', ...over });

/** A fake inner driver that records how many times next() was called and returns a stop action. */
function fakeDriver(tag: string): Driver & { calls: number } {
  const d = {
    calls: 0,
    async next(_ctx: DriverContext): Promise<DriverAction> {
      d.calls += 1;
      return { kind: 'message', content: tag } as unknown as DriverAction;
    },
  };
  return d;
}

test('availableModelTargets returns the five cloud presets (no local)', () => {
  const ids = availableModelTargets({}).map((t) => t.id);
  assert.deepEqual(ids, ['mimo-v2.5', 'mimo-v2.5-pro', 'deepseek-v4-flash', 'deepseek-v4-pro', 'minimax-m3']);
  const ds = availableModelTargets({}).find((t) => t.id === 'deepseek-v4-flash')!;
  assert.equal(ds.keyKind, 'deepseek');
  assert.match(ds.baseUrl, /api\.deepseek\.com/);
  const mimo = availableModelTargets({}).find((t) => t.id === 'mimo-v2.5')!;
  assert.equal(mimo.keyKind, 'mimo');
  assert.match(mimo.baseUrl, /xiaomimimo/);
  const mm = availableModelTargets({}).find((t) => t.id === 'minimax-m3')!;
  assert.equal(mm.keyKind, 'minimax');
  assert.match(mm.baseUrl, /minimax/);
});

test('PEHLICHI_MODEL_TARGETS can append custom presets; bad JSON is ignored', () => {
  const extra = availableModelTargets({ PEHLICHI_MODEL_TARGETS: '[{"model":"my-model","baseUrl":"https://x/v1"}]' });
  assert.ok(extra.some((t) => t.id === 'my-model'));
  assert.equal(availableModelTargets({ PEHLICHI_MODEL_TARGETS: 'not json' }).length, 5);
});

test('initialActive defaults to mimo-v2.5, honours a valid AGENT_MODEL', () => {
  assert.equal(initialActive({}).id, 'mimo-v2.5');
  assert.equal(initialActive({ AGENT_MODEL: 'deepseek-v4-pro' }).id, 'deepseek-v4-pro');
  assert.equal(initialActive({ AGENT_MODEL: 'nonsense' }).id, 'mimo-v2.5'); // unknown ⇒ first preset
});

test('SwappableDriver forwards next() to the current inner and swap() changes it', async () => {
  const a = fakeDriver('A');
  const b = fakeDriver('B');
  const sw = new SwappableDriver(a, target({ id: 'A', model: 'A' }));
  assert.equal(sw.active.model, 'A');
  await sw.next({} as DriverContext);
  assert.equal(a.calls, 1);

  sw.swap(b, target({ id: 'B', model: 'B' }));
  assert.equal(sw.active.model, 'B');
  await sw.next({} as DriverContext);
  assert.equal(b.calls, 1);
  assert.equal(a.calls, 1, 'old inner no longer receives turns');
});

test('resolveTargetRequest: preset id, unknown id, custom, and missing input', () => {
  const avail = availableModelTargets({});
  const byId = resolveTargetRequest({ id: 'deepseek-v4-pro' }, avail);
  assert.ok(!('error' in byId) && byId.id === 'deepseek-v4-pro');

  const bad = resolveTargetRequest({ id: 'nope' }, avail);
  assert.ok('error' in bad);

  const custom = resolveTargetRequest({ model: 'x', base_url: 'https://api.deepseek.com/v1' }, avail);
  assert.ok(!('error' in custom) && custom.model === 'x' && custom.keyKind === 'deepseek'); // inferred from URL

  const empty = resolveTargetRequest({}, avail);
  assert.ok('error' in empty);
});

test('buildDriverForTarget returns a usable Driver (no network at build time)', () => {
  const d = buildDriverForTarget(target(), 'sk-test');
  assert.equal(typeof d.next, 'function');
});

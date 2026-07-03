import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { truthCognition } from './truth-bridge.js';

/** Write a fake truth-firewall facade (ESM) at <root>/dist/src/lab-cognition.js. */
function fakeTruthFirewall(mode: 'ok' | 'throw'): string {
  const root = mkdtempSync(join(tmpdir(), 'fake-tf-'));
  const dir = join(root, 'dist', 'src');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const body =
    mode === 'throw'
      ? `export function cognitionForAgent(){ throw new Error('boom'); }\nexport function renderCognitionForPrompt(){ return ''; }`
      : `export function cognitionForAgent(i){ return { advisoryOnly:true, task:i.task }; }\n` +
        `export function renderCognitionForPrompt(s){ return s ? 'FAKE TRUTH: ' + (s.task||'') : ''; }`;
  writeFileSync(join(dir, 'lab-cognition.js'), body);
  return root;
}

test('truthCognition returns the rendered advisory block from the facade', async () => {
  process.env.TRUTH_FIREWALL_ROOT = fakeTruthFirewall('ok');
  try {
    const out = await truthCognition({ task: 'ship it' });
    assert.match(out, /FAKE TRUTH: ship it/);
  } finally {
    delete process.env.TRUTH_FIREWALL_ROOT;
  }
});

test('truthCognition degrades to empty when the facade is absent (release-safe)', async () => {
  process.env.TRUTH_FIREWALL_ROOT = join(tmpdir(), 'no-such-truth-firewall-dir-xyz');
  try {
    assert.equal(await truthCognition({ task: 'x' }), '');
  } finally {
    delete process.env.TRUTH_FIREWALL_ROOT;
  }
});

test('truthCognition swallows a facade that throws', async () => {
  process.env.TRUTH_FIREWALL_ROOT = fakeTruthFirewall('throw');
  try {
    assert.equal(await truthCognition({ task: 'x' }), '');
  } finally {
    delete process.env.TRUTH_FIREWALL_ROOT;
  }
});

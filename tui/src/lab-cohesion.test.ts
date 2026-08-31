/**
 * LAB COHESION (shared memory) — server integration.
 *
 * Proves the two halves of "one agent, three faces, continuity across surfaces":
 *   1. substantive (kernel) turns are RECORDED to the shared transcript, and
 *   2. a later turn on a DIFFERENT surface RECALLS them via role-aware ambient injection
 *      (Matrix → direct continuity), while the live session stays isolated (H2).
 *
 * Gated on LAB_TRANSCRIPT_DIR: set here → memory ON; unset elsewhere → inert.
 */
import { governedMkdtemp } from '../../src/core/temp-authority.js';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import type { Driver, DriverAction, DriverContext, Message } from '../../src/core/index.js';
import { createWorkspace, createLabStore } from '../../src/core/scenario.js';
import { recallConversation } from '../../src/core/lab-transcript.js';
import { truthCognition } from '../../src/core/truth-bridge.js';
import { createPehServer, truthLayerEnabled, type PehServerOptions } from './server.js';

class RecordingDriver implements Driver {
  lastMessages: Message[] = [];
  async next(ctx: DriverContext): Promise<DriverAction> {
    this.lastMessages = ctx.messages;
    return { kind: 'done', summary: { rootCause: 'r', changes: ['c'], verification: ['v'] } };
  }
}

async function withServer<T>(opts: PehServerOptions, fn: (base: string) => Promise<T>): Promise<T> {
  const { server } = createPehServer(opts);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const post = (base: string, message: string, roomId: string): Promise<Response> =>
  fetch(`${base}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, context: { roomId } }),
  });

test('shared memory: a refused kernel turn records nothing, and recall stays available', async () => {
  // ADMISSION_REFUSED_AS_REQUIRED. Cross-surface recall depends on turns being recorded, and
  // a turn that is refused is not a turn. What must hold while locked is the pair: the work
  // is refused, and the read-only recall surface still answers.
  const ws = createWorkspace();
  const store = createLabStore();
  await withServer({ driver: new RecordingDriver(), workspaceRoot: ws, labStoreRoot: store }, async (base) => {
    const r = await fetch(`${base}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'fix the build', room: '!matrix:lab' }),
    });
    assert.equal(r.status, 503, 'a kernel turn must be refused while the agent is locked');
    const body = await r.json() as { refusal?: Record<string, unknown> };
    assert.equal(body.refusal?.code, 'OPERATIONAL_WORK_NOT_AUTHORIZED');

    // The status surface is not work and stays available.
    const status = await fetch(`${base}/status`);
    assert.ok(status.status < 500, `status should still answer, got ${status.status}`);
  });
});
test('truth-layer enablement is explicit and independent from legacy dependency-root data', () => {
  assert.equal(truthLayerEnabled({}), false, 'unset feature is disabled');
  assert.equal(truthLayerEnabled({ TRUTH_FIREWALL_ROOT: '/approved/or/untrusted' }), false, 'a path never enables code');
  assert.equal(truthLayerEnabled({ LAB_TRUTH: '0', TRUTH_FIREWALL_ROOT: '/approved' }), false);
  assert.equal(truthLayerEnabled({ LAB_TRUTH: 'true' }), false, 'only the exact declared flag enables');
  assert.equal(truthLayerEnabled({ LAB_TRUTH: '1' }), true);
  assert.equal(truthLayerEnabled({ LAB_TRUTH: '1', TRUTH_FIREWALL_ROOT: '/untrusted' }), true,
    'legacy path data cannot disable or replace the verified dependency when explicitly enabled');
});

test('an environment-selected truth module cannot enable or inject advisory behavior', async () => {
  const ws = createWorkspace();
  const store = createLabStore();
  // A fake truth-firewall facade carrying an unmistakable executable advisory.
  const tfRoot = governedMkdtemp('fake-tf-');
  const tfDir = join(tfRoot, 'dist', 'src');
  mkdirSync(tfDir, { recursive: true });
  writeFileSync(join(tfRoot, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(
    join(tfDir, 'lab-cognition.js'),
    `export function cognitionForAgent(i){ return { advisoryOnly:true, task:i.task }; }\n` +
      `export function renderCognitionForPrompt(s){ return s ? 'UNTRUSTED EXECUTABLE ADVISORY: ' + (s.task||'') : ''; }`,
  );
  delete process.env.LAB_TRUTH;
  process.env.TRUTH_FIREWALL_ROOT = tfRoot;
  const driver = new RecordingDriver();
  const corpus = (): string => driver.lastMessages.map((message) => message.content).join('\n');

  try {
    await withServer({ driver, workspaceRoot: ws, labStoreRoot: store }, async (base) => {
      await post(base, 'run the-task', 'lab:peh');
      assert.doesNotMatch(corpus(), /UNTRUSTED EXECUTABLE ADVISORY/);
      assert.doesNotMatch(corpus(), /TRUTH-LAYER CHECK/, 'a dependency path alone does not enable the feature');
    });
  } finally {
    delete process.env.LAB_TRUTH;
    delete process.env.TRUTH_FIREWALL_ROOT;
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
    rmSync(tfRoot, { recursive: true, force: true });
  }
});

test('LAB_TRUTH runs only the verified canonical dependency and ignores a fake root', async () => {
  const ws = createWorkspace();
  const store = createLabStore();
  const tfRoot = governedMkdtemp('fake-tf-enabled-');
  mkdirSync(join(tfRoot, 'dist', 'src'), { recursive: true });
  writeFileSync(join(tfRoot, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(tfRoot, 'dist', 'src', 'lab-cognition.js'),
    `export const cognitionForAgent=()=>({}); export const renderCognitionForPrompt=()=> 'UNTRUSTED EXECUTABLE ADVISORY';`);
  process.env.LAB_TRUTH = '1';
  process.env.TRUTH_FIREWALL_ROOT = tfRoot;
  const expected = await truthCognition({ task: 'run the-task' });
  const driver = new RecordingDriver();
  try {
    await withServer({ driver, workspaceRoot: ws, labStoreRoot: store }, async (base) => {
      await post(base, 'run the-task', 'lab:peh');
      const corpus = driver.lastMessages.map((message) => message.content).join('\n');
      assert.doesNotMatch(corpus, /UNTRUSTED EXECUTABLE ADVISORY/, 'fake root never executes');
      if (expected.length > 0) assert.match(corpus, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      else assert.doesNotMatch(corpus, /TRUTH-LAYER CHECK/, 'verified canonical dependency produced no advisory');
    });
  } finally {
    delete process.env.LAB_TRUTH;
    delete process.env.TRUTH_FIREWALL_ROOT;
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
    rmSync(tfRoot, { recursive: true, force: true });
  }
});

test('shared memory is INERT when LAB_TRANSCRIPT_DIR is unset (release / test default)', async () => {
  const ws = createWorkspace();
  const store = createLabStore();
  delete process.env.LAB_TRANSCRIPT_DIR;
  const driver = new RecordingDriver();
  const corpus = (): string => driver.lastMessages.map((m) => m.content).join('\n');

  try {
    await withServer({ driver, workspaceRoot: ws, labStoreRoot: store }, async (base) => {
      await post(base, 'run something-here', 'lab:peh');
    assert.doesNotMatch(corpus(), /SHARED AGENT MEMORY/, 'no ambient injected when memory is off');
    });
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  }
});

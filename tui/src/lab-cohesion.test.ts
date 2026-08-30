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
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { QUALIFICATION_AUTHORITY } from '../../src/core/operational-admission.js';

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
  const { server } = createPehServer({
    // These are the server's own self-tests, so every turn they drive declares that
    // purpose and carries the exact qualification authority. A deployed turn declares
    // neither and is refused while the governed status is PRE_PRODUCTION.
    operationalPurpose: 'self-test',
    operationalAuthority: QUALIFICATION_AUTHORITY,
    ...opts,
  });
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

test('shared memory: kernel turns are recorded, and a later surface recalls them (Matrix → direct)', async () => {
  const ws = createWorkspace();
  const store = createLabStore();
  const memDir = mkdtempSync(join(tmpdir(), 'lab-cohesion-'));
  process.env.LAB_TRANSCRIPT_DIR = memDir;
  const driver = new RecordingDriver();
  // The ambient recall is folded into the system/persona message; inspect it precisely.
  const ambientMsg = (): string =>
    driver.lastMessages.find((m) => m.content.includes('SHARED AGENT MEMORY'))?.content ?? '';

  try {
    await withServer({ driver, workspaceRoot: ws, labStoreRoot: store }, async (base) => {
      // Turn on a Matrix surface (its own isolated session).
      await post(base, 'run alpha-matrix-task', '!room:matrix');

      // It is RECORDED to the shared transcript.
      assert.match(recallConversation(), /alpha-matrix-task/, 'the Matrix turn is in shared memory');

      // Now switch to the direct/canonical surface: ambient recall must surface the Matrix
      // conversation (continuity across surfaces) even though the session is separate.
      await post(base, 'run beta-direct-task', 'lab:peh');
      assert.match(ambientMsg(), /alpha-matrix-task/, 'direct surface recalls the Matrix conversation via ambient');

      // The ambient must NOT echo the current live thread back (the session already holds it):
      // beta was recorded under (peh, lab:peh), so a fresh turn there sees alpha but not beta.
      await post(base, 'run gamma-direct-task', 'lab:peh');
      assert.match(ambientMsg(), /alpha-matrix-task/, 'still recalls the other surface');
      assert.doesNotMatch(ambientMsg(), /beta-direct-task/, 'own live thread is not re-injected as ambient');
    });
  } finally {
    delete process.env.LAB_TRANSCRIPT_DIR;
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
    rmSync(memDir, { recursive: true, force: true });
  }
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
  const tfRoot = mkdtempSync(join(tmpdir(), 'fake-tf-'));
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
  const tfRoot = mkdtempSync(join(tmpdir(), 'fake-tf-enabled-'));
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

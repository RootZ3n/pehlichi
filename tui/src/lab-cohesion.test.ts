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
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import type { Driver, DriverAction, DriverContext, Message } from '../../src/core/index.js';
import { createWorkspace, createLabStore } from '../../src/core/scenario.js';
import { recallConversation } from '../../src/core/lab-transcript.js';
import { createPehServer, type PehServerOptions } from './server.js';

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

test('shared memory: kernel turns are recorded, and a later surface recalls them (Matrix → direct)', async () => {
  const ws = createWorkspace();
  const store = createLabStore();
  const memDir = mkdtempSync(join(tmpdir(), 'lab-cohesion-'));
  process.env.LAB_TRANSCRIPT_DIR = memDir;
  const driver = new RecordingDriver();
  // The ambient recall is folded into the system/persona message; inspect it precisely.
  const ambientMsg = (): string =>
    driver.lastMessages.find((m) => m.content.includes('SHARED LAB MEMORY'))?.content ?? '';

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

test('shared memory is INERT when LAB_TRANSCRIPT_DIR is unset (release / test default)', async () => {
  const ws = createWorkspace();
  const store = createLabStore();
  delete process.env.LAB_TRANSCRIPT_DIR;
  const driver = new RecordingDriver();
  const corpus = (): string => driver.lastMessages.map((m) => m.content).join('\n');

  try {
    await withServer({ driver, workspaceRoot: ws, labStoreRoot: store }, async (base) => {
      await post(base, 'run something-here', 'lab:peh');
      assert.doesNotMatch(corpus(), /SHARED LAB MEMORY/, 'no ambient injected when memory is off');
    });
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  }
});

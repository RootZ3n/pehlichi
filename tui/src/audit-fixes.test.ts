/**
 * TRIO AUDIT FIX regression tests (server / session layer).
 *
 *   C4  — transcript resurrection after /reset (checkpoint save/resume + clear-on-reset)
 *   H2  — per-room sessions: no cross-room context bleed
 *   H4  — TokenMonitor receives real usage from the driver
 *   H1  — endpoint auth on /chat
 */
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import {
  ScriptedDriver,
  type Driver,
  type DriverAction,
  type DriverContext,
  type Message,
  type TokenUsage,
} from '../../src/core/index.js';
import { createWorkspace, createLabStore } from '../../src/core/scenario.js';
import { pehProfile } from '../../src/profile.js';
import { KernelChatSession } from './lib/kernel-session.js';
import { createPehServer, type PehServerOptions } from './server.js';

/** A driver that always finishes with a valid summary (reusable across many turns). */
const doneDriver: Driver = {
  async next(): Promise<DriverAction> {
    return { kind: 'done', summary: { rootCause: 'r', changes: ['c'], verification: ['v'] } };
  },
};

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

// ── C4: checkpoint save → resume cycle, and /reset erases the transcript ────────

test('C4. a session checkpoints + resumes, and reset() clears checkpoints so the transcript cannot resurrect', async () => {
  const ws = createWorkspace();
  const store = createLabStore();
  const checkpointDir = mkdtempSync(join(tmpdir(), 'c4-cp-'));
  const base = { profile: pehProfile, driver: doneDriver, workspaceRoot: ws, labStoreRoot: store, checkpointDir };
  try {
    // Turn 1 writes a checkpoint.
    const s1 = new KernelChatSession(base);
    await s1.send('remember alpha');
    assert.equal(s1.getHistory().length, 2);

    // A fresh session on the same dir RESUMES from the checkpoint (save/resume cycle).
    const s2 = new KernelChatSession(base);
    assert.equal(s2.getHistory().length, 2, 'resumed prior transcript from checkpoint');
    assert.match(s2.getHistory()[0]!.content, /remember alpha/);

    // /reset must wipe the on-disk checkpoints, not just memory.
    s2.reset();
    assert.equal(s2.getHistory().length, 0);

    // A session constructed AFTER the reset must NOT resurrect the pre-reset transcript.
    const s3 = new KernelChatSession(base);
    assert.equal(s3.getHistory().length, 0, 'no resurrection: cleared checkpoints stay gone');
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
    rmSync(checkpointDir, { recursive: true, force: true });
  }
});

// ── H2: every room gets its own session; no cross-room context bleed ───────────

test('H2. /chat routes each room to its own session — one room never sees another’s history', async () => {
  const ws = createWorkspace();
  const store = createLabStore();

  // Records the messages handed to the driver on the most recent run, so we can inspect
  // exactly what prior context a given room's session threaded in.
  class RecordingDriver implements Driver {
    lastMessages: Message[] = [];
    async next(ctx: DriverContext): Promise<DriverAction> {
      this.lastMessages = ctx.messages;
      return { kind: 'done', summary: { rootCause: 'r', changes: ['c'], verification: ['v'] } };
    }
  }
  const driver = new RecordingDriver();
  const corpus = (): string => driver.lastMessages.map((m) => m.content).join('\n');

  const post = (base: string, message: string, roomId?: string): Promise<Response> =>
    fetch(`${base}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(roomId ? { message, context: { roomId } } : { message }),
    });

  try {
    await withServer({ driver, workspaceRoot: ws, labStoreRoot: store }, async (base) => {
      await post(base, 'alpha-secret', '!roomA');
      // Second turn in room A must carry room A's first message as prior context.
      await post(base, 'beta-followup', '!roomA');
      assert.match(corpus(), /alpha-secret/, 'room A turn 2 sees room A turn 1');

      // Room B is a different session — it must NOT see room A's transcript.
      await post(base, 'gamma-other', '!roomB');
      const bCorpus = corpus();
      assert.match(bCorpus, /gamma-other/);
      assert.doesNotMatch(bCorpus, /alpha-secret/, 'room B does NOT see room A history (no bleed)');
      assert.doesNotMatch(bCorpus, /beta-followup/);
    });
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  }
});

// ── H4: the TokenMonitor is fed REAL usage drained from the driver ─────────────

test('H4. token usage from the driver is recorded in the session TokenMonitor (not stuck at zero)', async () => {
  const ws = createWorkspace();
  const store = createLabStore();

  // A usage-reporting driver: finishes immediately and reports token usage to drain.
  class UsageDriver implements Driver {
    private pending: TokenUsage[] = [{ input: 1500, output: 800, cached: 1200 }];
    drainUsage(): TokenUsage[] { const d = this.pending; this.pending = []; return d; }
    async next(): Promise<DriverAction> {
      return { kind: 'done', summary: { rootCause: 'r', changes: ['c'], verification: ['v'] } };
    }
  }

  try {
    const session = new KernelChatSession({
      profile: pehProfile,
      driver: new UsageDriver(),
      workspaceRoot: ws,
      labStoreRoot: store,
    });
    const res = await session.send('do something');
    assert.ok(res.tokenUsage, 'tokenUsage is surfaced');
    assert.equal(res.tokenUsage!.totalInput, 1500);
    assert.equal(res.tokenUsage!.totalOutput, 800);
    assert.equal(res.tokenUsage!.totalCached, 1200);
    assert.equal(res.tokenUsage!.callCount, 1);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  }
});

// ── H1: /chat requires the configured bearer token ─────────────────────────────

test('H1. /chat rejects an unauthenticated request when a chat token is configured, and accepts the right token', async () => {
  const ws = createWorkspace();
  const store = createLabStore();
  try {
    await withServer(
      { driver: new ScriptedDriver([]), workspaceRoot: ws, labStoreRoot: store, chatToken: 's3cret', allowWrites: false },
      async (base) => {
        // No Authorization header → 401 (and the driver is never touched).
        const noAuth = await fetch(`${base}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'hi' }),
        });
        assert.equal(noAuth.status, 401);

        // Wrong token → 401.
        const badAuth = await fetch(`${base}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' },
          body: JSON.stringify({ message: 'hi' }),
        });
        assert.equal(badAuth.status, 401);

        // /health stays open (no auth) — only the chat endpoints are gated.
        const health = await fetch(`${base}/health`);
        assert.equal(health.status, 200);
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  }
});

test('H1. /chat with the correct bearer token passes the auth gate', async () => {
  const ws = createWorkspace();
  const store = createLabStore();
  const actions: DriverAction[] = [
    { kind: 'done', summary: { rootCause: 'authed', changes: ['c'], verification: ['v'] } },
  ];
  try {
    await withServer(
      { driver: new ScriptedDriver(actions), workspaceRoot: ws, labStoreRoot: store, chatToken: 's3cret' },
      async (base) => {
        const res = await fetch(`${base}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer s3cret' },
          body: JSON.stringify({ message: 'hi' }),
        });
        assert.notEqual(res.status, 401);
        const body = await res.json() as { content: string };
        assert.match(body.content, /authed/);
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  }
});

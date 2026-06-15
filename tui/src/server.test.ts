/**
 * Server acceptance tests — Blockers 1, 2, 5.
 *
 * These drive the REAL HTTP request path (createPehServer) with an injected
 * ScriptedDriver, so the whole kernel loop runs with no network.
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';

import { ScriptedDriver, type Driver, type DriverAction } from '../../src/core/index.js';
import { createWorkspace, createLabStore } from '../../src/core/scenario.js';
import { createPehServer, type PehServerOptions } from './server.js';

/** A driver that NEVER finishes — every turn narrates, so the budget always exhausts. */
const neverDoneDriver: Driver = {
  async next(): Promise<DriverAction> {
    return { kind: 'narrate', phase: 'other', text: 'still thinking' };
  },
};

/** A driver that finishes immediately on every turn with a valid summary. */
const alwaysDoneDriver: Driver = {
  async next(): Promise<DriverAction> {
    return { kind: 'done', summary: { rootCause: 'r', changes: ['c'], verification: ['v'] } };
  },
};

async function withServer<T>(
  opts: PehServerOptions,
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const { server } = createPehServer(opts);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ── Blocker 1: production runs on the kernel ──────────────────────────────────

test('B1. /chat drives the kernel loop: tool calls flow through the kernel registry + event system', async () => {
  const ws = createWorkspace();
  const store = createLabStore();
  // A terminal tool call then a valid done — exercising the kernel registry + summary.
  const actions: DriverAction[] = [
    { kind: 'tool', tool: 'terminal', args: { command: 'echo kernel-ran' } },
    { kind: 'done', summary: { rootCause: 'did the thing', changes: ['ran echo'], verification: ['stdout shows kernel-ran'] } },
  ];
  try {
    await withServer(
      { driver: new ScriptedDriver(actions), workspaceRoot: ws, labStoreRoot: store, allowWrites: true },
      async (base) => {
        const res = await fetch(`${base}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'run echo' }),
        });
        assert.equal(res.status, 200);
        const body = await res.json() as any;
        assert.equal(body.ok, true);
        assert.equal(body.partial, false);
        // The content came from the kernel's validated SUMMARY (the done path), not an
        // ad-hoc final assistant message.
        assert.match(body.content, /did the thing/);
        // The tool call went through the kernel tool registry (terminal is a kernel tool).
        const term = body.toolCalls.find((tc: any) => tc.name === 'terminal');
        assert.ok(term, 'terminal tool call surfaced from the kernel event stream');
        assert.equal(term.ok, true);
        assert.match(term.output, /kernel-ran/);
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  }
});

test('B1. validateSummary fires on done: an invalid summary fails the run (HTTP 500), not a quiet 200', async () => {
  const ws = createWorkspace();
  const store = createLabStore();
  const actions: DriverAction[] = [
    // changes[] empty => validateSummary must reject this done.
    { kind: 'done', summary: { rootCause: 'r', changes: [], verification: ['v'] } },
  ];
  try {
    await withServer(
      { driver: new ScriptedDriver(actions), workspaceRoot: ws, labStoreRoot: store },
      async (base) => {
        const res = await fetch(`${base}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'finish without verifying' }),
        });
        assert.equal(res.status, 500);
        const body = await res.json() as any;
        assert.match(body.error, /invalid summary/);
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  }
});

// ── Blocker 5: structured tool results with receipts are NOT stripped ─────────

test('B5. /chat response includes the terminal RECEIPT alongside the tool result (not just prose)', async () => {
  const ws = createWorkspace();
  const store = createLabStore();
  const actions: DriverAction[] = [
    { kind: 'tool', tool: 'terminal', args: { command: 'echo evidence' } },
    { kind: 'done', summary: { rootCause: 'r', changes: ['c'], verification: ['v'] } },
  ];
  try {
    await withServer(
      { driver: new ScriptedDriver(actions), workspaceRoot: ws, labStoreRoot: store, allowWrites: true },
      async (base) => {
        const res = await fetch(`${base}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'run echo' }),
        });
        const body = await res.json() as any;
        const term = body.toolCalls.find((tc: any) => tc.name === 'terminal');
        assert.ok(term?.receipt, 'the terminal receipt is forwarded, not stripped');
        assert.equal(term.receipt.exitCode, 0);
        assert.equal(typeof term.receipt.command, 'string');
        assert.ok(Array.isArray(term.receipt.envKeys), 'receipt carries env KEYS (audit surface)');
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  }
});

// ── Blocker 2: budget exhaustion is a clear partial, NOT a stale 200 replay ────

test('B2. exhausting the iteration budget returns a non-200 partial — and never a stale replay', async () => {
  const ws = createWorkspace();
  const store = createLabStore();
  try {
    await withServer(
      { driver: neverDoneDriver, workspaceRoot: ws, labStoreRoot: store, maxIterations: 3 },
      async (base) => {
        const send = async (message: string) => {
          const res = await fetch(`${base}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message }),
          });
          return { status: res.status, body: await res.json() as any };
        };

        const first = await send('do a long task');
        assert.notEqual(first.status, 200, 'budget-exhausted must NOT be a blind 200');
        assert.equal(first.status, 422);
        assert.equal(first.body.partial, true);
        assert.match(first.body.content, /Budget exhausted/);

        // A SECOND request must NOT return the first response verbatim (the stale-replay
        // bug). It is independently evaluated and again reports exhaustion clearly.
        const second = await send('a different question entirely');
        assert.equal(second.status, 422);
        assert.equal(second.body.partial, true);
        // Not a stale 200 with the old assistant text.
        assert.notEqual(second.status, 200);
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  }
});

// ── HTTP contract preserved ───────────────────────────────────────────────────

test('contract: /health, /tools, /capabilities, /reset still respond with the expected shape', async () => {
  const ws = createWorkspace();
  const store = createLabStore();
  try {
    await withServer(
      { driver: neverDoneDriver, workspaceRoot: ws, labStoreRoot: store },
      async (base) => {
        const health = await (await fetch(`${base}/health`)).json() as any;
        assert.equal(health.status, 'ok');
        assert.ok(health.toolCount > 0);

        const tools = await (await fetch(`${base}/tools`)).json() as any;
        assert.ok(Array.isArray(tools.tools));
        assert.ok(tools.tools.includes('terminal'), 'kernel terminal tool is advertised');

        const caps = await (await fetch(`${base}/capabilities`)).json() as any;
        assert.ok(caps.features.includes('kernel_loop'));
        assert.deepEqual(
          caps.endpoints,
          ['/health', '/tools', '/info', '/chat', '/chat/stream', '/reset', '/agent', '/capabilities', '/task/:id/status', '/api/sessions', '/api/memories', '/api/agents', '/api/bridge', '/receipts'],
        );

        const reset = await fetch(`${base}/reset`, { method: 'POST' });
        assert.equal(reset.status, 200);
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  }
});

test('UI read model: /api/sessions, /api/memories, /api/agents, /api/bridge respond with the expected shape', async () => {
  const ws = createWorkspace();
  const store = createLabStore();
  try {
    await withServer(
      { driver: neverDoneDriver, workspaceRoot: ws, labStoreRoot: store },
      async (base) => {
        const sessions = await (await fetch(`${base}/api/sessions`)).json() as any;
        assert.ok(Array.isArray(sessions.sessions), 'sessions is an array');
        assert.ok(sessions.sessions.some((s: any) => s.isDefault), 'the default session is present');
        assert.equal(typeof sessions.ttlMs, 'number');

        const memories = await (await fetch(`${base}/api/memories`)).json() as any;
        assert.ok(Array.isArray(memories.pastLives), 'pastLives is an array');
        assert.ok(memories.pastLives.length >= 1, 'at least one past life is surfaced');
        assert.ok(memories.pastLives[0].name && 'era' in memories.pastLives[0], 'past life has name + era');
        assert.ok(Array.isArray(memories.entries), 'entries is an array (best-effort)');

        const agents = await (await fetch(`${base}/api/agents`)).json() as any;
        assert.ok(Array.isArray(agents.agents), 'agents is an array');
        assert.ok(agents.agents.length >= 1, 'at least one ecosystem agent');
        assert.ok(agents.self && typeof agents.self.tools === 'number', 'self block reports tool count');

        const bridge = await (await fetch(`${base}/api/bridge`)).json() as any;
        assert.ok(Array.isArray(bridge.bridges), 'bridges is an array');
        assert.equal(typeof bridge.connected, 'number');
        // CORS header lets the file:// / cross-origin UI engine read these.
        const cors = (await fetch(`${base}/api/agents`)).headers.get('access-control-allow-origin');
        assert.equal(cors, '*', 'read model is CORS-open for the local UI');
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  }
});

// ── BLOCKER-1: per-caller session map is bounded by an idle TTL ────────────────

test('B1. idle sessions are evicted past the TTL; /health reports the count', async () => {
  const ws = createWorkspace();
  const store = createLabStore();
  let clock = 1_000; // injected, advanceable clock
  try {
    await withServer(
      { driver: alwaysDoneDriver, workspaceRoot: ws, labStoreRoot: store, sessionTtlMs: 1_000, now: () => clock },
      async (base) => {
        const chat = (roomId: string) => fetch(`${base}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'hi', context: { roomId } }),
        });
        const health = async () => (await fetch(`${base}/health`)).json() as any;

        // Two distinct rooms => default + room-a + room-b live in the map.
        await chat('room-a');
        await chat('room-b');
        let h = await health();
        assert.equal(h.sessions, 3, 'default + room-a + room-b are resident');
        assert.equal(h.sessionsEvicted, 0);

        // Advance well past the TTL, then drive ONE more request. The inline eviction at
        // the top of /chat reclaims both idle rooms; 'default' is never evicted.
        clock += 5_000;
        await chat('room-c');
        h = await health();
        assert.equal(h.sessions, 2, 'only default + the fresh room-c remain');
        assert.equal(h.sessionsEvicted, 2, 'room-a and room-b were evicted');
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  }
});

test('B1. /health surfaces instanceId and cronJobs for the operator (H1/H3)', async () => {
  const ws = createWorkspace();
  const store = createLabStore();
  try {
    await withServer(
      { driver: neverDoneDriver, workspaceRoot: ws, labStoreRoot: store },
      async (base) => {
        const h = await (await fetch(`${base}/health`)).json() as any;
        assert.match(h.instanceId, /^\d+:\d+$/, 'instanceId is port:PID');
        assert.equal(typeof h.cronJobs, 'number');
        assert.equal(typeof h.sessions, 'number');
        assert.equal(typeof h.sessionsEvicted, 'number');
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  }
});

// ── BLOCKER-2 / H4: bridge tasks are pollable by their X-Task-Id ───────────────

test('B2. /task/:id/status reports completed for a finished task and 404 for an unknown one', async () => {
  const ws = createWorkspace();
  const store = createLabStore();
  try {
    await withServer(
      { driver: alwaysDoneDriver, workspaceRoot: ws, labStoreRoot: store },
      async (base) => {
        const res = await fetch(`${base}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Task-Id': 'task-done' },
          body: JSON.stringify({ message: 'do it' }),
        });
        assert.equal(res.status, 200);

        const done = await (await fetch(`${base}/task/task-done/status`)).json() as any;
        assert.equal(done.taskId, 'task-done');
        assert.equal(done.status, 'completed');

        const unknown = await fetch(`${base}/task/nope-xyz/status`);
        assert.equal(unknown.status, 404);
        assert.equal((await unknown.json() as any).status, 'not-found');
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  }
});

test('B2. /task/:id/status reports failed when the run errors', async () => {
  const ws = createWorkspace();
  const store = createLabStore();
  // An invalid summary (empty changes) makes validateSummary reject => /chat 500 => task failed.
  const badDriver: Driver = {
    async next(): Promise<DriverAction> {
      return { kind: 'done', summary: { rootCause: 'r', changes: [], verification: ['v'] } };
    },
  };
  try {
    await withServer(
      { driver: badDriver, workspaceRoot: ws, labStoreRoot: store },
      async (base) => {
        const res = await fetch(`${base}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Task-Id': 'task-fail' },
          body: JSON.stringify({ message: 'finish badly' }),
        });
        assert.equal(res.status, 500);
        const status = await (await fetch(`${base}/task/task-fail/status`)).json() as any;
        assert.equal(status.status, 'failed');
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  }
});

test('B2. /task/:id/status reports running while the task is in flight', async () => {
  const ws = createWorkspace();
  const store = createLabStore();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const blockingDriver: Driver = {
    async next(): Promise<DriverAction> {
      await gate; // block until the test releases it
      return { kind: 'done', summary: { rootCause: 'r', changes: ['c'], verification: ['v'] } };
    },
  };
  try {
    await withServer(
      { driver: blockingDriver, workspaceRoot: ws, labStoreRoot: store },
      async (base) => {
        const inflight = fetch(`${base}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Task-Id': 'task-run' },
          body: JSON.stringify({ message: 'long task' }),
        });
        // Give the server a moment to register the task before the driver blocks.
        await new Promise((r) => setTimeout(r, 100));
        const running = await (await fetch(`${base}/task/task-run/status`)).json() as any;
        assert.equal(running.status, 'running');

        release();
        await inflight;
        const done = await (await fetch(`${base}/task/task-run/status`)).json() as any;
        assert.equal(done.status, 'completed');
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  }
});

after(() => {
  // Nothing global to clean; each test disposes its own workspace + server.
});

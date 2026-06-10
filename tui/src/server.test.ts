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
          ['/health', '/tools', '/info', '/chat', '/chat/stream', '/reset', '/agent', '/capabilities'],
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

after(() => {
  // Nothing global to clean; each test disposes its own workspace + server.
});

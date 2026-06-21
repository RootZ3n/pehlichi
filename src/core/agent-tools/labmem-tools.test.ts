/**
 * LABMEM ADAPTER tests (Phase 4 labmem-integration hardening).
 *
 * Proves the labmem_recall / labmem_remember adapter contract against a REAL
 * labmem store seeded in a temp root:
 *   1. recall returns shared + own + project memory.
 *   2. another agent's private memory is NEVER returned (isolation).
 *   3. an unavailable labmem (bad LABMEM_ROOT) yields a tool error, not a crash.
 *   4. global/user writes are forced to a DRY-RUN proposal (never applied) even
 *      when apply:true, and leave a DURABLE proposal receipt on disk.
 *
 * The adapter imports labmem code from LABMEM_ROOT/dist and uses the same root as
 * the data store, so each temp root symlinks dist -> the real built labmem. The
 * "unavailable" test must run FIRST: the adapter caches the labmem module on the
 * first successful load, so the cold import-failure path must be exercised before
 * any populated test succeeds.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createLabmemToolHandlers } from './labmem-tools.js';
import type { ToolContext, ToolResult } from '../tools.js';

const AGENT = 'pehlichi';
const REAL_LABMEM = process.env['LABMEM_REAL'] ?? '/pehverse/repos/lab-utilities/lab-memory/labmem';

const handlers = createLabmemToolHandlers();
const recall = handlers.get('labmem_recall')!;
const remember = handlers.get('labmem_remember')!;
const ctx = (dir: string): ToolContext => ({ workspaceRoot: dir, labStoreRoot: dir, store: {} });

// Lazily import the real built labmem so the test can seed the store directly.
// The path is non-literal so the typechecker treats the module as `any`.
let _labmem: any;
async function labmem(): Promise<any> {
  return (_labmem ??= await import(`${REAL_LABMEM}/dist/index.js`));
}

/** A temp labmem root whose `dist` is the real built labmem (code) + own data dirs. */
function freshRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  symlinkSync(join(REAL_LABMEM, 'dist'), join(root, 'dist'), 'dir');
  return root;
}

async function seed(root: string): Promise<void> {
  const m = await labmem();
  const store = m.createStore({ root });
  const base = { confidence: 'observed' as const, source: 'test', actor: 'test' };
  store.addMemory({ ...base, id: 'lab-rule', scope: 'global', namespace: 'global', memoryType: 'shared', title: 'Lab rule alpha', description: 'a shared lab-wide rule', body: 'all agents follow alpha' });
  store.addMemory({ ...base, id: 'own-fact', scope: 'agent', namespace: AGENT, memoryType: 'semantic', title: 'Own fact beta', description: 'this agent private', body: 'beta' });
  store.addMemory({ ...base, id: 'proj-fact', scope: 'project', namespace: AGENT, memoryType: 'project', title: 'Project fact gamma', description: 'agent project memory', body: 'gamma' });
  store.addMemory({ ...base, id: 'foreign-secret', scope: 'agent', namespace: 'other-agent', shared: false, memoryType: 'semantic', title: 'Foreign secret delta', description: 'another agent private', body: 'delta' });
}

// ── 1. unavailable labmem → tool error, not a crash (MUST run first) ──────────

test('labmem unavailable (bad LABMEM_ROOT) returns a tool error, not a crash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'labmem-pehlichi-missing-')); // no dist/, no core/
  const prev = process.env['LABMEM_ROOT'];
  process.env['LABMEM_ROOT'] = root;
  try {
    const res: ToolResult = await recall({}, ctx(root));
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /labmem_recall failed/);
  } finally {
    if (prev === undefined) delete process.env['LABMEM_ROOT']; else process.env['LABMEM_ROOT'] = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 2. recall returns shared + own + project; foreign private is absent ───────

test('recall returns shared + own + project memory and hides other agents private memory', async () => {
  const root = freshRoot('labmem-pehlichi-recall-');
  const prev = process.env['LABMEM_ROOT'];
  process.env['LABMEM_ROOT'] = root;
  try {
    await seed(root);
    const res: ToolResult = await recall({}, ctx(root));
    assert.equal(res.ok, true, res.error);
    assert.match(res.output, /Lab rule alpha/, 'shared memory must be recalled');
    assert.match(res.output, /Own fact beta/, 'own memory must be recalled');
    assert.match(res.output, /Project fact gamma/, 'project memory must be recalled');
    assert.doesNotMatch(res.output, /Foreign secret delta/, 'another agent private memory must NOT leak');
  } finally {
    if (prev === undefined) delete process.env['LABMEM_ROOT']; else process.env['LABMEM_ROOT'] = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 3. global/user write is forced to dry-run AND leaves a durable proposal ───

test('global remember is forced to dry-run (even apply:true) and leaves a durable proposal receipt', async () => {
  const root = freshRoot('labmem-pehlichi-proposal-');
  const prev = process.env['LABMEM_ROOT'];
  process.env['LABMEM_ROOT'] = root;
  try {
    const res: ToolResult = await remember(
      { id: 'shared-proposal', title: 'Proposed shared rule', description: 'an agent proposes a lab rule', body: 'do the thing', scope: 'global', apply: true },
      ctx(root),
    );
    assert.equal(res.ok, true, res.error);
    assert.match(res.output, /dry-run/, 'global write must report dry-run regardless of apply');
    assert.match(res.output, /proposal receipt:/, 'a proposal receipt path must be surfaced');

    // The memory entry itself must NOT have been applied.
    assert.ok(!existsSync(join(root, 'global', 'shared-proposal.md')), 'global write must not be applied to disk');
    // The applied-receipts ledger must NOT exist (invariant preserved).
    assert.ok(!existsSync(join(root, 'receipts')), 'dry-run must not write an applied receipt');

    // A DURABLE proposal receipt must persist.
    const ledger = join(root, 'proposals', 'proposals.jsonl');
    assert.ok(existsSync(ledger), 'proposals ledger must exist');
    const text = readFileSync(ledger, 'utf8');
    assert.match(text, /global:global:shared-proposal/, 'proposal must record the target fqid');
    assert.match(text, /"result": ?"dry-run"|"result":"dry-run"/, 'proposal must be a dry-run record');
  } finally {
    if (prev === undefined) delete process.env['LABMEM_ROOT']; else process.env['LABMEM_ROOT'] = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 4. own-memory write with apply:true is actually applied ───────────────────

test('own-memory remember with apply:true is applied (not a dry-run)', async () => {
  const root = freshRoot('labmem-pehlichi-apply-');
  const prev = process.env['LABMEM_ROOT'];
  process.env['LABMEM_ROOT'] = root;
  try {
    const res: ToolResult = await remember(
      { id: 'mine', title: 'My own note', description: 'private to this agent', body: 'kept', scope: 'agent', apply: true },
      ctx(root),
    );
    assert.equal(res.ok, true, res.error);
    assert.match(res.output, /applied:/, 'own-memory write with apply:true must be applied');
    assert.ok(existsSync(join(root, 'agents', AGENT, 'mine.md')), 'applied own memory must be written to disk');
  } finally {
    if (prev === undefined) delete process.env['LABMEM_ROOT']; else process.env['LABMEM_ROOT'] = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

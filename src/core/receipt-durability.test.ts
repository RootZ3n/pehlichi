/**
 * RECEIPT DURABILITY — does an ID a caller holds still resolve after the process that issued it?
 *
 * The previous store answered no, and no test said so, because every test constructed a store and
 * read from the same live object. That proves the cache, not the contract. The cases here cross a
 * process boundary: a child records receipts and is SIGKILLed, and the assertions run in a parent
 * that never shared its memory.
 *
 * SIGKILL rather than an exception or a thrown-and-caught error, because the claim is about a
 * process that gets no chance to flush. A handler-based test would prove orderly shutdown, which
 * was never in doubt.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { ReceiptStore } from './receipt-store.js';
import { receiptJournalName } from './loop.js';
import { governedMkdtemp } from './temp-authority.js';

const base = (): string => governedMkdtemp('receipt-durability-');

test('a receipt is on disk before record() returns', () => {
  const dir = base();
  try {
    const journalPath = join(dir, 'nested', 'receipts.jsonl');
    const store = new ReceiptStore({ journalPath });
    const receipt = store.record({ agent: 'ptah', status: 'success', toolCallCount: 1 });
    store.destroy();
    // Read the file directly rather than through the store, so the cache cannot answer for it.
    const lines = readFileSync(journalPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal((JSON.parse(lines[0] ?? '{}') as { id: string }).id, receipt.id);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a cache-only store reports that its IDs are not durable', () => {
  const store = new ReceiptStore();
  try {
    assert.equal(store.durable, false);
    const durable = new ReceiptStore({ journalPath: join(base(), 'j.jsonl') });
    assert.equal(durable.durable, true);
    durable.destroy();
  } finally { store.destroy(); }
});

test('TTL expiry evicts from the cache and never from the journal', () => {
  const dir = base();
  try {
    const journalPath = join(dir, 'receipts.jsonl');
    let now = 1_000_000;
    const store = new ReceiptStore({ journalPath, ttlMs: 10, clock: () => now });
    const receipt = store.record({ agent: 'ptah', status: 'success', toolCallCount: 0 });
    now += 10_000_000;                       // far past the TTL
    (store as unknown as { sweep: () => void }).sweep();
    // The eviction happened; the retrieval still works.
    assert.equal(store.get(receipt.id)?.id, receipt.id, 'an evicted receipt is still retrievable');
    assert.equal(store.recent(10).length, 1);
    assert.equal(store.summary().total, 1);
    store.destroy();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('receipts survive SIGKILL of the process that recorded them', () => {
  const dir = base();
  try {
    const journalPath = join(dir, 'receipts.jsonl');
    const child = join(dir, 'child.mjs');
    // The child records three receipts, prints their IDs, then blocks forever. It is killed
    // without warning, so nothing it might have done at exit can account for the result.
    writeFileSync(child, `
      import { ReceiptStore } from ${JSON.stringify(join(import.meta.dirname, 'receipt-store.js'))};
      const store = new ReceiptStore({ journalPath: ${JSON.stringify(journalPath)} });
      const ids = [];
      for (let i = 0; i < 3; i += 1) {
        ids.push(store.record({ agent: 'ptah', status: 'success', toolCallCount: i, taskId: 't-' + i }).id);
      }
      process.stdout.write(JSON.stringify(ids) + '\\n');
      setInterval(() => {}, 1000);
    `);
    const proc = spawnSync(process.execPath, ['--import', 'tsx', child], {
      encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL',
    });
    assert.equal(proc.signal, 'SIGKILL', 'the child must have been killed, not have exited');
    const ids = JSON.parse(String(proc.stdout).trim().split('\n').pop() ?? '[]') as string[];
    assert.equal(ids.length, 3);

    // A FRESH store in THIS process, sharing nothing with the dead one.
    const recovered = new ReceiptStore({ journalPath });
    try {
      for (const id of ids) {
        assert.equal(recovered.get(id)?.id, id, `receipt ${id} did not survive the kill`);
      }
      assert.equal(recovered.recent(100).length, 3);
      assert.equal(recovered.byTask('t-1').length, 1);
      assert.equal(recovered.summary().total, 3);
    } finally { recovered.destroy(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a torn final line loses only itself', () => {
  const dir = base();
  try {
    const journalPath = join(dir, 'receipts.jsonl');
    const store = new ReceiptStore({ journalPath });
    const a = store.record({ agent: 'ptah', status: 'success', toolCallCount: 0 });
    const b = store.record({ agent: 'ptah', status: 'failed', toolCallCount: 1 });
    store.destroy();
    // Simulate a kill part-way through a third append.
    writeFileSync(journalPath, `${readFileSync(journalPath, 'utf8')}{"id":"r-trunc","age`);
    const recovered = new ReceiptStore({ journalPath });
    try {
      assert.equal(recovered.recent(100).length, 2, 'the two intact records must remain');
      assert.equal(recovered.get(a.id)?.id, a.id);
      assert.equal(recovered.get(b.id)?.id, b.id);
      assert.equal(recovered.get('r-trunc'), undefined);
      assert.equal(recovered.failures().length, 1);
    } finally { recovered.destroy(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a well-formed line that is not a receipt is discarded, not trusted', () => {
  const dir = base();
  try {
    const journalPath = join(dir, 'receipts.jsonl');
    const store = new ReceiptStore({ journalPath });
    const good = store.record({ agent: 'ptah', status: 'success', toolCallCount: 0 });
    store.destroy();
    // Each of these parses as JSON and would have been cast straight to a Receipt.
    const planted = [
      '{"id":"r-x","agent":"ptah","timestamp":1,"toolCallCount":0,"status":"approved"}', // status not in the closed set
      '{"id":"","agent":"ptah","timestamp":1,"toolCallCount":0,"status":"success"}',     // empty id
      '{"agent":"ptah","timestamp":1,"toolCallCount":0,"status":"success"}',             // no id
      '{"id":"r-y","agent":"ptah","timestamp":"soon","toolCallCount":0,"status":"success"}', // timestamp not a number
      '"a bare string"', '42', 'null', '[]',
    ];
    writeFileSync(journalPath, `${readFileSync(journalPath, 'utf8')}${planted.join('\n')}\n`);
    const recovered = new ReceiptStore({ journalPath });
    try {
      assert.deepEqual(recovered.recent(100).map((r) => r.id), [good.id],
        'a malformed record reached the projection');
      assert.equal(recovered.get('r-x'), undefined);
      assert.equal(recovered.get('r-y'), undefined);
    } finally { recovered.destroy(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a journal filename identifies the run instead of colliding', () => {
  // The defect a live campaign exposed: a harness passing a non-numeric task id produced the
  // literal "NaN", so every run sharing a receipt root appended to one file.
  assert.equal(receiptJournalName('t01'), 't01');
  assert.equal(receiptJournalName('build/step 2'), 'build-step-2');
  let n = 0;
  const unique = (): string => `u${(n += 1)}`;
  for (const bad of ['NaN', 'undefined', 'null', '', '   ', '///', undefined]) {
    assert.match(receiptJournalName(bad, unique), /^run-u\d+$/, `${String(bad)} was not replaced`);
  }
  // Two unnameable runs must not land on the same file.
  assert.notEqual(receiptJournalName(undefined), receiptJournalName(undefined));
});

test('a missing journal reads as empty rather than throwing', () => {
  const dir = base();
  try {
    assert.deepEqual(ReceiptStore.readJournal(join(dir, 'absent.jsonl')), []);
    const store = new ReceiptStore({ journalPath: join(dir, 'absent.jsonl') });
    try {
      assert.equal(store.recent(10).length, 0);
      assert.equal(store.summary().total, 0);
    } finally { store.destroy(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the journal carries no credential material', () => {
  const dir = base();
  try {
    const journalPath = join(dir, 'receipts.jsonl');
    const store = new ReceiptStore({ journalPath });
    store.record({
      agent: 'ptah', status: 'success', toolCallCount: 1,
      principalId: 'operator-1', contentSummary: 'answered a question',
    });
    store.destroy();
    const raw = readFileSync(journalPath, 'utf8');
    for (const marker of ['sk-', 'Bearer ', 'apiKey', 'assertion', 'CHAT_TOKEN']) {
      assert.equal(raw.includes(marker), false, `journal contained ${marker}`);
    }
    assert.equal(raw.includes('operator-1'), true, 'the verified principal is part of the record');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the journal directory is created when it does not exist', () => {
  const dir = base();
  try {
    const journalPath = join(dir, 'a', 'b', 'c', 'receipts.jsonl');
    const store = new ReceiptStore({ journalPath });
    try {
      store.record({ agent: 'ptah', status: 'success', toolCallCount: 0 });
      assert.equal(existsSync(journalPath), true);
    } finally { store.destroy(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

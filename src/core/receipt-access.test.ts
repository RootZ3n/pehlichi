/**
 * RECEIPT ACCESS — the scope, the projection, and the two things that leak without them.
 *
 * Unlike delegated authority, all of this is pure: a scope is a function of a verified principal
 * and a projection is a function of a stored receipt, so a committed test proves the real thing
 * here rather than a shape around it. What this file does NOT cover is the authorization that
 * happens before any of it -- that is the same lane decision the other three lanes use, and it is
 * proved live and hostilely elsewhere.
 *
 * The two failure modes worth naming, because both existed:
 *
 *   - ENUMERATION. Filtering after paging, or answering a by-task lookup differently for "no such
 *     task" and "not your task", tells a caller what exists outside its scope without ever showing
 *     it a receipt.
 *   - AGGREGATE DISCLOSURE. A summary computed over the whole store describes precisely the set a
 *     caller was refused.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FORBIDDEN_RECEIPT_MARKERS,
  PUBLISHABLE_RECEIPT_KEYS,
  projectReceipt,
  receiptAccessScope,
  scopedReceipts,
  scopedSummary,
  withinScope,
} from './receipt-access.js';
import { ReceiptStore } from './receipt-store.js';

const bridge = { id: 'matrix-bridge@agent', kind: 'bridge' };
const service = { id: 'ikbi@agent', kind: 'service' };
const operator = { id: 'operator-cli@agent', kind: 'operator' };

function store(): ReceiptStore {
  let t = 1_000;
  const s = new ReceiptStore({ clock: () => (t += 1_000) });
  s.record({ agent: 'A', status: 'success', toolCallCount: 0, taskId: 't-bridge', workspaceId: 'w-1', principalId: bridge.id });
  s.record({ agent: 'A', status: 'failed', toolCallCount: 1, taskId: 't-service', workspaceId: 'w-2', principalId: service.id });
  s.record({ agent: 'A', status: 'success', toolCallCount: 2, taskId: 't-operator', workspaceId: 'w-3', principalId: operator.id });
  s.record({ agent: 'A', status: 'error', toolCallCount: 0, taskId: 't-anon', workspaceId: 'w-4' });
  return s;
}

const all = (s: ReceiptStore): Record<string, unknown>[] =>
  s.recent(Number.MAX_SAFE_INTEGER) as unknown as Record<string, unknown>[];

// ── scope ───────────────────────────────────────────────────────────────────────────────────

test('an operator audits everything; every other kind sees only what it produced', () => {
  assert.deepEqual(receiptAccessScope(operator), { kind: 'all' });
  assert.deepEqual(receiptAccessScope(bridge), { kind: 'own', principalId: bridge.id });
  assert.deepEqual(receiptAccessScope(service), { kind: 'own', principalId: service.id });
});

test('an unrecognised kind sees nothing, and a delegate is not thereby an auditor', () => {
  for (const kind of ['delegate', 'anonymous', '', 'admin', 'OPERATOR']) {
    assert.deepEqual(receiptAccessScope({ id: 'x', kind }), { kind: 'none' },
      `${kind} was granted a scope`);
  }
});

test('a receipt with no principal is invisible to everyone but an operator', () => {
  const anonymous: { readonly principalId?: string } = {};
  assert.equal(withinScope({ kind: 'all' }, anonymous), true);
  assert.equal(withinScope({ kind: 'own', principalId: bridge.id }, anonymous), false);
  assert.equal(withinScope({ kind: 'none' }, anonymous), false);
});

test('an own-scope never matches another principal, however similar the id', () => {
  const scope = receiptAccessScope(bridge);
  for (const id of ['matrix-bridge@agent2', 'matrix-bridge@agen', 'MATRIX-BRIDGE@AGENT', '', 'operator-cli@agent']) {
    assert.equal(withinScope(scope, { principalId: id }), false, `${id} matched`);
  }
  assert.equal(withinScope(scope, { principalId: bridge.id }), true);
});

// ── no enumeration outside scope ─────────────────────────────────────────────────────────────

test('a by-task lookup outside scope is indistinguishable from a task that does not exist', () => {
  const s = store();
  const scope = receiptAccessScope(bridge);
  const notMine = scopedReceipts(scope, s.byTask('t-operator') as unknown as Record<string, unknown>[]);
  const notThere = scopedReceipts(scope, s.byTask('t-does-not-exist') as unknown as Record<string, unknown>[]);
  assert.deepEqual(notMine, notThere);
  assert.deepEqual(notMine, []);
  assert.deepEqual(scopedSummary(notMine), scopedSummary(notThere));
  // And the caller's own task is still visible, so the scope narrows rather than blanks.
  assert.equal(scopedReceipts(scope, s.byTask('t-bridge') as unknown as Record<string, unknown>[]).length, 1);
});

test('a by-workspace lookup outside scope is equally indistinguishable', () => {
  const s = store();
  const scope = receiptAccessScope(service);
  const notMine = scopedReceipts(scope, s.byWorkspace('w-1') as unknown as Record<string, unknown>[]);
  const notThere = scopedReceipts(scope, s.byWorkspace('w-absent') as unknown as Record<string, unknown>[]);
  assert.deepEqual(notMine, notThere);
  assert.equal(scopedReceipts(scope, s.byWorkspace('w-2') as unknown as Record<string, unknown>[]).length, 1);
});

test('failures are scoped like everything else', () => {
  const s = store();
  // Two receipts are failures: one belongs to the service principal, one to nobody.
  assert.equal(s.failures().length, 2);
  assert.equal(scopedReceipts(receiptAccessScope(service), s.failures() as unknown as Record<string, unknown>[]).length, 1);
  assert.equal(scopedReceipts(receiptAccessScope(bridge), s.failures() as unknown as Record<string, unknown>[]).length, 0);
  assert.equal(scopedReceipts(receiptAccessScope(operator), s.failures() as unknown as Record<string, unknown>[]).length, 2);
});

test('the summary describes only what the caller may see', () => {
  const s = store();
  const everything = scopedSummary(scopedReceipts(receiptAccessScope(operator), all(s)));
  assert.deepEqual({ total: everything.total, failures: everything.failures }, { total: 4, failures: 2 });

  const mine = scopedSummary(scopedReceipts(receiptAccessScope(bridge), all(s)));
  assert.deepEqual({ total: mine.total, failures: mine.failures }, { total: 1, failures: 0 });

  const nothing = scopedSummary(scopedReceipts({ kind: 'none' }, all(s)));
  assert.deepEqual(nothing, { total: 0, failures: 0, oldestMs: null });

  // The oldest timestamp is the CALLER's oldest, not the store's. The bridge principal happens to
  // own the store's oldest receipt, so it is the service principal that demonstrates the
  // property: its earliest is later than the store's earliest, and a global summary would have
  // told it how far back activity it cannot see goes.
  const theirs = scopedSummary(scopedReceipts(receiptAccessScope(service), all(s)));
  assert.equal(mine.oldestMs, everything.oldestMs, 'the fixture no longer places the oldest receipt with the bridge');
  assert.notEqual(theirs.oldestMs, everything.oldestMs);
  assert.ok((theirs.oldestMs ?? 0) > (everything.oldestMs ?? 0));
});

test('scoping happens before paging, so an in-scope page is never shortened by out-of-scope rows', () => {
  const s = store();
  // The three newest receipts belong to service, operator and nobody. A surface that took the
  // newest two and THEN filtered would hand the bridge principal an empty page while its receipt
  // sat one row further down.
  const naive = scopedReceipts(receiptAccessScope(bridge), s.recent(2) as unknown as Record<string, unknown>[]);
  const correct = scopedReceipts(receiptAccessScope(bridge), all(s)).slice(0, 2);
  assert.equal(naive.length, 0, 'the fixture no longer demonstrates the ordering hazard');
  assert.equal(correct.length, 1, 'scoping before paging lost the caller its own receipt');
});

// ── the projection ───────────────────────────────────────────────────────────────────────────

test('a receipt is projected through an allowlist, so a new stored field is not published by default', () => {
  const projected = projectReceipt({
    id: 'r-1', agent: 'A', timestamp: 5, status: 'success', toolCallCount: 0,
    principalId: bridge.id,
    // None of these are publishable, and two of them are exactly what must never leave.
    presentedAssertion: 'eyJjbGFpbXMi', authorizationHeader: 'Bearer secret-value',
    internalNotes: 'anything', delegationToken: 'eyJ',
  });
  const keys = Object.keys(projected);
  for (const key of keys) assert.ok(PUBLISHABLE_RECEIPT_KEYS.includes(key), `${key} was published`);
  for (const leaked of ['presentedAssertion', 'authorizationHeader', 'internalNotes', 'delegationToken']) {
    assert.equal(keys.includes(leaked), false, `${leaked} survived the projection`);
  }
});

test('an absent optional field is omitted rather than published as undefined', () => {
  const projected = projectReceipt({ id: 'r-1', agent: 'A', timestamp: 1, status: 'success', toolCallCount: 0 });
  assert.equal(Object.keys(projected).includes('taskId'), false);
  assert.equal(Object.keys(projected).includes('principalId'), false);
  assert.equal(JSON.stringify(projected).includes('undefined'), false);
});

test('no projected receipt carries credential, bearer or assertion material', () => {
  const s = store();
  const published = JSON.stringify(scopedReceipts(receiptAccessScope(operator), all(s))).toLowerCase();
  for (const marker of FORBIDDEN_RECEIPT_MARKERS) {
    assert.equal(published.includes(marker.toLowerCase()), false, `a published receipt contains ${marker}`);
  }
});

test('the forbidden list actually covers the documents this deployment handles', () => {
  // A guard list that named none of the real schemas would pass the test above vacuously.
  for (const schema of ['pehverse-request-principal/', 'pehverse-delegation/', 'pehverse-ordinary-authorization/']) {
    assert.ok(FORBIDDEN_RECEIPT_MARKERS.includes(schema), `${schema} is not guarded`);
  }
  for (const header of ['authorization', 'bearer', 'x-pehverse-principal']) {
    assert.ok(FORBIDDEN_RECEIPT_MARKERS.includes(header), `${header} is not guarded`);
  }
  assert.equal(PUBLISHABLE_RECEIPT_KEYS.some((k) => /assert|token|secret|bearer|credential/i.test(k)), false,
    'the allowlist admits a field whose name says it carries authority');
});

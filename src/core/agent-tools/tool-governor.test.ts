/**
 * TOOL GOVERNOR tests (lab-trust sprint, Phase 7): per-tier budgets, repetition /
 * no-progress detection, stuck-delegation hard stop, and partial-not-success.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  RepetitionDetector,
  TIER_LIMITS,
  buildPartialStatus,
  isSuccess,
  resolveToolBudget,
} from './tool-governor.js';

// ── per-tier budgets ──────────────────────────────────────────────────────────

test('resolveToolBudget: casual/converse gets a tiny budget (no long tool loop)', () => {
  assert.equal(resolveToolBudget({ tier: 'converse' }).max, TIER_LIMITS.converse);
  assert.ok(resolveToolBudget({ tier: 'converse' }).max <= 4);
});

test('resolveToolBudget: read-only and mutation default to 12', () => {
  assert.equal(resolveToolBudget({ tier: 'readonly' }).max, 12);
  assert.equal(resolveToolBudget({ tier: 'mutation' }).max, 12);
});

test('resolveToolBudget: escalation to 20 works ONLY with a reason', () => {
  const ok = resolveToolBudget({ tier: 'escalation', escalate: { requested: 20, reason: 'large refactor approved' } });
  assert.equal(ok.max, 20);
  assert.equal(ok.escalated, true);

  const denied = resolveToolBudget({ tier: 'escalation', escalate: { requested: 20 } });
  assert.equal(denied.escalated, false);
  assert.equal(denied.max, TIER_LIMITS.mutation, 'no reason → falls back to the safe default');
});

test('resolveToolBudget: above 20 requires trusted operator; otherwise clamped to 20', () => {
  const clamped = resolveToolBudget({ tier: 'escalation', escalate: { requested: 50, reason: 'x' } });
  assert.equal(clamped.max, 20);
  assert.equal(clamped.clamped, true);

  const trusted = resolveToolBudget({ tier: 'escalation', escalate: { requested: 50, reason: 'x' }, trustedOperator: true });
  assert.equal(trusted.max, 50);
});

// ── repetition detection ──────────────────────────────────────────────────────

test('RepetitionDetector: same tool + same args stops on the 3rd identical call', () => {
  const d = new RepetitionDetector();
  const call = { tool: 'search_files', args: { query: 'foo' }, ok: true };
  assert.equal(d.record(call).stop, false);
  assert.equal(d.record(call).stop, false);
  assert.equal(d.record(call).stop, true, 'third identical call stops');
});

test('RepetitionDetector: different args do NOT trip the same-args rule', () => {
  const d = new RepetitionDetector();
  assert.equal(d.record({ tool: 'search_files', args: { query: 'a' }, ok: true }).stop, false);
  assert.equal(d.record({ tool: 'search_files', args: { query: 'b' }, ok: true }).stop, false);
  assert.equal(d.record({ tool: 'search_files', args: { query: 'c' }, ok: true }).stop, false);
});

test('RepetitionDetector: same tool failing twice stops', () => {
  const d = new RepetitionDetector();
  assert.equal(d.record({ tool: 'run_checks', args: { a: 1 }, ok: false }).stop, false);
  const v = d.record({ tool: 'run_checks', args: { a: 2 }, ok: false });
  assert.equal(v.stop, true);
  assert.match(v.reason ?? '', /failed/);
});

test('RepetitionDetector: repeated read with the same evidence stops (no progress)', () => {
  const d = new RepetitionDetector();
  assert.equal(d.record({ tool: 'read_file', args: { p: 'x' }, ok: true, evidenceKey: 'hash-1' }).stop, false);
  // Different args (so same-args rule does not fire) but identical evidence → no progress.
  const v = d.record({ tool: 'read_file', args: { p: 'x', n: 2 }, ok: true, evidenceKey: 'hash-1' });
  assert.equal(v.stop, true);
  assert.match(v.reason ?? '', /no new information|evidence/);
});

test('RepetitionDetector: repeated DELEGATION failure is a HARD stop for human review', () => {
  const d = new RepetitionDetector();
  const v1 = d.record({ tool: 'delegate_task', args: { goal: 'fix', n: 1 }, ok: false, isDelegation: true });
  assert.equal(v1.stop, false);
  const v2 = d.record({ tool: 'delegate_task', args: { goal: 'fix', n: 2 }, ok: false, isDelegation: true });
  assert.equal(v2.stop, true);
  assert.equal(v2.hard, true, 'repeated delegation failure is a hard stop');
});

// ── partial is never success ──────────────────────────────────────────────────

test('buildPartialStatus: partial result carries the required fields and is NOT success', () => {
  const p = buildPartialStatus({ toolCallsUsed: 12, budgetLimit: 12, reasonStopped: 'budget exhausted' });
  assert.equal(p.ok, false);
  assert.equal(p.partial, true);
  assert.equal(p.status, 'partial');
  assert.equal(p.toolCallsUsed, 12);
  assert.equal(p.budgetLimit, 12);
  assert.match(p.reasonStopped, /budget/);
  assert.ok(p.safeNextStep.length > 0);
  assert.equal(isSuccess(p), false, 'a partial result must never be reported as success');
});

test('isSuccess: only a non-partial ok result counts as success', () => {
  assert.equal(isSuccess({ ok: true }), true);
  assert.equal(isSuccess({ ok: true, partial: true }), false);
  assert.equal(isSuccess({ ok: false }), false);
});

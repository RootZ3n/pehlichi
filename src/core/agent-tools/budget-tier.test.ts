/**
 * Loop-level proof that per-tier budgets cap iterations (lab-trust sprint, Phase 7).
 * A converse tier caps a casual prompt at 4 tool/driver turns; a read-only tier at 12.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ScriptedDriver, type DriverAction } from '../driver.js';
import type { AgentEvent } from '../events.js';
import { runAgent } from '../loop.js';
import type { AgentProfile } from '../profile.js';

const profile: AgentProfile = { name: 'T', role: 'test', personaPreamble: 'test', skillTags: ['test'] };

function tmp(p: string): string {
  return mkdtempSync(join(tmpdir(), p));
}

// A driver that never finishes — it just keeps narrating, so the only thing that
// stops it is the iteration budget.
function runawayDriver(n = 50): ScriptedDriver {
  const actions: DriverAction[] = Array.from({ length: n }, (_u, i) => ({ kind: 'narrate', phase: 'other', text: `step ${i}` }));
  return new ScriptedDriver(actions);
}

async function runWithTier(tier: 'converse' | 'readonly'): Promise<{ partial: boolean; steps: number }> {
  const workspace = tmp('peh-bt-ws-');
  const labStore = tmp('peh-bt-ls-');
  const events: AgentEvent[] = [];
  try {
    const result = await runAgent({
      profile,
      task: 'hi there',
      workspaceRoot: workspace,
      labStoreRoot: labStore,
      driver: runawayDriver(),
      sinks: [(e) => events.push(e)],
      budgetTier: tier,
      partialOnExhaustion: true,
    });
    const narrates = events.filter((e) => e.kind === 'narrate').length;
    return { partial: result.partial === true, steps: narrates };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
  }
}

test('converse tier stops a casual prompt at the small budget (no long tool loop)', async () => {
  const r = await runWithTier('converse');
  assert.equal(r.partial, true, 'budget exhaustion returns a partial, not a success');
  // converse budget is 4 — far fewer than the runaway driver would otherwise run.
  assert.ok(r.steps <= 5, `expected the loop to stop quickly, ran ${r.steps} narrate steps`);
});

test('readonly tier allows more turns than converse but still caps (12)', async () => {
  const r = await runWithTier('readonly');
  assert.equal(r.partial, true);
  assert.ok(r.steps <= 13, `expected readonly cap ~12, ran ${r.steps}`);
  assert.ok(r.steps > 5, 'readonly allows more than the converse budget');
});

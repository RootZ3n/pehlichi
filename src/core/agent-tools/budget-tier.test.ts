/**
 * COMPONENT TEST. This drives `executeAgentRun`, the agent loop below the production
 * admission boundary, with fixture-owned dependencies. It proves things about the loop.
 *
 * It does not, and must not be read to, prove that `runAgent` admitted any work: while the
 * committed governed status is PRE_PRODUCTION, `runAgent` executes nothing. Admission is
 * covered separately in `operational-admission.test.ts`.
 */
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
import {  type RunAgentOptions, type RunAgentResult } from '../loop.js';


/**
 * PRE_PRODUCTION dormancy.
 *
 * These cases drove `executeAgentRun` directly, below the admission boundary. That is the seam
 * an independent audit turned into a bypass -- a namespace import and a computed property
 * reached the executor and ran an agent turn while the committed status refused it -- so the
 * executor is private now and nothing outside `loop.ts` can call it.
 *
 * Each case below needs a complete agent turn: a driver, real tools, a real workspace. None of
 * that is pure mechanics, and none of it can honestly run while work is refused, so they are
 * dormant rather than rewritten into something weaker that would still report a pass. They are
 * a production-transition gate: at the governance transition they must execute against the
 * admitted path, not be deleted.
 *
 * The stand-in exists so the bodies still typecheck. It throws, so un-skipping a case without
 * doing the real work fails loudly instead of quietly proving nothing.
 */
const PRE_PRODUCTION_DORMANT =
  'PRE_PRODUCTION: needs a complete agent turn below admission; the effectful executor is private. ' +
  'Production-transition gate: this case must execute against the admitted path after the governance transition.';
const componentExecuteAgentRun = (..._unused: unknown[]): Promise<RunAgentResult> => {
  throw new Error('the effectful executor is private; this dormant case cannot run below admission');
};

/** The loop below the admission boundary. See the component-test note at the top. */
const runAgent = (opts: RunAgentOptions): ReturnType<typeof componentExecuteAgentRun> =>
  componentExecuteAgentRun(opts);
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
      toolNames: [],
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

test('converse tier stops a casual prompt at the small budget (no long tool loop)', { skip: PRE_PRODUCTION_DORMANT }, async () => {
  const r = await runWithTier('converse');
  assert.equal(r.partial, true, 'budget exhaustion returns a partial, not a success');
  // converse budget is 4 — far fewer than the runaway driver would otherwise run.
  assert.ok(r.steps <= 5, `expected the loop to stop quickly, ran ${r.steps} narrate steps`);
});

test('readonly tier allows more turns than converse but still caps (12)', { skip: PRE_PRODUCTION_DORMANT }, async () => {
  const r = await runWithTier('readonly');
  assert.equal(r.partial, true);
  assert.ok(r.steps <= 13, `expected readonly cap ~12, ran ${r.steps}`);
  assert.ok(r.steps > 5, 'readonly allows more than the converse budget');
});

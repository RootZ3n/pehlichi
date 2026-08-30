/**
 * While the committed status refuses work, nothing runs. Proved by traps, not by prose.
 *
 * A refusal test that only reads the returned message proves the message. It does not prove
 * that no model was called, no tool executed, no file written and no process spawned on the way
 * to producing it -- and a bypass that did its work and *then* returned a refusal would pass
 * such a test cleanly.
 *
 * So every case here arms traps first. The driver throws if anything asks it for a turn. The
 * tools throw if anything invokes them. The approval callback throws if anything asks for an
 * authorization. Then the case attempts the work and asserts two things: it was refused, and
 * every trap is still untouched. The second assertion is the one that matters.
 *
 * The cases cover the categories the gate knows about and the surfaces that must stay open
 * while it is locked. A gate that achieved zero bypass by refusing health checks and the UI
 * would have broken the service rather than governed it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GOVERNED_STATUS_PATH, admitNonWorkSurface, admitRunWork, admitWork, readOperationalStatus,
  type NonWorkSurface, type OperationalStatus, type WorkCategory
} from './operational-admission.js';
import { OperationalWorkRefused, runAgent, runAgentInShadow } from './loop.js';
import type { AgentProfile } from './profile.js';
import type { Driver, DriverAction, DriverContext } from './driver.js';

/** Every trap this suite arms, and whether anything tripped it. */
interface Traps {
  readonly tripped: string[];
  readonly driver: Driver;
  readonly approvalCallback: () => never;
  readonly sink: () => never;
}

/**
 * Traps for every effect an admitted run would cause.
 *
 * Each one throws rather than recording, so a bypass cannot proceed past it and then be
 * reported afterwards; and each one also appends to `tripped`, so a swallowed throw is still
 * visible. Belt and braces, because the whole question here is whether something ran.
 */
function armTraps(): Traps {
  const tripped: string[] = [];
  const trip = (what: string): never => {
    tripped.push(what);
    throw new Error(`ZERO_BYPASS_VIOLATION: ${what} was reached while work is refused`);
  };
  return {
    tripped,
    driver: {
      async next(_ctx: DriverContext): Promise<DriverAction> { return trip('the model driver'); }
    } as unknown as Driver,
    approvalCallback: () => trip('the approval callback'),
    sink: () => trip('the event sink')
  };
}

const profile: AgentProfile = {
  name: 'zero-bypass-fixture',
  role: 'test',
  personaPreamble: 'A fixture profile. It never runs.',
  skillTags: ['test']
};

/** A disposable workspace and lab store, so a bypass would have somewhere to leave evidence. */
function disposable(): { workspace: string; labStore: string; drop: () => void } {
  const workspace = mkdtempSync(join(tmpdir(), 'peh-zerobypass-ws-'));
  const labStore = mkdtempSync(join(tmpdir(), 'peh-zerobypass-ls-'));
  return { workspace, labStore, drop: () => { for (const d of [workspace, labStore]) rmSync(d, { recursive: true, force: true }); } };
}

/** Attempt a run and report what happened, without letting a throw escape. */
async function attempt(run: () => Promise<unknown>): Promise<{ refused: boolean; error: unknown }> {
  try { await run(); return { refused: false, error: null }; }
  catch (error) { return { refused: error instanceof OperationalWorkRefused, error }; }
}

// --- the committed status is what it says it is -------------------------------------------

test('the committed status refuses operational work, and this suite is about that state', () => {
  const status = readOperationalStatus();
  assert.equal(status.state, 'PRE_PRODUCTION',
    'the committed status is no longer PRE_PRODUCTION; these cases describe a state that has passed');
  assert.equal(status.authorization, 'NOT_AUTHORIZED_FOR_OPERATIONAL_WORK');
  assert.equal(admitRunWork('agent-run').admitted, false);
});

// --- no path executes anything ---------------------------------------------------------------

test('every work category is refused, and no effect trap is reached', async () => {
  const categories: WorkCategory[] = [
    'agent-run', 'ordinary-work', 'repair', 'build', 'maintenance', 'cleanup',
    'reconnaissance', 'commissioning', 'qualification', 'self-test',
    'matrix-originated', 'cli-originated', 'role-pack-operation', 'model-route-operation'
  ];
  for (const category of categories) {
    const decision = admitRunWork(category);
    assert.equal(decision.admitted, false, `${category} was admitted`);
    assert.equal(decision.admitted === false && decision.refusal.code, 'OPERATIONAL_WORK_NOT_AUTHORIZED');
  }
  // Labelling work as qualification or a self-test is not authority, and never was: the
  // previous gate took a caller-supplied purpose, and that is exactly how it was defeated.
  for (const label of ['qualification', 'self-test'] as WorkCategory[])
    assert.equal(admitRunWork(label).admitted, false, `${label} bought an admission`);
});

test('runAgent refuses before the driver, the tools or the approval callback are reached', async () => {
  const traps = armTraps();
  const space = disposable();
  try {
    const outcome = await attempt(() => runAgent({
      profile, task: 'do the ordinary work',
      workspaceRoot: space.workspace, labStoreRoot: space.labStore,
      driver: traps.driver, toolNames: ['terminal', 'write_file'],
      sinks: [traps.sink], approvalCallback: traps.approvalCallback
    } as Parameters<typeof runAgent>[0]));

    assert.equal(outcome.refused, true, 'runAgent did not refuse');
    assert.deepEqual(traps.tripped, [], `an effect was reached: ${traps.tripped.join(', ')}`);
    // And it left nothing behind: no workspace file, no lab-store entry, no receipt.
    assert.deepEqual(readdirSync(space.workspace), [], 'the refused run wrote into the workspace');
    assert.deepEqual(readdirSync(space.labStore), [], 'the refused run wrote into the lab store');
  } finally { space.drop(); }
});

test('runAgentInShadow refuses on the same terms, and creates no shadow', async () => {
  const traps = armTraps();
  const space = disposable();
  try {
    const outcome = await attempt(() => runAgentInShadow({
      profile, task: 'do the ordinary work', labStoreRoot: space.labStore,
      driver: traps.driver, toolNames: ['terminal'],
      sinks: [traps.sink], approvalCallback: traps.approvalCallback
    } as Parameters<typeof runAgentInShadow>[0]));

    assert.equal(outcome.refused, true, 'runAgentInShadow did not refuse');
    assert.deepEqual(traps.tripped, []);
    assert.deepEqual(readdirSync(space.labStore), [], 'the refused shadow run wrote into the lab store');
  } finally { space.drop(); }
});

test('a model-only turn with no tools at all is still refused', async () => {
  // The converse lane: no tool lane, nothing to execute, just a model call. It is still work.
  const traps = armTraps();
  const space = disposable();
  try {
    const outcome = await attempt(() => runAgent({
      profile, task: 'just answer me',
      workspaceRoot: space.workspace, labStoreRoot: space.labStore,
      driver: traps.driver, toolNames: [], budgetTier: 'converse',
      sinks: [traps.sink]
    } as Parameters<typeof runAgent>[0]));
    assert.equal(outcome.refused, true, 'a model-only turn was admitted');
    assert.deepEqual(traps.tripped, [], 'the model was called for a refused turn');
  } finally { space.drop(); }
});

test('no option a caller can set changes the answer', async () => {
  // Role, model, route, pack, budget, unattended mode, a different profile: none of these is
  // consulted before the decision, and the decision takes no argument from the caller at all.
  const space = disposable();
  try {
    const variations: Record<string, Record<string, unknown>> = {
      'a different role': { profile: { ...profile, role: 'commissioner' } },
      'a privileged-sounding name': { profile: { ...profile, name: 'qualification-authority' } },
      'unattended mode': { unattended: true },
      'a large budget': { budgetTier: 'readonly', maxIterations: 999 },
      'partial results': { partialOnExhaustion: true },
      'planning enabled': { plan: true }
    };
    for (const [label, extra] of Object.entries(variations)) {
      const traps = armTraps();
      const outcome = await attempt(() => runAgent({
        profile, task: 'work', workspaceRoot: space.workspace, labStoreRoot: space.labStore,
        driver: traps.driver, toolNames: [], sinks: [traps.sink], ...extra
      } as Parameters<typeof runAgent>[0]));
      assert.equal(outcome.refused, true, `${label} produced an admission`);
      assert.deepEqual(traps.tripped, [], `${label} reached an effect`);
    }
  } finally { space.drop(); }
});

// --- the decision cannot be steered ----------------------------------------------------------

test('the governance repository cannot be chosen by a caller on the production path', () => {
  // `readOperationalStatus` takes a root for tests. `admitRunWork` -- the one the gate calls --
  // takes a category and nothing else, so a production caller has no way to point the decision
  // at a repository it prepared.
  assert.equal(admitRunWork.length, 1, 'admitRunWork takes more than a category');
  const planted = mkdtempSync(join(tmpdir(), 'peh-zerobypass-gov-'));
  try {
    const file = join(planted, GOVERNED_STATUS_PATH);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify({ state: 'PRODUCTION', authorization: 'AUTHORIZED_FOR_OPERATIONAL_WORK' }));
    // Reading the planted repository directly does report what was planted -- that is what the
    // parameter is for. What matters is that the production gate never reaches this call.
    assert.equal(admitRunWork('agent-run').admitted, false,
      'the production gate followed a planted governance repository');
  } finally { rmSync(planted, { recursive: true, force: true }); }
});

test('a missing, malformed or contradictory status fails closed', () => {
  const cases: Record<string, string | null> = {
    missing: null,
    'not json': '{',
    empty: '{}',
    'unknown state': JSON.stringify({ state: 'WHATEVER', authorization: 'AUTHORIZED_FOR_OPERATIONAL_WORK' }),
    contradictory: JSON.stringify({ state: 'PRE_PRODUCTION', authorization: 'AUTHORIZED_FOR_OPERATIONAL_WORK' }),
    'authorized but unreadable state': JSON.stringify({ authorization: 'AUTHORIZED_FOR_OPERATIONAL_WORK' })
  };
  for (const [label, body] of Object.entries(cases)) {
    const root = mkdtempSync(join(tmpdir(), 'peh-zerobypass-status-'));
    try {
      if (body !== null) {
        const file = join(root, GOVERNED_STATUS_PATH);
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, body);
      }
      let status: OperationalStatus | null = null;
      try { status = readOperationalStatus(root); } catch { status = null; }
      const admitted = status === null ? false : admitWork('agent-run', status).admitted;
      assert.equal(admitted, false, `a ${label} status admitted work`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('an authorization string alone does not admit; the state must agree', () => {
  // The contradictory case is the one worth stating twice: a manifest that claims authorization
  // while remaining PRE_PRODUCTION is not a permission, it is a disagreement, and it fails closed.
  const contradictory: OperationalStatus = {
    state: 'PRE_PRODUCTION', authorization: 'AUTHORIZED_FOR_OPERATIONAL_WORK'
  } as OperationalStatus;
  assert.equal(admitWork('agent-run', contradictory).admitted, false);
});

// --- what must stay up ---------------------------------------------------------------------------

test('the surfaces that are not work remain available while work is refused', () => {
  // Zero bypass must not be achieved by refusing everything: the service stays online, reports
  // its health, renders its UI and shows its identity while locked.
  const surfaces: NonWorkSurface[] = [
    'service-startup', 'health-report', 'status-display', 'ui-render',
    'matrix-connectivity', 'identity-display'
  ];
  for (const surface of surfaces)
    assert.equal(admitNonWorkSurface(surface).admitted, true, `${surface} was refused`);
});

test('a refusal produces no operational receipt and claims no completion', async () => {
  const traps = armTraps();
  const space = disposable();
  try {
    const outcome = await attempt(() => runAgent({
      profile, task: 'work', workspaceRoot: space.workspace, labStoreRoot: space.labStore,
      driver: traps.driver, toolNames: [], sinks: [traps.sink]
    } as Parameters<typeof runAgent>[0]));

    assert.equal(outcome.refused, true);
    // A refusal is not a run result. Returning one with `ok: false` would let a caller log it
    // as an ordinary failure and retry, and would let a reader mistake it for work attempted.
    const error = outcome.error as OperationalWorkRefused;
    assert.equal(error instanceof OperationalWorkRefused, true, 'a refusal came back as a result');
    assert.equal(Object.hasOwn(error, 'ok'), false, 'the refusal carries a run result shape');
    assert.equal(/\bcompleted\b|\bdone\b|\bsucceeded\b/i.test(error.message), false,
      `the refusal message claims completion: ${error.message}`);
    assert.deepEqual(readdirSync(space.labStore), [], 'a receipt was written for a refused run');
  } finally { space.drop(); }
});

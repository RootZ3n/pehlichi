/**
 * PRE_PRODUCTION means zero operational admission, and nothing talks its way past it.
 *
 * The first version of this gate was bypassable, and an independent audit proved it: it
 * accepted a caller-supplied purpose and a caller-supplied authority, and the authority was a
 * plaintext constant exported from shared core. Any in-process caller could import it, label
 * operational work `self-test`, and be admitted — then reuse the same string for a different
 * operation. A secret every caller can read is not an authority.
 *
 * So most of what follows is about what must NOT be admitted. Each case is a way somebody
 * could argue their way in — a role, a route, a model, a capability pack, the request arriving
 * over Matrix, the request calling itself a self-test — and every one has to be refused by a
 * gate that never learns about it.
 *
 * These are ADMISSION tests. A pass here means ADMISSION_REFUSED_AS_REQUIRED. None of them is
 * qualification evidence, and none of them commissions anything.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  admitWork, admitRunWork, admitNonWorkSurface, readOperationalStatus, describeRefusal,
  OperationalStatusUnreadable, GOVERNED_STATUS_PATH,
  type OperationalStatus, type WorkCategory, type NonWorkSurface
} from './operational-admission.js';
import { runAgent, runAgentInShadow, OperationalWorkRefused } from './loop.js';
import { ScriptedDriver } from './driver.js';
import { createWorkspace, createLabStore } from './scenario.js';

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(here, '..', '..');

const LOCKED: OperationalStatus = {
  state: 'PRE_PRODUCTION',
  authorization: 'NOT_AUTHORIZED_FOR_OPERATIONAL_WORK',
  productionAgent: 'hermes',
  clearedBy: 'independent Hermes-equivalence audit',
  reason: 'the Trio has never been used operationally'
};
const CLEARED: OperationalStatus = {
  ...LOCKED,
  state: 'PRODUCTION',
  authorization: 'AUTHORIZED_FOR_OPERATIONAL_WORK'
};

/** Every category the gate can be asked about. All of them are work; none is privileged. */
const ALL_WORK: readonly WorkCategory[] = [
  'agent-run', 'ordinary-work', 'repair', 'build', 'maintenance', 'cleanup',
  'reconnaissance', 'commissioning', 'qualification', 'self-test',
  'matrix-originated', 'cli-originated', 'role-pack-operation', 'model-route-operation'
];

/** A disposable repository whose only content is a governed boundary manifest. */
function repositoryWith(operationalStatus: unknown, { omit = false, malformed = false } = {}): { root: string; drop: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'trio-admission-'));
  mkdirSync(join(root, 'trio', 'governance'), { recursive: true });
  const target = join(root, GOVERNED_STATUS_PATH);
  if (malformed) writeFileSync(target, '{ this is not json');
  else writeFileSync(target, JSON.stringify(omit ? {} : { operationalStatus }, null, 1));
  return { root, drop: () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* disposable */ } } };
}

/** A minimal well-formed run request. Every field here is ordinary caller input. */
function runRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const workspace = createWorkspace();
  return {
    profile: { name: 'Admission', role: 'test', personaPreamble: 'test', skillTags: [] },
    task: 'do the thing',
    workspaceRoot: workspace,
    labStoreRoot: createLabStore(),
    driver: new ScriptedDriver([{ kind: 'done', summary: { rootCause: 'x', changes: [], verification: [] } }]),
    toolNames: [],
    ...overrides
  };
}

const refusalFrom = async (fn: () => Promise<unknown>): Promise<OperationalWorkRefused> => {
  try { await fn(); } catch (error) {
    assert.ok(error instanceof OperationalWorkRefused,
      `expected an admission refusal, got ${(error as Error)?.name}: ${(error as Error)?.message}`);
    return error as OperationalWorkRefused;
  }
  assert.fail('work was admitted while the governed status is PRE_PRODUCTION');
};

// --- the status this repository actually ships -----------------------------------------------

test('the repository ships a readable governed status, and it is locked', () => {
  const status = readOperationalStatus(repositoryRoot);
  assert.equal(status.state, 'PRE_PRODUCTION');
  assert.equal(status.authorization, 'NOT_AUTHORIZED_FOR_OPERATIONAL_WORK');
});

// --- 1-10: every work category is refused at the production boundary --------------------------

test('1-10. every work category is refused, including the ones that call themselves tests', () => {
  for (const category of ALL_WORK) {
    const decision = admitWork(category, LOCKED);
    assert.equal(decision.admitted, false, `${category} was admitted while locked`);
    assert.ok(!decision.admitted && decision.refusal.code === 'OPERATIONAL_WORK_NOT_AUTHORIZED');
    assert.ok(!decision.admitted && decision.refusal.category === category);
  }
  // The four that an operator is most likely to argue about, named individually so a
  // regression reads clearly.
  for (const category of ['qualification', 'self-test', 'commissioning', 'reconnaissance'] as const)
    assert.equal(admitWork(category, LOCKED).admitted, false);
});

test('1. an ordinary agent run through the production boundary is refused', async () => {
  const refusal = await refusalFrom(() => runAgent(runRequest() as never));
  assert.equal(refusal.refusal.code, 'OPERATIONAL_WORK_NOT_AUTHORIZED');
  assert.equal(refusal.refusal.state, 'PRE_PRODUCTION');
  assert.equal(refusal.refusal.category, 'agent-run');
});

test('5. tool-bearing reconnaissance is refused, read-only claim or not', async () => {
  // A lane of read-only tools is still a tool-bearing run, and the gate is reached before the
  // lane is even validated — so "it only reads" is not a category of admission.
  await refusalFrom(() => runAgent(runRequest({ toolNames: ['read_file'], task: 'just look around' }) as never));
});

test('6. a delegated / shadow run is refused at the same boundary', async () => {
  const refusal = await refusalFrom(() => runAgentInShadow(runRequest({ workspaceRoot: undefined }) as never));
  assert.equal(refusal.refusal.code, 'OPERATIONAL_WORK_NOT_AUTHORIZED');
});

test('7-8. a request labelled self-test or qualification is refused like any other', async () => {
  // There is nowhere to put the label any more, which is the point — but a caller that adds
  // the fields anyway must not be treated differently.
  for (const label of [
    { operationalPurpose: 'self-test', operationalAuthority: 'trio-qualification/pre-production-self-test/1' },
    { operationalPurpose: 'qualification' },
    { purpose: 'self-test', authority: 'anything' }
  ]) await refusalFrom(() => runAgent(runRequest(label) as never));
});

test('9-10. Matrix-originated and CLI-originated work are refused', async () => {
  for (const origin of [
    { task: 'matrix: please fix the build', roomKey: '!room:lab', matrixIdentity: '@peh:lab' },
    { task: 'cli: repair the deploy', origin: 'cli', tty: true }
  ]) await refusalFrom(() => runAgent(runRequest(origin) as never));
});

// --- 11-14: nothing about the caller is an authorization --------------------------------------

test('11-14. role, model, route and capability pack cannot bypass', async () => {
  for (const claim of [
    { profile: { name: 'Coordinator', role: 'coordinator', personaPreamble: 'p', skillTags: ['admin'] } },
    { model: 'claude-opus-5', modelOverride: 'claude-opus-5' },
    { route: 'anthropic/primary', routingTarget: 'primary' },
    { capabilityPacks: ['work-orders', 'occasio'], skillTags: ['safety'], rolePack: 'work-orders' },
    { serviceHealth: 'healthy', authorized: true, admin: true, override: true, bypass: true }
  ]) await refusalFrom(() => runAgent(runRequest(claim) as never));
});

test('11-14. and none of them changes the decision the gate makes', () => {
  // Structural: the decision is a function of the committed status and the category alone.
  const bare = admitWork('agent-run', LOCKED);
  for (const category of ALL_WORK) {
    const other = admitWork(category, LOCKED);
    assert.equal(other.admitted, bare.admitted, `${category} changed admission`);
  }
});

// --- 15-18: the old authority is gone and cannot be recreated ---------------------------------

test('15. importing the old qualification authority fails because it no longer exists', async () => {
  const admission = await import('./operational-admission.js') as Record<string, unknown>;
  assert.equal('QUALIFICATION_AUTHORITY' in admission, false, 'the exported authority is still present');
  assert.equal('QUALIFICATION_PURPOSES' in admission, false, 'the exported purpose list is still present');
  const publicApi = await import('./index.js') as Record<string, unknown>;
  for (const name of ['QUALIFICATION_AUTHORITY', 'QUALIFICATION_PURPOSES', 'executeAgentRun', 'executeAgentInShadow'])
    assert.equal(name in publicApi, false, `${name} is reachable from the package public API`);
});

test('16. the old plaintext value supplied by hand has no effect', async () => {
  // The exact string that used to work.
  await refusalFrom(() => runAgent(runRequest({
    operationalAuthority: 'trio-qualification/pre-production-self-test/1',
    operationalPurpose: 'self-test'
  }) as never));
});

test('17-18. relabelling the purpose or the operation has no effect', () => {
  for (const category of ALL_WORK)
    assert.equal(admitWork(category, LOCKED).admitted, false, `relabelling as ${category} admitted work`);
  // And the refusal reports the label it was given rather than being steered by it.
  assert.equal((admitWork('self-test', LOCKED) as { refusal: { category: string } }).refusal.category, 'self-test');
});

test('19. a replayed earlier request remains refused', async () => {
  const replayed = runRequest({
    operationalPurpose: 'self-test',
    operationalAuthority: 'trio-qualification/pre-production-self-test/1',
    nonce: 'a-previously-accepted-run', runId: 'earlier-run-id'
  });
  await refusalFrom(() => runAgent(replayed as never));
  await refusalFrom(() => runAgent(replayed as never));
});

// --- 20-22: governance failures fail closed ---------------------------------------------------

test('20. missing governance refuses', () => {
  const r = repositoryWith(null, { omit: true });
  try {
    assert.throws(() => readOperationalStatus(r.root), OperationalStatusUnreadable);
  } finally { r.drop(); }
});

test('21. malformed governance refuses', () => {
  for (const broken of [
    { malformed: true, status: null as unknown },
    { malformed: false, status: { state: 'SOMETHING_ELSE', authorization: 'NOT_AUTHORIZED_FOR_OPERATIONAL_WORK', productionAgent: 'h', clearedBy: 'x'.repeat(8), reason: 'y'.repeat(20) } },
    { malformed: false, status: { state: 'PRE_PRODUCTION', authorization: 'MAYBE', productionAgent: 'h', clearedBy: 'x'.repeat(8), reason: 'y'.repeat(20) } },
    { malformed: false, status: { state: 'PRE_PRODUCTION', authorization: 'NOT_AUTHORIZED_FOR_OPERATIONAL_WORK' } },
    { malformed: false, status: 'PRE_PRODUCTION' }
  ]) {
    const r = repositoryWith(broken.status, { malformed: broken.malformed });
    try {
      assert.throws(() => readOperationalStatus(r.root), OperationalStatusUnreadable,
        `a malformed status was accepted: ${JSON.stringify(broken)}`);
    } finally { r.drop(); }
  }
});

test('22. conflicting state fields refuse rather than being reconciled', () => {
  for (const conflicting of [
    { state: 'PRODUCTION', authorization: 'NOT_AUTHORIZED_FOR_OPERATIONAL_WORK', productionAgent: 'h', clearedBy: 'x'.repeat(8), reason: 'y'.repeat(20) },
    { state: 'PRE_PRODUCTION', authorization: 'AUTHORIZED_FOR_OPERATIONAL_WORK', productionAgent: 'h', clearedBy: 'x'.repeat(8), reason: 'y'.repeat(20) }
  ]) {
    const r = repositoryWith(conflicting);
    try {
      assert.throws(() => readOperationalStatus(r.root), OperationalStatusUnreadable,
        'a self-contradictory status was reconciled instead of refused');
    } finally { r.drop(); }
  }
});

test('an unreadable status becomes a refusal, never an exception the caller can mistake for a pass', () => {
  const decision = admitRunWork('agent-run');
  // This repository is readable and locked, so the code is the ordinary one; the point is that
  // `admitRunWork` returns a decision on every path rather than throwing.
  assert.equal(decision.admitted, false);
  assert.ok(!decision.admitted && ['OPERATIONAL_WORK_NOT_AUTHORIZED', 'OPERATIONAL_STATUS_UNREADABLE'].includes(decision.refusal.code));
});

// --- 23: the service stays up ------------------------------------------------------------------

test('23. health, status, UI, connectivity and identity remain available without work execution', () => {
  const surfaces: readonly NonWorkSurface[] = [
    'service-startup', 'health-report', 'status-display', 'ui-render', 'matrix-connectivity', 'identity-display'
  ];
  for (const surface of surfaces) assert.equal(admitNonWorkSurface(surface).admitted, true, `${surface} was refused`);
  // And admitting a surface does not admit work.
  assert.equal(admitWork('agent-run', LOCKED).admitted, false);
});

// --- 24: a component test cannot produce an admission receipt ----------------------------------

test('24. no component below the boundary is reachable, under any spelling', async () => {
  // This used to assert the opposite -- that `executeAgentRun` was reachable from the module,
  // for component tests. An independent audit used exactly that reachability: a namespace
  // import and a computed property name, `"execute" + "AgentRun"`, ran an agent turn while the
  // committed status refused it. Being absent from the public index was never a boundary,
  // because relative imports inside the package were always part of the threat model.
  const loop = await import('./loop.js') as Record<string, unknown>;
  const namespaceProperties = [...Object.keys(loop), ...Object.getOwnPropertyNames(loop)];
  for (const name of ['executeAgentRun', 'executeAgentInShadow'])
    assert.equal(namespaceProperties.includes(name), false, `${name} is still on the loop namespace`);
  // The audit's exact expression, reproduced: it must now resolve to nothing.
  assert.equal(loop['execute' + 'AgentRun'], undefined, 'the computed-property bypass still resolves');
  assert.equal(loop['execute' + 'AgentInShadow'], undefined);

  // And the executor still never decides admission -- it is below the boundary, not beside it.
  const source = readFileSync(join(here, 'loop.ts'), 'utf8');
  const body = source.slice(source.indexOf('async function executeAgentRun'));
  assert.equal(/admitWork|admitRunWork|admitted\s*:\s*true/.test(body), false,
    'the component below the boundary decides admission, which it must never do');
  const publicApi = await import('./index.js') as Record<string, unknown>;
  assert.equal('executeAgentRun' in publicApi, false);
});

// --- 25: identity does not change the answer ---------------------------------------------------

test('25. identity, personality and UI differences do not change admission', () => {
  const differentIdentity: OperationalStatus = {
    ...LOCKED,
    productionAgent: 'hermes',
    clearedBy: 'a differently worded audit',
    reason: 'a completely different sentence about why this agent is not cleared'
  };
  assert.equal(admitWork('agent-run', differentIdentity).admitted, admitWork('agent-run', LOCKED).admitted);
  assert.equal(admitWork('agent-run', differentIdentity).admitted, false);
});

// --- the cleared state, and the refusal's shape -------------------------------------------------

test('a coherent cleared status is the only thing that admits work', () => {
  assert.equal(admitWork('ordinary-work', CLEARED).admitted, true);
  for (const category of ALL_WORK) assert.equal(admitWork(category, CLEARED).admitted, true);
});

test('the refusal carries four fields and no secret material', () => {
  const decision = admitWork('agent-run', LOCKED);
  assert.equal(decision.admitted, false);
  if (decision.admitted) return;
  assert.deepEqual(Object.keys(decision.refusal).sort(), ['category', 'code', 'nextAction', 'state']);
  assert.match(describeRefusal(decision.refusal), /OPERATIONAL_WORK_NOT_AUTHORIZED/);
  assert.match(decision.refusal.nextAction, /no runtime override exists/);
  const serialized = JSON.stringify(decision.refusal);
  for (const leak of ['sk-', 'ghp_', 'password', 'token', 'apikey', 'Bearer ', 'personaPreamble', 'hermes'])
    assert.equal(serialized.toLowerCase().includes(leak.toLowerCase()), false, `the refusal carried ${leak}`);
});

test('the gate opens no credential-bearing path', () => {
  // Behavioural: unreadable credential-class files sit beside the governed manifest. If the
  // gate touched any of them it would raise EACCES, and a gate that reads only what it
  // declares cannot.
  const r = repositoryWith(LOCKED);
  const guarded = ['.env', '.npmrc', '.netrc', 'secrets.json', 'id_rsa'];
  try {
    for (const name of guarded) {
      const target = join(r.root, name);
      writeFileSync(target, 'API_TOKEN=must-never-be-opened\n');
      chmodSync(target, 0o000);
    }
    const governance = join(r.root, 'trio', 'governance', '.env');
    writeFileSync(governance, 'API_TOKEN=must-never-be-opened\n');
    chmodSync(governance, 0o000);
    assert.equal(readOperationalStatus(r.root).state, 'PRE_PRODUCTION');
  } finally {
    for (const name of guarded) { try { chmodSync(join(r.root, name), 0o600); } catch { /* best effort */ } }
    try { chmodSync(join(r.root, 'trio', 'governance', '.env'), 0o600); } catch { /* best effort */ }
    r.drop();
  }
});

test('the gate declares exactly one governed path and reads nothing else', () => {
  assert.equal(GOVERNED_STATUS_PATH, 'trio/governance/boundary-manifest.json');
  const source = readFileSync(join(here, 'operational-admission.ts'), 'utf8');
  assert.equal((source.match(/readFileSync\(/g) ?? []).length, 1, 'the gate reads from more than one place');
  for (const forbidden of ['os.homedir', 'readdirSync', 'execSync', 'spawnSync', 'createReadStream', 'process.env'])
    assert.equal(source.includes(forbidden), false, `the gate uses ${forbidden}`);
});

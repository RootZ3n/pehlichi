/**
 * The pre-production lock is executable, and nothing talks its way past it.
 *
 * `PRE_PRODUCTION` and `NOT_AUTHORIZED_FOR_OPERATIONAL_WORK` sat in the governed boundary
 * manifest and were read by nothing. An independent audit made the point plainly: a
 * declaration that no code consumes is not a control, and an agent that is declared
 * unavailable for real work but does real work when asked is available for real work.
 *
 * The cases below are mostly about what must NOT admit a run. Every one of them is a way
 * somebody could plausibly argue their way in -- the agent's role, the model it routes to,
 * the capability pack it was given, the fact that the request arrived over Matrix -- and each
 * one has to be refused by a gate that never learns about it in the first place.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  admitOperation, admitRun, readOperationalStatus, describeRefusal,
  OperationalStatusUnreadable, QUALIFICATION_AUTHORITY, QUALIFICATION_PURPOSES,
  GOVERNED_STATUS_PATH,
  type OperationalStatus, type RunPurpose
} from './operational-admission.js';

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

/** A disposable repository whose only content is a governed boundary manifest. */
function repositoryWith(operationalStatus: unknown, { omit = false, malformed = false } = {}): { root: string; drop: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'trio-admission-'));
  mkdirSync(join(root, 'trio', 'governance'), { recursive: true });
  const target = join(root, GOVERNED_STATUS_PATH);
  if (malformed) writeFileSync(target, '{ this is not json');
  else writeFileSync(target, JSON.stringify(omit ? {} : { operationalStatus }, null, 1));
  return { root, drop: () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* disposable */ } } };
}

const ORDINARY: readonly RunPurpose[] = ['ordinary-work', 'repair', 'build', 'maintenance', 'commissioning'];

// --- the committed status this repository actually ships -----------------------------------

test('the repository ships a readable governed status, and it is locked', () => {
  const status = readOperationalStatus(repositoryRoot);
  assert.equal(status.state, 'PRE_PRODUCTION');
  assert.equal(status.authorization, 'NOT_AUTHORIZED_FOR_OPERATIONAL_WORK');
  assert.equal(status.productionAgent, 'hermes');
});

test('ordinary work is refused against the repository status as committed', () => {
  const decision = admitRun({ operation: 'answer a user request' }, repositoryRoot);
  assert.equal(decision.admitted, false);
  assert.ok(!decision.admitted && decision.refusal.category === 'OPERATIONAL_WORK_NOT_AUTHORIZED');
});

// --- what the lock refuses -----------------------------------------------------------------

test('every ordinary work purpose is refused while locked', () => {
  for (const purpose of ORDINARY) {
    const decision = admitOperation({ operation: 'a job', purpose }, LOCKED);
    assert.equal(decision.admitted, false, `${purpose} was admitted while locked`);
    assert.ok(!decision.admitted && decision.refusal.category === 'OPERATIONAL_WORK_NOT_AUTHORIZED');
  }
});

test('an omitted purpose is treated as ordinary work, not as an exemption', () => {
  const decision = admitOperation({ operation: 'an unlabelled job' }, LOCKED);
  assert.equal(decision.admitted, false, 'saying nothing about a run admitted it');
  assert.ok(!decision.admitted && decision.refusal.purpose === 'ordinary-work');
});

test('repair, build and maintenance execution are refused specifically', () => {
  for (const purpose of ['repair', 'build', 'maintenance'] as const)
    assert.equal(admitOperation({ operation: `${purpose} the lab`, purpose }, LOCKED).admitted, false);
});

test('commissioning use is refused', () => {
  assert.equal(admitOperation({ operation: 'commission this agent', purpose: 'commissioning' }, LOCKED).admitted, false);
});

// --- what cannot be used as an authorization -----------------------------------------------

test('no role, model, route, capability pack, health or Matrix identity can bypass the lock', () => {
  // The gate takes a request and a status. Anything else a caller wants to offer has nowhere
  // to go -- which is the property under test, so it is asserted structurally as well as by
  // passing the claims in and watching them be ignored.
  const claims = {
    operation: 'a job', purpose: 'ordinary-work' as const,
    role: 'coordinator', rolePack: 'work-orders', model: 'claude-opus-5',
    route: 'anthropic/primary', serviceHealth: 'healthy', matrixIdentity: '@peh:lab',
    agentId: 'pehlichi', authorized: true, admin: true, override: true
  };
  const decision = admitOperation(claims, LOCKED);
  assert.equal(decision.admitted, false, 'an extra claim on the request admitted a locked run');

  // And the decision is identical to the one made without any of them.
  const bare = admitOperation({ operation: 'a job', purpose: 'ordinary-work' }, LOCKED);
  assert.deepEqual(decision, bare, 'the presence of role/model/route/identity changed the decision');
});

test('a model route does not bypass the lock', () => {
  for (const model of ['claude-opus-5', 'local/mimo', 'ollama/llama3'])
    assert.equal(admitOperation({ operation: `run on ${model}`, purpose: 'ordinary-work' }, LOCKED).admitted, false);
});

test('a role-pack assignment does not bypass the lock', () => {
  for (const pack of ['work-orders', 'occasio', 'onboarding', 'model-reports'])
    assert.equal(admitOperation({ operation: `act under ${pack}`, purpose: 'ordinary-work' }, LOCKED).admitted, false);
});

test('Matrix-originated work does not bypass the lock', () => {
  assert.equal(admitOperation({ operation: 'matrix: please fix the build', purpose: 'ordinary-work' }, LOCKED).admitted, false);
});

// --- the one lane that is open -------------------------------------------------------------

test('a qualification run is permitted only with the exact authority', () => {
  for (const purpose of QUALIFICATION_PURPOSES) {
    assert.equal(admitOperation({ operation: 'qualify', purpose }, LOCKED).admitted, false,
      `${purpose} was admitted with no authority`);
    assert.equal(admitOperation({ operation: 'qualify', purpose, authority: 'trio-qualification' }, LOCKED).admitted, false,
      `${purpose} was admitted with a near-miss authority`);
    assert.equal(admitOperation({ operation: 'qualify', purpose, authority: `${QUALIFICATION_AUTHORITY} ` }, LOCKED).admitted, false,
      `${purpose} was admitted with a whitespace-padded authority`);
    assert.equal(admitOperation({ operation: 'qualify', purpose, authority: QUALIFICATION_AUTHORITY }, LOCKED).admitted, true,
      `${purpose} was refused despite carrying the exact authority`);
  }
});

test('the qualification authority does not open an ordinary work lane', () => {
  for (const purpose of ORDINARY)
    assert.equal(admitOperation({ operation: 'a job', purpose, authority: QUALIFICATION_AUTHORITY }, LOCKED).admitted, false,
      `${purpose} was admitted by presenting the qualification authority`);
});

test('a cleared status admits ordinary work', () => {
  const decision = admitOperation({ operation: 'a job', purpose: 'ordinary-work' }, CLEARED);
  assert.equal(decision.admitted, true);
  assert.ok(decision.admitted && decision.state === 'PRODUCTION');
});

// --- failing closed ------------------------------------------------------------------------

test('a removed operational status fails closed', () => {
  const r = repositoryWith(null, { omit: true });
  try {
    const decision = admitRun({ operation: 'a job' }, r.root);
    assert.equal(decision.admitted, false);
    assert.ok(!decision.admitted && decision.refusal.category === 'OPERATIONAL_STATUS_UNREADABLE');
  } finally { r.drop(); }
});

test('a malformed operational status fails closed', () => {
  for (const broken of [
    { malformed: true, status: null as unknown },
    { malformed: false, status: { state: 'SOMETHING_ELSE', authorization: 'NOT_AUTHORIZED_FOR_OPERATIONAL_WORK', productionAgent: 'hermes', clearedBy: 'x'.repeat(8), reason: 'y'.repeat(20) } },
    { malformed: false, status: { state: 'PRE_PRODUCTION', authorization: 'MAYBE', productionAgent: 'hermes', clearedBy: 'x'.repeat(8), reason: 'y'.repeat(20) } },
    { malformed: false, status: { state: 'PRE_PRODUCTION', authorization: 'NOT_AUTHORIZED_FOR_OPERATIONAL_WORK' } },
    { malformed: false, status: 'PRE_PRODUCTION' }
  ]) {
    const r = repositoryWith(broken.status, { malformed: broken.malformed });
    try {
      const decision = admitRun({ operation: 'a job', purpose: 'self-test', authority: QUALIFICATION_AUTHORITY }, r.root);
      assert.equal(decision.admitted, false, `a malformed status admitted a run: ${JSON.stringify(broken)}`);
      assert.ok(!decision.admitted && decision.refusal.category === 'OPERATIONAL_STATUS_UNREADABLE');
    } finally { r.drop(); }
  }
});

test('an absent manifest fails closed rather than throwing into the caller', () => {
  const decision = admitRun({ operation: 'a job' }, join(tmpdir(), `trio-admission-absent-${process.pid}`));
  assert.equal(decision.admitted, false);
  assert.ok(!decision.admitted && decision.refusal.category === 'OPERATIONAL_STATUS_UNREADABLE');
  assert.throws(() => readOperationalStatus(join(tmpdir(), `trio-admission-absent-${process.pid}`)), OperationalStatusUnreadable);
});

// --- what must not change the decision ------------------------------------------------------

test('changing identity, branding or UI does not affect admission', () => {
  const identityOnly = {
    ...LOCKED,
    productionAgent: 'hermes',
    clearedBy: 'independent Hermes-equivalence audit',
    reason: 'a completely different sentence about why this agent is not cleared'
  };
  const before = admitOperation({ operation: 'a job' }, LOCKED);
  const after = admitOperation({ operation: 'a job' }, identityOnly);
  assert.equal(before.admitted, after.admitted, 'a change to declarative identity text changed admission');
  assert.equal(after.admitted, false);
});

test('the gate opens no credential-bearing path', () => {
  // Behavioural rather than by inspection: the disposable repository holds unreadable
  // credential-class files alongside the governed manifest. If the gate touched any of them
  // it would raise EACCES, and a gate that reads only what it declares cannot.
  const r = repositoryWith(LOCKED);
  try {
    for (const name of ['.env', '.npmrc', '.netrc', 'secrets.json', 'id_rsa']) {
      const target = join(r.root, name);
      writeFileSync(target, 'API_TOKEN=must-never-be-opened\n');
      chmodSync(target, 0o000);
    }
    const governance = join(r.root, 'trio', 'governance', '.env');
    writeFileSync(governance, 'API_TOKEN=must-never-be-opened\n');
    chmodSync(governance, 0o000);

    const decision = admitRun({ operation: 'a job' }, r.root);
    assert.equal(decision.admitted, false, 'the gate should still refuse');
    assert.ok(!decision.admitted && decision.refusal.category === 'OPERATIONAL_WORK_NOT_AUTHORIZED',
      'the gate failed for an I/O reason, which means it opened something it should not have');

    // And the status itself still reads cleanly, so the refusal above came from the manifest.
    assert.equal(readOperationalStatus(r.root).state, 'PRE_PRODUCTION');
  } finally {
    for (const name of ['.env', '.npmrc', '.netrc', 'secrets.json', 'id_rsa'])
      { try { chmodSync(join(r.root, name), 0o600); } catch { /* best effort */ } }
    try { chmodSync(join(r.root, 'trio', 'governance', '.env'), 0o600); } catch { /* best effort */ }
    r.drop();
  }
});

test('the gate declares exactly one governed path and reads nothing else', () => {
  assert.equal(GOVERNED_STATUS_PATH, 'trio/governance/boundary-manifest.json');
  const source = readFileSync(join(here, 'operational-admission.ts'), 'utf8');
  // One read call, one path join against the declared constant.
  assert.equal((source.match(/readFileSync\(/g) ?? []).length, 1, 'the gate reads from more than one place');
  assert.equal((source.match(/GOVERNED_STATUS_PATH/g) ?? []).length >= 2, true);
  for (const forbidden of ['os.homedir', 'readdirSync', 'execSync', 'spawnSync', 'createReadStream'])
    assert.equal(source.includes(forbidden), false, `the gate uses ${forbidden}`);
});

// --- the refusal itself ----------------------------------------------------------------------

test('a refusal is structured, states why, and carries no secret material', () => {
  const decision = admitOperation({ operation: 'deploy the thing', purpose: 'ordinary-work' }, LOCKED);
  assert.equal(decision.admitted, false);
  if (decision.admitted) return;
  const { refusal } = decision;
  assert.deepEqual(Object.keys(refusal).sort(),
    ['authorization', 'category', 'operation', 'productionAgent', 'purpose', 'reason', 'state']);
  assert.equal(refusal.state, 'PRE_PRODUCTION');
  assert.equal(refusal.authorization, 'NOT_AUTHORIZED_FOR_OPERATIONAL_WORK');
  assert.match(describeRefusal(refusal), /OPERATIONAL_WORK_NOT_AUTHORIZED/);
  const serialized = JSON.stringify(refusal);
  for (const secret of ['sk-', 'ghp_', 'password', 'token=', 'apikey', 'Bearer '])
    assert.equal(serialized.toLowerCase().includes(secret.toLowerCase()), false, `the refusal carried ${secret}`);
});

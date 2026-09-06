/**
 * CONTAINMENT WIRING — the first slice, plus the configuration boundary.
 *
 * Covers the two tool modules routed through the vendored authority (`execute-code-tools.ts` and
 * `lab-shell-tools.ts`) and the closed deployment schema that supplies their writable allocation.
 * Byte-identical across the Trio, like the modules it tests, and it names no agent: the allocation
 * comes from this deployment's own capsule, whichever deployment that is.
 *
 * The live cases exercise the REAL policy on this host. A containment suite made only of mocks
 * proves the plan was constructed correctly and says nothing about whether the kernel enforced it.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import type { ContainmentAvailability } from './containment/availability.js';
import { detectContainment } from './containment/availability.js';
import { containmentConfig, planFor, sshBrokerPolicy } from './containment/policy.js';
import { CONTAINMENT_VERSION } from './containment/version.js';
import { ContainmentRefused, wrap } from './containment/wrap.js';
import { agentContainmentConfig, repositoryRootFrom } from './containment-config.js';
import { readAgentCapsules } from './runtime-config.js';
import { governedMkdtemp } from './temp-authority.js';

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = repositoryRootFrom(here);

/** THE declared allocation for this deployment, from the governed capsule and nowhere else. */
const declared = readAgentCapsules(repositoryRoot).deployment.containment.writableWorkspaces;

const AVAILABLE: ContainmentAvailability = { available: true, tool: 'bwrap', version: 'stub' };
const UNAVAILABLE: ContainmentAvailability = { available: false, reason: 'stubbed for this test' };

const scratchRoot = (): string => {
  const governed = process.env.PEHVERSE_TEMP_ROOT;
  assert.ok(governed !== undefined && governed.length > 0, 'PEHVERSE_TEMP_ROOT must be set for these tests');
  return governed;
};

const declaredConfig = () => containmentConfig({ writableWorkspaces: declared });
const configWithScratch = (scratch: string) =>
  containmentConfig({ writableWorkspaces: declared, governedTempRoot: scratch });

// ------------------------------------------------------------------ 1. allowed inside the allocation

test('1. execution is allowed inside every declared workspace', () => {
  assert.ok(declared.length > 0, 'this deployment declares a writable allocation');
  for (const workspace of declared) {
    const decision = planFor(
      { command: 'node', args: ['x.js'], writableRoot: join(workspace, 'run'), cwd: join(workspace, 'run') },
      declaredConfig(), AVAILABLE,
    );
    assert.equal(decision.allowed, true, `work inside ${workspace} must be allowed`);
  }
});

test('1b. the governed scratch is writable, which is where execute_code puts its file', () => {
  const scratch = scratchRoot();
  const decision = planFor(
    { command: 'python3', args: ['s.py'], writableRoot: join(scratch, 'trio-agent', 'run-1'), tempRoot: scratch },
    configWithScratch(scratch), AVAILABLE,
  );
  assert.equal(decision.allowed, true);
});

// ------------------------------------------------------------------ 2. denial outside it

test('2. execution outside every declared workspace is denied', () => {
  const decision = planFor({ command: 'node', args: ['x.js'], writableRoot: '/etc' }, declaredConfig(), AVAILABLE);
  assert.equal(decision.allowed === false && decision.denial.code, 'WORKSPACE_NOT_DECLARED');
});

test('2b. a sibling sharing a name prefix is not inside the workspace', () => {
  const first = declared[0];
  assert.ok(first !== undefined);
  const decision = planFor({ command: 'node', args: [], writableRoot: `${first}-evil` }, declaredConfig(), AVAILABLE);
  assert.equal(decision.allowed === false && decision.denial.code, 'WORKSPACE_NOT_DECLARED');
});

test('2c. the parent of a declared workspace is not itself declared', () => {
  const first = declared[0];
  assert.ok(first !== undefined);
  const decision = planFor({ command: 'node', args: [], writableRoot: dirname(first) }, declaredConfig(), AVAILABLE);
  assert.equal(decision.allowed === false && decision.denial.code, 'WORKSPACE_NOT_DECLARED');
});

// ------------------------------------------------------------------ 3. unavailable fails closed

test('3. an unavailable boundary denies risky work rather than running it uncontained', () => {
  const scratch = scratchRoot();
  for (const command of ['python3', 'node', 'ssh']) { // ssh is a risky network TOOL now, so it is refused too
    const decision = planFor(
      { command, args: [], writableRoot: scratch, tempRoot: scratch },
      configWithScratch(scratch), UNAVAILABLE,
    );
    assert.equal(decision.allowed === false && decision.denial.code, 'CONTAINMENT_UNAVAILABLE', command);
  }
});

test('3b. confinement is decided BEFORE availability, so no host repair can authorise it', () => {
  const decision = planFor({ command: 'node', args: [], writableRoot: '/etc' }, declaredConfig(), UNAVAILABLE);
  assert.equal(decision.allowed === false && decision.denial.code, 'WORKSPACE_NOT_DECLARED');
});

test('3c. no containment policy exists without the external identity binding', () => {
  // These suites run under an operator entry, which carries no systemd credential. That is exactly
  // the "direct invocation outside the governed launcher" case, and it must produce no policy at
  // all rather than a policy built from files the repository attests to about itself.
  assert.throws(() => agentContainmentConfig(), /external identity refused/);
});

// ------------------------------------------------------------------ 4. a refusal carries no policy

test('4. a refusal carries no executable policy and cannot be wrapped', () => {
  const decision = planFor({ command: 'node', args: [], writableRoot: '/etc' }, declaredConfig(), AVAILABLE);
  assert.equal(decision.allowed, false);
  assert.equal('policy' in decision, false, 'a denial must not carry a policy object');
  assert.throws(() => wrap(decision, 'node', []), ContainmentRefused);
});

// ------------------------------------------------------------------ 5. every spawn goes through wrap

test('5. the wired files spawn only what wrap() returned', () => {
  /*
     They still need spawnSync to RUN what the authority hands back — the authority builds argv, it
     does not spawn. What must not exist is a spawn of a command that never went through
     planFor/wrap, so the assertion is not "no import"; it is that every spawn target is the wrapped
     binary.
  */
  for (const file of ['execute-code-tools.ts', 'lab-shell-tools.ts']) {
    const source = readFileSync(join(here, 'agent-tools', file), 'utf8');
    const spawns = [...source.matchAll(/spawnSync\s*\(\s*([A-Za-z0-9_.]+)/g)].map((m) => m[1]);
    assert.ok(spawns.length > 0, `${file} should still spawn something`);
    for (const target of spawns) {
      assert.equal(target, 'contained.binary', `${file} spawns ${target}, which did not come from wrap()`);
    }
    // execute_code decides through planFor; lab_shell decides through the SSH broker policy, which
    // is a separate code path precisely so no name can reach it.
    assert.match(source, /planFor\(|sshBrokerPolicy\(/, `${file} must obtain a decision from the authority`);
    assert.match(source, /wrap\(decision/, `${file} must build its argv through wrap`);
  }
});

test('5b. neither wired file contains a fallback that runs the command uncontained', () => {
  for (const file of ['execute-code-tools.ts', 'lab-shell-tools.ts']) {
    const source = readFileSync(join(here, 'agent-tools', file), 'utf8');
    assert.equal(/trustedLocalOverride/.test(source), false, `${file} must not mention the override`);
    assert.equal(/mode:\s*['"]off['"]/.test(source), false, `${file} must not disable containment`);
    assert.match(source, /if \(!decision\.allowed\)[\s\S]{0,400}?return/, `${file} must return on refusal`);
  }
});

test('5c. the model-controlled shell tool spawns only what wrap() returned', () => {
  /*
     Phase 3C measured what the `terminal` tool permitted before this: with an auditor-controlled
     local sink and a synthetic canary outside the workspace, six of seven exfiltration routes
     delivered the canary — curl, cat-into-curl, relative traversal, read-then-post, wget, python.
     The positive control proved the sink reachable, so those were real deliveries.

     It is a separate assertion from test 5 because `tools.ts` is not in agent-tools/ and because
     this is the file a provider's chosen string actually reaches.
  */
  const source = readFileSync(join(here, 'tools.ts'), 'utf8');
  const spawns = [...source.matchAll(/spawnSync\s*\(\s*([A-Za-z0-9_.]+)/g)].map((m) => m[1]);
  assert.ok(spawns.length > 0, 'tools.ts should still spawn something');
  for (const target of spawns) {
    assert.equal(target, 'contained.binary', `tools.ts spawns ${target}, which did not come from wrap()`);
  }
  assert.match(source, /planFor\(/, 'the shell tool must obtain a decision from the authority');
  assert.match(source, /wrap\(decision/, 'the shell tool must build its argv through wrap');
  assert.equal(/trustedLocalOverride/.test(source), false, 'tools.ts must not mention the override');
  assert.equal(/mode:\s*['"]off['"]/.test(source), false, 'tools.ts must not disable containment');
});

test('5d. the shell tool asks for the view that can never share the network', () => {
  // `narrow` forces networkAllowed=false in the authority itself, whatever the command wants, so
  // a model-chosen command cannot reach the network however it is spelled. The service's own
  // provider connection is unaffected: that call is made by this process, not by a child.
  const source = readFileSync(join(here, 'tools.ts'), 'utf8');
  assert.match(source, /view:\s*"narrow"/, 'the shell tool must plan under the narrow view');
});

test('5e. a background command is planned exactly like a foreground one', () => {
  /*
     A background flag must not be a route to a shell that a foreground call could not reach. The
     decision is taken before the branch, and the registry is handed the wrapped argv.
  */
  const source = readFileSync(join(here, 'tools.ts'), 'utf8');
  const decisionAt = source.indexOf('const decision = containedShellPlan');
  const backgroundAt = source.indexOf('args.background === true');
  assert.ok(decisionAt > 0 && backgroundAt > 0, 'both the decision and the background branch must exist');
  assert.ok(decisionAt < backgroundAt, 'containment must be decided before the background branch');
  assert.match(source, /processes\.spawn\(\s*\n?\s*\[contained\.binary/,
    'the background path must spawn the wrapped argv');
});

// ------------------------------------------------------------------ 6. the shared code names nobody

test('6. the vendored authority names no deployment and branches on none', () => {
  const names = /pehlichi|loony-luna|mad-ptah|johnny|\bpeh\b|\bluna\b|\bptah\b/i;
  for (const module of ['version', 'risk', 'availability', 'paths', 'policy', 'argv', 'wrap', 'conformance', 'index']) {
    const source = readFileSync(join(here, 'containment', `${module}.ts`), 'utf8');
    assert.equal(names.test(source), false, `containment/${module}.ts names a deployment`);
  }
});

test('6b. the loader names no deployment either, beyond saying that it does not', () => {
  const names = /pehlichi|loony-luna|mad-ptah|johnny|\bpeh\b|\bluna\b|\bptah\b/i;
  const loader = readFileSync(join(here, 'containment-config.ts'), 'utf8');
  const withoutTheDisclaimer = loader.replace(/nothing here names[^.]*\./, '');
  assert.equal(names.test(withoutTheDisclaimer), false, 'containment-config.ts names a deployment');
});

test('6c. the identity table is not vendored at all', () => {
  assert.throws(() => readFileSync(join(here, 'containment', 'agents.ts'), 'utf8'));
});

test('6d. the version stamp this deployment reports is well formed', () => {
  assert.match(CONTAINMENT_VERSION, /^\d+\.\d+\.\d+$/);
});

// ------------------------------------------------------------------ closed-schema negatives

/** A throwaway repository root holding a copy of this deployment's two capsules. */
function fixtureRoot(mutate: (deployment: Record<string, unknown>) => void): string {
  const root = governedMkdtemp('capsule-fixture-');
  mkdirSync(join(root, 'capsule'), { recursive: true });
  mkdirSync(join(root, 'deployment'), { recursive: true });
  cpSync(join(repositoryRoot, 'capsule', 'agent.json'), join(root, 'capsule', 'agent.json'));
  const deployment = JSON.parse(
    readFileSync(join(repositoryRoot, 'deployment', 'agent.env.json'), 'utf8'),
  ) as Record<string, unknown>;
  mutate(deployment);
  writeFileSync(join(root, 'deployment', 'agent.env.json'), `${JSON.stringify(deployment, null, 2)}\n`);
  return root;
}

test('N1. a deployment that declares no containment block is refused', () => {
  const root = fixtureRoot((d) => { delete d['containment']; });
  assert.throws(() => readAgentCapsules(root), /missing or unknown fields/);
});

test('N2. an unknown field inside the containment block is refused', () => {
  const root = fixtureRoot((d) => { d['containment'] = { writableWorkspaces: declared, mode: 'off' }; });
  assert.throws(() => readAgentCapsules(root), /missing or unknown fields/);
});

test('N3. an unknown field beside the containment block is refused', () => {
  const root = fixtureRoot((d) => { d['containmentOverride'] = { trustedLocalOverride: true }; });
  assert.throws(() => readAgentCapsules(root), /missing or unknown fields/);
});

test('N4. an empty allocation is refused rather than read as "nothing to protect"', () => {
  const root = fixtureRoot((d) => { d['containment'] = { writableWorkspaces: [] }; });
  assert.throws(() => readAgentCapsules(root), /non-empty array/);
});

test('N5. a broadened allocation is refused', () => {
  // Several correct rules can fire first -- `/` ends in a separator, the rest are simply not in the
  // reviewed vocabulary. The assertion pins the OUTCOME (refused, with a reason that names the
  // path) rather than which rule happened to reach it first.
  for (const broad of ['/', '/pehverse', '/etc', '/etc/foo', '/pehverse-other', '/pehverse/worktrees-evil']) {
    const root = fixtureRoot((d) => { d['containment'] = { writableWorkspaces: [broad] }; });
    assert.throws(() => readAgentCapsules(root), /not reviewed|not normalised/, broad);
  }
});

test('N6. traversal and un-normalised paths are refused', () => {
  for (const bad of ['/pehverse/worktrees/..', '/pehverse//worktrees', '/pehverse/worktrees/', '/pehverse/./worktrees']) {
    const root = fixtureRoot((d) => { d['containment'] = { writableWorkspaces: [bad] }; });
    assert.throws(() => readAgentCapsules(root), /not normalised/, bad);
  }
  const relative = fixtureRoot((d) => { d['containment'] = { writableWorkspaces: ['worktrees'] }; });
  assert.throws(() => readAgentCapsules(relative), /not absolute/);
});

test('N7. a path that would be expanded from the environment is refused', () => {
  for (const bad of ['/pehverse/$HOME', '/pehverse/`id`']) {
    const root = fixtureRoot((d) => { d['containment'] = { writableWorkspaces: [bad] }; });
    assert.throws(() => readAgentCapsules(root), /expansion/, bad);
  }
  const tilde = fixtureRoot((d) => { d['containment'] = { writableWorkspaces: ['~/worktrees'] }; });
  assert.throws(() => readAgentCapsules(tilde), /not absolute/);
});

test('N8. a malformed allocation — wrong type, duplicate, or empty string — is refused', () => {
  const cases: unknown[] = ['/pehverse/worktrees', 42, [42], [''], ['/pehverse/worktrees', '/pehverse/worktrees']];
  for (const value of cases) {
    const root = fixtureRoot((d) => { d['containment'] = { writableWorkspaces: value }; });
    assert.throws(() => readAgentCapsules(root), JSON.stringify(value));
  }
});

test('N9. a capsule that cannot be parsed at all fails closed', () => {
  const root = governedMkdtemp('capsule-broken-');
  mkdirSync(join(root, 'capsule'), { recursive: true });
  mkdirSync(join(root, 'deployment'), { recursive: true });
  cpSync(join(repositoryRoot, 'capsule', 'agent.json'), join(root, 'capsule', 'agent.json'));
  writeFileSync(join(root, 'deployment', 'agent.env.json'), '{ not json');
  assert.throws(() => readAgentCapsules(root));
});

// ------------------------------------------------------------------ identity binding (C-1)

/** The other two Trio repositories, as sources of genuinely valid foreign capsules. */
const siblings = (): Array<{ id: string; root: string }> =>
  ['pehlichi', 'mad-ptah', 'loony-luna']
    .map((id) => ({ id, root: join(dirname(repositoryRoot), id) }))
    .filter((s) => s.root !== repositoryRoot && existsSync(join(s.root, 'capsule', 'agent.json')));

/**
 * A repository root whose capsule and deployment can be taken from different agents.
 *
 * `packageName` defaults to THIS repository's, so the fixture is the honest reproduction of the
 * audit: a real checkout with a foreign file dropped into it.
 */
function crossBoundFixture(capsuleFrom: string, deploymentFrom: string, packageFrom = repositoryRoot): string {
  const root = governedMkdtemp('identity-fixture-');
  mkdirSync(join(root, 'capsule'), { recursive: true });
  mkdirSync(join(root, 'deployment'), { recursive: true });
  cpSync(join(capsuleFrom, 'capsule', 'agent.json'), join(root, 'capsule', 'agent.json'));
  cpSync(join(deploymentFrom, 'deployment', 'agent.env.json'), join(root, 'deployment', 'agent.env.json'));
  cpSync(join(packageFrom, 'package.json'), join(root, 'package.json'));
  return root;
}

test('I1. this deployment is bound: capsule, deployment and repository identities agree', () => {
  const { capsule, deployment } = readAgentCapsules(repositoryRoot);
  const packageName = (JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as { name: string }).name;
  assert.equal(deployment.identity, capsule.identity.id);
  assert.equal(packageName, capsule.identity.id);
});

test('I2. a foreign deployment paired with this capsule is rejected (the audit\'s swapped-deployment)', () => {
  for (const other of siblings()) {
    const root = crossBoundFixture(repositoryRoot, other.root);
    assert.throws(() => readAgentCapsules(root), /identity mismatch/,
      `${other.id}'s deployment must not bind to this capsule`);
  }
});

test('I3. a foreign capsule paired with this deployment is rejected (the audit\'s swapped-capsule)', () => {
  for (const other of siblings()) {
    const root = crossBoundFixture(other.root, repositoryRoot);
    assert.throws(() => readAgentCapsules(root), /identity mismatch/,
      `${other.id}'s capsule must not bind to this deployment`);
  }
});

test('I4. a consistent foreign PAIR is still rejected, because it does not belong to this repository', () => {
  for (const other of siblings()) {
    const root = crossBoundFixture(other.root, other.root);
    assert.throws(() => readAgentCapsules(root), /does not belong to this repository/,
      `${other.id}'s matched pair must not bind to this repository`);
  }
});

test('I5. a missing, wrong-typed or malformed deployment identity fails closed', () => {
  const cases: Array<[string, unknown]> = [
    ['missing', undefined], ['number', 7], ['empty', ''], ['padded', ' pehlichi'],
    ['array', ['pehlichi']], ['object', { id: 'pehlichi' }], ['null', null],
  ];
  for (const [label, value] of cases) {
    const root = fixtureRoot((d) => { if (value === undefined) delete d['identity']; else d['identity'] = value; });
    assert.throws(() => readAgentCapsules(root), label);
  }
});

test('I6. an unreadable or identity-less repository fails closed rather than defaulting', () => {
  const noPackage = crossBoundFixture(repositoryRoot, repositoryRoot);
  rmSync(join(noPackage, 'package.json'));
  assert.throws(() => readAgentCapsules(noPackage), /repository identity unreadable/);
});

test('I7. identity is never inferred from the directory the checkout happens to sit in', () => {
  // The fixture directory is a random governed scratch name that matches no agent. A correctly
  // bound pair still loads, and a mismatched one still fails -- so the answer came from the files.
  const bound = crossBoundFixture(repositoryRoot, repositoryRoot);
  assert.equal(readAgentCapsules(bound).capsule.identity.id,
    readAgentCapsules(repositoryRoot).capsule.identity.id);
  const loader = readFileSync(join(here, 'containment-config.ts'), 'utf8');
  const config = readFileSync(join(here, 'runtime-config.ts'), 'utf8');
  for (const source of [loader, config]) {
    assert.equal(/process\.argv|process\.env\.[A-Z_]*IDENTITY|basename\(/.test(source), false,
      'identity must not come from arguments, the environment, or a directory name');
  }
});

// ------------------------------------------------------------------ live: the real boundary

test('live: the real boundary confines a wired-style execution on this host', (t) => {
  const availability = detectContainment();
  if (!availability.available) {
    t.skip(`no containment backend here: ${availability.reason ?? 'unknown'}`);
    return;
  }
  const scratch = governedMkdtemp('containment-wiring-');
  const run = join(scratch, 'run');
  const outside = join(scratch, 'outside');
  mkdirSync(run, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'sentinel'), 'untouched');

  const script = join(run, 'probe.mjs');
  const escape = join(outside, 'escaped');
  writeFileSync(script, `
    import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(join(run, 'inside.txt'))}, 'ok');
    try { writeFileSync(${JSON.stringify(escape)}, 'escaped'); } catch {}
    console.log('done');
  `);

  const decision = planFor(
    { command: 'node', args: [script], writableRoot: run, cwd: run, tempRoot: run },
    containmentConfig({ writableWorkspaces: declared, governedTempRoot: scratch }),
  );
  assert.equal(decision.allowed, true);
  const contained = wrap(decision, 'node', [script]);
  assert.equal(contained.binary, 'bwrap');

  let result;
  try {
    result = spawnSync(contained.binary, [...contained.args], {
      encoding: 'utf8', timeout: 30_000,
      stdio: [...contained.stdio] as never,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: run, LANG: 'C.UTF-8' },
    });
  } finally {
    contained.dispose();
  }

  assert.equal(readFileSync(join(run, 'inside.txt'), 'utf8'), 'ok',
    `the contained write inside the workspace did not land: ${result.stderr ?? ''}`);
  assert.throws(() => readFileSync(escape, 'utf8'), 'a write escaped the workspace');
  assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'untouched');
});

test('live: the same escape succeeds uncontained, so the control above has teeth', () => {
  const scratch = governedMkdtemp('containment-positive-');
  const outside = join(scratch, 'outside');
  mkdirSync(outside, { recursive: true });
  const escape = join(outside, 'escaped');
  const script = join(scratch, 'probe.mjs');
  writeFileSync(script, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(escape)}, 'escaped');`);

  spawnSync('node', [script], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(readFileSync(escape, 'utf8'), 'escaped',
    'the uncontained write did not land, so the contained control proves nothing');
});

test('live: a contained interpreter has no network, which is the documented contract change', (t) => {
  if (!detectContainment().available) { t.skip('no containment backend here'); return; }
  const scratch = governedMkdtemp('containment-net-');
  const script = join(scratch, 'net.mjs');
  writeFileSync(script, `
    import { lookup } from 'node:dns';
    lookup('example.com', (err) => { console.log(err ? 'BLOCKED' : 'REACHED'); });
  `);
  const decision = planFor(
    { command: 'node', args: [script], writableRoot: scratch, cwd: scratch, tempRoot: scratch },
    containmentConfig({ writableWorkspaces: declared, governedTempRoot: scratch }),
  );
  assert.equal(decision.allowed === true && decision.policy.networkAllowed, false);
  const contained = wrap(decision, 'node', [script]);
  let result;
  try {
    result = spawnSync(contained.binary, [...contained.args], {
      encoding: 'utf8', timeout: 30_000,
      stdio: [...contained.stdio] as never,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: scratch, LANG: 'C.UTF-8' },
    });
  } finally {
    contained.dispose();
  }
  assert.equal((result.stdout ?? '').trim(), 'BLOCKED', `stderr: ${result.stderr ?? ''}`);
});

test('live: naming ssh grants no network, and the broker grants it with the filter still on', () => {
  const scratch = scratchRoot();
  const named = planFor(
    { command: 'ssh', args: ['-o', 'BatchMode=yes', 'host', 'true'], writableRoot: scratch, tempRoot: scratch },
    configWithScratch(scratch), AVAILABLE,
  );
  assert.equal(named.allowed === true && named.policy.networkAllowed, false, 'a name must not buy the network');
  assert.equal(named.allowed === true && named.policy.risk.kind, 'network-tool');
  assert.equal(named.allowed === true && named.policy.denyUnixSockets, true);

  const brokered = sshBrokerPolicy({ writableRoot: scratch, tempRoot: scratch }, AVAILABLE);
  assert.equal(brokered.allowed === true && brokered.policy.networkAllowed, true);
  assert.equal(brokered.allowed === true && brokered.policy.denyUnixSockets, true,
    'the exception is gone: the networked operation is filtered too');
});

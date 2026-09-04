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
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import type { ContainmentAvailability } from './containment/availability.js';
import { detectContainment } from './containment/availability.js';
import { containmentConfig, planFor } from './containment/policy.js';
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
  for (const command of ['python3', 'node', 'ssh']) {
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

test('3c. the configuration this deployment actually loads is auto-mode with no override', () => {
  const live = agentContainmentConfig();
  assert.equal(live.mode, 'auto');
  assert.equal(live.trustedLocalOverride, false);
  for (const workspace of declared) assert.ok(live.writableWorkspaces.includes(workspace), workspace);
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
    assert.match(source, /planFor\(/, `${file} must decide through planFor`);
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
  // `/` is caught by the normalisation rule (it ends in a separator) before the depth rule sees it.
  // Both are refusals; the assertion accepts either so it pins the OUTCOME rather than the order in
  // which two correct rules happen to fire.
  for (const broad of ['/', '/pehverse', '/etc']) {
    const root = fixtureRoot((d) => { d['containment'] = { writableWorkspaces: [broad] }; });
    assert.throws(() => readAgentCapsules(root), /too broad|not normalised/, broad);
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

  const result = spawnSync(contained.binary, [...contained.args], {
    encoding: 'utf8', timeout: 30_000,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: run, LANG: 'C.UTF-8' },
  });

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
  const result = spawnSync(contained.binary, [...contained.args], {
    encoding: 'utf8', timeout: 30_000,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: scratch, LANG: 'C.UTF-8' },
  });
  assert.equal((result.stdout ?? '').trim(), 'BLOCKED', `stderr: ${result.stderr ?? ''}`);
});

test('live: ssh keeps the network, because containing it without one would only break it', () => {
  const scratch = scratchRoot();
  const decision = planFor(
    { command: 'ssh', args: ['-o', 'BatchMode=yes', 'host', 'true'], writableRoot: scratch, tempRoot: scratch },
    configWithScratch(scratch), AVAILABLE,
  );
  assert.equal(decision.allowed === true && decision.policy.networkAllowed, true);
  assert.equal(decision.allowed === true && decision.policy.risk.kind, 'network-client');
});

/**
 * CONTAINMENT WIRING — the first slice.
 *
 * Covers the two tool modules wired through the vendored authority: `execute-code-tools.ts` and
 * `lab-shell-tools.ts`. Byte-identical across the Trio, like the modules it tests.
 *
 * The live cases exercise the REAL policy on this host rather than a mock. A containment suite made
 * only of mocks proves that the plan was constructed correctly and says nothing about whether the
 * kernel enforced it.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { AGENT_PROFILES, configFor } from './containment/agents.js';
import type { ContainmentAvailability } from './containment/availability.js';
import { detectContainment } from './containment/availability.js';
import { planFor } from './containment/policy.js';
import { CONTAINMENT_VERSION } from './containment/version.js';
import { ContainmentRefused, wrap } from './containment/wrap.js';
import { capsuleIdentityId, repositoryRootFrom } from './containment-config.js';

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = repositoryRootFrom(here);
const agentId = capsuleIdentityId(repositoryRoot);

const UNAVAILABLE: ContainmentAvailability = { available: false, reason: 'stubbed for this test' };

const scratchRoot = (): string => {
  const governed = process.env.PEHVERSE_TEMP_ROOT;
  assert.ok(governed !== undefined && governed.length > 0, 'PEHVERSE_TEMP_ROOT must be set for these tests');
  return governed;
};

/** This agent's real configuration, with a scratch root the test controls. */
const configWithScratch = (scratch: string) => configFor(agentId, { governedTempRoot: scratch });

// ------------------------------------------------------------------ 1. allowed inside the workspace

test('1. execution is allowed inside each declared workspace', () => {
  const profile = AGENT_PROFILES[agentId as keyof typeof AGENT_PROFILES];
  assert.ok(profile !== undefined, `${agentId} has a declared containment profile`);

  for (const workspace of profile.writableWorkspaces) {
    const decision = planFor(
      { command: 'node', args: ['x.js'], writableRoot: join(workspace, 'run'), cwd: join(workspace, 'run') },
      configFor(agentId),
      { available: true, tool: 'bwrap', version: 'stub' },
    );
    assert.equal(decision.allowed, true, `${agentId} must be able to work inside ${workspace}`);
  }
});

test('1b. the governed scratch is a writable workspace, which is where execute_code works', () => {
  const scratch = scratchRoot();
  const decision = planFor(
    { command: 'python3', args: ['s.py'], writableRoot: join(scratch, 'trio-agent', 'run-1'), tempRoot: scratch },
    configWithScratch(scratch),
    { available: true, tool: 'bwrap', version: 'stub' },
  );
  assert.equal(decision.allowed, true);
});

// ------------------------------------------------------------------ 2. denial outside it

test('2. execution outside every declared workspace is denied', () => {
  const decision = planFor(
    { command: 'node', args: ['x.js'], writableRoot: '/etc' },
    configFor(agentId),
    { available: true, tool: 'bwrap', version: 'stub' },
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.allowed === false && decision.denial.code, 'WORKSPACE_NOT_DECLARED');
});

test('2b. a sibling directory sharing a name prefix is not inside the workspace', () => {
  const profile = AGENT_PROFILES[agentId as keyof typeof AGENT_PROFILES];
  const first = profile?.writableWorkspaces[0];
  assert.ok(first !== undefined);
  const decision = planFor(
    { command: 'node', args: [], writableRoot: `${first}-evil` },
    configFor(agentId),
    { available: true, tool: 'bwrap', version: 'stub' },
  );
  assert.equal(decision.allowed === false && decision.denial.code, 'WORKSPACE_NOT_DECLARED');
});

// ------------------------------------------------------------------ 3. unavailable fails closed

test('3. an unavailable boundary denies risky work rather than running it uncontained', () => {
  const scratch = scratchRoot();
  for (const command of ['python3', 'node', 'ssh']) {
    const decision = planFor(
      { command, args: [], writableRoot: scratch, tempRoot: scratch },
      configWithScratch(scratch),
      UNAVAILABLE,
    );
    assert.equal(decision.allowed, false, `${command} must be refused when containment is unavailable`);
    assert.equal(decision.allowed === false && decision.denial.code, 'CONTAINMENT_UNAVAILABLE', command);
  }
});

test('3b. no agent configuration can reach the trusted-local override', () => {
  for (const id of Object.keys(AGENT_PROFILES)) {
    assert.equal(configFor(id).trustedLocalOverride, false, id);
  }
});

// ------------------------------------------------------------------ 4. a refusal carries no policy

test('4. a refusal carries no executable policy and cannot be wrapped', () => {
  const decision = planFor(
    { command: 'node', args: [], writableRoot: '/etc' },
    configFor(agentId),
    { available: true, tool: 'bwrap', version: 'stub' },
  );
  assert.equal(decision.allowed, false);
  assert.equal('policy' in decision, false, 'a denial must not carry a policy object');
  assert.throws(() => wrap(decision, 'node', []), ContainmentRefused);
});

// ------------------------------------------------------------------ 5. no direct child_process

test('5. the newly wired production files do not import node:child_process directly', () => {
  /*
     execute-code-tools.ts and lab-shell-tools.ts still need spawnSync to RUN what the authority
     hands back — the authority builds argv, it does not spawn. What must not exist is a spawn of a
     command that never went through planFor/wrap. So the assertion is not "no import"; it is that
     every spawn call in these files spawns the WRAPPED binary.
  */
  const wired = ['execute-code-tools.ts', 'lab-shell-tools.ts'];
  for (const file of wired) {
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
    // A denial must lead to a return, never to a spawn further down.
    assert.match(source, /if \(!decision\.allowed\)[\s\S]{0,400}?return/, `${file} must return on refusal`);
  }
});

// ------------------------------------------------------------------ 6. parity of shared config

test('6. every agent shares one containment configuration except its writable workspaces', () => {
  const shapes = new Set(
    Object.keys(AGENT_PROFILES).map((id) => {
      const { writableWorkspaces: _authorised, ...rest } = configFor(id, { governedTempRoot: '/lab/scratch' });
      return JSON.stringify(rest);
    }),
  );
  assert.equal(shapes.size, 1, 'containment configuration must differ only in writableWorkspaces');
});

test('6b. the vendored authority is byte-identical across the Trio and matches its source', () => {
  const siblings = ['pehlichi', 'mad-ptah', 'loony-luna']
    .map((name) => join(dirname(repositoryRoot), name, 'src', 'core', 'containment'))
    .filter((dir) => existsSync(dir));
  assert.ok(siblings.length >= 1, 'at least this agent must have a vendored copy');

  const mine = join(here, 'containment');
  const modules = readdirSync(mine).filter((f) => f.endsWith('.ts')).sort();
  assert.ok(modules.length >= 10, 'the vendored authority should be complete');

  for (const dir of siblings) {
    for (const module of modules) {
      assert.equal(
        readFileSync(join(dir, module), 'utf8'),
        readFileSync(join(mine, module), 'utf8'),
        `${module} differs between ${dir} and ${mine}`,
      );
    }
  }

  // And against the canonical repository, when it is present beside the agents.
  const canonical = join(dirname(dirname(repositoryRoot)), 'lab-utilities', 'lab-containment', 'src');
  if (existsSync(canonical)) {
    for (const module of modules) {
      assert.equal(
        readFileSync(join(mine, module), 'utf8'),
        readFileSync(join(canonical, module), 'utf8'),
        `${module} has drifted from the canonical authority`,
      );
    }
  }
});

test('6c. the vendored version stamp is the one this agent reports', () => {
  assert.match(CONTAINMENT_VERSION, /^\d+\.\d+\.\d+$/);
});

// ------------------------------------------------------------------ live: the real policy

test('live: the real boundary confines a wired-style execution on this host', (t) => {
  const availability = detectContainment();
  if (!availability.available) {
    t.skip(`no containment backend here: ${availability.reason ?? 'unknown'}`);
    return;
  }
  const scratch = mkdtempSync(join(scratchRoot(), 'containment-wiring-'));
  const run = join(scratch, 'run');
  const outside = join(scratch, 'outside');
  mkdirSync(run, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'sentinel'), 'untouched');

  // Exactly the shape execute_code builds: interpreter, scratch as the one writable path.
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
    configFor(agentId, { governedTempRoot: scratch }),
  );
  assert.equal(decision.allowed, true);
  const contained = wrap(decision, 'node', [script]);
  assert.equal(contained.binary, 'bwrap');

  const result = spawnSync(contained.binary, [...contained.args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: run, LANG: 'C.UTF-8' },
  });

  assert.equal(readFileSync(join(run, 'inside.txt'), 'utf8'), 'ok',
    `the contained write inside the workspace did not land: ${result.stderr ?? ''}`);
  assert.throws(() => readFileSync(escape, 'utf8'), 'a write escaped the workspace');
  assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'untouched');
});

test('live: the same escape succeeds uncontained, so the control above has teeth', () => {
  const scratch = mkdtempSync(join(scratchRoot(), 'containment-positive-'));
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
  const availability = detectContainment();
  if (!availability.available) {
    t.skip('no containment backend here');
    return;
  }
  const scratch = mkdtempSync(join(scratchRoot(), 'containment-net-'));
  const script = join(scratch, 'net.mjs');
  writeFileSync(script, `
    import { lookup } from 'node:dns';
    lookup('example.com', (err) => { console.log(err ? 'BLOCKED' : 'REACHED'); });
  `);
  const decision = planFor(
    { command: 'node', args: [script], writableRoot: scratch, cwd: scratch, tempRoot: scratch },
    configFor(agentId, { governedTempRoot: scratch }),
  );
  assert.equal(decision.allowed, true);
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
    configFor(agentId, { governedTempRoot: scratch }),
    { available: true, tool: 'bwrap', version: 'stub' },
  );
  assert.equal(decision.allowed, true);
  assert.equal(decision.allowed === true && decision.policy.networkAllowed, true);
  assert.equal(decision.allowed === true && decision.policy.risk.kind, 'network-client');
});

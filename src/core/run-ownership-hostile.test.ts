/**
 * RUN OWNERSHIP — hostile suite.
 *
 * THE PRIOR FALSE ASSUMPTION, stated once so it cannot come back: residue was "a run directory that
 * is not one of MY ancestors". A sibling service is never anyone's ancestor, so three legitimately
 * running lab services were classified as residue by construction — every run, in every repository.
 * The rule proved nothing about the directories; it only asked who was looking.
 *
 * Residue is now a PROVABLY DEAD owner. LIVE, DEAD, UNKNOWN — and UNKNOWN is never residue and is
 * never removed, because being wrong that way costs a stale directory and being wrong the other way
 * costs a running service.
 *
 * Every destructive case here runs against a fixture root built by this suite. Nothing in this file
 * writes to, or removes from, the production governed root; the production cases are read-only
 * classification.
 *
 * Byte-identical across the Trio.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  LAB_UNIT,
  STATE,
  classifyComponent,
  classifyOwnership,
  ownershipFacts,
  readBootId,
  readSidecar,
  readStartTicks,
  readUnit,
  residueOf,
} from '../../scripts/trio/run-ownership.mjs';
import { governedMkdtemp } from './temp-authority.js';

const BOOT = readBootId();
const HOST = hostname();
const COMPONENT = 'trio-agent';

/** A fixture governed root: `<root>/trio-agent/<runId>` plus `<root>/trio-agent/.runs/<runId>.json`. */
function fixture(): { root: string; add: (runId: string, record: unknown | undefined) => string } {
  const root = governedMkdtemp('ownership-fixture-');
  mkdirSync(join(root, COMPONENT, '.runs'), { recursive: true });
  const add = (runId: string, record: unknown | undefined): string => {
    const dir = join(root, COMPONENT, runId);
    mkdirSync(dir, { recursive: true });
    if (record !== undefined) {
      writeFileSync(join(root, COMPONENT, '.runs', `${runId}.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    }
    return dir;
  };
  return { root, add };
}

/** A complete, honest record for a pid that is genuinely alive right now. */
function recordFor(runId: string, dir: string, root: string, pid = process.pid): Record<string, unknown> {
  return {
    marker: 'pehverse-governed-temp-child',
    version: 1,
    component: COMPONENT,
    runId,
    childPath: dir,
    root,
    hostname: HOST,
    ...ownershipFacts(pid),
    createdAt: Date.now(),
  };
}

const stateOf = (record: unknown, dir: string): string => classifyOwnership(record as never, dir).state;

// ------------------------------------------------------------------ live owners

test('O1. the current process is LIVE when every fact agrees', (t) => {
  if (readUnit(process.pid) === undefined) {
    t.skip('this process is not in a lab-*.service cgroup, so LIVE is unreachable here');
    return;
  }
  const f = fixture();
  const dir = f.add('run-self', undefined);
  assert.equal(stateOf(recordFor('run-self', dir, f.root), dir), STATE.LIVE);
});

test('O1b. LIVE is reachable and correct against a genuinely running lab service', (t) => {
  // The suite itself runs under an operator entry, which is not in a lab unit, so O1 skips. This
  // proves the LIVE path end to end against a real service process instead of leaving it untested:
  // real pid, real start ticks, real cgroup unit.
  const show = spawnSync('systemctl', ['show', 'lab-ptah', '-p', 'MainPID', '--value'], { encoding: 'utf8' });
  const pid = Number((show.stdout ?? '').trim());
  if (!Number.isInteger(pid) || pid <= 0 || readUnit(pid) === undefined) {
    t.skip('no running lab service to bind against on this host');
    return;
  }
  const f = fixture();
  const dir = f.add('run-service', undefined);
  const record = recordFor('run-service', dir, f.root, pid);
  assert.equal(record['unit'], 'lab-ptah.service');
  const verdict = classifyOwnership(record as never, dir);
  assert.equal(verdict.state, STATE.LIVE, verdict.reason);

  // And the same record with any single fact spoiled must stop being LIVE.
  for (const spoil of [{ processStartTicks: 1 }, { unit: 'lab-luna.service' }, { bootId: 'x' }]) {
    assert.notEqual(classifyOwnership({ ...record, ...spoil } as never, dir).state, STATE.LIVE,
      JSON.stringify(spoil));
  }
});

test('O2. a process with no lab unit is UNKNOWN, never LIVE and never DEAD', () => {
  const f = fixture();
  const dir = f.add('run-nounit', undefined);
  const record = { ...recordFor('run-nounit', dir, f.root) };
  delete record['unit'];
  assert.equal(stateOf(record, dir), STATE.UNKNOWN);
});

test('O3. an ancestor process is judged by the same evidence, not by being an ancestor', () => {
  const f = fixture();
  const parent = process.ppid;
  const dir = f.add('run-parent', undefined);
  const record = recordFor('run-parent', dir, f.root, parent);
  // Whatever it comes out as, it must never be DEAD while the parent is alive.
  assert.notEqual(stateOf(record, dir), STATE.DEAD, 'a living ancestor must never be residue');
});

test('O4. all three live sibling services classify away from DEAD in the production root', () => {
  // The exact defect: siblings are never ancestors. Read-only; nothing is removed.
  const verdicts = classifyComponent(process.env['PEHVERSE_TEMP_ROOT'] ?? '', COMPONENT);
  for (const v of verdicts) {
    assert.notEqual(v.state, STATE.DEAD, `${v.runId} was called residue: ${v.reason}`);
  }
  assert.deepEqual(residueOf(verdicts), [], 'the production root must yield no residue');
});

// ------------------------------------------------------------------ provable death

test('O5. an exited process is DEAD', () => {
  const f = fixture();
  const child = spawnSync('/bin/sh', ['-c', 'echo $$'], { encoding: 'utf8' });
  const pid = Number((child.stdout ?? '').trim());
  assert.ok(Number.isInteger(pid) && pid > 0, 'the control must report a pid');
  const dir = f.add('run-exited', undefined);
  const record = {
    ...recordFor('run-exited', dir, f.root),
    pid,
    processStartTicks: 12345,
    unit: 'lab-ptah.service',
    bootId: BOOT,
  };
  assert.equal(stateOf(record, dir), STATE.DEAD);
});

test('O6. PID reuse is DEAD, not LIVE — a live pid alone proves nothing', () => {
  const f = fixture();
  const dir = f.add('run-reuse', undefined);
  const actual = readStartTicks(process.pid);
  assert.ok(actual !== undefined);
  const record = {
    ...recordFor('run-reuse', dir, f.root),
    processStartTicks: actual + 1_000_000, // same live pid, different process
    unit: 'lab-ptah.service',
  };
  assert.equal(stateOf(record, dir), STATE.DEAD);
});

test('O7. a record from a previous boot is DEAD', () => {
  const f = fixture();
  const dir = f.add('run-oldboot', undefined);
  const record = { ...recordFor('run-oldboot', dir, f.root), bootId: '00000000-0000-0000-0000-000000000000' };
  assert.equal(stateOf(record, dir), STATE.DEAD);
});

// ------------------------------------------------------------------ everything ambiguous is UNKNOWN

test('O8. a missing, empty, malformed or partial sidecar is UNKNOWN', () => {
  const f = fixture();
  const dir = f.add('run-nosidecar', undefined);
  assert.equal(stateOf(undefined, dir), STATE.UNKNOWN);
  for (const partial of [
    {},
    { runId: 'run-nosidecar' },
    { runId: 'run-nosidecar', hostname: HOST },
    { runId: 'run-nosidecar', hostname: HOST, pid: process.pid },                       // pid alone
    { runId: 'run-nosidecar', hostname: HOST, pid: process.pid, bootId: BOOT },          // no start ticks
    { runId: 'run-nosidecar', hostname: HOST, pid: 'x', bootId: BOOT },
    { runId: 'run-nosidecar', hostname: HOST, pid: -1, bootId: BOOT },
  ]) {
    assert.equal(stateOf(partial, dir), STATE.UNKNOWN, JSON.stringify(partial));
  }
});

test('O9. a legacy record — exactly what the live services carry today — is UNKNOWN', () => {
  const f = fixture();
  const dir = f.add('run-legacy', undefined);
  const legacy = {
    marker: 'pehverse-governed-temp-child', version: 1, component: COMPONENT,
    runId: 'run-legacy', childPath: dir, root: f.root, hostname: HOST,
    pid: process.pid, bootId: BOOT, createdAt: Date.now(),
  };
  const verdict = classifyOwnership(legacy as never, dir);
  assert.equal(verdict.state, STATE.UNKNOWN);
  assert.match(verdict.reason, /start-time/);
});

test('O10. an unparseable or oversized sidecar file reads as no record at all', () => {
  const f = fixture();
  const dir = f.add('run-bad', undefined);
  const path = join(f.root, COMPONENT, '.runs', 'run-bad.json');
  for (const text of ['{ not json', '', 'null', '[]', '"x"', `{"pad":"${'x'.repeat(70000)}"}`]) {
    writeFileSync(path, text);
    assert.equal(readSidecar(path), undefined, JSON.stringify(text.slice(0, 12)));
    assert.equal(stateOf(readSidecar(path), dir), STATE.UNKNOWN);
  }
});

test('O11. a record naming another host, another directory, or another path is UNKNOWN', () => {
  const f = fixture();
  const dir = f.add('run-foreign', undefined);
  const base = recordFor('run-foreign', dir, f.root);
  assert.equal(stateOf({ ...base, hostname: 'somewhere-else' }, dir), STATE.UNKNOWN);
  assert.equal(stateOf({ ...base, runId: 'a-different-run' }, dir), STATE.UNKNOWN);
  assert.equal(stateOf({ ...base, childPath: '/elsewhere' }, dir), STATE.UNKNOWN);
});

test('O12. a wrong unit is UNKNOWN, not LIVE', () => {
  const f = fixture();
  const dir = f.add('run-unit', undefined);
  const base = recordFor('run-unit', dir, f.root);
  for (const unit of ['lab-nonexistent.service', 'sshd.service', 'not-a-unit', '']) {
    assert.notEqual(stateOf({ ...base, unit }, dir), STATE.LIVE, unit);
    assert.notEqual(stateOf({ ...base, unit }, dir), STATE.DEAD, unit);
  }
  assert.equal(LAB_UNIT.test('lab-ptah.service'), true);
  assert.equal(LAB_UNIT.test('sshd.service'), false);
});

test('O13. a symlinked run directory or sidecar is UNKNOWN', () => {
  const f = fixture();
  const real = f.add('run-real', undefined);
  const link = join(f.root, COMPONENT, 'run-link');
  symlinkSync(real, link);
  assert.equal(stateOf(recordFor('run-link', link, f.root), link), STATE.UNKNOWN);

  // A symlinked sidecar reads through, but the record it yields still has to agree with the
  // directory it claims — and here it does not.
  const other = f.add('run-other', recordFor('run-other', join(f.root, COMPONENT, 'run-other'), f.root));
  const sidecarLink = join(f.root, COMPONENT, '.runs', 'run-real.json');
  symlinkSync(join(f.root, COMPONENT, '.runs', 'run-other.json'), sidecarLink);
  assert.equal(classifyOwnership(readSidecar(sidecarLink) as never, real).state, STATE.UNKNOWN);
  void other;
});

test('O14. a directory owned by another uid is UNKNOWN', () => {
  const f = fixture();
  const dir = f.add('run-uid', undefined);
  const record = recordFor('run-uid', dir, f.root);
  assert.notEqual(classifyOwnership(record as never, dir, { uid: 999999 }).state, STATE.LIVE);
  assert.notEqual(classifyOwnership(record as never, dir, { uid: 999999 }).state, STATE.DEAD);
});

test('O15. an unreadable boot id makes everything UNKNOWN rather than DEAD', () => {
  const f = fixture();
  const dir = f.add('run-noboot', undefined);
  const record = recordFor('run-noboot', dir, f.root);
  const verdict = classifyOwnership(record as never, dir, { bootId: undefined });
  assert.equal(verdict.state, STATE.UNKNOWN);
});

test('O16. mutation during inspection cannot turn UNKNOWN into DEAD', () => {
  const f = fixture();
  const dir = f.add('run-mutate', undefined);
  const record = recordFor('run-mutate', dir, f.root);
  assert.notEqual(stateOf(record, dir), STATE.DEAD);
  rmSync(dir, { recursive: true, force: true }); // the directory vanishes mid-flight
  assert.notEqual(stateOf(record, dir), STATE.DEAD, 'a vanished directory is not proof its owner died');
});

// ------------------------------------------------------------------ the reaper, against fixtures only

test('O17. dry-run classification names exactly the dead, and nothing else', () => {
  const f = fixture();
  const live = f.add('run-live', undefined);
  writeFileSync(join(f.root, COMPONENT, '.runs', 'run-live.json'),
    `${JSON.stringify(recordFor('run-live', live, f.root), null, 2)}\n`, { mode: 0o600 });
  const deadDir = f.add('run-dead', {
    ...recordFor('run-dead', join(f.root, COMPONENT, 'run-dead'), f.root),
    bootId: '00000000-0000-0000-0000-000000000000',
  });
  f.add('run-unknown', undefined);

  const verdicts = classifyComponent(f.root, COMPONENT);
  const byId = Object.fromEntries(verdicts.map((v) => [v.runId, v.state]));
  assert.equal(byId['run-dead'], STATE.DEAD);
  assert.equal(byId['run-unknown'], STATE.UNKNOWN);
  assert.notEqual(byId['run-live'], STATE.DEAD);
  assert.deepEqual(residueOf(verdicts).map((v) => v.runId), ['run-dead']);
  // Nothing was removed by classifying.
  assert.equal(readdirSync(join(f.root, COMPONENT)).includes('run-dead'), true);
  void deadDir;
});

test('O18. real deletion removes the dead fixture and leaves live and unknown ones alone', async () => {
  const f = fixture();
  const live = f.add('run-live', undefined);
  writeFileSync(join(f.root, COMPONENT, '.runs', 'run-live.json'),
    `${JSON.stringify(recordFor('run-live', live, f.root), null, 2)}\n`, { mode: 0o600 });
  f.add('run-dead', {
    ...recordFor('run-dead', join(f.root, COMPONENT, 'run-dead'), f.root),
    bootId: '00000000-0000-0000-0000-000000000000',
  });
  f.add('run-unknown', undefined);
  writeFileSync(join(f.root, COMPONENT, 'run-unknown', 'keep-me'), 'x');

  const authority = await import('../../scripts/trio/governed-temp-authority.mjs');
  writeFileSync(join(f.root, '.pehverse-temp-root.json'),
    `${JSON.stringify({ marker: 'pehverse-governed-temp-root', version: 1 }, null, 2)}\n`);
  chmodSync(f.root, 0o700);
  const reaped = (authority as { reapDisprovenRuns: (e: NodeJS.ProcessEnv) => string[] })
    .reapDisprovenRuns({ ...process.env, PEHVERSE_TEMP_ROOT: f.root });

  assert.deepEqual(reaped, ['run-dead']);
  const remaining = readdirSync(join(f.root, COMPONENT)).filter((n) => n !== '.runs').sort();
  assert.deepEqual(remaining, ['run-live', 'run-unknown']);
  assert.equal(readFileSync(join(f.root, COMPONENT, 'run-unknown', 'keep-me'), 'utf8'), 'x');
});

test('O19. no live service directory is deleted, proven against the production root', () => {
  // Classification only. The three live runs must survive, and be named, without any removal.
  const root = process.env['PEHVERSE_TEMP_ROOT'] ?? '';
  const before = readdirSync(join(root, COMPONENT)).sort();
  const verdicts = classifyComponent(root, COMPONENT);
  assert.deepEqual(residueOf(verdicts), []);
  const after = readdirSync(join(root, COMPONENT)).sort();
  assert.deepEqual(after, before, 'classifying the production root must change nothing');
});

test('O20. the sidecar the authority writes now carries the evidence liveness needs', () => {
  const facts = ownershipFacts(process.pid);
  assert.equal(facts.ownershipSchemaVersion, 1);
  assert.equal(facts.pid, process.pid);
  assert.equal(typeof facts.processStartTicks, 'number');
  assert.equal(typeof facts.bootId, 'string');
  const source = readFileSync(
    new URL('../../scripts/trio/governed-temp-authority.mjs', import.meta.url), 'utf8');
  assert.match(source, /ownershipFacts\(process\.pid\)/, 'the writer must record the facts');
  assert.match(source, /renameSync/, 'the sidecar must be written atomically');
});

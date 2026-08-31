/**
 * LAB SHELL tests — no real SSH: a fake LabRunner records the (host, remoteCommand) and returns a
 * scripted outcome, so we assert the read-only allowlist, cwd confinement, and wrapper construction.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createLabShellToolHandlers,
  labShellToolSpecs,
  labShellToolNames,
  validateLabCommand,
  validateLabCwd,
  labSshHost,
  labRoot,
  type LabRunner,
  type LabRunResult,
} from './lab-shell-tools.js';
import { createFullToolRegistry } from './index.js';
import { agentToolNames } from '../../profile.js';
import type { ToolContext } from '../tools.js';
import { governedMkdtemp } from '../temp-authority.js';

const ctx: ToolContext = { workspaceRoot: governedMkdtemp('shell-ws-'), labStoreRoot: governedMkdtemp('shell-store-'), store: {} };
const ROOT = '/pehverse/repos';

function fakeRunner(outcome: Partial<LabRunResult> = {}): { run: LabRunner; calls: Array<{ host: string; cmd: string }> } {
  const calls: Array<{ host: string; cmd: string }> = [];
  const run: LabRunner = (host, cmd) => {
    calls.push({ host, cmd });
    return { code: 0, stdout: 'ok', stderr: '', ...outcome };
  };
  return { run, calls };
}
const opts = (run: LabRunner) => ({ run, host: () => 'zen@lab', root: () => ROOT });

test('spec registered + on the allowlist', () => {
  assert.equal(labShellToolSpecs.length, 1);
  assert.ok(labShellToolNames.has('lab_shell'));
  assert.ok(agentToolNames.includes('lab_shell'));
  const names = new Set(createFullToolRegistry({ workspaceRoot: governedMkdtemp('shell-reg-ws-'), agentServerUrl: 'http://127.0.0.1:0', agentId: 'test-agent' }).map((t) => t.spec.name));
  assert.ok(names.has('lab_shell'));
});

test('validateLabCommand accepts read-only commands', () => {
  for (const c of ['ls -la', 'git log --oneline -20', 'grep -rn TODO src', "find . -name '*.ts'", 'cat README.md', 'git diff HEAD~1']) {
    assert.equal(validateLabCommand(c).ok, true, c);
  }
});

test('validateLabCommand rejects metacharacters (no chaining/redirect/substitution)', () => {
  for (const c of ['ls; rm -rf /', 'cat x | sh', 'echo hi > /etc/passwd', 'echo `whoami`', 'cat $(ls)', 'ls & sleep 1']) {
    const r = validateLabCommand(c);
    assert.equal(r.ok, false, c);
  }
});

test('pipes between read-only stages are allowed; a non-read stage is rejected', () => {
  assert.equal(validateLabCommand('grep -rn foo src | wc -l').ok, true);
  assert.equal(validateLabCommand("find . -name '*.ts' | wc -l").ok, true);
  assert.equal(validateLabCommand('git log --oneline | head -20').ok, true);
  assert.equal(validateLabCommand('cat x | sh').ok, false); // sh not allowed
  assert.equal(validateLabCommand('ls | tee out.txt').ok, false); // tee not allowed
  assert.equal(validateLabCommand('ls ||').ok, false); // empty stage
});

test('validateLabCommand rejects non-allowed binaries and writing git/find', () => {
  assert.equal(validateLabCommand('rm -rf /').ok, false);
  assert.equal(validateLabCommand('python evil.py').ok, false);
  assert.equal(validateLabCommand('git push origin main').ok, false);
  assert.equal(validateLabCommand('git commit -m x').ok, false);
  assert.equal(validateLabCommand('git checkout main').ok, false);
  assert.equal(validateLabCommand('find . -delete').ok, false);
  assert.equal(validateLabCommand('find . -name x -exec rm {} ;').ok, false); // also caught by metachars, doubly safe
});

test('validateLabCwd confines to the lab root', () => {
  assert.equal((validateLabCwd('/pehverse/repos/ecosystem/pehlichi', ROOT) as { ok: true }).ok, true);
  assert.equal(validateLabCwd('/etc', ROOT).ok, false);
  assert.equal(validateLabCwd('/pehverse/repos/../secret', ROOT).ok, false);
  assert.equal(validateLabCwd('relative/path', ROOT).ok, false);
  assert.equal(validateLabCwd("/pehverse/repos/'; rm -rf", ROOT).ok, false);
});

test('handler refuses when LAB_SSH_HOST is not configured', async () => {
  const { run } = fakeRunner();
  const h = createLabShellToolHandlers({ run, host: () => undefined, root: () => ROOT });
  const res = await h.get('lab_shell')!({ command: 'ls' }, ctx);
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /not configured/i);
});

test('handler runs a valid command, building the confined cd+command wrapper', async () => {
  const { run, calls } = fakeRunner({ stdout: 'README.md\nsrc' });
  const h = createLabShellToolHandlers(opts(run));
  const res = await h.get('lab_shell')!({ command: 'ls', cwd: '/pehverse/repos/ecosystem/pehlichi' }, ctx);
  assert.equal(res.ok, true);
  assert.match(res.output, /README/);
  assert.equal(calls[0]!.host, 'zen@lab');
  assert.equal(calls[0]!.cmd, "cd '/pehverse/repos/ecosystem/pehlichi' && ls");
});

test('handler defaults cwd to the lab root and rejects a bad command before running', async () => {
  const { run, calls } = fakeRunner();
  const h = createLabShellToolHandlers(opts(run));
  await h.get('lab_shell')!({ command: 'git log' }, ctx);
  assert.equal(calls[0]!.cmd, `cd '${ROOT}' && git log`);

  const bad = await h.get('lab_shell')!({ command: 'rm -rf /' }, ctx);
  assert.equal(bad.ok, false);
  assert.equal(calls.length, 1, 'nothing runs for a rejected command');
});

test('a spawn failure (ssh not found) fails cleanly', async () => {
  const { run } = fakeRunner({ code: -1, error: 'ssh not found on PATH' });
  const h = createLabShellToolHandlers(opts(run));
  const res = await h.get('lab_shell')!({ command: 'ls' }, ctx);
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /ssh not found/);
});

test('env resolvers read LAB_SSH_HOST / LAB_SHELL_ROOT', () => {
  assert.equal(labSshHost({}), undefined);
  assert.equal(labSshHost({ LAB_SSH_HOST: 'a@b' }), 'a@b');
  assert.equal(labRoot({}), '/pehverse/repos');
  assert.equal(labRoot({ LAB_SHELL_ROOT: '/x/y/' }), '/x/y');
});

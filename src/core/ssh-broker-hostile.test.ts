/**
 * SSH BROKER — hostile suite.
 *
 * The previous rule was "the command is named ssh, therefore network and no syscall filter". An
 * independent re-audit put a private executable named `ssh` earlier in PATH and the production path
 * ran it under that exempt policy. These cases exist so that specific failure, and the family it
 * belongs to, cannot come back.
 *
 * Byte-identical across the Trio, like everything else in `src/core/`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { classifyCommandRisk } from './containment/risk.js';
import { planFor, sshBrokerPolicy } from './containment/policy.js';
import { containmentConfig } from './containment/policy.js';
import {
  SSH_EXECUTABLE,
  SSH_FIXED_OPTIONS,
  buildSshArgv,
  checkSshExecutable,
  checkSshRequest,
  sshEnvironment,
} from './containment/ssh-broker.js';
import { wrap } from './containment/wrap.js';
import { governedMkdtemp } from './temp-authority.js';
import { runLabRead, validateLabCommand } from './agent-tools/lab-shell-tools.js';

const here = dirname(fileURLToPath(import.meta.url));
const ok = { host: 'zen@lab', directory: '/pehverse/repos', command: 'ls -la' } as const;

// ------------------------------------------------------------------ the exception is gone

test('S1. no command name buys the network or an unfiltered sandbox any more', () => {
  for (const name of ['ssh', 'scp', 'sftp', 'curl', 'wget', '/usr/bin/ssh']) {
    const risk = classifyCommandRisk(name, ['host']);
    assert.equal(risk.needsNetwork, false, `${name} must not classify as needing the network`);
    assert.notEqual(risk.kind, 'network-client', name);
  }
});

test('S2. every policy planFor can produce denies unix sockets', () => {
  const config = containmentConfig({ writableWorkspaces: ['/pehverse/worktrees'] });
  const available = { available: true, tool: 'bwrap' as const, version: 'stub' };
  for (const [command, args] of [['ssh', ['h']], ['node', ['x']], ['pnpm', ['install']], ['hostname', []]] as const) {
    const d = planFor({ command, args: [...args], writableRoot: '/pehverse/worktrees' }, config, available);
    if (d.allowed) assert.equal(d.policy.denyUnixSockets, true, `${command} must keep the filter`);
  }
});

test('S3. the broker operation itself keeps the filter and is not reachable by naming anything', () => {
  const decision = sshBrokerPolicy({ writableRoot: '/pehverse/worktrees' },
    { available: true, tool: 'bwrap', version: 'stub' });
  assert.equal(decision.allowed, true);
  assert.equal(decision.allowed === true && decision.policy.networkAllowed, true);
  assert.equal(decision.allowed === true && decision.policy.denyUnixSockets, true);

  // And nothing in planFor produces a networked policy for a name.
  const config = containmentConfig({ writableWorkspaces: ['/pehverse/worktrees'] });
  const named = planFor({ command: 'ssh', args: ['h'], writableRoot: '/pehverse/worktrees' }, config,
    { available: true, tool: 'bwrap', version: 'stub' });
  assert.equal(named.allowed === true && named.policy.networkAllowed, false);
});

test('S4. the broker refuses when containment is unavailable, with no fallback', () => {
  const decision = sshBrokerPolicy({ writableRoot: '/pehverse/worktrees' },
    { available: false, reason: 'stubbed' });
  assert.equal(decision.allowed, false);
  assert.equal(decision.allowed === false && decision.denial.code, 'CONTAINMENT_UNAVAILABLE');
});

// ------------------------------------------------------------------ executable resolution

test('S5. the executable is an absolute constant, never resolved through PATH', () => {
  assert.equal(SSH_EXECUTABLE, '/usr/bin/ssh');
  const source = readFileSync(join(here, 'agent-tools', 'lab-shell-tools.ts'), 'utf8');
  // Comments explain that PATH is not used; the assertion is about CODE, so they are stripped
  // first — exactly as the lab's other content scanners do.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  assert.equal(/\bPATH\b/.test(code), false, 'the runner code must not consult PATH');
  assert.equal(/spawnSync\(\s*['"]ssh['"]/.test(source), false, 'the bare name must never be spawned');
  assert.match(source, /checkSshExecutable\(\)/);
});

test('S6. a substituted ssh earlier in PATH is not what runs', () => {
  const fake = governedMkdtemp('ssh-path-');
  const marker = join(fake, 'marker');
  writeFileSync(join(fake, 'ssh'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = `${fake}:${previous ?? ''}`;
  try {
    // The reviewed client is what the broker names; a hostile PATH cannot change that. The call may
    // fail for environmental reasons, but the marker must never appear.
    runLabRead(ok);
  } catch { /* an environmental failure is not the assertion */ } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
  }
  assert.throws(() => readFileSync(marker, 'utf8'), 'a PATH-substituted ssh was executed');
});

test('S7. a symlinked, non-root or writable executable is refused', () => {
  const dir = governedMkdtemp('ssh-exe-');
  const real = join(dir, 'real');
  writeFileSync(real, '#!/bin/sh\n', { mode: 0o755 });
  const link = join(dir, 'link');
  symlinkSync(real, link);
  assert.equal(checkSshExecutable(link).ok, false, 'a symlink must be refused as a symlink');
  assert.equal(checkSshExecutable(real).ok, false, 'a non-root executable must be refused');
  assert.equal(checkSshExecutable(join(dir, 'absent')).ok, false, 'an absent executable must be refused');
  chmodSync(real, 0o777);
  assert.equal(checkSshExecutable(real).ok, false, 'a world-writable executable must be refused');
  assert.equal(checkSshExecutable().ok, true, 'the reviewed executable must pass');
});

// ------------------------------------------------------------------ the closed request schema

test('S8. every dangerous option is refused in joined, split, equals, abbreviated and lookalike form', () => {
  const forms = [
    'ProxyCommand=/bin/sh', '-oProxyCommand=x', '-o ProxyCommand=x', 'proxycommand', 'PROXYCOMMAND',
    'Pro​xyCommand', 'ＰroxyCommand', 'LocalCommand=x', 'PermitLocalCommand=yes',
    'KnownHostsCommand=x', 'PKCS11Provider=/x.so', 'SecurityKeyProvider=/x.so', 'ProxyUseFdpass=yes',
    'ControlMaster=auto', 'ControlPath=/var/run/x', 'IdentityAgent=/x.sock', 'ForwardAgent=yes',
    'RemoteForward=1', 'LocalForward=1', 'DynamicForward=1', 'Tunnel=yes', 'Include /x',
    'Match exec "/bin/sh"', 'RequestTTY=force', 'RemoteCommand=/bin/sh', 'Subsystem=sftp',
    'ProxyJump=other', 'SetEnv=X=1', 'SendEnv=X',
  ];
  for (const form of forms) {
    for (const field of ['host', 'directory', 'command'] as const) {
      const request = { ...ok, [field]: field === 'directory' ? `/pehverse/${form}` : form };
      assert.equal(checkSshRequest(request).ok, false, `${field}=${JSON.stringify(form)} must be refused`);
    }
  }
});

test('S9. shell metacharacters are refused in every field', () => {
  const nasty = ["a;b", "a|b", "a&b", "a`b`", "a$(b)", "a>b", "a<b", "a\nb", "a'b", 'a"b', 'a\\b', 'a\tb'];
  for (const value of nasty) {
    for (const field of ['host', 'directory', 'command'] as const) {
      assert.equal(checkSshRequest({ ...ok, [field]: value }).ok, false,
        `${field}=${JSON.stringify(value)} must be refused`);
    }
  }
});

test('S10. a second destination, a relative directory, or traversal is refused', () => {
  assert.equal(checkSshRequest({ ...ok, host: 'a b' }).ok, false);
  assert.equal(checkSshRequest({ ...ok, host: 'ssh://x' }).ok, false);
  assert.equal(checkSshRequest({ ...ok, host: 'x:22' }).ok, false);
  assert.equal(checkSshRequest({ ...ok, directory: 'repos' }).ok, false);
  assert.equal(checkSshRequest({ ...ok, directory: '/pehverse/../etc' }).ok, false);
  assert.equal(checkSshRequest(ok).ok, true, 'the one permitted shape must still pass');
});

test('S11. the argv is built by the broker and carries no caller fragment as an option', () => {
  const argv = buildSshArgv(ok);
  const terminator = argv.indexOf('--');
  assert.ok(terminator > 0, 'the option list must be terminated');
  assert.deepEqual(argv.slice(0, terminator), [...SSH_FIXED_OPTIONS]);
  assert.deepEqual(argv.slice(terminator), ['--', 'zen@lab', "cd '/pehverse/repos' && ls -la"]);
  for (const dangerous of ['ProxyCommand=none', 'PermitLocalCommand=no', 'IdentityAgent=none', 'ControlMaster=no']) {
    assert.ok(argv.includes(dangerous), `${dangerous} must be pinned on the command line`);
  }
  assert.ok(argv.includes('-F') && argv.includes('/dev/null'), 'user configuration must be replaced');
});

test('S12. the environment is an allowlist with no ssh, loader, shell or agent variables', () => {
  const env = sshEnvironment('/home/zen');
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH']);
  assert.equal(env.PATH, '/usr/bin');
  for (const forbidden of ['SSH_AUTH_SOCK', 'SSH_ASKPASS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'BASH_ENV', 'ENV', 'IFS']) {
    assert.equal(forbidden in env, false, `${forbidden} must not be forwarded`);
  }
});

// ------------------------------------------------------------------ live behaviour

test('S13. a ProxyCommand marker cannot be produced through the broker', () => {
  const dir = governedMkdtemp('ssh-proxy-');
  const marker = join(dir, 'proxy-marker');
  // Every shape that would carry it is refused before anything is spawned.
  for (const attempt of [
    { ...ok, command: `ProxyCommand=/bin/sh -c 'touch ${marker}'` },
    { ...ok, host: `-oProxyCommand=touch` },
    { ...ok, directory: `/pehverse/-oProxyCommand=touch` },
  ]) {
    assert.equal(checkSshRequest(attempt).ok, false);
  }
  assert.throws(() => readFileSync(marker, 'utf8'));
});

test('S14. the broker cannot reach a host unix socket', async () => {
  const dir = governedMkdtemp('ssh-sock-');
  const socketPath = join(dir, 'host.sock');
  const server = createServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  try {
    // The broker's policy denies AF_UNIX, so a program run under it cannot connect at all. Proven
    // against the policy the broker actually uses, not a reconstruction of it.
    const decision = sshBrokerPolicy({ writableRoot: dir, tempRoot: dir });
    if (!decision.allowed) return; // no containment backend here; S4 covers the refusal path
    assert.equal(decision.policy.denyUnixSockets, true);

    const probe = join(dir, 'probe.mjs');
    writeFileSync(probe, `
      import net from 'node:net';
      const c = net.connect(${JSON.stringify(socketPath)});
      c.on('connect', () => { console.log('connected'); process.exit(0); });
      c.on('error', (e) => { console.log(e.code); process.exit(0); });
    `);
    const contained = wrap(decision, process.execPath, [probe]);
    let out = '';
    try {
      const r = spawnSync(contained.binary, [...contained.args], {
        encoding: 'utf8', timeout: 25_000, stdio: [...contained.stdio] as never,
        env: { PATH: '/usr/bin', HOME: dir, LANG: 'C.UTF-8' },
      });
      out = (r.stdout ?? '').trim();
    } finally {
      contained.dispose();
    }
    assert.match(out, /EACCES|EAFNOSUPPORT/, `the broker policy reached a host unix socket: ${out}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('S15. an arbitrary local child cannot be started through the lab_shell path', () => {
  const dir = governedMkdtemp('ssh-child-');
  const marker = join(dir, 'child-marker');
  mkdirSync(join(dir, 'bin'), { recursive: true });
  const payload = join(dir, 'bin', 'payload');
  writeFileSync(payload, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  for (const attempt of [
    { ...ok, command: payload },
    { ...ok, command: `sh -c ${payload}` },
    { ...ok, host: payload },
  ]) {
    const shaped = checkSshRequest(attempt);
    if (shaped.ok) {
      // A shape that survives the schema must still be refused by the read-only command allowlist.
      assert.equal(validateLabCommand(attempt.command).ok, false, `${attempt.command} must not be an allowed command`);
    }
  }
  assert.throws(() => readFileSync(marker, 'utf8'), 'an arbitrary local child was started');
});

test('S16. the remote command allowlist still refuses everything outside read-only work', () => {
  for (const bad of ['rm -rf /', 'sh -c x', 'curl http://x', 'git push', 'find . -delete', 'python3 -c 1']) {
    assert.equal(validateLabCommand(bad).ok, false, bad);
  }
  for (const good of ['ls -la', 'git log --oneline -20', 'grep -rn TODO src', 'cat README.md']) {
    assert.equal(validateLabCommand(good).ok, true, good);
  }
});

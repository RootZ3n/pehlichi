/**
 * RESTART-READINESS PREFLIGHT — non-authoritative, and deliberately powerless.
 *
 * A stale root-owned identity record took Ptah down. Every commit that touched `package.json`
 * invalidated the record's `package.sha256`, the running service kept serving because tsx loads
 * source once at startup, and the breakage stayed invisible until the next restart. Three services
 * were latently un-restartable for hours and nothing said so.
 *
 * This says so. It recomputes the same bindings the startup gate will check and reports whether a
 * restart would survive. What it must never become is a second way to be admitted, so:
 *
 *   - it GRANTS NOTHING. It returns a report, not a decision, and no caller can turn its output
 *     into an admission;
 *   - it REFRESHES NOTHING. It cannot write a record, cannot re-derive a digest into one, and
 *     cannot make a stale binding fresh. A drift it finds is a drift an operator must fix;
 *   - it is NOT the gate. The startup gate still runs and still decides. This runs before a
 *     restart so the answer is known while the service is still up.
 *
 * Exit status is the machine-readable answer: 0 restart-ready, 1 NOT restart-ready, 2 the preflight
 * itself could not determine an answer -- which is also not readiness.
 *
 * usage: node restart-readiness.mjs [--json] [--repo <path>] [--credentials <dir>]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
const REPO = flag('--repo') ?? join(HERE, '..', '..');
const CREDS = flag('--credentials') ?? process.env.CREDENTIALS_DIRECTORY;
const JSON_OUT = argv.includes('--json');

const BOUND = { package: 'package.json', capsule: 'capsule/agent.json', deployment: 'deployment/agent.env.json' };
const CLOSURE_FILES = [
  'src/core/loop.ts', 'src/core/operational-admission.ts',
  'src/core/ordinary-admission.ts', 'src/core/qualification-admission.ts',
];
const POLICY_PATH = 'trio/governance/boundary-manifest.json';

const fileDigest = (p) => `sha256:${createHash('sha256').update(readFileSync(p)).digest('hex')}`;
const partsDigest = (parts) => {
  const h = createHash('sha256');
  for (const p of parts) { h.update(p); h.update('\0'); }
  return `sha256:${h.digest('hex')}`;
};

const findings = [];
const note = (check, ready, detail) => findings.push({ check, ready, detail });

let git;
try {
  git = (args) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' }).trim();
  git(['rev-parse', 'HEAD']);
} catch (error) {
  note('repository readable', false, String(error?.message ?? error).slice(0, 120));
}

// ── deployment identity: the exact condition that took Ptah down ────────────────────────────
let identity;
if (CREDS === undefined || CREDS.length === 0) {
  note('identity credential channel', false, 'no CREDENTIALS_DIRECTORY; cannot compare the record');
} else {
  try {
    identity = JSON.parse(readFileSync(join(CREDS, 'agent-identity'), 'utf8'));
  } catch (error) {
    note('identity record readable', false, String(error?.message ?? error).slice(0, 120));
  }
}
if (identity !== undefined) {
  for (const [key, rel] of Object.entries(BOUND)) {
    let actual;
    try { actual = fileDigest(join(REPO, rel)); } catch { actual = undefined; }
    const declared = identity[key]?.sha256;
    note(`identity.${key} digest`, actual !== undefined && actual === declared,
      actual === declared ? 'matches' : `${rel} drifted from the authorised digest`);
  }
}

// ── ordinary authorization: commit, tree, policy and closure ────────────────────────────────
let lease;
if (CREDS !== undefined && CREDS.length > 0) {
  try {
    lease = JSON.parse(readFileSync(join(CREDS, 'ordinary-authorization'), 'utf8'));
  } catch {
    note('ordinary authorization present', false,
      'absent or unreadable; ordinary work will refuse after restart (identity may still be fine)');
  }
}
if (lease !== undefined && git !== undefined) {
  const commit = git(['rev-parse', 'HEAD']);
  const tree = git(['rev-parse', 'HEAD^{tree}']);
  const dirty = git(['status', '--porcelain']);
  note('lease.subject.commit', lease.subject?.commit === commit,
    lease.subject?.commit === commit ? 'matches' : 'the lease names a different commit');
  note('lease.subject.tree', lease.subject?.tree === tree,
    lease.subject?.tree === tree ? 'matches' : 'the lease names a different tree');
  note('working tree clean', dirty === '', dirty === '' ? 'clean' : `${dirty.split('\n').length} modified paths`);
  let policy;
  let closure;
  try {
    policy = partsDigest([POLICY_PATH, readFileSync(join(REPO, POLICY_PATH), 'utf8')]);
    closure = partsDigest([...CLOSURE_FILES].sort().flatMap((rel) => [rel, readFileSync(join(REPO, rel), 'utf8')]));
  } catch { /* reported below as a mismatch */ }
  note('lease.policySha256', policy !== undefined && lease.policySha256 === policy,
    lease.policySha256 === policy ? 'matches' : 'the governance manifest drifted from the lease');
  note('lease.closureSha256', closure !== undefined && lease.closureSha256 === closure,
    lease.closureSha256 === closure ? 'matches' : 'the executing closure drifted from the lease');
  const now = Date.now();
  note('lease validity window', Number.isFinite(Date.parse(lease.expiresAt)) && now < Date.parse(lease.expiresAt),
    `expires ${String(lease.expiresAt).slice(0, 19)}`);
}

const blocking = findings.filter((f) => !f.ready);
const determinable = findings.length > 0;
const ready = determinable && blocking.length === 0;
const status = !determinable ? 'INDETERMINATE' : ready ? 'RESTART_READY' : 'NOT_RESTART_READY';

if (JSON_OUT) {
  process.stdout.write(`${JSON.stringify({ status, ready, repo: REPO, findings }, null, 1)}\n`);
} else {
  process.stdout.write(`restart-readiness: ${status}\n`);
  for (const f of findings) process.stdout.write(`  ${f.ready ? 'ok  ' : 'DRIFT'} ${f.check.padEnd(28)} ${f.detail}\n`);
  if (!ready && determinable) {
    process.stdout.write('\n  A restart would be refused by the startup gate. This preflight cannot fix that:\n');
    process.stdout.write('  it reports drift and grants nothing. An operator must reconcile the root-owned record.\n');
  }
}
process.exitCode = !determinable ? 2 : ready ? 0 : 1;

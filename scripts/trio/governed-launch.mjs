#!/usr/bin/env node
/**
 * GOVERNED LAUNCH WRAPPER — establishes governed temporary storage BEFORE Node/tsx loads.
 *
 * tsx (4.22.4) initializes its FileCache from os.tmpdir() at module-init time, before any
 * `--import` hook runs. An in-process bootstrap is structurally too late. This wrapper
 * resolves and validates PEHVERSE_TEMP_ROOT, creates a unique private run directory, exports
 * TMPDIR/TMP/TEMP/PEHVERSE_TEMP_ROOT, then spawns the child command with those variables
 * in the environment so tsx (and every other module) sees the governed root from the first
 * line of code.
 *
 * Usage: node scripts/trio/governed-launch.mjs <component> -- <command> [args...]
 *
 * Components: trio-agent, trio-test
 *
 * Part of the byte-identical Trio shared core.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ─── Constants (must match src/core/temp-authority.ts) ────────────────────────

const TEMP_ROOT_ENV = 'PEHVERSE_TEMP_ROOT';
const TEMP_RUN_ID_ENV = 'PEHVERSE_TEMP_RUN_ID';
const TEMP_COMPONENT_ENV = 'PEHVERSE_TEMP_COMPONENT';
const ROOT_MARKER_NAME = '.pehverse-temp-root.json';
const ROOT_MARKER = 'pehverse-governed-temp-root';
const CHILD_MARKER = 'pehverse-governed-temp-child';
const MARKER_VERSION = 1;
const RECORDS_DIRNAME = '.runs';
const FORBIDDEN_TMP = '/tmp';
const TMPFS_MAGIC = 0x01021994;
const MIN_FREE_BYTES = 512 * 1024 * 1024;
const ALLOWED_COMPONENTS = ['trio-agent', 'trio-test'];

// ─── Error type ───────────────────────────────────────────────────────────────

class GovernedLaunchError extends Error {
  constructor(code, detail) {
    super(`governed launch failed [${code}]: ${detail}. The lab never falls back to /tmp. Set ${TEMP_ROOT_ENV} to an absolute lab-owned directory on persistent disk, outside /tmp, not a symlink, owner-only writable.`);
    this.name = 'GovernedLaunchError';
    this.code = code;
  }
}

// ─── Path safety (matches temp-authority.ts / governed-temp.mjs) ──────────────

const isUnder = (child, parent) =>
  child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

function symlinkComponentOf(candidate) {
  const parts = candidate.split(path.sep).filter((p) => p.length > 0);
  let current = path.sep;
  for (const part of parts) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) return current; } catch { return undefined; }
  }
  return undefined;
}

function realCandidateOf(candidate) {
  try {
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
    return path.join(fs.realpathSync(path.dirname(candidate)), candidate.slice(path.dirname(candidate).length + 1));
  } catch { return candidate; }
}

function refuseTmp(code, candidate) {
  const real = realCandidateOf(candidate);
  if (candidate === FORBIDDEN_TMP || real === FORBIDDEN_TMP)
    throw new GovernedLaunchError(code, `${candidate} is /tmp`);
  if (isUnder(candidate, FORBIDDEN_TMP) || isUnder(real, FORBIDDEN_TMP))
    throw new GovernedLaunchError(code, `${candidate} resolves beneath /tmp`);
}

function markerValid(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, ROOT_MARKER_NAME), 'utf8'));
    return parsed !== null && typeof parsed === 'object' &&
      parsed.marker === ROOT_MARKER && parsed.version === MARKER_VERSION;
  } catch { return false; }
}

// ─── Root validation (matches resolveGovernedTempRoot in temp-authority.ts) ───

function resolveGovernedTempRoot() {
  const raw = process.env[TEMP_ROOT_ENV]?.trim();
  if (raw === undefined || raw.length === 0)
    throw new GovernedLaunchError('root_not_configured', `${TEMP_ROOT_ENV} is not set`);
  if (!path.isAbsolute(raw))
    throw new GovernedLaunchError('root_not_absolute', `${raw} is not absolute`);

  const candidate = path.resolve(raw);
  refuseTmp('root_is_tmp', candidate);

  const link = symlinkComponentOf(candidate);
  if (link !== undefined)
    throw new GovernedLaunchError('root_symlink', `${link} is a symlink`);

  // Refuse a root inside a git worktree — git resolves fixtures upward into the repo.
  for (let current = fs.existsSync(candidate) ? candidate : path.dirname(candidate); ; ) {
    if (fs.existsSync(path.join(current, '.git')))
      throw new GovernedLaunchError('root_inside_git_worktree',
        `${candidate} is inside the git working tree at ${current}`);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  if (!fs.existsSync(candidate)) {
    let probe = path.dirname(candidate);
    while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
    try { fs.accessSync(probe, fs.constants.W_OK); } catch {
      throw new GovernedLaunchError('root_not_creatable', `${candidate} does not exist and ${probe} is not writable`);
    }
    fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
  }

  const stat = fs.statSync(candidate);
  if (!stat.isDirectory())
    throw new GovernedLaunchError('root_not_directory', `${candidate} is not a directory`);

  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid)
    throw new GovernedLaunchError('root_not_owned', `${candidate} is owned by uid ${stat.uid}, not ${uid}`);

  if ((stat.mode & 0o022) !== 0)
    throw new GovernedLaunchError('root_permissive',
      `${candidate} is group/world writable (mode ${(stat.mode & 0o777).toString(8)})`);

  try {
    const info = fs.statfsSync(candidate);
    if (Number(info.type) === TMPFS_MAGIC)
      throw new GovernedLaunchError('root_on_tmpfs', `${candidate} is on tmpfs, not persistent disk`);
    if (Number(info.bavail) * Number(info.bsize) < MIN_FREE_BYTES)
      throw new GovernedLaunchError('root_insufficient_space', `${candidate} is below the free-space floor`);
  } catch (err) { if (err instanceof GovernedLaunchError) throw err; }

  if (!markerValid(candidate)) {
    const entries = fs.readdirSync(candidate).filter((name) => name !== ROOT_MARKER_NAME);
    if (fs.existsSync(path.join(candidate, ROOT_MARKER_NAME)) || entries.length > 0)
      throw new GovernedLaunchError('root_marker_invalid',
        `${candidate} exists without a valid ${ROOT_MARKER_NAME} marker`);
    fs.writeFileSync(
      path.join(candidate, ROOT_MARKER_NAME),
      JSON.stringify({ marker: ROOT_MARKER, version: MARKER_VERSION }, null, 2) + '\n',
      { mode: 0o600, flag: 'wx' }
    );
  }

  const real = fs.realpathSync(candidate);
  refuseTmp('root_is_tmp', real);
  return real;
}

// ─── Run directory creation ───────────────────────────────────────────────────

function createRunDirectory(root, component) {
  const runId = `${component}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  const componentDir = path.join(root, component);
  fs.mkdirSync(componentDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(componentDir, RECORDS_DIRNAME), { recursive: true, mode: 0o700 });
  const dir = path.join(componentDir, runId);
  fs.mkdirSync(dir, { mode: 0o700 }); // non-recursive: EEXIST on collision
  const after = fs.lstatSync(dir);
  const uid = process.getuid?.();
  if (after.isSymbolicLink() || !after.isDirectory() || (uid !== undefined && after.uid !== uid))
    throw new GovernedLaunchError('run_unsafe', `${dir} was substituted before use`);
  const real = fs.realpathSync(dir);
  if (!isUnder(real, root))
    throw new GovernedLaunchError('path_escapes_root', `${dir} resolves outside ${root}`);
  refuseTmp('path_escapes_root', real);
  const recordPath = path.join(componentDir, RECORDS_DIRNAME, `${runId}.json`);
  fs.writeFileSync(recordPath, JSON.stringify({
    marker: CHILD_MARKER, version: MARKER_VERSION, component, runId,
    childPath: dir, root, hostname: os.hostname(), pid: process.pid, createdAt: Date.now()
  }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return { path: dir, runId, root, recordPath };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const separatorIndex = args.indexOf('--');
if (separatorIndex < 1 || separatorIndex >= args.length - 1) {
  process.stderr.write('Usage: node governed-launch.mjs <component> -- <command> [args...]\n');
  process.exit(1);
}

const component = args[0];
if (!ALLOWED_COMPONENTS.includes(component)) {
  process.stderr.write(`Component ${JSON.stringify(component)} is not allowed. Must be one of: ${ALLOWED_COMPONENTS.join(', ')}\n`);
  process.exit(1);
}

const command = args[separatorIndex + 1];
const commandArgs = args.slice(separatorIndex + 2);

// Validate governed root and create run directory
const root = resolveGovernedTempRoot();
const run = createRunDirectory(root, component);

// Build child environment — governed temp vars override anything inherited
const childEnv = { ...process.env };
childEnv.TMPDIR = run.path;
childEnv.TMP = run.path;
childEnv.TEMP = run.path;
childEnv[TEMP_ROOT_ENV] = root;
childEnv[TEMP_COMPONENT_ENV] = component;
childEnv[TEMP_RUN_ID_ENV] = run.runId;

// Spawn the child, inheriting stdio so interactive processes work
const result = spawnSync(command, commandArgs, {
  stdio: 'inherit',
  env: childEnv,
  shell: false
});

// Cleanup: remove run directory and sidecar record
try { fs.rmSync(run.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {}
try { fs.rmSync(run.recordPath, { force: true }); } catch {}

process.exit(result.status ?? 1);

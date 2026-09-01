/**
 * CANONICAL GOVERNED TEMPORARY-STORAGE AUTHORITY — the single validation implementation.
 *
 * This is the ONE place the lab decides where scratch lives. Every other entry point
 * (governed-launch.mjs, governed-npm.mjs, governed-run.mjs, and the TypeScript
 * temp-authority.ts wrapper) delegates here. There is no second implementation.
 *
 * Plain ESM, imports only node:* builtins. No tsx, no npm, no external dependencies.
 * A plain `node` process running this module allocates nothing in /tmp (verified claim 1
 * from Order 14 §0).
 *
 * Part of the byte-identical Trio shared core.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ─── Contract names ──────────────────────────────────────────────────────────

export const TEMP_ROOT_ENV = 'PEHVERSE_TEMP_ROOT';
export const TEMP_RUN_ID_ENV = 'PEHVERSE_TEMP_RUN_ID';
export const TEMP_COMPONENT_ENV = 'PEHVERSE_TEMP_COMPONENT';
export const ROOT_MARKER_NAME = '.pehverse-temp-root.json';
export const ROOT_MARKER = 'pehverse-governed-temp-root';
export const CHILD_MARKER = 'pehverse-governed-temp-child';
export const MARKER_VERSION = 1;
export const RECORDS_DIRNAME = '.runs';
export const ALLOWED_COMPONENTS = Object.freeze(['trio-agent', 'trio-test']);

/** The forbidden system temp directories, named ONLY so they can be refused. */
export const FORBIDDEN_ROOTS = Object.freeze(['/tmp', '/var/tmp']);

/** Linux TMPFS_MAGIC — a root on tmpfs is not persistent disk and is refused. */
const TMPFS_MAGIC = 0x01021994;
export const MIN_FREE_BYTES = 512 * 1024 * 1024;
export const MIN_FREE_INODES = 50_000;

// ─── Error type ──────────────────────────────────────────────────────────────

export class GovernedTempError extends Error {
  constructor(code, detail) {
    super(`governed temporary storage unavailable [${code}]: ${detail}. The lab never falls back to /tmp. Set ${TEMP_ROOT_ENV} to an absolute lab-owned directory on persistent disk, outside /tmp and /var/tmp, not a symlink, owner-only writable.`);
    this.name = 'GovernedTempError';
    this.code = code;
  }
}

// ─── Path safety ─────────────────────────────────────────────────────────────

export function isUnder(child, parent) {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

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

function refuseForbiddenRoots(code, candidate) {
  const real = realCandidateOf(candidate);
  for (const forbidden of FORBIDDEN_ROOTS) {
    if (candidate === forbidden || real === forbidden)
      throw new GovernedTempError(code, `${candidate} is ${forbidden}`);
    if (isUnder(candidate, forbidden) || isUnder(real, forbidden))
      throw new GovernedTempError(code, `${candidate} resolves beneath ${forbidden}`);
  }
}

function markerValid(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, ROOT_MARKER_NAME), 'utf8'));
    return parsed !== null && typeof parsed === 'object' &&
      parsed.marker === ROOT_MARKER && parsed.version === MARKER_VERSION;
  } catch { return false; }
}

function readBootId() {
  try {
    const raw = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return raw.length > 0 ? raw : undefined;
  } catch { return undefined; }
}

// ─── Canonical root validation (§4, 13 ordered checks) ───────────────────────

/**
 * Resolve, validate and (deliberately) create THE governed root.
 *
 * Ordered checks (fail-closed, first failure wins):
 *  1. present and non-blank after trim()
 *  2. path.isAbsolute
 *  3. candidate AND realpathSync result are not /tmp, /var/tmp, nor beneath them
 *  4. no component of the path is a symlink
 *  5. not inside a git worktree
 *  6. exists, or parent writable → create mode 0o700
 *  7. statSync().isDirectory()
 *  8. stat.uid === process.getuid()
 *  9. (stat.mode & 0o077) === 0 — owner-only (tightened from 0o022)
 * 10. statfsSync().type !== TMPFS_MAGIC
 * 11. free bytes ≥ MIN_FREE_BYTES, free inodes ≥ MIN_FREE_INODES
 * 12. valid marker, or empty directory and marker is written
 * 13. re-check 3 against the final realpathSync
 */
export function resolveGovernedTempRoot(env = process.env) {
  // Check 1: present and non-blank
  const raw = env[TEMP_ROOT_ENV]?.trim();
  if (raw === undefined || raw.length === 0)
    throw new GovernedTempError('root_not_configured', `${TEMP_ROOT_ENV} is not set`);

  // Check 2: absolute
  if (!path.isAbsolute(raw))
    throw new GovernedTempError('root_not_absolute', `${raw} is not absolute`);

  const candidate = path.resolve(raw);

  // Check 3: not /tmp, /var/tmp, or beneath them
  refuseForbiddenRoots('root_is_forbidden', candidate);

  // Check 4: no symlink components
  const link = symlinkComponentOf(candidate);
  if (link !== undefined)
    throw new GovernedTempError('root_symlink', `${link} is a symlink`);

  // Check 5: not inside a git worktree
  for (let current = fs.existsSync(candidate) ? candidate : path.dirname(candidate); ; ) {
    if (fs.existsSync(path.join(current, '.git')))
      throw new GovernedTempError('root_inside_git_worktree',
        `${candidate} is inside the git working tree at ${current}`);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // Check 6: exists or create
  if (!fs.existsSync(candidate)) {
    let probe = path.dirname(candidate);
    while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
    try { fs.accessSync(probe, fs.constants.W_OK); } catch {
      throw new GovernedTempError('root_not_creatable', `${candidate} does not exist and ${probe} is not writable`);
    }
    fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
  }

  // Check 7: is a directory
  const stat = fs.statSync(candidate);
  if (!stat.isDirectory())
    throw new GovernedTempError('root_not_directory', `${candidate} is not a directory`);

  // Check 8: owned by this uid
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid)
    throw new GovernedTempError('root_not_owned', `${candidate} is owned by uid ${stat.uid}, not ${uid}`);

  // Check 9: owner-only (0o077 — tightened from 0o022)
  if ((stat.mode & 0o077) !== 0)
    throw new GovernedTempError('root_permissive',
      `${candidate} is group/world accessible (mode ${(stat.mode & 0o777).toString(8)})`);

  // Check 10 + 11: tmpfs and free space
  try {
    const info = fs.statfsSync(candidate);
    if (Number(info.type) === TMPFS_MAGIC)
      throw new GovernedTempError('root_on_tmpfs', `${candidate} is on tmpfs, not persistent disk`);
    if (Number(info.bavail) * Number(info.bsize) < MIN_FREE_BYTES)
      throw new GovernedTempError('root_insufficient_space', `${candidate} is below the free-space floor`);
    if (Number(info.files) > 0 && Number(info.ffree) < MIN_FREE_INODES)
      throw new GovernedTempError('root_insufficient_space', `${candidate} has insufficient free inodes`);
  } catch (err) { if (err instanceof GovernedTempError) throw err; }

  // Check 12: marker validation or stamping
  if (!markerValid(candidate)) {
    const entries = fs.readdirSync(candidate).filter((name) => name !== ROOT_MARKER_NAME);
    if (fs.existsSync(path.join(candidate, ROOT_MARKER_NAME)) || entries.length > 0)
      throw new GovernedTempError('root_marker_invalid',
        `${candidate} exists without a valid ${ROOT_MARKER_NAME} marker`);
    fs.writeFileSync(
      path.join(candidate, ROOT_MARKER_NAME),
      JSON.stringify({ marker: ROOT_MARKER, version: MARKER_VERSION }, null, 2) + '\n',
      { mode: 0o600, flag: 'wx' }
    );
  }

  // Check 13: re-check forbidden roots against final realpath
  const real = fs.realpathSync(candidate);
  refuseForbiddenRoots('root_is_forbidden', real);
  return real;
}

// ─── Run directory lifecycle ─────────────────────────────────────────────────

/**
 * Create one exclusively-owned run directory with its sidecar ownership record.
 * The sidecar includes bootId for identity binding across reboots.
 */
export function createRunDirectory(component, env = process.env) {
  if (!ALLOWED_COMPONENTS.includes(component))
    throw new GovernedTempError('component_not_allowed', `${component} is not an allow-listed component`);

  const root = resolveGovernedTempRoot(env);
  const runId = `${component}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  const componentDir = path.join(root, component);
  fs.mkdirSync(componentDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(componentDir, RECORDS_DIRNAME), { recursive: true, mode: 0o700 });

  const dir = path.join(componentDir, runId);
  fs.mkdirSync(dir, { mode: 0o700 }); // non-recursive: EEXIST on collision

  // Substitution guard
  const after = fs.lstatSync(dir);
  const uid = process.getuid?.();
  if (after.isSymbolicLink() || !after.isDirectory() || (uid !== undefined && after.uid !== uid))
    throw new GovernedTempError('run_unsafe', `${dir} was substituted before use`);
  const real = fs.realpathSync(dir);
  if (!isUnder(real, root))
    throw new GovernedTempError('path_escapes_root', `${dir} resolves outside ${root}`);
  refuseForbiddenRoots('path_escapes_root', real);

  // Sidecar with bootId for identity binding
  const recordPath = path.join(componentDir, RECORDS_DIRNAME, `${runId}.json`);
  fs.writeFileSync(recordPath, JSON.stringify({
    marker: CHILD_MARKER, version: MARKER_VERSION, component, runId,
    childPath: dir, root, hostname: os.hostname(), pid: process.pid,
    bootId: readBootId(), createdAt: Date.now()
  }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });

  return { path: dir, runId, root, recordPath };
}

/**
 * Idempotent cleanup: remove run directory and sidecar record.
 */
export function cleanupRun(run) {
  try { fs.rmSync(run.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {}
  try { fs.rmSync(run.recordPath, { force: true }); } catch {}
}

/**
 * Build the child environment with governed temp variables.
 */
export function buildChildEnv(run, component, env = process.env) {
  const childEnv = { ...env };
  childEnv.TMPDIR = run.path;
  childEnv.TMP = run.path;
  childEnv.TEMP = run.path;
  childEnv.NODE_COMPILE_CACHE = path.join(run.path, 'node-compile-cache');
  childEnv[TEMP_ROOT_ENV] = run.root;
  childEnv[TEMP_COMPONENT_ENV] = component;
  childEnv[TEMP_RUN_ID_ENV] = run.runId;
  return childEnv;
}

/**
 * Assert that this process's temp environment is governed. Used by in-process
 * entry points (temp-authority.ts wrapper) to verify the environment is safe.
 */
export function assertGovernedTempSafety(env = process.env) {
  const root = resolveGovernedTempRoot(env);
  const scratch = env.TMPDIR;
  if (!scratch || !path.isAbsolute(scratch))
    throw new GovernedTempError('run_unsafe', 'TMPDIR is not set or not absolute');
  const realScratch = fs.realpathSync(scratch);
  refuseForbiddenRoots('run_unsafe', realScratch);
  if (!isUnder(realScratch, root))
    throw new GovernedTempError('run_unsafe', `TMPDIR ${scratch} is outside governed root ${root}`);
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) {
    if (env[key] !== scratch)
      throw new GovernedTempError('run_unsafe', `${key} does not match TMPDIR`);
  }
  return { root, scratch };
}

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

import { STATE, classifyComponent, ownershipFacts } from './run-ownership.mjs';
import path from 'node:path';

// ─── Contract names ──────────────────────────────────────────────────────────

export const TEMP_ROOT_ENV = 'PEHVERSE_TEMP_ROOT';
export const TEMP_RUN_ID_ENV = 'PEHVERSE_TEMP_RUN_ID';
export const TEMP_COMPONENT_ENV = 'PEHVERSE_TEMP_COMPONENT';
export const TEMP_RUN_CHAIN_ENV = 'PEHVERSE_TEMP_RUN_CHAIN';
export const ROOT_MARKER_NAME = '.pehverse-temp-root.json';
export const ROOT_MARKER = 'pehverse-governed-temp-root';
export const CHILD_MARKER = 'pehverse-governed-temp-child';
export const MARKER_VERSION = 1;
export const RECORDS_DIRNAME = '.runs';
export const ALLOWED_COMPONENTS = Object.freeze(['trio-agent', 'trio-test']);

/** The declared top-of-chain entry classes. A governed entry says which it is; it is never inferred. */
export const ENTRY_CLASSES = Object.freeze(['service', 'operator']);

/** The shape a governed run id must have before it is used to build a record path. */
const RUN_ID_SHAPE = /^[a-z0-9][a-z0-9-]{0,79}$/;

/** Bound on symlink resolution while canonicalizing, so a link cycle terminates. */
const MAX_LINK_DEPTH = 40;

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

/**
 * Canonicalize a path the way the kernel would resolve it, so that every containment
 * comparison in this module is made against the REAL location and never against a string.
 *
 * Components are resolved left to right: a symlink is expanded before the rest of the path
 * is applied, and `..` is applied to the already-resolved prefix. That ordering is what makes
 * `<root>/link/../escape` and `<root>/../../../../tmp/x` both resolve truthfully, which a
 * lexical `path.resolve` followed by one `realpathSync` does not. Components that do not
 * exist are kept verbatim, so a not-yet-created path still canonicalizes to where it WOULD be.
 */
export function canonicalizePath(candidate, depth = 0) {
  if (depth > MAX_LINK_DEPTH)
    throw new GovernedTempError('path_not_canonicalizable', `${candidate} exceeds the symlink resolution limit`);
  const absolute = path.isAbsolute(candidate) ? candidate : path.join(process.cwd(), candidate);
  let current = path.sep;
  for (const part of absolute.split(path.sep)) {
    if (part.length === 0 || part === '.') continue;
    if (part === '..') { current = path.dirname(current); continue; }
    const next = current === path.sep ? path.sep + part : current + path.sep + part;
    let target;
    try { target = fs.lstatSync(next).isSymbolicLink() ? fs.readlinkSync(next) : undefined; }
    catch { target = undefined; }
    current = target === undefined
      ? next
      : canonicalizePath(path.isAbsolute(target) ? target : current + path.sep + target, depth + 1);
  }
  return current;
}

function refuseForbiddenRoots(code, candidate) {
  const real = canonicalizePath(candidate);
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

  /*
    THE OWNERSHIP SIDECAR, written atomically.

    It carries what it takes to prove the owner is alive later: the boot, the pid, the pid's START
    TIME, and the lab unit the creating process belongs to. A pid on its own proves nothing -- pids
    are reused -- so a reader that has only a pid must answer UNKNOWN, and UNKNOWN is never residue.

    Written to a temporary name and renamed, so a reader never sees a half-written record and then
    concludes something about it. `wx` on the temporary name keeps two runs from colliding, and the
    target is refused if it somehow already exists rather than being silently replaced.
  */
  const recordPath = path.join(componentDir, RECORDS_DIRNAME, `${runId}.json`);
  if (fs.existsSync(recordPath)) throw new GovernedTempError('run_unsafe', `${recordPath} already exists`);
  const pendingPath = `${recordPath}.pending-${process.pid}`;
  const record = {
    marker: CHILD_MARKER, version: MARKER_VERSION, component, runId,
    childPath: dir, root, hostname: os.hostname(),
    ...ownershipFacts(process.pid),
    createdAt: Date.now()
  };
  fs.writeFileSync(pendingPath, JSON.stringify(record, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(pendingPath, recordPath);

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
  // The chain names every governed run that is an ANCESTOR of the child, outermost first.
  // A residue detector needs it: an ancestor's run directory is alive by construction while
  // its descendant scans, and is therefore not residue. Only the chain can tell them apart.
  childEnv[TEMP_RUN_CHAIN_ENV] = [...runChainOf(env), run.runId].join(':');
  return childEnv;
}

/** The governed run ids this process inherited, outermost first. Empty at the top of a chain. */
export function runChainOf(env = process.env) {
  return (env[TEMP_RUN_CHAIN_ENV] ?? '').split(':').filter((id) => id.length > 0);
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

// ─── Entry contracts — what replaces the lifecycle-marker heuristic ──────────
//
// The Order 15 guard asked "did a package manager run ahead of me?" and answered it by
// looking for npm_lifecycle_event / npm_execpath. That question cannot be answered from
// those variables: `pnpm exec` sets neither, blank values read as absent, and any of them
// can be forged. An absent marker was read as "a direct service start", so the whole guard
// could be skipped by removing information.
//
// The replacement never infers. There are exactly two ways to be a governed process, and a
// process must PROVE it is one of them:
//
//   1. Top of chain — the caller DECLARES the entry class (`--entry=service` or
//      `--entry=operator`, and the package-manager entries by construction). Nothing is
//      inferred from what is missing; the declaration is explicit and visible in the unit
//      file or the command line.
//   2. Governed child — the process proves a governed ancestor by exhibiting a complete,
//      canonically consistent governed environment whose ownership record exists beneath the
//      validated root and is bound to this boot. Forging it requires already holding write
//      access inside the governed root, which is the trust boundary itself.
//
// Everything else is refused. Absence of evidence is refusal, not permission.

function refuseGoverned(code, detail) {
  throw new GovernedTempError(code, detail);
}

/** Canonicalize a governed path and refuse every shape that must never reach a comparison. */
function canonicalGovernedPath(label, raw, code) {
  const value = (raw ?? '').trim();
  if (value.length === 0) refuseGoverned(code, `${label} is missing or blank`);
  if (!path.isAbsolute(value)) refuseGoverned(code, `${label} ${value} is not an absolute path`);
  const link = symlinkComponentOf(value);
  if (link !== undefined) refuseGoverned(code, `${label} traverses the symlink ${link}`);
  const real = canonicalizePath(value);
  for (const forbidden of FORBIDDEN_ROOTS) {
    if (real === forbidden || isUnder(real, forbidden))
      refuseGoverned(code, `${label} ${value} canonicalizes to ${real}, beneath ${forbidden}`);
  }
  if (real !== path.resolve(value))
    refuseGoverned(code, `${label} ${value} canonicalizes elsewhere (${real}) — traversal or substitution`);
  return real;
}

/**
 * Validate the environment a TOP-OF-CHAIN governed entry inherited.
 *
 * A top-of-chain entry allocates nothing before it decides (verified claim 1: a plain-node
 * builtin-only module touches no temporary storage), so the only inherited value that can
 * already have caused an ungoverned write is NODE_COMPILE_CACHE, which this process's own
 * Node honoured at startup, before a single line here ran. It cannot be undone — so it is
 * detected and refused, loudly, rather than silently tolerated.
 *
 * @returns {string} the validated governed root
 */
export function assertCanonicalEntryEnvironment(env = process.env) {
  const root = resolveGovernedTempRoot(env);
  const inherited = env.NODE_COMPILE_CACHE;
  // ABSENT is the only safe reading of "nothing was cached ahead of us". A variable that is
  // PRESENT but blank is not absent: Node resolves it as a relative path and has already
  // written a cache directory into the current working directory — which is how a repository
  // acquired three compile-cache files under a directory named with three spaces.
  if (inherited === undefined) return root;
  const cache = canonicalGovernedPath('NODE_COMPILE_CACHE', inherited, 'ungoverned_inherited_cache');
  if (!isUnder(cache, root))
    refuseGoverned('ungoverned_inherited_cache',
      `NODE_COMPILE_CACHE ${inherited} is outside the governed root ${root}; this process had already ` +
      'written there before it could refuse. Start from `node scripts/trio/governed-npm.mjs` or ' +
      '`node scripts/trio/governed-pnpm.mjs`, or declare the entry class in the service unit');
  return root;
}

/**
 * Prove that this process is a GOVERNED CHILD, i.e. that a governed ancestor established
 * private storage before any package manager or loader in between could allocate.
 *
 * Every value is canonicalized before it is compared, and the ownership record beneath the
 * validated root must independently agree with the environment. Missing, blank, relative,
 * traversing, symlinked, forbidden, inconsistent and forged values are all refused.
 *
 * @returns {{root: string, runDir: string, runId: string, component: string, chain: string[]}}
 */
export function assertGovernedChildEnvironment(env = process.env) {
  const CODE = 'ungoverned_parent_environment';
  const root = resolveGovernedTempRoot(env);

  const runDirRaw = (env.TMPDIR ?? '').trim();
  const runDir = canonicalGovernedPath('TMPDIR', runDirRaw, CODE);
  for (const key of ['TMP', 'TEMP']) {
    const value = (env[key] ?? '').trim();
    if (value.length === 0) refuseGoverned(CODE, `${key} is missing or blank`);
    if (value !== runDirRaw) refuseGoverned(CODE, `${key} disagrees with TMPDIR`);
  }
  if (!isUnder(runDir, root))
    refuseGoverned(CODE, `TMPDIR ${runDirRaw} canonicalizes to ${runDir}, outside the validated root ${root}`);
  if (runDir === root)
    refuseGoverned(CODE, 'TMPDIR is the governed root itself, not a private run directory');

  let runStat;
  try { runStat = fs.lstatSync(runDir); }
  catch { return refuseGoverned(CODE, `TMPDIR ${runDirRaw} does not exist`); }
  if (runStat.isSymbolicLink() || !runStat.isDirectory())
    refuseGoverned(CODE, `TMPDIR ${runDirRaw} is not a directory`);
  const uid = process.getuid?.();
  if (uid !== undefined && runStat.uid !== uid)
    refuseGoverned(CODE, `TMPDIR ${runDirRaw} is owned by uid ${runStat.uid}, not ${uid}`);
  if ((runStat.mode & 0o077) !== 0)
    refuseGoverned(CODE, `TMPDIR ${runDirRaw} is group or world accessible`);

  const cache = canonicalGovernedPath('NODE_COMPILE_CACHE', env.NODE_COMPILE_CACHE, CODE);
  if (!isUnder(cache, runDir))
    refuseGoverned(CODE,
      `NODE_COMPILE_CACHE canonicalizes to ${cache}, outside the private run directory ${runDir}`);

  const component = (env[TEMP_COMPONENT_ENV] ?? '').trim();
  const runId = (env[TEMP_RUN_ID_ENV] ?? '').trim();
  if (component.length === 0 || runId.length === 0)
    refuseGoverned(CODE, 'the governed run identity is missing');
  if (!ALLOWED_COMPONENTS.includes(component))
    refuseGoverned(CODE, `${component} is not an allow-listed component`);
  if (!RUN_ID_SHAPE.test(runId))
    refuseGoverned(CODE, 'the governed run id is malformed');

  const recordPath = path.join(root, component, RECORDS_DIRNAME, `${runId}.json`);
  let record;
  try { record = JSON.parse(fs.readFileSync(recordPath, 'utf8')); }
  catch { return refuseGoverned(CODE, 'this run has no ownership record beneath the governed root'); }
  if (record === null || typeof record !== 'object' || Array.isArray(record))
    refuseGoverned(CODE, 'the ownership record is malformed');
  if (record.marker !== CHILD_MARKER || record.version !== MARKER_VERSION)
    refuseGoverned(CODE, 'the ownership record is not a governed child record');
  if (record.runId !== runId || record.component !== component)
    refuseGoverned(CODE, 'the ownership record does not match the declared run identity');
  if (typeof record.childPath !== 'string' || canonicalizePath(record.childPath) !== runDir)
    refuseGoverned(CODE, 'the ownership record names a different run directory');
  if (typeof record.root !== 'string' || canonicalizePath(record.root) !== root)
    refuseGoverned(CODE, 'the ownership record names a different governed root');
  const bootId = readBootId();
  if (bootId !== undefined && record.bootId !== bootId)
    refuseGoverned(CODE, 'the ownership record was written before this boot');

  return { root, runDir, runId, component, chain: runChainOf(env) };
}

// ─── Identity-bound reaping ─────────────────────────────────────────────────

function pidIsLive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
}

/**
 * Collect run directories whose owner is provably gone.
 *
 * Identity binding: a record is collectable only when it was written on a DIFFERENT boot
 * (after which a recycled pid proves nothing) or when its pid is not live on THIS boot.
 * A directory is never removed unless its record's childPath canonicalizes beneath the
 * component directory it was found in.
 *
 * @returns {string[]} the run ids collected
 */
export function reapDisprovenRuns(env = process.env) {
  /*
    ONLY A PROVABLY DEAD OWNER IS RESIDUE.

    The previous rule removed anything whose boot did not match OR whose pid was not live -- which
    also removed everything when the boot id could not be read at all, and trusted a bare pid to
    say a run was alive. Both are now the shared classifier's problem, and it answers UNKNOWN
    wherever the facts do not settle the question. UNKNOWN is retained, untouched, forever if need
    be: an un-reaped directory costs disk, and a wrongly reaped one costs a running service.
  */
  const root = resolveGovernedTempRoot(env);
  const reaped = [];
  for (const component of ALLOWED_COMPONENTS) {
    const componentDir = path.join(root, component);
    const verdicts = classifyComponent(root, component, RECORDS_DIRNAME);
    for (const verdict of verdicts) {
      if (verdict.state !== STATE.DEAD) continue;
      const real = canonicalizePath(verdict.path);
      if (!isUnder(real, componentDir) || real === componentDir) continue;
      try { fs.rmSync(real, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
      try { fs.rmSync(path.join(componentDir, RECORDS_DIRNAME, `${verdict.runId}.json`), { force: true }); } catch { /* best effort */ }
      reaped.push(verdict.runId);
    }
  }
  return reaped;
}


/**
 * THE GOVERNED TEMPORARY-STORAGE AUTHORITY — the one place this agent decides where scratch lives.
 *
 * LAB RULE: `/tmp` is forbidden for every lab-owned runtime, test, fixture, subprocess, and
 * generated artifact. Not as a cleanup target — as a toxic path. This module therefore has NO
 * fallback: when no governed root can be resolved and validated, scratch is a typed failure
 * (`TempAuthorityError`), never a quiet `/tmp`.
 *
 * THE CONTRACT (shared lab-wide, not agent-specific):
 *
 *   PEHVERSE_TEMP_ROOT     required deployment value naming the lab-controlled temporary root.
 *                          Host-specific — set in deployment data (e.g. the service .env), never
 *                          hardcoded here. Refused unless it is an absolute, symlink-free,
 *                          owner-only directory on persistent disk, resolving outside /tmp, with
 *                          headroom, carrying this module's versioned ownership marker.
 *   PEHVERSE_TEMP_RUN_ID   set for a lab-owned child so it JOINS its parent's run directory
 *                          instead of minting its own — one wrapper then cleans up for all.
 *
 * THE SHAPE:
 *
 *   <root>/                              validated, marker-stamped, lab-owned
 *     .pehverse-temp-root.json           the root's versioned ownership marker
 *     <component>/                       allow-listed component name
 *       .runs/<runId>.json               sidecar ownership records, never inside the child
 *       <runId>/                         mode 0700, exclusively created, one per run
 *
 * Cleanup only ever targets the exact run directory a well-formed record claims, under a root
 * whose marker still validates. A directory nothing claims is reported residue, never deleted
 * by prefix. The reaper removes a child only when its owner is positively DISPROVEN (different
 * boot, dead pid, recycled pid) — fail-closed, an uncollected directory costs an inode, a
 * wrongly collected one costs someone's running work.
 *
 * This file is part of the byte-identical Trio shared core. It carries no agent identity and
 * no host paths.
 */
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  resolveGovernedTempRoot as resolveCanonical,
  GovernedTempError,
} from "../../scripts/trio/governed-temp-authority.mjs";

// ─── Contract names ──────────────────────────────────────────────────────────

export const TEMP_ROOT_ENV = "PEHVERSE_TEMP_ROOT";
export const TEMP_RUN_ID_ENV = "PEHVERSE_TEMP_RUN_ID";
export const TEMP_COMPONENT_ENV = "PEHVERSE_TEMP_COMPONENT";
export const ROOT_MARKER_NAME = ".pehverse-temp-root.json";
export const ROOT_MARKER = "pehverse-governed-temp-root";
export const CHILD_MARKER = "pehverse-governed-temp-child";
export const MARKER_VERSION = 1;
export const RECORDS_DIRNAME = ".runs";

/** Components this agent may claim under the root. Closed set — not a naming convention. */
export const TEMP_COMPONENTS = Object.freeze(["trio-agent", "trio-test"] as const);
export type TempComponent = (typeof TEMP_COMPONENTS)[number];

/** The forbidden system temp directory, named ONLY so it can be refused. */
const FORBIDDEN_TMP = "/tmp";
export const MIN_FREE_BYTES = 512 * 1024 * 1024;
export const MIN_FREE_INODES = 50_000;

export type TempAuthorityErrorCode =
  | "root_not_configured"
  | "root_not_absolute"
  | "root_is_forbidden"
  | "root_is_tmp"
  | "root_under_tmp"
  | "root_symlink"
  | "root_not_directory"
  | "root_not_owned"
  | "root_permissive"
  | "root_on_tmpfs"
  | "root_inside_git_worktree"
  | "root_insufficient_space"
  | "root_not_creatable"
  | "root_marker_invalid"
  | "root_not_atomic"
  | "component_not_allowed"
  | "run_id_invalid"
  | "run_exists"
  | "run_unsafe"
  | "path_escapes_root";

/** Typed, so entry points and doctors can report the refusal as a blocking failure. */
export class TempAuthorityError extends Error {
  readonly code: TempAuthorityErrorCode;
  constructor(code: TempAuthorityErrorCode, detail: string) {
    super(
      `governed temporary storage unavailable [${code}]: ${detail}. ` +
        `The lab never falls back to /tmp. Set ${TEMP_ROOT_ENV} in deployment data to an ` +
        `absolute lab-owned directory on persistent disk, outside /tmp, not a symlink, ` +
        `owner-only writable.`,
    );
    this.name = "TempAuthorityError";
    this.code = code;
  }
}

// ─── Root validation ─────────────────────────────────────────────────────────

function isUnder(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}


/**
 * Is `path` inside a git working tree? Walked upward looking for `.git` on the filesystem —
 * the authoritative answer, with no subprocess. A scratch root inside a worktree is refused
 * because git then sees every fixture as repository content, and a fixture that deletes its
 * own `.git` still resolves up to the enclosing repository: suites asserting "this is NOT a
 * git repository" fail for reasons having nothing to do with the code under test.
 */
/** The candidate judged on its OWN real path, so a symlink to /tmp is refused as /tmp. */
function realCandidateOf(candidate: string): string {
  try {
    if (existsSync(candidate)) return realpathSync(candidate);
    return join(realpathSync(dirname(candidate)), candidate.slice(dirname(candidate).length + 1));
  } catch {
    return candidate;
  }
}

function refuseTmp(code: "root_is_tmp" | "root_under_tmp" | "path_escapes_root", candidate: string): void {
  const real = realCandidateOf(candidate);
  if (candidate === FORBIDDEN_TMP || real === FORBIDDEN_TMP) {
    throw new TempAuthorityError(code === "path_escapes_root" ? code : "root_is_tmp", `${candidate} is /tmp`);
  }
  if (isUnder(candidate, FORBIDDEN_TMP) || isUnder(real, FORBIDDEN_TMP)) {
    throw new TempAuthorityError(code === "path_escapes_root" ? code : "root_under_tmp", `${candidate} resolves beneath /tmp`);
  }
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function markerValid(root: string): boolean {
  const record = readJson(join(root, ROOT_MARKER_NAME));
  return record !== undefined && record["marker"] === ROOT_MARKER && record["version"] === MARKER_VERSION;
}

/**
 * Resolve, validate, and (deliberately) create THE governed temporary root. Every lab rule is
 * checked here in one place; no caller can accept a root by a different route.
 *
 * Delegates to the canonical plain-ESM implementation in governed-temp-authority.mjs.
 * Wraps GovernedTempError into TempAuthorityError for backward compatibility.
 */
export function resolveGovernedTempRoot(env: NodeJS.ProcessEnv = process.env): string {
  try {
    return resolveCanonical(env);
  } catch (err) {
    if (err instanceof GovernedTempError) {
      throw new TempAuthorityError(canonicalCodeToAuthorityCode(err.code, err.message), err.message);
    }
    throw err;
  }
}

/**
 * Map the canonical module's codes onto this module's published contract.
 *
 * The canonical authority refuses every forbidden root — `/tmp` and `/var/tmp` alike — under
 * one code. This module has published `root_is_tmp` and `root_under_tmp` since Order 11 and
 * its callers and suites branch on them, so the distinction is restored here rather than
 * changing an API that ~40 importers depend on.
 */
function canonicalCodeToAuthorityCode(code: string, message: string): TempAuthorityErrorCode {
  if (code === "root_is_forbidden") {
    return message.includes("resolves beneath") ? "root_under_tmp" : "root_is_tmp";
  }
  return code as TempAuthorityErrorCode;
}

// ─── Run directories ─────────────────────────────────────────────────────────

export interface RunDirectoryHandle {
  readonly root: string;
  readonly component: TempComponent;
  readonly runId: string;
  readonly path: string;
}

interface OwnershipRecord {
  readonly marker: typeof CHILD_MARKER;
  readonly version: number;
  readonly component: string;
  readonly runId: string;
  readonly childPath: string;
  readonly root: string;
  readonly hostname: string;
  readonly bootId?: string;
  readonly pid: number;
  readonly processStartTicks?: number;
  readonly createdAt: number;
}

const RUN_ID_SHAPE = /^[a-z0-9][a-z0-9-]{0,79}$/;

export function mintRunId(component: TempComponent): string {
  return `${component}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

function readBootId(): string | undefined {
  try {
    const raw = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

function readStartTicks(pid: number): number | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(")");
    if (close < 0) return undefined;
    const ticks = Number(raw.slice(close + 1).trim().split(/\s+/)[19]);
    return Number.isFinite(ticks) ? ticks : undefined;
  } catch {
    return undefined;
  }
}

function recordPathFor(root: string, component: string, runId: string): string {
  return join(root, component, RECORDS_DIRNAME, `${runId}.json`);
}

function assertComponent(component: string): asserts component is TempComponent {
  if (!(TEMP_COMPONENTS as readonly string[]).includes(component)) {
    throw new TempAuthorityError("component_not_allowed", `${component} is not an allow-listed component`);
  }
}

/**
 * Create one exclusively-owned run directory: `<root>/<component>/<runId>/`, mode 0700, with
 * its ownership record written BEFORE the directory is handed to anyone. A colliding run id is
 * an error, never reuse.
 */
export function createRunDirectory(
  component: TempComponent,
  opts: { readonly env?: NodeJS.ProcessEnv; readonly runId?: string } = {},
): RunDirectoryHandle {
  assertComponent(component);
  const root = resolveGovernedTempRoot(opts.env ?? process.env);
  const runId = opts.runId ?? mintRunId(component);
  if (!RUN_ID_SHAPE.test(runId)) throw new TempAuthorityError("run_id_invalid", `run id ${JSON.stringify(runId)} is not canonical`);

  const componentDir = join(root, component);
  mkdirSync(componentDir, { recursive: true, mode: 0o700 });
  if (lstatSync(componentDir).isSymbolicLink()) throw new TempAuthorityError("run_unsafe", `${componentDir} is a symlink`);
  mkdirSync(join(componentDir, RECORDS_DIRNAME), { recursive: true, mode: 0o700 });

  const path = join(componentDir, runId);
  try {
    mkdirSync(path, { mode: 0o700 }); // non-recursive: EEXIST on collision, no reuse
  } catch (err) {
    throw new TempAuthorityError("run_exists", `${path} already exists: ${err instanceof Error ? err.message : String(err)}`);
  }
  chmodSync(path, 0o700);
  const after = lstatSync(path);
  const uid = process.getuid?.();
  if (after.isSymbolicLink() || !after.isDirectory() || (uid !== undefined && after.uid !== uid)) {
    throw new TempAuthorityError("run_unsafe", `${path} was substituted before use`);
  }
  const real = realpathSync(path);
  if (!isUnder(real, root)) throw new TempAuthorityError("path_escapes_root", `${path} resolves to ${real}, outside ${root}`);
  refuseTmp("path_escapes_root", real);

  const bootId = readBootId();
  const ticks = readStartTicks(process.pid);
  const record: OwnershipRecord = {
    marker: CHILD_MARKER,
    version: MARKER_VERSION,
    component,
    runId,
    childPath: path,
    root,
    hostname: hostname(),
    ...(bootId !== undefined ? { bootId } : {}),
    pid: process.pid,
    ...(ticks !== undefined ? { processStartTicks: ticks } : {}),
    createdAt: Date.now(),
  };
  writeFileSync(recordPathFor(root, component, runId), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return { root, component, runId, path };
}

function readOwnershipRecord(root: string, component: string, runId: string): OwnershipRecord | undefined {
  const parsed = readJson(recordPathFor(root, component, runId));
  if (parsed === undefined) return undefined;
  if (parsed["marker"] !== CHILD_MARKER || parsed["version"] !== MARKER_VERSION) return undefined;
  if (typeof parsed["childPath"] !== "string" || typeof parsed["root"] !== "string" || typeof parsed["pid"] !== "number") return undefined;
  return parsed as unknown as OwnershipRecord;
}

/**
 * Remove a directory tree, restoring owner write permission a fixture may have removed, and
 * never following a symlink out of it.
 */
function forceRemoveTree(path: string): void {
  const relax = (dir: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* best effort — rm below reports what truly cannot go */
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) relax(join(dir, entry.name));
    }
  };
  try {
    if (lstatSync(path).isSymbolicLink()) return;
  } catch {
    return; // already gone
  }
  relax(path);
  rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

/**
 * Remove exactly ONE owned run directory. Idempotent: an already-removed run reports ok.
 * Refuses when the ownership record does not vouch for the exact path, when the path escapes
 * the root, or when the root's marker no longer validates — a changed identity is a reason to
 * stop, not to proceed.
 */
export function removeRunDirectory(handle: {
  readonly root: string;
  readonly component: string;
  readonly runId: string;
  readonly path: string;
}): { readonly ok: boolean; readonly reason?: string } {
  const record = readOwnershipRecord(handle.root, handle.component, handle.runId);
  const gone = !existsSync(handle.path);
  if (record === undefined) {
    return gone ? { ok: true } : { ok: false, reason: `no ownership record claims ${handle.path} — refusing to remove` };
  }
  if (!markerValid(handle.root)) {
    return { ok: false, reason: `${handle.root} no longer carries a valid root marker — refusing to remove anything under it` };
  }
  if (resolve(record.childPath) !== resolve(handle.path) || resolve(record.root) !== resolve(handle.root)) {
    return { ok: false, reason: `record for ${handle.runId} claims ${record.childPath} under ${record.root}, not ${handle.path}` };
  }
  if (!isUnder(resolve(handle.path), resolve(handle.root))) {
    return { ok: false, reason: `${handle.path} is not under ${handle.root}` };
  }
  forceRemoveTree(handle.path);
  rmSync(recordPathFor(handle.root, handle.component, handle.runId), { force: true });
  return { ok: true };
}

/**
 * Remove every run directory whose owner is positively DISPROVEN — a different boot, a dead
 * pid, or a recycled pid — and nothing else. Live owners and anything undecidable are retained.
 */
export function reapDisprovenRuns(env: NodeJS.ProcessEnv = process.env): {
  readonly reaped: readonly string[];
  readonly retained: readonly string[];
} {
  const root = resolveGovernedTempRoot(env);
  const bootId = readBootId();
  const reaped: string[] = [];
  const retained: string[] = [];
  for (const component of TEMP_COMPONENTS) {
    const recordsDir = join(root, component, RECORDS_DIRNAME);
    let names: string[] = [];
    try {
      names = readdirSync(recordsDir).filter((n) => n.endsWith(".json")).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const runId = name.slice(0, -".json".length);
      const record = readOwnershipRecord(root, component, runId);
      const childPath = record !== undefined ? resolve(record.childPath) : join(recordsDir, name);
      let disproven = false;
      if (record !== undefined && record.hostname === hostname() && isUnder(childPath, root) && resolve(record.root) === root) {
        if (bootId !== undefined && record.bootId !== undefined && record.bootId !== bootId) disproven = true;
        else if (bootId !== undefined && record.bootId !== undefined && !existsSync(`/proc/${record.pid}`)) disproven = true;
        else if (bootId !== undefined && record.bootId !== undefined && record.processStartTicks !== undefined) {
          const ticks = readStartTicks(record.pid);
          if (ticks !== undefined && ticks !== record.processStartTicks) disproven = true;
        }
      }
      if (disproven && record !== undefined) {
        forceRemoveTree(childPath);
        rmSync(recordPathFor(root, component, runId), { force: true });
        reaped.push(childPath);
      } else {
        retained.push(childPath);
      }
    }
  }
  return { reaped, retained };
}

// ─── The per-process governed scratch directory ──────────────────────────────

let cachedScratch: RunDirectoryHandle | undefined;
let cachedOwned = false;
let exitHookInstalled = false;

/**
 * THE replacement for `os.tmpdir()` in every lab-owned call site.
 *
 * Returns this process's governed scratch directory, creating it on first use. A process that
 * inherits `PEHVERSE_TEMP_RUN_ID` JOINS its parent's run directory (the wrapper owns cleanup);
 * a process with no inherited run id mints its own and removes it at exit. Either way the
 * process's own TMPDIR/TMP/TEMP are exported to the governed directory, so third-party code
 * asking the platform for a temp dir lands here too rather than escaping to /tmp.
 */
export function processScratchDir(env: NodeJS.ProcessEnv = process.env): string {
  if (cachedScratch !== undefined) return cachedScratch.path;
  const rawComponent = env[TEMP_COMPONENT_ENV]?.trim();
  let component: TempComponent = "trio-agent";
  if (rawComponent !== undefined && rawComponent.length > 0) {
    assertComponent(rawComponent);
    component = rawComponent;
  }
  const inherited = env[TEMP_RUN_ID_ENV]?.trim();
  if (inherited !== undefined && inherited.length > 0) {
    if (!RUN_ID_SHAPE.test(inherited)) throw new TempAuthorityError("run_id_invalid", `inherited run id ${JSON.stringify(inherited)} is not canonical`);
    const root = resolveGovernedTempRoot(env);
    const path = join(root, component, inherited);
    if (existsSync(path)) {
      const stat = lstatSync(path);
      const uid = process.getuid?.();
      if (stat.isSymbolicLink() || !stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) {
        throw new TempAuthorityError("run_unsafe", `${path} is not this lab's directory`);
      }
      cachedScratch = { root, component, runId: inherited, path };
      cachedOwned = false;
    } else {
      cachedScratch = createRunDirectory(component, { env, runId: inherited });
      cachedOwned = false; // the wrapper that exported the id owns cleanup
    }
  } else {
    cachedScratch = createRunDirectory(component, { env });
    cachedOwned = true;
  }
  if (cachedOwned && !exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      try {
        if (cachedScratch !== undefined && cachedOwned) removeRunDirectory(cachedScratch);
      } catch {
        /* exit handlers must not throw */
      }
    });
  }
  env.TMPDIR = cachedScratch.path;
  env.TMP = cachedScratch.path;
  env.TEMP = cachedScratch.path;
  return cachedScratch.path;
}

/** The environment a lab-owned child must receive — explicit, never inherited from the host. */
export function childTempEnv(runDir: string): {
  readonly TMPDIR: string;
  readonly TMP: string;
  readonly TEMP: string;
} {
  const real = realpathSync(runDir);
  refuseTmp("path_escapes_root", real);
  return { TMPDIR: runDir, TMP: runDir, TEMP: runDir };
}

/**
 * THE replacement for `mkdtempSync(join(tmpdir(), prefix))` in every lab-owned call site —
 * a fresh unique directory inside this process's governed scratch. Fixed shared names are
 * forbidden even outside /tmp; always minting a unique leaf is the enforcement.
 */
export function governedMkdtemp(prefix: string): string {
  return mkdtempSync(join(processScratchDir(), prefix));
}

/**
 * Entry-point assertion: the configured root is safe and this process's TMPDIR/TMP/TEMP point
 * inside governed storage before any work starts. Doctor/health surfaces report the thrown
 * `TempAuthorityError` as a blocking failure.
 */
export function assertGovernedTempSafety(env: NodeJS.ProcessEnv = process.env): { readonly root: string; readonly scratch: string } {
  const scratch = processScratchDir(env);
  const root = resolveGovernedTempRoot(env);
  for (const key of ["TMPDIR", "TMP", "TEMP"] as const) {
    const value = env[key];
    if (value === undefined || value !== scratch) {
      throw new TempAuthorityError("run_unsafe", `${key} is not bound to the governed scratch directory`);
    }
  }
  return { root, scratch };
}

/** Forget the cached scratch. Tests only — production resolves once per process by design. */
export function resetTempAuthorityForTests(): void {
  cachedScratch = undefined;
  cachedOwned = false;
}

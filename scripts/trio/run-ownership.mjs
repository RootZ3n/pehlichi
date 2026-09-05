/**
 * GOVERNED RUN OWNERSHIP — is the process that created this directory still alive?
 *
 * THE PRIOR FALSE ASSUMPTION. Residue was "any run directory that is not one of MY ancestors".
 * `PEHVERSE_TEMP_RUN_CHAIN` lists the chain a test is nested inside, and a sibling service is never
 * in it — so three legitimate, running lab services were classified as residue by construction. The
 * rule proved nothing about the directories; it only asked whether the observer had made them.
 *
 * THE REPLACEMENT. Ownership is decided by evidence about the recorded owner, and a directory is
 * residue only when that owner is PROVABLY DEAD. Three states, and the middle one is the point:
 *
 *   LIVE     every fact agrees and the owner is running.
 *   DEAD     the owner is positively disproven — a different boot, an absent process, or a PID
 *            whose start time no longer matches the one recorded.
 *   UNKNOWN  anything else. Missing facts, partial sidecars, unreadable /proc, a legacy record
 *            written before this evidence existed. UNKNOWN is never residue and is never removed.
 *
 * A PID ALONE PROVES NOTHING. A live PID is not evidence of ownership: PIDs are reused. Liveness
 * therefore requires the boot to match, the recorded start ticks to match exactly, and the process
 * to still sit in the recorded `lab-*.service` cgroup. Absence of a process under a matching boot
 * IS proof of death, which is the one direction a PID can settle on its own.
 *
 * Plain `.mjs` with builtin-only imports: the reaper runs inside the bare-node governed launcher,
 * before any loader exists, and the test suite consumes the same module so the two cannot disagree.
 *
 * Part of the byte-identical Trio shared core.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, join, resolve } from 'node:path';

export const OWNERSHIP_SCHEMA_VERSION = 1;

/** The unit shape a governed lab run may claim. Nothing else is a lab service. */
export const LAB_UNIT = /^lab-[a-z0-9][a-z0-9-]*\.service$/;

export const STATE = Object.freeze({ LIVE: 'LIVE', DEAD: 'DEAD', UNKNOWN: 'UNKNOWN' });

/** The current boot, or undefined when it cannot be read — in which case nothing is provable. */
export function readBootId() {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Field 22 of `/proc/<pid>/stat` — the process start time in clock ticks since boot.
 *
 * Parsed from after the last `)` because the second field is the executable name and may itself
 * contain spaces and parentheses. Together with the boot id this is what makes a PID identify one
 * process rather than a number a later process may inherit.
 */
export function readStartTicks(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = raw.lastIndexOf(')');
    if (close < 0) return undefined;
    const ticks = Number(raw.slice(close + 1).trim().split(/\s+/)[19]);
    return Number.isFinite(ticks) ? ticks : undefined;
  } catch {
    return undefined;
  }
}

/** The `lab-*.service` unit a pid currently belongs to, or undefined. */
export function readUnit(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/cgroup`, 'utf8');
    const match = /\/(lab-[a-z0-9][a-z0-9-]*\.service)/.exec(raw);
    return match === null ? undefined : match[1];
  } catch {
    return undefined;
  }
}

/** The ownership facts this process can record about itself, for a sidecar. */
export function ownershipFacts(pid = process.pid) {
  const bootId = readBootId();
  const processStartTicks = readStartTicks(pid);
  const unit = readUnit(pid);
  return {
    ownershipSchemaVersion: OWNERSHIP_SCHEMA_VERSION,
    ...(bootId !== undefined ? { bootId } : {}),
    pid,
    ...(processStartTicks !== undefined ? { processStartTicks } : {}),
    ...(unit !== undefined ? { unit } : {}),
  };
}

function unknown(reason) { return { state: STATE.UNKNOWN, reason }; }
function dead(reason) { return { state: STATE.DEAD, reason }; }
function live(reason) { return { state: STATE.LIVE, reason }; }

/**
 * Classify one run directory from its sidecar record.
 *
 * `record` is whatever was parsed from `.runs/<runId>.json`, or undefined when there is none or it
 * did not parse. `childPath` is the directory on disk. Nothing here removes anything; callers
 * decide, and only DEAD authorises removal.
 */
export function classifyOwnership(record, childPath, options = {}) {
  const now = {
    bootId: options.bootId ?? readBootId(),
    host: options.hostname ?? hostname(),
    uid: options.uid ?? process.getuid?.(),
  };

  if (record === undefined || record === null || typeof record !== 'object') {
    return unknown('there is no readable ownership record');
  }
  if (typeof record.runId !== 'string' || record.runId.length === 0) return unknown('the record names no run');
  if (basename(childPath) !== record.runId) return unknown('the record does not name this directory');
  if (typeof record.hostname !== 'string') return unknown('the record names no host');
  if (record.hostname !== now.host) return unknown(`the record belongs to host ${record.hostname}`);
  if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0) {
    return unknown('the record names no usable pid');
  }
  if (typeof record.bootId !== 'string' || record.bootId.length === 0) {
    return unknown('the record names no boot, so neither life nor death can be shown');
  }
  if (now.bootId === undefined) return unknown('this host will not report its boot id');

  // ---- the three ways an owner is POSITIVELY disproven ----------------------------------------
  if (record.bootId !== now.bootId) return dead('the record is from a previous boot');
  if (!existsSync(`/proc/${record.pid}`)) return dead('the recorded process no longer exists');
  if (typeof record.processStartTicks === 'number') {
    const ticks = readStartTicks(record.pid);
    if (ticks !== undefined && ticks !== record.processStartTicks) {
      return dead('the pid was reused: its start time differs from the recorded one');
    }
  }

  // ---- from here the owner is not disproven; LIVE still has to be earned ----------------------
  if (typeof record.processStartTicks !== 'number') {
    return unknown('the record predates start-time evidence, so the pid cannot be tied to this run');
  }
  if (readStartTicks(record.pid) === undefined) {
    return unknown('the start time of the recorded process cannot be read');
  }
  if (typeof record.unit !== 'string' || !LAB_UNIT.test(record.unit)) {
    return unknown('the record names no lab service unit');
  }
  const unit = readUnit(record.pid);
  if (unit === undefined) return unknown('the recorded process reports no unit');
  if (unit !== record.unit) return unknown(`the recorded process now runs under ${unit}`);

  // ---- and the directory itself has to be the thing the record describes ----------------------
  let stat;
  try {
    stat = lstatSync(childPath);
  } catch {
    return unknown('the run directory cannot be inspected');
  }
  if (stat.isSymbolicLink()) return unknown('the run directory is a symlink');
  if (!stat.isDirectory()) return unknown('the run directory is not a directory');
  if (now.uid !== undefined && stat.uid !== now.uid) return unknown(`the run directory is owned by uid ${stat.uid}`);
  if (typeof record.childPath !== 'string' || resolve(record.childPath) !== resolve(childPath)) {
    return unknown('the record describes a different path');
  }
  try {
    if (realpathSync(childPath) !== resolve(childPath)) return unknown('the run directory resolves elsewhere');
  } catch {
    return unknown('the run directory cannot be resolved');
  }

  return live(`owned by pid ${record.pid} in ${record.unit}`);
}

/** Read and shape-check a sidecar. Anything unparseable yields undefined, which means UNKNOWN. */
export function readSidecar(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  if (text.length > 64 * 1024) return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Classify every entry under one component directory.
 *
 * Returns one verdict per entry, including entries with no sidecar at all — those are UNKNOWN, not
 * residue, which is the difference between this and what it replaces.
 */
export function classifyComponent(root, component, recordsDirname = '.runs') {
  const componentDir = join(root, component);
  const recordsDir = join(componentDir, recordsDirname);
  let entries = [];
  try {
    entries = readdirSync(componentDir).filter((n) => n !== recordsDirname).sort();
  } catch {
    return [];
  }
  const bootId = readBootId();
  return entries.map((name) => {
    const childPath = join(componentDir, name);
    const record = readSidecar(join(recordsDir, `${name}.json`));
    const verdict = classifyOwnership(record, childPath, { bootId });
    return { runId: name, path: childPath, state: verdict.state, reason: verdict.reason };
  });
}

/** The only entries a reaper may touch. Nothing else is ever a candidate. */
export function residueOf(verdicts) {
  return verdicts.filter((v) => v.state === STATE.DEAD);
}

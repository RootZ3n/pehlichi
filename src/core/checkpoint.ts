/**
 * CHECKPOINTING — durable conversation snapshots for crash-safe resume.
 *
 * The loop periodically writes a checkpoint (the running message history + the
 * iteration it was at) to JSON under a checkpoint directory. On a crash/restart
 * the loop can load the latest checkpoint and continue from where it left off.
 *
 * Storage is intentionally simple: one JSON file per checkpoint, named by a
 * zero-padded iteration so lexical AND numeric order agree. Only the most recent
 * `CHECKPOINT_KEEP` files are retained — older ones are pruned on each save.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Message } from "./driver.js";

/** A single durable snapshot of a run's conversation state. */
export interface Checkpoint {
  readonly iteration: number;
  readonly timestamp: number;
  readonly messages: Message[];
  readonly taskId: string;
}

/** How many checkpoints to retain (last N). */
export const CHECKPOINT_KEEP = 3;

const PREFIX = "checkpoint-";
const SUFFIX = ".json";

/** Zero-pad the iteration so filename order matches numeric order. */
function fileFor(iteration: number): string {
  return `${PREFIX}${String(iteration).padStart(8, "0")}${SUFFIX}`;
}

/** Parse the iteration encoded in a checkpoint filename (-1 if unparseable). */
function iterationOf(file: string): number {
  const n = Number(file.slice(PREFIX.length, file.length - SUFFIX.length));
  return Number.isFinite(n) ? n : -1;
}

/** List checkpoint files in a directory, sorted ascending by iteration. Empty if none/missing. */
export function listCheckpointFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.startsWith(PREFIX) && f.endsWith(SUFFIX))
    .sort((a, b) => iterationOf(a) - iterationOf(b));
}

/**
 * Write a checkpoint as JSON (creating the dir as needed), then prune to the last
 * `CHECKPOINT_KEEP` checkpoints. Returns the path written.
 */
export function saveCheckpoint(dir: string, cp: Checkpoint): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileFor(cp.iteration));
  writeFileSync(path, JSON.stringify(cp, null, 2), "utf8");
  pruneCheckpoints(dir, CHECKPOINT_KEEP);
  return path;
}

/** Load the most recent checkpoint, or undefined when there is none / it is unreadable. */
export function loadLatestCheckpoint(dir: string): Checkpoint | undefined {
  const latest = listCheckpointFiles(dir).at(-1);
  if (latest === undefined) return undefined;
  try {
    return JSON.parse(readFileSync(join(dir, latest), "utf8")) as Checkpoint;
  } catch {
    return undefined;
  }
}

/** Delete all but the most recent `keep` checkpoints. */
export function pruneCheckpoints(dir: string, keep = CHECKPOINT_KEEP): void {
  const files = listCheckpointFiles(dir);
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    rmSync(join(dir, f), { force: true });
  }
}

/**
 * Delete EVERY checkpoint file in `dir` (C4). A `/reset` must erase the pre-reset
 * transcript from disk, not just from memory — otherwise prune keeps the highest
 * iterations while a fresh post-reset checkpoint starts at a LOW iteration, so
 * loadLatestCheckpoint (which picks the HIGHEST) resurrects the old conversation on the
 * next restart. Clearing the directory guarantees the next load sees only post-reset
 * state. Safe to call when the dir is missing or already empty.
 */
export function clearCheckpoints(dir: string): void {
  for (const f of listCheckpointFiles(dir)) {
    rmSync(join(dir, f), { force: true });
  }
}

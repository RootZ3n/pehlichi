import { existsSync, realpathSync } from "node:fs";

/**
 * Resolve to a canonical path when the filesystem allows it, best-effort otherwise.
 *
 * Symlinks matter here: a workspace reached through a link must be bound at its real target, or
 * bwrap binds the link's parent and the confinement is not what the policy said it was.
 */
export function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** `existsSync` that cannot throw. bwrap refuses to start if a bind source is missing. */
export function existsSafe(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Is `candidate` the same as `root`, or beneath it?
 *
 * Compared with an explicit separator so `/lab/workspace-evil` is not treated as being inside
 * `/lab/workspace`. Both sides must already be canonical; containment decisions made on
 * un-canonicalised paths are decisions about names rather than about directories.
 */
export function isWithin(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith("/") ? root : root + "/");
}

/** Is `candidate` within ANY of `roots`? */
export function isWithinAny(candidate: string, roots: readonly string[]): boolean {
  return roots.some((root) => isWithin(candidate, root));
}

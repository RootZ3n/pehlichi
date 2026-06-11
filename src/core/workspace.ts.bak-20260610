/**
 * Workspace confinement. Every file/exec tool resolves paths through here and
 * rejects anything that escapes workspaceRoot — same discipline as lab-store's
 * slug guard: resolve, then prefix-check, reject traversal.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Thrown by tools on a confinement violation or an invalid argument. */
export class ToolError extends Error {
  override readonly name = "ToolError";
  constructor(message: string) {
    super(message);
  }
}

/**
 * Resolve `p` relative to the workspace root and assert it stays inside.
 * Returns the absolute path. Throws ToolError on escape / empty / traversal.
 */
export function resolveInWorkspace(workspaceRoot: string, p: string): string {
  if (typeof p !== "string" || p.length === 0) {
    throw new ToolError("path is required");
  }
  const root = resolve(workspaceRoot);
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ToolError(`path "${p}" escapes the workspace`);
  }
  // H6 (symlink escape): the logical-path check above is necessary but not sufficient —
  // a symlink whose LOGICAL path is inside the workspace can still point its REAL target
  // outside it (e.g. `link -> /etc/passwd`). Resolve symlinks and re-check the REAL path.
  // For a path that does not exist yet (a file about to be written), resolve the nearest
  // existing ancestor instead, so a symlinked parent directory is still caught.
  const realRoot = existsSync(root) ? realpathSync(root) : root;
  const realAbs = realPathOrNearest(abs);
  const realRel = relative(realRoot, realAbs);
  if (realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) {
    throw new ToolError(`path "${p}" escapes the workspace via a symlink`);
  }
  return abs;
}

/**
 * realpathSync of `abs`, or — when `abs` does not exist yet — realpathSync of its
 * nearest existing ancestor with the not-yet-created tail re-appended. This lets the
 * confinement check follow a symlinked PARENT directory even for a target that has not
 * been written, closing the TOCTOU-adjacent gap for write_file/patch on new paths.
 */
function realPathOrNearest(abs: string): string {
  let dir = abs;
  const tail: string[] = [];
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) return abs; // reached the filesystem root without finding one
    tail.unshift(dir.slice(parent.length + 1));
    dir = parent;
  }
  return tail.length === 0 ? realpathSync(dir) : resolve(realpathSync(dir), ...tail);
}

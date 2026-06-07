/**
 * Workspace confinement. Every file/exec tool resolves paths through here and
 * rejects anything that escapes workspaceRoot — same discipline as lab-store's
 * slug guard: resolve, then prefix-check, reject traversal.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";

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
  return abs;
}

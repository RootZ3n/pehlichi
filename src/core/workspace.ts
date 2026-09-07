/**
 * Workspace confinement. Every file/exec tool resolves paths through here and
 * rejects anything that escapes workspaceRoot — same discipline as lab-store's
 * slug guard: resolve, then prefix-check, reject traversal.
 */
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
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
  // FULL-ACCESS MODE (operator opt-in via AGENT_FS_UNRESTRICTED): skip workspace
  // confinement entirely so file tools can read/write anywhere on the host. Absolute
  // paths are honored as-is; relative paths still resolve against the workspace.
  if (process.env.AGENT_FS_UNRESTRICTED === "true") {
    return resolve(workspaceRoot, p);
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

/*
  READING BY FILE IDENTITY, NOT BY NAME.

  `resolveInWorkspace` answers "is this PATHNAME inside the root", and resolves symlinks to catch a
  link whose target is outside. A hardlink defeats both: it is a second NAME for an outside inode,
  its realpath is the in-workspace name, and there is nothing in the path to notice. Measured on
  this host with `fs.protected_hardlinks=1`: a same-owner alias is creatable, `nlink` is 2, the
  inode is identical to the outside file, and the content read back through it in full.

  Returning a pathname is also a check-then-open: whatever is validated can be replaced before the
  caller opens it. So the boundary hands back a DESCRIPTOR and the caller reads from that — the
  bytes come from the exact inode that was inspected, and no second lookup happens.

  Three things are established on the descriptor itself:

    • `O_NOFOLLOW` refuses a symlinked final component at open time, in the kernel, rather than in
      a pathname comparison that a rename could invalidate a moment later.
    • `fstat` reports `nlink`. A regular file inside a workspace with more than one link is refused:
      the other names cannot be enumerated cheaply, so their location cannot be established, and a
      boundary that cannot establish it must not assume it.
    • the inode must still be a regular file — a device or fifo swapped in is not readable content.

  This is not a claim of race freedom from two pathname checks. There is exactly one lookup.
*/
export class FileIdentityRefused extends ToolError {
  /** The refusal class, for the receipt. Never carries a byte of the protected content. */
  readonly detail: string;
  constructor(detail: string, message: string) {
    super(message);
    this.detail = detail;
  }
}

/** Open a workspace file by identity. The caller must close the returned descriptor. */
export function openInWorkspace(workspaceRoot: string, p: string): number {
  const abs = resolveInWorkspace(workspaceRoot, p);
  let fd: number;
  try {
    fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      // The refusal names the class and the path the caller already knows. It never quotes the
      // target or any byte of the protected content.
      throw new FileIdentityRefused("symlink",
        `path "${p}" is a symbolic link and is refused at the workspace boundary`);
    }
    throw error;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new FileIdentityRefused("not-a-regular-file",
        `path "${p}" is not a regular file`);
    }
    if (st.nlink > 1) {
      throw new FileIdentityRefused("hardlink-alias",
        `path "${p}" has ${st.nlink} links, so its content may also exist outside the workspace; ` +
        "reading it is refused");
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Read a workspace file by identity. Refuses symlinks and hardlink aliases before any byte is returned. */
export function readInWorkspace(workspaceRoot: string, p: string): string {
  const fd = openInWorkspace(workspaceRoot, p);
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

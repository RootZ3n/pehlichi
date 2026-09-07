/**
 * MATERIALIZING A WORKSPACE, SO FILE IDENTITY STOPS BEING A QUESTION.
 *
 * A bind mount confines PATHS. It cannot confine INODES, and that is not an implementation gap —
 * it is what a mount namespace is. The kernel resolves a name to an inode and serves it; a
 * directory entry records no provenance, so there is nothing for the boundary to consult. A
 * hardlink inside a bound directory is an ordinary name for an inode that also has names outside,
 * and no amount of care about which directories are visible can tell the two apart. Landlock does
 * not help either: it restricts by path hierarchy, so a link inside an allowed hierarchy is allowed.
 *
 * Every boundary that tries to ANSWER the question is either racy or wrong:
 *
 *   • refuse `nlink > 1`            — breaks package managers; a live repository holds 5112 such files
 *   • exempt `node_modules` by path — the partner names were measured in other repositories'
 *                                     dependency trees, all writable by the same account, so their
 *                                     bytes cannot be shown to be immutable
 *   • scan for the other names      — costs a tree walk per command and still describes a moment
 *
 * So this does not answer the question; it removes it — but only if it removes the right thing.
 * Copying alone is NOT enough, and measuring that was the useful part: materializing an aliased file
 * breaks the alias RELATIONSHIP and copies the CONTENT, so the canary was still readable from the
 * new workspace. An alias to an operator secret would have been faithfully reproduced inside the
 * very boundary meant to exclude it.
 *
 * Materialization is therefore an ADMISSION point, not a copy. Content is copied through an open
 * descriptor into a freshly created file, and a source whose inode has names the source tree cannot
 * account for is REFUSED and recorded rather than reproduced. Afterwards every file in the workspace
 * is one that was admitted, each is a new inode with one link, and the contained shell sees nothing
 * that arrived by aliasing.
 *
 * The rule costs nothing on real project content: the live Mad-Ptah tree has 1010 project files and
 * ZERO multiply-linked ones once dependencies are excluded. Dependencies are the only place
 * hardlinks legitimately appear, and they come from a separate immutable root instead.
 *
 * Three properties the copy itself must have, because a careless copy reintroduces exactly what it
 * was meant to remove:
 *
 *   • `cp -a` and its equivalents PRESERVE hardlinks. They are never used here.
 *   • the source is opened once with `O_NOFOLLOW` and read from that descriptor, so a rename
 *     between deciding and reading cannot substitute a different file.
 *   • the source is stat'd on the same descriptor before and after, and a size or mtime that moved
 *     under the copy is a refusal rather than a partially-copied file presented as whole.
 */
import {
  closeSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync,
  lstatSync, writeFileSync, constants,
} from "node:fs";
import type { Dirent } from "node:fs";
import { join, relative, resolve } from "node:path";

/** Why a source entry was not materialized. Never carries a byte of the entry's content. */
export type SkipReason =
  | "symlink"
  | "not-a-regular-file"
  | "unreadable"
  | "externally-aliased"
  | "aliased-during-materialization";

export interface MaterializeResult {
  readonly files: number;
  readonly bytes: number;
  readonly directories: number;
  /** Entries deliberately not copied, with the reason. A silent omission would be worse. */
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: SkipReason }>;
  readonly milliseconds: number;
}

export class MaterializationRefused extends Error {
  readonly detail: string;
  constructor(detail: string, message: string) {
    super(message);
    this.name = "MaterializationRefused";
    this.detail = detail;
  }
}

/**
 * Copy one file by identity.
 *
 * Opened with `O_NOFOLLOW`, so a symlinked final component is refused by the kernel rather than by
 * a comparison. Read from the descriptor, so the bytes are the ones that were inspected. Stat'd on
 * that same descriptor before and after, because a source that changed under the copy has not been
 * copied — it has been sampled twice, and presenting that as a file is how a race becomes data.
 */
function copyByDescriptor(
  sourcePath: string,
  destinationPath: string,
  accountedFor: (dev: number, ino: number, nlink: number) => boolean,
  admit: (dev: number, ino: number) => void,
): number {
  let fd: number;
  try {
    fd = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new MaterializationRefused("symlink", `${sourcePath} is a symbolic link`);
    throw new MaterializationRefused("unreadable", `${sourcePath} could not be opened`);
  }
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) {
      throw new MaterializationRefused("not-a-regular-file",
        `${sourcePath} is not a regular file, so it has no content to materialize`);
    }
    /*
      ADMISSION, decided on the descriptor rather than on the name. A file whose inode has names the
      source tree cannot account for is content that arrived from somewhere the run was not granted,
      and copying it would carry it across the boundary intact.
    */
    if (before.nlink > 1 && !accountedFor(before.dev, before.ino, before.nlink)) {
      throw new MaterializationRefused("externally-aliased",
        `${sourcePath} has ${before.nlink} links and the source tree accounts for fewer, ` +
        "so its content is reachable from outside and it is not admitted");
    }
    admit(before.dev, before.ino);
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new MaterializationRefused("mutated-during-copy",
        `${sourcePath} changed while it was being read; the copy is not a copy of anything`);
    }
    // `wx` fails rather than following or truncating an existing entry, so nothing already present
    // at the destination can capture the write.
    const out = openSync(destinationPath, "wx", 0o644);
    try { writeFileSync(out, bytes); } finally { closeSync(out); }
    return bytes.byteLength;
  } finally {
    closeSync(fd);
  }
}

/**
 * Materialize `source` into `staging`, which must not already exist.
 *
 * Symlinks are recorded and NOT recreated: a link is a name for something the copy does not own,
 * and recreating it would put the original question back inside the answer.
 */
export function materialize(
  source: string,
  staging: string,
  options: { readonly exclude?: ReadonlyArray<string> } = {},
): MaterializeResult {
  const from = resolve(source);
  const to = resolve(staging);
  const exclude = new Set(options.exclude ?? []);
  const started = Date.now();
  const skipped: Array<{ path: string; reason: SkipReason }> = [];
  let files = 0;
  let bytes = 0;
  let directories = 0;

  mkdirSync(to, { recursive: true });

  /*
    One pass over the source counts every inode that has more than one link, so admission can ask
    whether a file's other names are all inside the tree being materialized. It is built before any
    copying starts, from the same tree, and is used only to REFUSE — a stale count can withhold a
    file that was admissible, never admit one that was not.
  */
  /** Inodes whose bytes were copied. The second census re-examines exactly these. */
  const admittedInodes = new Set<string>();
  const admit = (dev: number, ino: number): void => { admittedInodes.add(`${dev}:${ino}`); };

  const linkCounts = new Map<string, number>();
  const census = (dir: string): void => {
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (exclude.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { census(abs); continue; }
      if (!entry.isFile()) continue;
      try {
        const st = lstatSync(abs);
        if (st.nlink <= 1) continue;
        const key = `${st.dev}:${st.ino}`;
        linkCounts.set(key, (linkCounts.get(key) ?? 0) + 1);
      } catch { /* an entry that vanished between listing and stat is simply not counted */ }
    }
  };
  census(from);
  const accountedFor = (dev: number, ino: number, nlink: number): boolean =>
    (linkCounts.get(`${dev}:${ino}`) ?? 0) >= nlink;

  const visit = (dir: string): void => {
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(from, abs);
      if (exclude.has(entry.name)) continue;
      if (entry.isSymbolicLink()) { skipped.push({ path: rel, reason: "symlink" }); continue; }
      if (entry.isDirectory()) {
        mkdirSync(join(to, rel), { recursive: true });
        directories += 1;
        visit(abs);
        continue;
      }
      if (!entry.isFile()) { skipped.push({ path: rel, reason: "not-a-regular-file" }); continue; }
      try {
        bytes += copyByDescriptor(abs, join(to, rel), accountedFor, admit);
        files += 1;
      } catch (error) {
        if (error instanceof MaterializationRefused && error.detail !== "mutated-during-copy") {
          skipped.push({ path: rel, reason: error.detail as SkipReason });
          continue;
        }
        throw error;
      }
    }
  };
  visit(from);

  /*
    THE SAMPLING WINDOW, AND WHY A SECOND CENSUS CLOSES IT.

    `nlink` is a count read at a moment. An adversary who can write the source can unlink the
    OUTSIDE name just before the descriptor is stat'd, so the file looks ordinary, and restore it
    afterwards. Phase 3F won exactly that race against the first version of this code: a second
    process flapping the outside name in a loop got the canary admitted.

    A single sample cannot be made reliable — that is what a sample is. So the tree is censused
    AGAIN after every copy, and any admitted inode that now has names the tree cannot account for
    invalidates the whole materialization. The result is a two-sided window, and the adversary has
    to keep the outside name absent across BOTH censuses and every copy in between.

    If they do, the argument changes rather than weakens: for the entire materialization the inode's
    only name was inside the workspace. The content was, throughout, exclusively a workspace file —
    which is indistinguishable from an adversary with write access simply writing those bytes, and
    no boundary above the filesystem can prevent that. What is closed here is admission through
    ALIASING; what remains is an adversary who already has write access to the source, and that was
    never what this boundary was for.

    The whole materialization is rejected rather than the single file: a source being manipulated
    while it is read is not a source one file of which can be trusted.
  */
  const recensus = new Map<string, number>();
  const second = (dir: string): void => {
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (exclude.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { second(abs); continue; }
      if (!entry.isFile()) continue;
      try {
        const st = lstatSync(abs);
        if (st.nlink <= 1) continue;
        const key = `${st.dev}:${st.ino}`;
        recensus.set(key, (recensus.get(key) ?? 0) + 1);
      } catch { /* vanished between listing and stat */ }
    }
  };
  second(from);
  for (const [key, insideNow] of recensus) {
    // Only inodes whose bytes were actually COPIED matter here. A file refused at admission is
    // already refused; re-rejecting the whole run for it would make an ordinary planted alias fatal
    // instead of skipped, which is the wrong shape of answer and would break any tree that legally
    // contains one.
    if (!admittedInodes.has(key)) continue;
    const [devText, inoText] = key.split(":");
    let nlinkNow = 0;
    // Re-stat one occurrence to learn the current link count for this inode.
    const probe = (dir: string): boolean => {
      let entries: Dirent[];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
      for (const entry of entries) {
        if (exclude.has(entry.name)) continue;
        const abs = join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { if (probe(abs)) return true; continue; }
        if (!entry.isFile()) continue;
        try {
          const st = lstatSync(abs);
          if (`${st.dev}:${st.ino}` === key) { nlinkNow = st.nlink; return true; }
        } catch { /* vanished */ }
      }
      return false;
    };
    probe(from);
    if (nlinkNow > insideNow) {
      throw new MaterializationRefused("aliased-during-materialization",
        `inode ${devText}:${inoText} has ${nlinkNow} links and the tree accounts for ${insideNow}; ` +
        "the source was manipulated while it was being read and the materialization is rejected");
    }
  }

  return { files, bytes, directories, skipped, milliseconds: Date.now() - started };
}

/**
 * Materialize into a sibling staging directory, then move it into place in one step.
 *
 * A run never observes a half-built workspace: until the rename there is nothing at the destination,
 * and after it there is everything. An interrupted materialization leaves staging behind and the
 * destination absent, which is a state a caller can recognise rather than one it can mistake for a
 * finished workspace.
 */
export function materializeInto(
  source: string,
  destination: string,
  options: { readonly exclude?: ReadonlyArray<string> } = {},
): MaterializeResult {
  const target = resolve(destination);
  const staging = `${target}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  try {
    const result = materialize(source, staging, options);
    renameSync(staging, target);
    return result;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

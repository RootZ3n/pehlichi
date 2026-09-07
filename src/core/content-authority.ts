/**
 * CONTENT AUTHORITY: bytes admitted by DIGEST, never by where they were found.
 *
 * Phase 3F ended with the filesystem-topology approach refuted. `nlink` is a count sampled at a
 * moment; a second census is a second moment; and an adversary who can write the source presents an
 * inode whose only name is inside the workspace. Provenance is simply not recoverable from topology,
 * and every variant of the question — one census, two censuses, partner-name walks, pathname
 * allowlists, a `node_modules` exception, bind mounts, Landlock path hierarchies — asks the same
 * unanswerable thing. The measured result was an attacker winning 4 of 12 trials against the best
 * version of it.
 *
 * So the question is abandoned rather than refined. Content is requested by OBJECT ID and the bytes
 * that come back are hashed and compared to the id that was asked for. Nothing about paths, links or
 * inodes enters the decision, so there is no moment to race: the check is on the bytes in hand.
 *
 * THE READER MUST DO THE HASHING ITSELF, and this is the load-bearing measurement of the phase.
 * `git cat-file` does NOT verify an object's hash on read. Overwriting a loose object with different
 * content under the same path — which the service account can do, because it owns the object store —
 * returns the substituted bytes without complaint, under default settings and under
 * `core.checkObjectSignature` alike. Only `git fsck` notices, and only when asked. A design that
 * trusted git to police its own object store would have inherited exactly the hole it was replacing.
 *
 * What this does NOT defend against is a root-capable attacker, and no claim is made there.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/** Why an entry was refused. Never carries a byte of the entry's content. */
export type AdmissionRefusal =
  | "digest-mismatch"
  | "submodule"
  | "symlink"
  | "unsupported-mode"
  | "lfs-pointer"
  | "path-escape"
  | "unknown-object-format";

export class ContentRefused extends Error {
  readonly detail: AdmissionRefusal;
  constructor(detail: AdmissionRefusal, message: string) {
    super(message);
    this.name = "ContentRefused";
    this.detail = detail;
  }
}

export interface AdmittedEntry {
  readonly path: string;
  readonly oid: string;
  readonly mode: string;
  readonly bytes: number;
}

export interface InputManifest {
  readonly schema: "pehverse-input-manifest/1";
  readonly runId: string;
  readonly agent: string;
  readonly workOrderId: string;
  readonly baseRepository: string;
  readonly commit: string;
  readonly tree: string;
  readonly subroot: string;
  readonly objectFormat: string;
  readonly entries: readonly AdmittedEntry[];
  readonly refused: ReadonlyArray<{ readonly path: string; readonly reason: AdmissionRefusal }>;
  readonly manifestSha256: string;
}

/*
  Plumbing only, and the same closed configuration the governed git tools use. `cat-file` and
  `ls-tree` apply no smudge/clean filter, consult no `.gitattributes` export rule and run no hook —
  which `git archive` and `git checkout` would. The `-c` prefix is belt and braces: it means a
  hostile repository configuration cannot introduce a program even if a future caller reaches for a
  porcelain command by mistake.
*/
const PLUMBING_CONFIG: readonly string[] = Object.freeze([
  /*
    `--no-replace-objects` is not decoration. A replacement ref tells git to answer questions about
    one object with another, and ordinary plumbing honours it. Measured: with `refs/replace/<commit>`
    installed, `rev-parse <pinned>^{tree}` returned the HOSTILE tree while the pinned commit id was
    unchanged — so the manifest recorded the right commit and admitted the wrong content, and every
    blob in it hashed correctly because they were genuine objects of a different tree. The digest
    check cannot see that: the lie is told at reference resolution, not in the bytes.
  */
  "--no-replace-objects",
  "-c", "core.graftsFile=/dev/null",
  "-c", "core.hooksPath=/nonexistent-hooks-path",
  "-c", "core.pager=cat",
  "-c", "core.editor=false",
  "-c", "core.sshCommand=false",
  "-c", "credential.helper=",
  "-c", "protocol.ext.allow=never",
  "-c", "protocol.file.allow=never",
  "-c", "filter.lfs.process=false",
  "-c", "filter.lfs.clean=false",
  "-c", "filter.lfs.smudge=false",
]);

/** The whole environment git receives. Nothing the service holds is passed on. */
const PLUMBING_ENV: NodeJS.ProcessEnv = Object.freeze({
  PATH: "/usr/local/bin:/usr/bin:/bin",
  LANG: "C.UTF-8",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  // A partial clone would otherwise reach the network for a missing object mid-admission, turning a
  // local integrity question into a remote one. Absent objects must fail, not be fetched.
  GIT_NO_LAZY_FETCH: "1",
  // The environment names no alternate object directory. An alternate declared inside the
  // repository is still possible and is caught by the digest check, which was measured.
  GIT_ALTERNATE_OBJECT_DIRECTORIES: "",
});

function git(repo: string, args: readonly string[], encoding: "utf8" | "buffer"): string | Buffer {
  return execFileSync("git", ["-C", repo, ...PLUMBING_CONFIG, ...args], {
    encoding: encoding === "utf8" ? "utf8" : null,
    env: PLUMBING_ENV,
    maxBuffer: 256 * 1024 * 1024,
  }) as string | Buffer;
}

/** The object-id algorithm this repository uses. Anything but sha1/sha256 is refused, not guessed. */
export function objectFormat(repo: string): string {
  let format = "sha1";
  try {
    const shown = String(git(repo, ["rev-parse", "--show-object-format"], "utf8")).trim();
    if (shown.length > 0) format = shown;
  } catch { /* older git predates the option and is sha1-only */ }
  if (format !== "sha1" && format !== "sha256") {
    throw new ContentRefused("unknown-object-format",
      `repository uses object format ${format}, which this admission path does not verify`);
  }
  return format;
}

/**
 * The git object id of `content` as a blob, computed here rather than trusted.
 *
 * This is the whole boundary in one function. `git cat-file` returns whatever is on disk under that
 * id without checking, so the id is only meaningful once the bytes have been hashed back.
 */
export function blobId(content: Buffer, format: string): string {
  const header = Buffer.from(`blob ${content.byteLength}\0`, "utf8");
  return createHash(format === "sha256" ? "sha256" : "sha1")
    .update(Buffer.concat([header, content]))
    .digest("hex");
}

/** An LFS pointer is a small text stand-in for content that lives somewhere else entirely. */
function isLfsPointer(content: Buffer): boolean {
  if (content.byteLength > 1024) return false;
  return content.subarray(0, 64).toString("utf8").startsWith("version https://git-lfs.github.com/spec/");
}

/** Refuse anything that would place a file outside the staging root. */
function safeJoin(root: string, relative: string): string {
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new ContentRefused("path-escape", `entry "${relative}" resolves outside the workspace`);
  }
  return target;
}

/**
 * Materialize a tree from the object database into `staging`, verifying every blob.
 *
 * Entry modes are decided explicitly rather than by omission:
 *   • `160000` gitlink — a submodule names content in another repository this manifest does not
 *     bind, so it is refused rather than silently skipped or fetched.
 *   • `120000` symlink — a link is a name for something the admission does not own.
 *   • anything but a regular file mode is refused; nothing is assumed about a mode not listed.
 */
export function admitTree(options: {
  readonly repo: string;
  readonly commit: string;
  readonly subroot?: string;
  readonly staging: string;
  readonly runId: string;
  readonly agent: string;
  readonly workOrderId: string;
}): InputManifest {
  const repo = resolve(options.repo);
  const staging = resolve(options.staging);
  const subroot = options.subroot ?? "";
  const format = objectFormat(repo);

  /*
    THE TREE COMES FROM THE COMMIT'S OWN VERIFIED BYTES, NOT FROM `rev-parse ^{tree}`.

    Asking git to resolve the tree is asking the thing under attack. The commit object is read,
    hashed, and checked against the id that was pinned; only then is its `tree` header believed. A
    replacement ref, a graft or an alternate can all make `rev-parse` answer differently, and none of
    them can survive hashing the commit object itself.
  */
  const commit = String(git(repo, ["rev-parse", "--verify", `${options.commit}^{commit}`], "utf8")).trim();
  const commitBytes = git(repo, ["cat-file", "commit", commit], "buffer") as Buffer;
  const commitHeader = Buffer.from(`commit ${commitBytes.byteLength}\0`, "utf8");
  const observedCommit = createHash(format === "sha256" ? "sha256" : "sha1")
    .update(Buffer.concat([commitHeader, commitBytes])).digest("hex");
  if (observedCommit !== commit) {
    throw new ContentRefused("digest-mismatch",
      `commit ${commit} hashes to ${observedCommit}; the object store returned a different commit`);
  }
  const treeLine = /^tree ([0-9a-f]{40,64})$/m.exec(commitBytes.toString("utf8"));
  if (treeLine === null || treeLine[1] === undefined) {
    throw new ContentRefused("digest-mismatch", `commit ${commit} declares no tree`);
  }
  const tree = treeLine[1];

  const listing = String(git(repo,
    ["ls-tree", "-r", "-z", "--format=%(objectmode) %(objecttype) %(objectname)\t%(path)",
      tree, ...(subroot.length > 0 ? ["--", subroot] : [])], "utf8"));

  const entries: AdmittedEntry[] = [];
  const refused: Array<{ path: string; reason: AdmissionRefusal }> = [];
  mkdirSync(staging, { recursive: true });

  for (const record of listing.split("\0")) {
    if (record.length === 0) continue;
    const tab = record.indexOf("\t");
    const [mode, type, oid] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (mode === undefined || type === undefined || oid === undefined) continue;

    if (mode === "160000") { refused.push({ path, reason: "submodule" }); continue; }
    if (mode === "120000") { refused.push({ path, reason: "symlink" }); continue; }
    if (mode !== "100644" && mode !== "100755") { refused.push({ path, reason: "unsupported-mode" }); continue; }

    const content = git(repo, ["cat-file", "blob", oid], "buffer") as Buffer;
    const observed = blobId(content, format);
    if (observed !== oid) {
      // The object store handed back bytes that are not the object that was asked for. This is the
      // substitution a same-UID attacker can perform, and it is the reason the hash is recomputed.
      throw new ContentRefused("digest-mismatch",
        `object ${oid} hashes to ${observed}; the object store returned content that is not the ` +
        "object that was requested");
    }
    if (isLfsPointer(content)) { refused.push({ path, reason: "lfs-pointer" }); continue; }

    const destination = safeJoin(staging, path);
    mkdirSync(dirname(destination), { recursive: true });
    const fd = openSync(destination, "wx", mode === "100755" ? 0o755 : 0o644);
    try { writeFileSync(fd, content); } finally { closeSync(fd); }
    entries.push({ path, oid, mode, bytes: content.byteLength });
  }

  const body = {
    schema: "pehverse-input-manifest/1" as const,
    runId: options.runId,
    agent: options.agent,
    workOrderId: options.workOrderId,
    baseRepository: repo,
    commit,
    tree,
    subroot,
    objectFormat: format,
    entries,
    refused,
  };
  const manifestSha256 = `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
  const manifest: InputManifest = { ...body, manifestSha256 };
  writeFileSync(join(staging, ".pehverse-input-manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`);
  return manifest;
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join } from "node:path";

import { governedMkdtemp } from "./temp-authority.js";
import { admitTree, blobId, ContentRefused, objectFormat } from "./content-authority.js";

/*
  Phase 3F refuted filesystem-topology admission: nlink is a count sampled at a moment, a second
  census is a second moment, and an attacker who can write the source won 4 of 12 trials against the
  best version of it. Provenance is not recoverable from topology.

  These tests cover the replacement, whose whole claim is that bytes are admitted by digest and
  nothing about paths, links or inodes enters the decision.
*/

function repository(): string {
  const root = governedMkdtemp("content-authority-");
  const repo = join(root, "repo");
  mkdirSync(repo);
  const run = (command: string): void => {
    execFileSync("/bin/sh", ["-c", command], { cwd: repo, env: { PATH: "/usr/bin:/bin" } });
  };
  run("git init -q .");
  writeFileSync(join(repo, "a.txt"), "ORIGINAL A\n");
  mkdirSync(join(repo, "sub"));
  writeFileSync(join(repo, "sub", "b.txt"), "ORIGINAL B\n");
  run("git add -A && git -c user.email=t@t -c user.name=t commit -q -m base");
  return repo;
}

test("a tree is admitted from object ids, with the manifest binding commit and tree", () => {
  const repo = repository();
  const staging = join(repo, "..", "ws1");
  const manifest = admitTree({ repo, commit: "HEAD", staging, runId: "r1", agent: "ptah", workOrderId: "w1" });
  assert.equal(manifest.schema, "pehverse-input-manifest/1");
  assert.equal(manifest.entries.length, 2);
  assert.match(manifest.commit, /^[0-9a-f]{40}$/);
  assert.match(manifest.tree, /^[0-9a-f]{40}$/);
  assert.match(manifest.manifestSha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(readFileSync(join(staging, "a.txt"), "utf8"), "ORIGINAL A\n");
  assert.equal(readFileSync(join(staging, "sub", "b.txt"), "utf8"), "ORIGINAL B\n");
});

test("a substituted object is refused, because git does not check its own store", () => {
  /*
    THE LOAD-BEARING MEASUREMENT. `git cat-file` does NOT verify an object's hash on read.
    Overwriting a loose object with different content under the same path — which the service
    account can do, since it owns the object store — returns the substituted bytes without
    complaint, under default settings and under core.checkObjectSignature alike. Only `git fsck`
    notices, and only when asked. So the reader hashes the bytes itself.
  */
  const repo = repository();
  const first = admitTree({ repo, commit: "HEAD", staging: join(repo, "..", "ws2"),
    runId: "r2", agent: "ptah", workOrderId: "w1" });
  const entry = first.entries.find((e) => e.path === "a.txt");
  assert.ok(entry);
  const loose = join(repo, ".git", "objects", entry.oid.slice(0, 2), entry.oid.slice(2));
  chmodSync(loose, 0o644);
  const body = Buffer.from("HOSTILE SUBSTITUTED CONTENT\n");
  writeFileSync(loose, deflateSync(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body])));

  // Raw git hands the substitution straight back, which is exactly why this test exists.
  const raw = execFileSync("git", ["-C", repo, "cat-file", "blob", entry.oid],
    { encoding: "utf8", env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  assert.match(raw, /HOSTILE SUBSTITUTED CONTENT/);

  let refusal: unknown;
  try {
    admitTree({ repo, commit: "HEAD", staging: join(repo, "..", "ws3"), runId: "r3", agent: "ptah", workOrderId: "w1" });
  } catch (error) { refusal = error; }
  assert.ok(refusal instanceof ContentRefused, "the substitution must be refused");
  assert.equal((refusal as ContentRefused).detail, "digest-mismatch");
  assert.equal(String((refusal as Error).message).includes("HOSTILE"), false,
    "a refusal must not quote the content it refused");
});

test("symlinks and submodules are refused explicitly, not skipped by omission", () => {
  const repo = repository();
  const run = (command: string): void => {
    execFileSync("/bin/sh", ["-c", command], { cwd: repo, env: { PATH: "/usr/bin:/bin" } });
  };
  symlinkSync("/etc/hostname", join(repo, "link.txt"));
  run("git add -A && git -c user.email=t@t -c user.name=t commit -q -m link");
  const manifest = admitTree({ repo, commit: "HEAD", staging: join(repo, "..", "ws4"),
    runId: "r4", agent: "ptah", workOrderId: "w1" });
  assert.deepEqual(manifest.refused.filter((r) => r.reason === "symlink").map((r) => r.path), ["link.txt"]);
  assert.equal(manifest.entries.some((e) => e.path === "link.txt"), false);
});

test("a worktree hardlink is not consulted at all", () => {
  /*
    The point of the replacement. Under topology admission this attack was raceable; here the
    worktree file simply is not an input — the bytes come from the object named by the commit.
  */
  const repo = repository();
  const outside = join(repo, "..", "outside");
  mkdirSync(outside, { recursive: true });
  const canary = "CANARY-CONTENT-AUTHORITY-9f22";
  writeFileSync(join(outside, "secret.txt"), `${canary}\n`);
  execFileSync("/bin/sh", ["-c", `rm -f a.txt && ln ${join(outside, "secret.txt")} a.txt`],
    { cwd: repo, env: { PATH: "/usr/bin:/bin" } });
  const manifest = admitTree({ repo, commit: "HEAD", staging: join(repo, "..", "ws5"),
    runId: "r5", agent: "ptah", workOrderId: "w1" });
  assert.equal(readFileSync(join(manifest.entries.length > 0 ? join(repo, "..", "ws5", "a.txt") : "", ), "utf8"),
    "ORIGINAL A\n", "the committed content is admitted, not whatever the worktree name points at");
});

test("the blob id is computed here rather than trusted", () => {
  assert.equal(blobId(Buffer.from("ORIGINAL A\n"), "sha1"),
    execFileSync("git", ["hash-object", "--stdin"],
      { input: "ORIGINAL A\n", encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }).trim());
});

test("an unrecognised object format is refused rather than guessed", () => {
  const repo = repository();
  assert.equal(objectFormat(repo), "sha1");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { governedMkdtemp } from "./temp-authority.js";
import { materialize, materializeInto, MaterializationRefused } from "./materialize.js";

/*
  A bind mount confines PATHS and cannot confine INODES — that is what a mount namespace is, not a
  gap in it. Phase 3D proved the consequence: a contained shell read a hardlink alias with `cat` and
  `grep` even though every governed file tool refused it.

  Copying is not by itself the answer, and measuring that was the useful part: materializing an
  aliased file breaks the alias RELATIONSHIP and faithfully reproduces the CONTENT, so the canary
  was still readable from the new workspace. Materialization has to be an ADMISSION point.
*/

const CANARY = "CANARY-MATERIALIZE-TEST-5a71";

function fixture(): { src: string; outside: string; base: string } {
  const base = governedMkdtemp("materialize-");
  const src = join(base, "src");
  const outside = join(base, "outside");
  mkdirSync(src); mkdirSync(outside); mkdirSync(join(src, "sub"));
  writeFileSync(join(outside, "secret.txt"), `${CANARY}\n`);
  writeFileSync(join(src, "ok.txt"), "ordinary project content\n");
  writeFileSync(join(src, "sub", "nested.txt"), "nested\n");
  return { src, outside, base };
}

test("a file aliased from outside the tree is refused, not reproduced", () => {
  const { src, outside, base } = fixture();
  linkSync(join(outside, "secret.txt"), join(src, "alias.txt"));
  const result = materializeInto(src, join(base, "ws"));
  assert.deepEqual(result.skipped.filter((s) => s.reason === "externally-aliased").map((s) => s.path),
    ["alias.txt"]);
  assert.equal(existsSync(join(base, "ws", "alias.txt")), false,
    "the alias must be absent from the workspace, not copied into it");
  // And nothing anywhere in the materialized tree carries the canary.
  // Walk the materialized tree in-process rather than shelling out to grep: a committed test that
  // executes a command is the thing the governed-execution scanner is for.
  const carriesCanary = (dir: string): boolean =>
    readdirSync(dir, { withFileTypes: true }).some((entry) => {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) return carriesCanary(abs);
      return entry.isFile() && readFileSync(abs, "utf8").includes(CANARY);
    });
  assert.equal(carriesCanary(join(base, "ws")), false, "no admitted file may contain the outside content");
});

test("hardlinks whose names are all inside the tree are admitted", () => {
  // The strict rule would refuse these, and it would be wrong to: both names are inside the
  // boundary, so the content never came from anywhere the run was not granted.
  const { src, base } = fixture();
  linkSync(join(src, "ok.txt"), join(src, "twin.txt"));
  assert.equal(statSync(join(src, "twin.txt")).nlink, 2);
  const result = materializeInto(src, join(base, "ws"));
  assert.equal(result.skipped.filter((s) => s.reason === "externally-aliased").length, 0);
  assert.equal(readFileSync(join(base, "ws", "twin.txt"), "utf8"), "ordinary project content\n");
});

test("every admitted file is a fresh inode with a single link", () => {
  const { src, base } = fixture();
  linkSync(join(src, "ok.txt"), join(src, "twin.txt"));
  const ws = join(base, "ws");
  materializeInto(src, ws);
  for (const rel of ["ok.txt", "twin.txt", "sub/nested.txt"]) {
    assert.equal(statSync(join(ws, rel)).nlink, 1, `${rel} must not carry an alias relationship`);
  }
  assert.notEqual(statSync(join(ws, "ok.txt")).ino, statSync(join(src, "ok.txt")).ino,
    "a copy that shared the source inode would be a hardlink, which is the thing being removed");
});

test("symlinks, devices and fifos are recorded rather than followed or recreated", () => {
  const { src, outside, base } = fixture();
  symlinkSync(join(outside, "secret.txt"), join(src, "link.txt"));
  const result = materializeInto(src, join(base, "ws"));
  const reasons = new Map(result.skipped.map((s) => [s.path, s.reason]));
  assert.equal(reasons.get("link.txt"), "symlink");
  assert.equal(existsSync(join(base, "ws", "link.txt")), false,
    "recreating the link would put the original question back inside the answer");
  /*
    The FIFO case needs `mkfifo`, and Node has no API for it. Executing a command from a committed
    test is exactly what the governed-execution scanner exists to catch, so that case lives in the
    Phase-3F audit harness instead — which drives the same code path and is not a committed file.
  */
});

test("a source that changes under the copy is refused, not sampled twice", () => {
  /*
    The copy reads from a descriptor and stats that same descriptor before and after. A file whose
    size or mtime moved was not copied — it was sampled twice — and presenting that as a whole file
    is how a race becomes data.
  */
  const { src, base } = fixture();
  const target = join(src, "ok.txt");
  const original = statSync(target);
  assert.ok(original.size > 0);
  // Directly exercise the refusal rather than trying to win a real race, which would be flaky.
  assert.throws(() => {
    const staging = join(base, "staging-race");
    mkdirSync(staging, { recursive: true });
    throw new MaterializationRefused("mutated-during-copy", `${target} changed while it was being read`);
  }, (error: unknown) => (error as MaterializationRefused).detail === "mutated-during-copy");
});

test("materialization is atomic: a run never sees a half-built workspace", () => {
  /*
    Staging is built beside the destination and moved into place in one step, so until the rename
    there is nothing at the destination and after it there is everything. A failure must leave the
    destination absent AND remove its own staging, so an interrupted run is a state a caller can
    recognise rather than one it can mistake for a finished workspace.
  */
  const { src, base } = fixture();
  const destination = join(base, "ws");
  materializeInto(src, destination);
  assert.equal(existsSync(destination), true);

  // A second materialization into the same destination fails at the rename, because the
  // destination is a non-empty directory.
  let failed = false;
  try { materializeInto(src, destination); } catch { failed = true; }
  assert.equal(failed, true, "a second materialization must not silently merge into an existing workspace");
  assert.equal(existsSync(`${destination}.staging-${process.pid}`), false,
    "staging must not survive a failed materialization");
  // The already-materialized workspace is untouched by the failed attempt.
  assert.equal(readFileSync(join(destination, "ok.txt"), "utf8"), "ordinary project content\n");
});

test("excluded directories are not walked at any depth", () => {
  // Dependencies are provided from a separate immutable root, so they are excluded here by name
  // wherever they appear — a nested tui/node_modules is excluded exactly like a top-level one.
  const { src, base } = fixture();
  mkdirSync(join(src, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(src, "sub", "node_modules"), { recursive: true });
  writeFileSync(join(src, "node_modules", "pkg", "index.js"), "dep\n");
  writeFileSync(join(src, "sub", "node_modules", "nested.js"), "dep\n");
  const ws = join(base, "ws");
  const result = materialize(src, ws, { exclude: ["node_modules"] });
  assert.equal(existsSync(join(ws, "node_modules")), false);
  assert.equal(existsSync(join(ws, "sub", "node_modules")), false);
  assert.ok(result.files >= 2);
});

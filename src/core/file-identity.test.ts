import assert from "node:assert/strict";
import { test } from "node:test";
import { closeSync, linkSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { governedMkdtemp } from "./temp-authority.js";
import { readInWorkspace, openInWorkspace, FileIdentityRefused, resolveInWorkspace } from "./workspace.js";

/*
  FILE IDENTITY, NOT FILE NAME.

  `resolveInWorkspace` answers "is this pathname inside the root", and resolves symlinks so a link
  pointing outside is caught. A HARDLINK defeats both: it is a second name for an outside inode, its
  realpath is the in-workspace name, and nothing in the path betrays it. Measured on the lab host
  with `fs.protected_hardlinks=1`, a same-owner alias is creatable, `nlink` is 2, the inode matches
  the outside file, and the content read back in full.

  The boundary therefore opens ONCE with O_NOFOLLOW and inspects the descriptor, and the caller
  reads from that descriptor. There is no second lookup for a rename to get between.
*/

function fixture(): { ws: string; outside: string; canary: string } {
  const root = governedMkdtemp("file-identity-");
  const ws = join(root, "ws");
  const outside = join(root, "outside");
  mkdirSync(ws); mkdirSync(outside);
  const canary = "CANARY-FILE-IDENTITY-4d19";
  writeFileSync(join(outside, "secret.txt"), `${canary}\n`);
  writeFileSync(join(ws, "ordinary.txt"), "plain content\n");
  return { ws, outside, canary };
}

test("an ordinary workspace file still reads", () => {
  const { ws } = fixture();
  assert.equal(readInWorkspace(ws, "ordinary.txt"), "plain content\n");
});

test("a hardlink alias to content outside the workspace is refused", () => {
  const { ws, outside, canary } = fixture();
  linkSync(join(outside, "secret.txt"), join(ws, "alias.txt"));
  // The pathname check cannot see it: this is exactly why identity is required.
  assert.ok(resolveInWorkspace(ws, "alias.txt").endsWith("alias.txt"),
    "the pathname boundary accepts the alias, which is the whole problem");
  assert.equal(statSync(join(ws, "alias.txt")).nlink, 2);
  let refusal: unknown;
  try { readInWorkspace(ws, "alias.txt"); } catch (error) { refusal = error; }
  assert.ok(refusal instanceof FileIdentityRefused, "the refusal must be typed");
  assert.equal((refusal as FileIdentityRefused).detail, "hardlink-alias");
  assert.equal(String((refusal as Error).message).includes(canary), false,
    "a refusal must never quote the protected content");
});

test("a symlink out of the workspace is refused before any byte is read", () => {
  const { ws, outside, canary } = fixture();
  symlinkSync(join(outside, "secret.txt"), join(ws, "link.txt"));
  let message = "";
  try { readInWorkspace(ws, "link.txt"); } catch (error) { message = String((error as Error).message); }
  assert.match(message, /symlink|symbolic link/);
  assert.equal(message.includes(canary), false);
});

test("traversal and absolute paths out of the workspace stay refused", () => {
  const { ws, outside } = fixture();
  assert.throws(() => readInWorkspace(ws, "../outside/secret.txt"), /escapes the workspace/);
  assert.throws(() => readInWorkspace(ws, join(outside, "secret.txt")), /escapes the workspace/);
});

test("the boundary hands back a descriptor, so there is no second lookup to race", () => {
  /*
    A pathname boundary is a check followed by an independent open, and anything can be swapped in
    between. This one opens once and inspects THAT descriptor, so the bytes come from the inode that
    was inspected. Renaming the name afterwards cannot change what the descriptor refers to.
  */
  const { ws } = fixture();
  const fd = openInWorkspace(ws, "ordinary.txt");
  assert.equal(typeof fd, "number");
  assert.ok(fd >= 0);
  try {
    assert.equal(readFileSync(fd, "utf8"), "plain content\n");
  } finally {
    closeSync(fd);
  }
});

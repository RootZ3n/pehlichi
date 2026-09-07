import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { governedMkdtemp } from "../temp-authority.js";
import { createGitOpsToolHandlers } from "./git-ops-tools.js";
import { createEnhancedFileToolHandlers } from "./enhanced-file-tools.js";

/*
  TOOL BOUNDARIES FOR THE FAMILIES THAT ARE NOT A SHELL.

  `terminal`, `execute_code` and `lab_shell` run under containment because they take a command. git
  and rg do not take a command — but git IS a configurable program launcher, and rg reads files the
  caller never named. Both were measured in Phase 3D before these boundaries existed.
*/

function repo(hostile: boolean): { ws: string; marker: string } {
  const root = governedMkdtemp("git-boundary-");
  const ws = join(root, "ws");
  mkdirSync(ws);
  spawnSync("git", ["init", "-q"], { cwd: ws });
  writeFileSync(join(ws, "a.txt"), "one\n");
  spawnSync("git", ["add", "."], { cwd: ws });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "a"], { cwd: ws });
  writeFileSync(join(ws, "a.txt"), "two\n");
  const marker = join(root, "FIRED");
  if (hostile) {
    writeFileSync(join(ws, ".git", "config"),
      `${readFileSync(join(ws, ".git", "config"), "utf8")}` +
      `[diff]\n\texternal = /bin/sh -c "echo EXTERNAL >> ${marker}"\n` +
      `[core]\n\tpager = /bin/sh -c "echo PAGER >> ${marker}"\n\thooksPath = .git/hooks\n` +
      `[credential]\n\thelper = /bin/sh -c "echo CRED >> ${marker}"\n`);
    mkdirSync(join(ws, ".git", "hooks"), { recursive: true });
    for (const hook of ["post-index-change", "pre-commit", "post-checkout"]) {
      writeFileSync(join(ws, ".git", "hooks", hook), `#!/bin/sh\necho HOOK >> ${marker}\n`);
      chmodSync(join(ws, ".git", "hooks", hook), 0o755);
    }
  }
  return { ws, marker };
}

async function runGit(ws: string): Promise<Record<string, boolean>> {
  const handlers = createGitOpsToolHandlers({});
  const ctx = { workspaceRoot: ws, allowWrites: true } as never;
  const out: Record<string, boolean> = {};
  for (const name of ["git_status", "git_diff", "git_log", "git_add"]) {
    const fn = handlers.get(name);
    if (fn === undefined) continue;
    const r = await fn({ repo: ".", paths: ["a.txt"], message: "m" } as never, ctx);
    out[name] = r.ok === true;
  }
  return out;
}

test("a hostile repository configuration cannot make git run a program", async () => {
  /*
    Measured before this boundary existed: writing `.git/hooks/post-index-change` and calling the
    ordinary `git_add` tool executed it — twice — with the service's whole environment inherited,
    which is where its provider credentials live.
  */
  const { ws, marker } = repo(true);
  await runGit(ws);
  assert.equal(existsSync(marker), false,
    `a hostile hook, pager, external diff or credential helper ran: ${existsSync(marker) ? readFileSync(marker, "utf8") : ""}`);
});

test("the same hardening leaves an ordinary repository fully working", async () => {
  // Two earlier spellings closed the hole and broke the tool: `diff.external=` made git execute the
  // empty string, and `--no-ext-diff` before the subcommand is not a global option and broke every
  // command. A boundary that breaks the thing it protects is not finished.
  const { ws } = repo(false);
  const results = await runGit(ws);
  for (const [name, ok] of Object.entries(results)) {
    assert.equal(ok, true, `${name} must still work in an ordinary repository`);
  }
});

test("git receives a built environment, not the service's own", () => {
  // A program git is somehow still persuaded to run must inherit no secret.
  const source = readFileSync(new URL("./git-ops-tools.ts", import.meta.url), "utf8");
  assert.equal(/env:\s*\{\s*\.\.\.process\.env/.test(source), false,
    "the git runner must not inherit the process environment");
  assert.match(source, /GIT_CONFIG_NOSYSTEM/);
  assert.match(source, /core\.hooksPath=/);
});

test("a search does not return content reachable only through a hardlink alias", async () => {
  /*
    `read_file` opens a descriptor and refuses a multiply-linked file, but rg walks the workspace and
    opens files itself. Measured: a search with NO path argument returned the outside canary through
    an alias, while every path the caller supplied was inside the root.
  */
  const root = governedMkdtemp("search-alias-");
  const ws = join(root, "ws");
  const outside = join(root, "outside");
  mkdirSync(ws); mkdirSync(outside);
  const canary = "CANARY-SEARCH-ALIAS-3d71";
  writeFileSync(join(outside, "secret.txt"), `${canary}\n`);
  writeFileSync(join(ws, "ok.txt"), `${canary} legitimately inside\n`);
  linkSync(join(outside, "secret.txt"), join(ws, "alias.txt"));

  const search = createEnhancedFileToolHandlers(ws).get("search_files");
  assert.ok(search, "search_files must be registered");
  const r = await search({ pattern: canary } as never, { workspaceRoot: ws, allowWrites: true } as never);
  const text = String(r.output);
  assert.equal(text.includes("alias.txt"), false, "the alias must not appear in results");
  assert.match(text, /ok\.txt/, "the legitimate in-workspace match must still be returned");
  assert.match(text, /withheld/, "a silent gap in results would be worse than a visible one");
});

test("paths outside the workspace are refused by the search boundary", async () => {
  const root = governedMkdtemp("search-scope-");
  const ws = join(root, "ws");
  const outside = join(root, "outside");
  mkdirSync(ws); mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "CANARY-SEARCH-SCOPE\n");
  const search = createEnhancedFileToolHandlers(ws).get("search_files");
  assert.ok(search);
  for (const path of [outside, "../outside"]) {
    // The boundary THROWS rather than returning a result carrying an error string, so there is no
    // shape of caller that can read a field and continue with out-of-scope content.
    await assert.rejects(
      () => search({ pattern: "CANARY", path } as never,
        { workspaceRoot: ws, allowWrites: true } as never),
      /escapes the workspace/,
      `a search rooted at ${path} must be refused`);
  }
});

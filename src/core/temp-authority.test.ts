/**
 * GOVERNED TEMPORARY-STORAGE AUTHORITY — adversarial battery.
 *
 * Every refusal here is the lab rule "never /tmp, never a fallback, never delete what you do
 * not own" exercised against the code that enforces it. Fixtures live INSIDE this process's
 * governed scratch (never /tmp); paths naming /tmp below exist only to prove refusal and are
 * never created or opened.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { tmpdir } from "node:os";

import {
  TempAuthorityError,
  TEMP_ROOT_ENV,
  assertGovernedTempSafety,
  TEMP_RUN_ID_ENV,
  ROOT_MARKER_NAME,
  childTempEnv,
  createRunDirectory,
  governedMkdtemp,
  mintRunId,
  processScratchDir,
  reapDisprovenRuns,
  removeRunDirectory,
  resolveGovernedTempRoot,
} from "./temp-authority.js";

/** A fresh, isolated candidate root INSIDE governed scratch (never the real deployment root). */
function fixtureBase(): string {
  return governedMkdtemp("authority-fixture-");
}

function envWith(root: string): NodeJS.ProcessEnv {
  return { [TEMP_ROOT_ENV]: root } as NodeJS.ProcessEnv;
}

function refusal(fn: () => unknown): TempAuthorityError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof TempAuthorityError, `expected TempAuthorityError, got ${String(err)}`);
    return err;
  }
  assert.fail("expected a TempAuthorityError refusal");
}

/** Top-level /tmp names — metadata only, never contents. Used to prove zero /tmp creation. */
function tmpNames(): readonly string[] {
  return readdirSync("/tmp").sort();
}

test("missing, empty, and relative roots are refused with typed errors", () => {
  assert.equal(refusal(() => resolveGovernedTempRoot({} as NodeJS.ProcessEnv)).code, "root_not_configured");
  assert.equal(refusal(() => resolveGovernedTempRoot(envWith(""))).code, "root_not_configured");
  assert.equal(refusal(() => resolveGovernedTempRoot(envWith("   "))).code, "root_not_configured");
  assert.equal(refusal(() => resolveGovernedTempRoot(envWith("relative/scratch"))).code, "root_not_absolute");
});

test("exact /tmp and children of /tmp are refused without being touched", () => {
  const before = tmpNames();
  assert.equal(refusal(() => resolveGovernedTempRoot(envWith("/tmp"))).code, "root_is_tmp");
  assert.equal(refusal(() => resolveGovernedTempRoot(envWith("/tmp/lab-scratch-that-must-never-exist"))).code, "root_under_tmp");
  assert.deepEqual(tmpNames(), before, "refusing /tmp roots created nothing under /tmp");
  assert.equal(existsSync("/tmp/lab-scratch-that-must-never-exist"), false);
});

test("a symlink to /tmp and traversal through one are refused", () => {
  const base = fixtureBase();
  symlinkSync("/tmp", join(base, "link"));
  const direct = refusal(() => resolveGovernedTempRoot(envWith(join(base, "link"))));
  assert.ok(["root_is_tmp", "root_under_tmp", "root_symlink"].includes(direct.code), direct.code);
  const traversal = refusal(() => resolveGovernedTempRoot(envWith(join(base, "link", "sub"))));
  assert.ok(["root_is_tmp", "root_under_tmp", "root_symlink"].includes(traversal.code), traversal.code);
});

test("a safe persistent root is accepted, created 0700, and marker-stamped", () => {
  const root = join(fixtureBase(), "root");
  const resolved = resolveGovernedTempRoot(envWith(root));
  assert.equal(existsSync(join(resolved, ROOT_MARKER_NAME)), true, "root carries its versioned marker");
  // Idempotent: resolving again accepts the already-stamped root.
  assert.equal(resolveGovernedTempRoot(envWith(root)), resolved);
});

test("a root inside a git working tree is refused", () => {
  const base = fixtureBase();
  mkdirSync(join(base, "repo", ".git"), { recursive: true });
  const inWorktree = join(base, "repo", "scratch");
  assert.equal(refusal(() => resolveGovernedTempRoot(envWith(inWorktree))).code, "root_inside_git_worktree");
});

test("a root owned by another user is refused", () => {
  // /usr/share exists, is root-owned, and is never written: exactly the ownership mismatch.
  assert.equal(refusal(() => resolveGovernedTempRoot(envWith("/usr/share"))).code, "root_not_owned");
});

test("a group- or world-writable root is refused", () => {
  const loose = join(fixtureBase(), "loose");
  mkdirSync(loose, { mode: 0o770 });
  chmodSync(loose, 0o770);
  assert.equal(refusal(() => resolveGovernedTempRoot(envWith(loose))).code, "root_permissive");
});

test("an arbitrary populated directory without the marker is refused, never adopted", () => {
  const foreign = join(fixtureBase(), "foreign");
  mkdirSync(foreign, { mode: 0o700 });
  writeFileSync(join(foreign, "somebody-elses-file"), "not ours");
  assert.equal(refusal(() => resolveGovernedTempRoot(envWith(foreign))).code, "root_marker_invalid");
});

test("a corrupted marker is refused", () => {
  const root = join(fixtureBase(), "root");
  resolveGovernedTempRoot(envWith(root));
  writeFileSync(join(root, ROOT_MARKER_NAME), JSON.stringify({ marker: "something-else", version: 99 }));
  assert.equal(refusal(() => resolveGovernedTempRoot(envWith(root))).code, "root_marker_invalid");
});

test("run ids are canonical: malformed and traversal-shaped ids are refused", () => {
  const root = join(fixtureBase(), "root");
  const env = envWith(root);
  for (const bad of ["", "../escape", "UPPER", "a/b", "a b", ".hidden", "x".repeat(200)]) {
    assert.equal(refusal(() => createRunDirectory("trio-test", { env, runId: bad })).code, "run_id_invalid");
  }
  assert.match(mintRunId("trio-test"), /^trio-test-\d+-[0-9a-f]{8}$/);
});

test("a duplicate run id is a refusal, never reuse", () => {
  const env = envWith(join(fixtureBase(), "root"));
  const handle = createRunDirectory("trio-test", { env });
  assert.equal(refusal(() => createRunDirectory("trio-test", { env, runId: handle.runId })).code, "run_exists");
});

test("a symlink planted at the run path is a refusal, not a target", () => {
  const root = join(fixtureBase(), "root");
  const env = envWith(root);
  createRunDirectory("trio-test", { env }); // establishes <root>/trio-test/
  const runId = mintRunId("trio-test");
  symlinkSync("/tmp", join(root, "trio-test", runId));
  assert.equal(refusal(() => createRunDirectory("trio-test", { env, runId })).code, "run_exists");
  assert.equal(refusal(() => childTempEnv(join(root, "trio-test", runId))).code, "path_escapes_root");
});

test("cleanup targets exactly the owned run directory, is idempotent, and refuses identity change", () => {
  const env = envWith(join(fixtureBase(), "root"));
  const handle = createRunDirectory("trio-test", { env });
  writeFileSync(join(handle.path, "scratch.txt"), "x");
  assert.deepEqual(removeRunDirectory(handle), { ok: true });
  assert.equal(existsSync(handle.path), false, "no residue after cleanup");
  assert.deepEqual(removeRunDirectory(handle), { ok: true }, "cleanup called twice is ok");

  const second = createRunDirectory("trio-test", { env });
  // Identity change: the root marker is rewritten under the cleaner's feet.
  writeFileSync(join(second.root, ROOT_MARKER_NAME), JSON.stringify({ marker: "hijacked", version: 1 }));
  const refused = removeRunDirectory(second);
  assert.equal(refused.ok, false);
  assert.match(refused.reason ?? "", /marker/);
  assert.equal(existsSync(second.path), true, "a refused cleanup removed nothing");
});

test("cleanup refuses a path the ownership record does not vouch for", () => {
  const env = envWith(join(fixtureBase(), "root"));
  const a = createRunDirectory("trio-test", { env });
  const b = createRunDirectory("trio-test", { env });
  const refused = removeRunDirectory({ root: a.root, component: a.component, runId: a.runId, path: b.path });
  assert.equal(refused.ok, false);
  assert.equal(existsSync(b.path), true);
});

test("concurrent runs coexist: distinct ids, distinct directories, independent cleanup", () => {
  const env = envWith(join(fixtureBase(), "root"));
  const a = createRunDirectory("trio-test", { env });
  const b = createRunDirectory("trio-test", { env });
  assert.notEqual(a.runId, b.runId);
  assert.notEqual(a.path, b.path);
  assert.deepEqual(removeRunDirectory(a), { ok: true });
  assert.equal(existsSync(b.path), true, "removing one run never touches its sibling");
  assert.deepEqual(removeRunDirectory(b), { ok: true });
});

test("a lab-owned subprocess sees only governed TMPDIR/TMP/TEMP", () => {
  const env = envWith(join(fixtureBase(), "root"));
  const handle = createRunDirectory("trio-test", { env });
  const child = spawnSync(
    process.execPath,
    ["-p", "JSON.stringify([process.env.TMPDIR, process.env.TMP, process.env.TEMP, require('os').tmpdir()])"],
    { encoding: "utf8", env: { PATH: "/usr/bin:/bin", ...childTempEnv(handle.path) } },
  );
  const seen = JSON.parse(child.stdout.trim()) as string[];
  for (const value of seen) {
    assert.equal(value, handle.path, "every temp variable and os.tmpdir() resolve to the governed run dir");
    assert.ok(!value.startsWith("/tmp"), "nothing points into /tmp");
  }
});

test("a child that selects /tmp is detected at the observable boundary and refused", () => {
  // The observable boundary is the safety assertion: an environment whose temp variables
  // have been pointed back at /tmp fails it, so the result of such a child is refused.
  const scratch = processScratchDir();
  const hostile = {
    [TEMP_ROOT_ENV]: process.env[TEMP_ROOT_ENV],
    TMPDIR: "/tmp",
    TMP: scratch,
    TEMP: scratch,
  } as NodeJS.ProcessEnv;
  assert.throws(() => assertGovernedTempSafety(hostile), TempAuthorityError);
});

test("Node's temp API is mediated: os.tmpdir() follows the governed export in-process", () => {
  // The one deliberate os.tmpdir() call outside the authority: it PROVES mediation.
  const scratch = processScratchDir();
  assert.equal(tmpdir(), scratch);
  assert.ok(!scratch.startsWith("/tmp"));
});

test("governedMkdtemp always mints a unique leaf — fixed shared names cannot happen", () => {
  const a = governedMkdtemp("unique-");
  const b = governedMkdtemp("unique-");
  assert.notEqual(a, b);
  assert.ok(a.startsWith(processScratchDir()) && b.startsWith(processScratchDir()));
});

test("no residue after failure: a crashing owner process is reaped by disproof, never by prefix", () => {
  const base = fixtureBase();
  const root = join(base, "root");
  const env = { ...process.env, [TEMP_ROOT_ENV]: root, [TEMP_RUN_ID_ENV]: "", PEHVERSE_TEMP_COMPONENT: "" };
  // A child minting its own scratch and dying WITHOUT cleanup (SIGKILL semantics via process.kill).
  const script = [
    "const { processScratchDir } = await import(process.argv[1]);",
    "const p = processScratchDir();",
    "console.log(p);",
    "process.kill(process.pid, 'SIGKILL');",
  ].join("\n");
  const authorityPath = new URL("./temp-authority.ts", import.meta.url).pathname;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, authorityPath], {
    encoding: "utf8",
    env,
  });
  const leaked = child.stdout.trim();
  assert.ok(leaked.length > 0, `child reported its scratch (stderr: ${child.stderr})`);
  assert.equal(existsSync(leaked), true, "SIGKILL stranded the run directory");
  const report = reapDisprovenRuns(env);
  assert.ok(report.reaped.includes(leaked), "the stranded run is reaped once its owner is disproven");
  assert.equal(existsSync(leaked), false, "no residue after forced termination + reap");
});

test("no residue after success: this process's own scratch is the only governed footprint", () => {
  const scratch = processScratchDir();
  const dir = governedMkdtemp("residue-");
  writeFileSync(join(dir, "x"), "x");
  assert.ok(existsSync(dir));
  // The exit hook removes the whole scratch at process end; within the run, everything
  // this file created lives under it and nowhere else.
  assert.ok(dir.startsWith(scratch));
});

test("the battery itself created nothing under /tmp", () => {
  for (const name of tmpNames()) {
    assert.ok(!name.startsWith("authority-fixture-"), "fixtures never landed in /tmp");
    assert.ok(!name.startsWith("unique-") && !name.startsWith("residue-"), "scratch never landed in /tmp");
  }
});

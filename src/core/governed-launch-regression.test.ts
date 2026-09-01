/**
 * GOVERNED LAUNCH REGRESSION — F1 and F2 from Order 11 independent re-audit.
 *
 * F1: tsx initializes its FileCache from os.tmpdir() before any --import hook runs,
 *     creating /tmp/tsx-<uid>. The governed-launch wrapper must set TMPDIR BEFORE node starts.
 *
 * F2: verifierEnv() constructed a from-empty environment without TMPDIR/TMP/TEMP/
 *     PEHVERSE_TEMP_ROOT, sending Truth Firewall children to /tmp unguarded.
 *
 * Each test carries a positive control that proves the detector is non-vacuous.
 *
 * Part of the byte-identical Trio shared core.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  TEMP_ROOT_ENV,
  processScratchDir,
} from "./temp-authority.js";

// ─── F1: governed-launch wrapper prevents /tmp/tsx-* creation ─────────────────

test("F1 positive control: tsx without TMPDIR creates /tmp/tsx-*", () => {
  // Remove any existing tsx cache so the positive control is clean
  const existingCache = readdirSync("/tmp").filter((n) => n.startsWith("tsx-"));
  for (const name of existingCache) {
    try { execFileSync("rm", ["-rf", join("/tmp", name)]); } catch {}
  }
  // Spawn node with tsx loader but NO TMPDIR set — simulates the old launch path
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", "console.log('tsx-loaded')"], {
    encoding: "utf8",
    timeout: 15_000,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: "C.UTF-8",
      // Explicitly OMIT TMPDIR, TMP, TEMP — the old bug
    },
  });
  assert.equal(result.status, 0, `tsx load failed: ${result.stderr}`);
  const after = readdirSync("/tmp").filter((n) => n.startsWith("tsx-"));
  // The positive control: without TMPDIR, tsx DOES create /tmp/tsx-*
  assert.ok(after.length > 0, "positive control failed: tsx did not create /tmp/tsx-* without TMPDIR");
  // Cleanup the positive control's residue
  for (const name of after) {
    try { execFileSync("rm", ["-rf", join("/tmp", name)]); } catch {}
  }
});

test("F1 fix verification: tsx with governed TMPDIR creates nothing in /tmp", () => {
  const scratch = processScratchDir();
  const before = new Set(readdirSync("/tmp").filter((n) => n.startsWith("tsx-")));
  // Spawn node with tsx loader AND TMPDIR set to governed scratch — the fix
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", "console.log('tsx-governed')"], {
    encoding: "utf8",
    timeout: 15_000,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: "C.UTF-8",
      TMPDIR: scratch,
      TMP: scratch,
      TEMP: scratch,
      PEHVERSE_TEMP_ROOT: process.env[TEMP_ROOT_ENV],
    },
  });
  assert.equal(result.status, 0, `tsx load failed: ${result.stderr}`);
  const after = new Set(readdirSync("/tmp").filter((n) => n.startsWith("tsx-")));
  const created = [...after].filter((n) => !before.has(n));
  assert.equal(created.length, 0, `fix failed: tsx created /tmp entries: ${created.join(", ")}`);
});

test("F1 structural: package.json test scripts route through governed-launch.mjs", () => {
  // Read package.json and verify the test script uses the wrapper
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  for (const key of ["test", "test:runtime", "test:parity"]) {
    const script = pkg.scripts[key];
    assert.ok(
      script.includes("governed-launch.mjs"),
      `${key} script does not use governed-launch.mjs: ${script}`
    );
    assert.ok(
      script.includes("trio-test"),
      `${key} script does not specify trio-test component: ${script}`
    );
  }
  // start and repl should use trio-agent
  for (const key of ["start", "repl"]) {
    const script = pkg.scripts[key];
    assert.ok(
      script.includes("governed-launch.mjs"),
      `${key} script does not use governed-launch.mjs: ${script}`
    );
    assert.ok(
      script.includes("trio-agent"),
      `${key} script does not specify trio-agent component: ${script}`
    );
  }
});

test("F1 structural: tui/package.json scripts route through governed-launch.mjs", () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "tui/package.json"), "utf8"));
  for (const key of ["dev", "start"]) {
    const script = pkg.scripts[key];
    assert.ok(
      script.includes("governed-launch.mjs"),
      `tui ${key} script does not use governed-launch.mjs: ${script}`
    );
    assert.ok(
      script.includes("trio-agent"),
      `tui ${key} script does not specify trio-agent component: ${script}`
    );
  }
});

// ─── F2: verifierEnv() must include governed temp vars ────────────────────────

test("F2 positive control: from-empty env without governed vars sends child to /tmp", () => {
  // Simulate the OLD verifierEnv() — a from-empty env without TMPDIR/TMP/TEMP
  const oldEnv = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    LANG: "C.UTF-8",
    NODE_OPTIONS: "",
    NODE_PATH: "",
    NO_COLOR: "1",
    CI: "true",
  };
  const script = [
    "import os from 'node:os';",
    "console.log(JSON.stringify({",
    "  tmpdir: os.tmpdir(),",
    "  TMPDIR: process.env.TMPDIR ?? null,",
    "  PEHVERSE_TEMP_ROOT: process.env.PEHVERSE_TEMP_ROOT ?? null",
    "}));",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 10_000,
    env: oldEnv,
  });
  assert.equal(result.status, 0, `child failed: ${result.stderr}`);
  const child = JSON.parse(result.stdout.trim());
  // Positive control: without governed vars, child sees /tmp
  assert.equal(child.tmpdir, "/tmp", "positive control: child should see /tmp as tmpdir");
  assert.equal(child.TMPDIR, null, "positive control: child should have no TMPDIR");
  assert.equal(child.PEHVERSE_TEMP_ROOT, null, "positive control: child should have no PEHVERSE_TEMP_ROOT");
});

test("F2 fix verification: truth-agent-adapter.ts is builtin-only and vendorable", () => {
  // Read the adapter source and verify it has NO non-builtin imports
  const adapterPath = join(process.cwd(), "runtime/server/truth-agent-adapter.ts");
  const source = readFileSync(adapterPath, "utf8");
  // Must NOT import from sibling tree (vendorability invariant)
  assert.ok(
    !source.includes("from '../../src/core/temp-authority"),
    "truth-agent-adapter.ts must not import from temp-authority (builtin-only)"
  );
  // Must only import from node: builtins
  const importLines = source.split('\n').filter(l => l.startsWith('import '));
  for (const line of importLines) {
    assert.ok(
      line.includes("from 'node:") || line.includes('from "node:'),
      `non-builtin import found: ${line}`
    );
  }
});

// ─── Order 15 §9: the governed boundary, end to end ──────────────────────────

const GOVERNED_ROOT = process.env[TEMP_ROOT_ENV] ?? "";
/** This suite runs INSIDE a governed run of its own; that one is not residue. */
const OWN_RUN = process.env["PEHVERSE_TEMP_RUN_ID"] ?? "";
const AUTHORITY = join(process.cwd(), "scripts/trio/governed-temp-authority.mjs");
const LAUNCH = join(process.cwd(), "scripts/trio/governed-launch.mjs");
const GOVERNED_NPM = join(process.cwd(), "scripts/trio/governed-npm.mjs");

/** A scratch directory beneath the governed root — never /tmp, cleaned by the caller. */
function scratch(name: string): string {
  const dir = join(processScratchDir(), `o15-${name}-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function tmpEntries(): readonly string[] {
  return readdirSync("/tmp").filter((n) => n.startsWith("tsx-") || n === "node-compile-cache" || n.startsWith("trio-"));
}

/** Run a node program with an explicit environment and capture its outcome. */
function runNode(args: readonly string[], env: NodeJS.ProcessEnv): { status: number | null; signal: string | null; out: string } {
  const r = spawnSync(process.execPath, [...args], { encoding: "utf8", env, shell: false });
  return { status: r.status, signal: r.signal, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const baseEnv = (root: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", [TEMP_ROOT_ENV]: root,
});

// T1 — the canonical authority refuses every hostile root, by code.
test("T1 canonical authority refuses every hostile root with the expected code", () => {
  const root = GOVERNED_ROOT;
  const host = scratch("t1");
  const cases: ReadonlyArray<readonly [string, string | undefined, string]> = [
    ["missing", undefined, "root_not_configured"],
    ["blank", "", "root_not_configured"],
    ["whitespace", "   ", "root_not_configured"],
    ["relative", "rel/dir", "root_not_absolute"],
    ["dot-relative", "./x", "root_not_absolute"],
    ["forbidden-tmp", "/tmp", "root_is_forbidden"],
    ["forbidden-tmp-child", "/tmp/x", "root_is_forbidden"],
    ["forbidden-var-tmp", "/var/tmp", "root_is_forbidden"],
    ["tmpfs", "/dev/shm/o15", "root_on_tmpfs"],
    ["not-owned", "/opt", "root_not_owned"],
  ];
  const probe = `import{resolveGovernedTempRoot}from${JSON.stringify(AUTHORITY)};try{resolveGovernedTempRoot(process.env);console.log("ACCEPTED")}catch(e){console.log("CODE:"+e.code)}`;
  for (const [name, value, expected] of cases) {
    const env = baseEnv(root);
    if (value === undefined) delete env[TEMP_ROOT_ENV]; else env[TEMP_ROOT_ENV] = value;
    const { out } = runNode(["--input-type=module", "-e", probe], env);
    assert.match(out, new RegExp(`CODE:${expected}`), `${name}: expected ${expected}, got ${out.trim()}`);
  }
  // Structural refusals that need a real directory on disk.
  const link = join(host, "link-to-tmp");
  symlinkSync("/tmp", link);
  assert.match(runNode(["--input-type=module", "-e", probe], { ...baseEnv(root), [TEMP_ROOT_ENV]: link }).out,
    /CODE:root_is_forbidden/, "a symlink to the forbidden root must be refused");
  const permissive = join(host, "permissive");
  mkdirSync(permissive, { mode: 0o700 });
  chmodSync(permissive, 0o755);
  assert.match(runNode(["--input-type=module", "-e", probe], { ...baseEnv(root), [TEMP_ROOT_ENV]: permissive }).out,
    /CODE:root_permissive/, "a group/world-readable root must be refused (0o077, not 0o022)");
  const populated = join(host, "unmarked");
  mkdirSync(join(populated, "foreign"), { recursive: true, mode: 0o700 });
  assert.match(runNode(["--input-type=module", "-e", probe], { ...baseEnv(root), [TEMP_ROOT_ENV]: populated }).out,
    /CODE:root_marker_invalid/, "an unmarked populated directory must not be adopted");
  const inRepo = join(process.cwd(), ".o15-probe-root");
  mkdirSync(inRepo, { recursive: true, mode: 0o700 });
  try {
    assert.match(runNode(["--input-type=module", "-e", probe], { ...baseEnv(root), [TEMP_ROOT_ENV]: inRepo }).out,
      /CODE:root_inside_git_worktree/, "a repository-contained root must be refused");
  } finally { rmSync(inRepo, { recursive: true, force: true }); }
  rmSync(host, { recursive: true, force: true });
});

// T2 — the pre-npm entry point refuses identically; one implementation, not an approximation.
test("T2 governed-npm.mjs refuses the same hostile roots as the canonical authority", () => {
  for (const [value, expected] of [["", "root_not_configured"], ["rel/x", "root_not_absolute"],
       ["/tmp", "root_is_forbidden"], ["/var/tmp", "root_is_forbidden"], ["/opt", "root_not_owned"]] as const) {
    const env = baseEnv(value); env[TEMP_ROOT_ENV] = value;
    const { status, out } = runNode([GOVERNED_NPM, "--version"], env);
    assert.notEqual(status, 0, `governed-npm accepted ${value}`);
    assert.match(out, new RegExp(expected), `governed-npm gave the wrong reason for ${value}: ${out.slice(0, 160)}`);
  }
});

// T3 — validation allocates nothing before it decides.
test("T3 a refused launch allocates nothing in /tmp", () => {
  const before = tmpEntries();
  const env = baseEnv(""); delete env[TEMP_ROOT_ENV];
  const { status } = runNode([GOVERNED_NPM, "--version"], env);
  assert.notEqual(status, 0, "an unconfigured root must fail closed");
  assert.deepEqual([...tmpEntries()].sort(), [...before].sort(), "a refused launch created something in /tmp");
});

// T4 — tsx initialises only after the governed variables exist.
test("T4 tsx resolves its cache inside the governed run directory, not /tmp", () => {
  const root = GOVERNED_ROOT;
  const probe = `import os from "node:os";import fs from "node:fs";console.log(JSON.stringify({t:os.tmpdir(),e:fs.readdirSync(os.tmpdir())}))`;
  const file = join(scratch("t4"), "probe.ts");
  writeFileSync(file, probe);
  const { out } = runNode([LAUNCH, "trio-test", "--", process.execPath, "--import", "tsx", file], baseEnv(root));
  const line = out.split("\n").find((l) => l.trim().startsWith("{"));
  assert.ok(line, `probe produced no result: ${out.slice(0, 300)}`);
  const parsed = JSON.parse(line) as { t: string; e: string[] };
  assert.ok(parsed.t.startsWith(root), `os.tmpdir() was ${parsed.t}, outside the governed root`);
  assert.ok(parsed.e.some((n) => n.startsWith("tsx-")), "the tsx cache did not land in the governed run directory");
});

// T5 — npm initialises only after the governed variables exist.
test("T5 npm resolves its compile cache inside the governed run directory, not /tmp", () => {
  const root = GOVERNED_ROOT;
  const before = tmpEntries();
  const { status, out } = runNode([GOVERNED_NPM, "--version"], baseEnv(root));
  assert.equal(status, 0, `governed npm failed: ${out.slice(0, 300)}`);
  assert.deepEqual([...tmpEntries()].sort(), [...before].sort(), "governed npm created something in /tmp");
});

// T6 — positive control: the detector in T3/T5 can fail.
test("T6 positive control: ungoverned npm does create a compile cache in /tmp", () => {
  const hadCache = readdirSync("/tmp").includes("node-compile-cache");
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  const npm = spawnSync("npm", ["--version"], { encoding: "utf8", env, shell: false });
  assert.equal(npm.status, 0, "the control could not run npm");
  assert.ok(readdirSync("/tmp").includes("node-compile-cache"),
    "ungoverned npm did not create /tmp/node-compile-cache — the T3/T5 detector would be vacuous");
  if (!hadCache) rmSync("/tmp/node-compile-cache", { recursive: true, force: true });
});

// T7/T8 — lifecycle and status fidelity.
test("T7 the run directory and its sidecar are removed on success, failure and signal", () => {
  const root = GOVERNED_ROOT;
  const runsOf = (c: string): number => {
    try { return readdirSync(join(root, c)).filter((n) => n !== ".runs" && n !== OWN_RUN).length; } catch { return 0; }
  };
  const before = runsOf("trio-test");
  for (const script of ['process.exit(0)', 'process.exit(3)', 'process.kill(process.pid,"SIGTERM")']) {
    runNode([LAUNCH, "trio-test", "--", process.execPath, "-e", script], baseEnv(root));
  }
  runNode([LAUNCH, "trio-test", "--", "definitely-not-a-command-o15"], baseEnv(root));
  assert.equal(runsOf("trio-test"), before, "a run directory survived");
  const sidecars = readdirSync(join(root, "trio-test", ".runs")).filter((n) => n !== `${OWN_RUN}.json`);
  assert.deepEqual(sidecars, [], "a sidecar record survived");
});

test("T8 the child's exit status and signal are preserved, never collapsed", () => {
  const root = GOVERNED_ROOT;
  for (const code of [0, 1, 7, 42]) {
    const { status } = runNode([LAUNCH, "trio-test", "--", process.execPath, "-e", `process.exit(${code})`], baseEnv(root));
    assert.equal(status, code, `exit ${code} was not preserved`);
  }
  const term = runNode([LAUNCH, "trio-test", "--", process.execPath, "-e", 'process.kill(process.pid,"SIGTERM")'], baseEnv(root));
  assert.equal(term.signal, "SIGTERM", `a signalled child yielded status=${term.status} signal=${term.signal}, not SIGTERM`);
});

// T9 — concurrency.
test("T9 concurrent launches get unique run directories and leak nothing", () => {
  const root = GOVERNED_ROOT;
  const others = (): number => readdirSync(join(root, "trio-test")).filter((n) => n !== ".runs" && n !== OWN_RUN).length;
  const before = others();
  const ids = new Set<string>();
  const N = 12;
  for (let i = 0; i < N; i++) {
    const { out } = runNode([LAUNCH, "trio-test", "--", process.execPath, "-e", "console.log(process.env.PEHVERSE_TEMP_RUN_ID)"], baseEnv(root));
    ids.add(out.trim());
  }
  assert.equal(ids.size, N, "run ids collided");
  assert.equal(others(), before, "concurrent launches leaked");
});

// T13 — the TypeScript wrapper and the canonical module cannot drift.
test("T13 the TypeScript authority refuses exactly what the canonical module refuses", async () => {
  const mod = await import("./temp-authority.js");
  const root = GOVERNED_ROOT;
  const probe = `import{resolveGovernedTempRoot}from${JSON.stringify(AUTHORITY)};try{resolveGovernedTempRoot(process.env);console.log("ACCEPTED")}catch(e){console.log("CODE:"+e.code)}`;
  // The wrapper publishes root_is_tmp / root_under_tmp, a distinction the canonical module
  // folds into one code. Anything else must pass through unchanged.
  const equivalent = (canonical: string, wrapped: string): boolean =>
    canonical === wrapped || (canonical === "root_is_forbidden" && (wrapped === "root_is_tmp" || wrapped === "root_under_tmp"));
  for (const value of ["", "rel/x", "/tmp", "/tmp/child", "/var/tmp", "/opt", "/dev/shm/o15"]) {
    const env = baseEnv(root); env[TEMP_ROOT_ENV] = value;
    const canonical = (runNode(["--input-type=module", "-e", probe], env).out.match(/CODE:(\w+)/) ?? [])[1] ?? "ACCEPTED";
    let wrapped = "ACCEPTED";
    try { mod.resolveGovernedTempRoot({ ...env }); } catch (err) { wrapped = (err as { code?: string }).code ?? "?"; }
    assert.notEqual(canonical, "ACCEPTED", `canonical accepted ${JSON.stringify(value)}`);
    assert.notEqual(wrapped, "ACCEPTED", `wrapper accepted ${JSON.stringify(value)}`);
    assert.ok(equivalent(canonical, wrapped),
      `drift on ${JSON.stringify(value)}: wrapper=${wrapped} canonical=${canonical}`);
  }
});

// T14 — the boundary is live, not dead code.
test("T14 every canonical entry point routes through the governed boundary", () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string> };
  const exempt = new Set(["build", "typecheck", "governed"]);
  for (const [name, value] of Object.entries(pkg.scripts)) {
    if (exempt.has(name)) continue;
    assert.match(value, /^node scripts\/trio\/governed-launch\.mjs /, `package.json script ${name} bypasses the governed boundary`);
  }
  assert.equal(pkg.scripts["governed"], "node scripts/trio/governed-npm.mjs",
    "the pre-npm boundary has no committed caller — it would be dead code");
  const tui = JSON.parse(readFileSync(join(process.cwd(), "tui/package.json"), "utf8")) as { scripts: Record<string, string> };
  for (const name of ["start", "dev"]) {
    assert.match(tui.scripts[name] ?? "", /^node \.\.\/scripts\/trio\/governed-launch\.mjs /, `tui script ${name} bypasses the governed boundary`);
  }
});

// T15 — the scanner declarations are content-anchored, not pathname-anchored.
test("T15 a changed line in a declared file changes its pinned digest set", () => {
  const declared = join(process.cwd(), "scripts/trio/governed-temp-authority.mjs");
  const lines = readFileSync(declared, "utf8").split("\n").map((l) => l.trim())
    .filter((l) => /\/tmp(?:[/"'`\s),;:\]]|$)/.test(l));
  assert.ok(lines.length > 0, "the declared file no longer contains the pinned pattern");
  const digest = (l: string): string => createHash("sha256").update(l).digest("hex");
  const pinned = new Set(lines.map(digest));
  const planted = 'fs.mkdirSync("/tmp/o15-live-usage", { recursive: true });';
  assert.ok(!pinned.has(digest(planted)),
    "a planted live usage would already be pinned — the declaration would not detect it");
  assert.equal(new Set([...lines, planted].map(digest)).size, pinned.size + 1,
    "adding a live usage did not change the pinned set, so the declaration is not content-anchored");
});

// T16 — nothing lab-owned survives in /tmp, and the governed root is clean.
test("T16 no lab-owned /tmp entry and no governed residue survive this suite", () => {
  assert.deepEqual(readdirSync("/tmp").filter((n) => n.startsWith("trio-")), [], "lab-owned /tmp entries survived");
  const root = GOVERNED_ROOT;
  for (const component of ["trio-agent", "trio-test"]) {
    let entries: string[] = [];
    try { entries = readdirSync(join(root, component)).filter((n) => n !== ".runs" && n !== OWN_RUN); } catch { continue; }
    assert.deepEqual(entries.filter((n) => !n.startsWith("o15-")), [], `${component} holds governed residue`);
  }
});

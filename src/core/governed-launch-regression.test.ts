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
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  TEMP_ROOT_ENV,
  processScratchDir,
} from "./temp-authority.js";

// ─── F1: governed-launch wrapper prevents /tmp/tsx-* creation ─────────────────

test("F1 positive control: tsx allocates in os.tmpdir() when nothing governs it", () => {
  // The defect this proves is that tsx builds its FileCache from os.tmpdir() at module init,
  // before any --import hook can run. Demonstrating it does NOT require pointing os.tmpdir()
  // at the real /tmp: the control redirects it to a private directory beneath the governed
  // root, so the allocation is observed exactly where the defect would have put it, and the
  // suite leaves nothing behind on shared storage.
  const host = scratch("f1-control");
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", "console.log('tsx-loaded')"], {
    encoding: "utf8",
    timeout: 15_000,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: "C.UTF-8",
      // os.tmpdir() follows TMPDIR; NODE_COMPILE_CACHE and the governed identity are
      // deliberately absent, which is precisely the ungoverned condition.
      TMPDIR: host, TMP: host, TEMP: host,
    },
  });
  assert.equal(result.status, 0, `tsx load failed: ${result.stderr}`);
  const created = readdirSync(host).filter((n) => n.startsWith("tsx-"));
  assert.ok(created.length > 0,
    "positive control failed: tsx allocated no cache in os.tmpdir(), so the F1 detector would be vacuous");
  assert.deepEqual(tmpEntries(), TMP_BASELINE, "the positive control wrote to shared /tmp");
  rmSync(host, { recursive: true, force: true });
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

// ─── Order 16 §9: the governed boundary, end to end ──────────────────────────
//
// Every test below asserts an expected RESULT, not merely that something ran, and every
// negative control is executed beneath governed parent storage so that proving a defect
// never creates residue on shared storage.

const GOVERNED_ROOT = process.env[TEMP_ROOT_ENV] ?? "";
/**
 * This suite runs inside a governed run, and that run may itself be nested inside the
 * canonical package-manager entry. Every run in the chain is ALIVE by construction while
 * this suite scans, so none of them is residue. Only the chain can tell an ancestor from a
 * leak, which is why the wrapper publishes it.
 */
const OWN_CHAIN = new Set((process.env["PEHVERSE_TEMP_RUN_CHAIN"] ?? "").split(":").filter((id) => id.length > 0));
const AUTHORITY = join(process.cwd(), "scripts/trio/governed-temp-authority.mjs");
const LAUNCH = join(process.cwd(), "scripts/trio/governed-launch.mjs");
const GOVERNED_NPM = join(process.cwd(), "scripts/trio/governed-npm.mjs");
const GOVERNED_PNPM = join(process.cwd(), "scripts/trio/governed-pnpm.mjs");
const ADAPTER = join(process.cwd(), "runtime/server/truth-agent-adapter.ts");

/** A scratch directory beneath the governed root — never shared storage, cleaned by the caller. */
function scratch(name: string): string {
  const dir = join(processScratchDir(), `o16-${name}-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Everything a lab-owned run could leave on shared temporary storage. `trio-*` was the Order 15
 * detector; it missed the two classes that were actually observed surviving — the tsx cache and
 * the Node compile cache — so both are named here.
 */
function tmpEntries(): readonly string[] {
  return readdirSync("/tmp")
    .filter((n) => n.startsWith("tsx-") || n === "node-compile-cache" || n.startsWith("trio-"))
    .sort();
}

/** The shared-storage state this suite inherited. Nothing it does may change it. */
const TMP_BASELINE = tmpEntries();

/** Run a node program with an explicit environment and capture its outcome. */
function runNode(args: readonly string[], env: NodeJS.ProcessEnv): { status: number | null; signal: string | null; out: string } {
  const r = spawnSync(process.execPath, [...args], { encoding: "utf8", env, shell: false });
  return { status: r.status, signal: r.signal, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const baseEnv = (root: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", [TEMP_ROOT_ENV]: root,
});

/** The environment a governed child legitimately inherits, as the wrapper itself builds it. */
function childEnvOf(root: string, runDir: string, component: string, runId: string): NodeJS.ProcessEnv {
  return {
    ...baseEnv(root),
    TMPDIR: runDir, TMP: runDir, TEMP: runDir,
    NODE_COMPILE_CACHE: join(runDir, "node-compile-cache"),
    PEHVERSE_TEMP_COMPONENT: component,
    PEHVERSE_TEMP_RUN_ID: runId,
  };
}

/**
 * Mint a real governed run — directory plus ownership record — so a child environment can be
 * built that is genuine in every respect except the one the test then corrupts.
 */
async function mintRun(component: "trio-agent" | "trio-test"): Promise<{ runDir: string; runId: string; release: () => void }> {
  const mod = await import(AUTHORITY) as typeof import("../../scripts/trio/governed-temp-authority.mjs");
  const run = mod.createRunDirectory(component, process.env);
  return { runDir: run.path, runId: run.runId, release: () => mod.cleanupRun(run) };
}

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
    ["forbidden-tmp-trailing", "/tmp/", "root_is_forbidden"],
    ["forbidden-tmp-traversal", "/tmp/../tmp", "root_is_forbidden"],
    ["forbidden-tmp-child", "/tmp/x", "root_is_forbidden"],
    ["forbidden-var-tmp", "/var/tmp", "root_is_forbidden"],
    ["forbidden-var-tmp-child", "/var/tmp/x", "root_is_forbidden"],
    ["tmpfs", "/dev/shm/o16", "root_on_tmpfs"],
    ["not-owned", "/opt", "root_not_owned"],
  ];
  const probe = `import{resolveGovernedTempRoot}from${JSON.stringify(AUTHORITY)};try{resolveGovernedTempRoot(process.env);console.log("ACCEPTED")}catch(e){console.log("CODE:"+e.code)}`;
  for (const [name, value, expected] of cases) {
    const env = baseEnv(root);
    if (value === undefined) delete env[TEMP_ROOT_ENV]; else env[TEMP_ROOT_ENV] = value;
    const { out } = runNode(["--input-type=module", "-e", probe], env);
    assert.match(out, new RegExp(`CODE:${expected}`), `${name}: expected ${expected}, got ${out.trim()}`);
  }
  // Structural refusals that need real directories on disk.
  const link = join(host, "link-to-forbidden");
  symlinkSync("/tmp", link);
  assert.match(runNode(["--input-type=module", "-e", probe], { ...baseEnv(root), [TEMP_ROOT_ENV]: link }).out,
    /CODE:root_is_forbidden/, "a symlink to the forbidden root must be refused");
  const viaLink = join(host, "via");
  mkdirSync(join(host, "real"), { mode: 0o700 });
  symlinkSync(join(host, "real"), viaLink);
  assert.match(runNode(["--input-type=module", "-e", probe], { ...baseEnv(root), [TEMP_ROOT_ENV]: join(viaLink, "under") }).out,
    /CODE:root_symlink/, "a symlink COMPONENT must be refused even when its target is safe");
  const permissive = join(host, "permissive");
  mkdirSync(permissive, { mode: 0o700 });
  chmodSync(permissive, 0o755);
  assert.match(runNode(["--input-type=module", "-e", probe], { ...baseEnv(root), [TEMP_ROOT_ENV]: permissive }).out,
    /CODE:root_permissive/, "a group/world-readable root must be refused (0o077, not 0o022)");
  const world = join(host, "world");
  mkdirSync(world, { mode: 0o700 });
  chmodSync(world, 0o777);
  assert.match(runNode(["--input-type=module", "-e", probe], { ...baseEnv(root), [TEMP_ROOT_ENV]: world }).out,
    /CODE:root_permissive/, "a world-writable root must be refused");
  const populated = join(host, "unmarked");
  mkdirSync(join(populated, "foreign"), { recursive: true, mode: 0o700 });
  assert.match(runNode(["--input-type=module", "-e", probe], { ...baseEnv(root), [TEMP_ROOT_ENV]: populated }).out,
    /CODE:root_marker_invalid/, "an unmarked populated directory must not be adopted");
  const wrongVersion = join(host, "wrong-marker");
  mkdirSync(wrongVersion, { mode: 0o700 });
  writeFileSync(join(wrongVersion, ".pehverse-temp-root.json"), JSON.stringify({ marker: "pehverse-governed-temp-root", version: 99 }), { mode: 0o600 });
  assert.match(runNode(["--input-type=module", "-e", probe], { ...baseEnv(root), [TEMP_ROOT_ENV]: wrongVersion }).out,
    /CODE:root_marker_invalid/, "a marker from another contract version must not be adopted");
  const inRepo = join(process.cwd(), ".o16-probe-root");
  mkdirSync(inRepo, { recursive: true, mode: 0o700 });
  try {
    assert.match(runNode(["--input-type=module", "-e", probe], { ...baseEnv(root), [TEMP_ROOT_ENV]: inRepo }).out,
      /CODE:root_inside_git_worktree/, "a repository-contained root must be refused");
  } finally { rmSync(inRepo, { recursive: true, force: true }); }
  rmSync(host, { recursive: true, force: true });
  assert.deepEqual(tmpEntries(), TMP_BASELINE, "the hostile-root matrix touched shared /tmp");
});

// T2 — the pre-package-manager entries refuse identically; one implementation, not an approximation.
test("T2 the canonical package-manager entries refuse the same hostile roots as the authority", () => {
  for (const entry of [GOVERNED_NPM, GOVERNED_PNPM]) {
    for (const [value, expected] of [["", "root_not_configured"], ["rel/x", "root_not_absolute"],
         ["/tmp", "root_is_forbidden"], ["/var/tmp", "root_is_forbidden"], ["/opt", "root_not_owned"]] as const) {
      const env = baseEnv(value); env[TEMP_ROOT_ENV] = value;
      const { status, out } = runNode([entry, "--version"], env);
      assert.notEqual(status, 0, `${entry} accepted ${value}`);
      assert.match(out, new RegExp(expected), `${entry} gave the wrong reason for ${value}: ${out.slice(0, 160)}`);
    }
  }
});

// T3 — validation allocates nothing before it decides.
test("T3 a refused launch allocates nothing on shared temporary storage", () => {
  for (const entry of [GOVERNED_NPM, GOVERNED_PNPM]) {
    const env = baseEnv(""); delete env[TEMP_ROOT_ENV];
    const { status } = runNode([entry, "--version"], env);
    assert.notEqual(status, 0, `${entry}: an unconfigured root must fail closed`);
  }
  assert.deepEqual(tmpEntries(), TMP_BASELINE, "a refused launch created something in /tmp");
});

// T4 — tsx initialises only after the governed variables exist.
test("T4 tsx resolves its cache inside the governed run directory, not /tmp", () => {
  const root = GOVERNED_ROOT;
  const probe = `import os from "node:os";import fs from "node:fs";console.log(JSON.stringify({t:os.tmpdir(),e:fs.readdirSync(os.tmpdir())}))`;
  const file = join(scratch("t4"), "probe.ts");
  writeFileSync(file, probe);
  const { out } = runNode([LAUNCH, "--entry=operator", "trio-test", "--", process.execPath, "--import", "tsx", file], baseEnv(root));
  const line = out.split("\n").find((l) => l.trim().startsWith("{"));
  assert.ok(line, `probe produced no result: ${out.slice(0, 300)}`);
  const parsed = JSON.parse(line) as { t: string; e: string[] };
  assert.ok(parsed.t.startsWith(root), `os.tmpdir() was ${parsed.t}, outside the governed root`);
  assert.ok(parsed.e.some((n) => n.startsWith("tsx-")), "the tsx cache did not land in the governed run directory");
  assert.deepEqual(tmpEntries(), TMP_BASELINE, "governed tsx created something in /tmp");
});

// T5 — npm and pnpm initialise only after the governed variables exist.
test("T5 the package managers resolve their compile cache inside the governed run directory", () => {
  const root = GOVERNED_ROOT;
  const probe = `import fs from "node:fs";import os from "node:os";console.log("PROBE:"+JSON.stringify({t:os.tmpdir(),c:process.env.NODE_COMPILE_CACHE,e:fs.readdirSync(os.tmpdir())}))`;
  for (const entry of [GOVERNED_NPM, GOVERNED_PNPM]) {
    const { status, out } = runNode([entry, "exec", "--", process.execPath, "--input-type=module", "-e", probe], baseEnv(root));
    assert.equal(status, 0, `${entry} exec failed: ${out.slice(0, 400)}`);
    const line = out.split("\n").map((l) => l.trim()).find((l) => l.startsWith("PROBE:"));
    assert.ok(line, `${entry}: probe produced no result: ${out.slice(0, 400)}`);
    const parsed = JSON.parse(line.slice("PROBE:".length)) as { t: string; c: string; e: string[] };
    assert.ok(parsed.t.startsWith(root), `${entry}: os.tmpdir() was ${parsed.t}, outside the governed root`);
    assert.ok(parsed.c.startsWith(root), `${entry}: NODE_COMPILE_CACHE was ${parsed.c}, outside the governed root`);
    assert.ok(parsed.e.includes("node-compile-cache"),
      `${entry}: the manager's compile cache did not land in the governed run directory`);
  }
  assert.deepEqual(tmpEntries(), TMP_BASELINE, "a governed package manager created something in /tmp");
});

// T6 — positive control: the detector in T3/T4/T5 can fail.
test("T6 positive control: an ungoverned package manager does allocate a compile cache", () => {
  // The defect is that the manager caches into os.tmpdir() before any guard could run. The
  // control redirects os.tmpdir() to private governed storage so the allocation is observed
  // exactly where the defect would have put it, WITHOUT writing to shared /tmp.
  const host = scratch("t6-control");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
    TMPDIR: host, TMP: host, TEMP: host,
    // NODE_COMPILE_CACHE deliberately absent: that is the ungoverned condition.
  };
  const npm = spawnSync("npm", ["--version"], { encoding: "utf8", env, shell: false });
  assert.equal(npm.status, 0, `the control could not run npm: ${npm.stderr}`);
  assert.ok(readdirSync(host).includes("node-compile-cache"),
    "ungoverned npm allocated no compile cache in os.tmpdir() — the T3/T4/T5 detector would be vacuous");
  assert.deepEqual(tmpEntries(), TMP_BASELINE, "the positive control wrote to shared /tmp");
  rmSync(host, { recursive: true, force: true });
});

// T7/T8 — lifecycle and status fidelity.
test("T7 the run directory and its sidecar are removed on success, failure and signal", () => {
  const root = GOVERNED_ROOT;
  const runsOf = (c: string): number => {
    try { return readdirSync(join(root, c)).filter((n) => n !== ".runs" && !OWN_CHAIN.has(n)).length; } catch { return 0; }
  };
  const before = runsOf("trio-test");
  for (const script of ['process.exit(0)', 'process.exit(3)', 'process.kill(process.pid,"SIGTERM")']) {
    runNode([LAUNCH, "--entry=operator", "trio-test", "--", process.execPath, "-e", script], baseEnv(root));
  }
  runNode([LAUNCH, "--entry=operator", "trio-test", "--", "definitely-not-a-command-o16"], baseEnv(root));
  assert.equal(runsOf("trio-test"), before, "a run directory survived");
  const sidecars = readdirSync(join(root, "trio-test", ".runs")).filter((n) => !OWN_CHAIN.has(n.replace(/\.json$/, "")));
  assert.deepEqual(sidecars, [], "a sidecar record survived");
});

test("T8 the child's exit status and signal are preserved, never collapsed", () => {
  const root = GOVERNED_ROOT;
  for (const code of [0, 1, 7, 42, 255]) {
    const { status, signal } = runNode([LAUNCH, "--entry=operator", "trio-test", "--", process.execPath, "-e", `process.exit(${code})`], baseEnv(root));
    assert.equal(signal, null, `exit ${code} was reported as a signal`);
    assert.equal(status, code, `exit ${code} was not preserved`);
  }
  // A signalled child must make the wrapper die of the SAME signal, so the caller observes the
  // conventional 128+N rather than a collapsed exit 1.
  for (const [sig, conventional] of [["SIGTERM", 143], ["SIGINT", 130], ["SIGHUP", 129], ["SIGQUIT", 131]] as const) {
    const r = runNode([LAUNCH, "--entry=operator", "trio-test", "--", process.execPath, "-e", `process.kill(process.pid,"${sig}")`], baseEnv(root));
    assert.equal(r.signal, sig, `${sig}: wrapper yielded status=${r.status} signal=${r.signal}`);
    assert.equal(r.status, null, `${sig}: a signalled wrapper must not also report an exit code`);
    assert.equal(128 + (sig === "SIGHUP" ? 1 : sig === "SIGINT" ? 2 : sig === "SIGQUIT" ? 3 : 15), conventional,
      `${sig}: the conventional status this test asserts is stated wrongly`);
  }
  // A command that does not exist is a spawn failure, not a silent success.
  const missing = runNode([LAUNCH, "--entry=operator", "trio-test", "--", "definitely-not-a-command-o16"], baseEnv(root));
  assert.equal(missing.status, 127, `a missing command yielded ${missing.status}, not 127`);
  assert.match(missing.out, /ENOENT/, "a missing command produced no diagnostic on stderr");
});

// T9 — GENUINE concurrency: every launch is in flight at the same time.
test("T9 twenty-four simultaneous launches get unique run directories and leak nothing", async () => {
  const root = GOVERNED_ROOT;
  const others = (): number => readdirSync(join(root, "trio-test")).filter((n) => n !== ".runs" && !OWN_CHAIN.has(n)).length;
  const before = others();
  const N = 24;
  // Each child blocks on a barrier file until every sibling has started, so the launches
  // genuinely overlap. A sequential loop cannot exercise the defect this test exists to catch
  // (Order 13: twelve concurrent launches leaked twelve directories).
  const barrier = scratch("t9");
  const child = [
    `import fs from "node:fs";`,
    `fs.writeFileSync(${JSON.stringify(barrier)}+"/"+process.env.PEHVERSE_TEMP_RUN_ID,"");`,
    `const deadline=Date.now()+30000;`,
    `while(fs.readdirSync(${JSON.stringify(barrier)}).length<${N}&&Date.now()<deadline){}`,
    `console.log(process.env.PEHVERSE_TEMP_RUN_ID);`,
  ].join("");
  const { spawn } = await import("node:child_process");
  const launches = Array.from({ length: N }, () => new Promise<{ id: string; code: number | null }>((resolve, reject) => {
    const p = spawn(process.execPath, [LAUNCH, "--entry=operator", "trio-test", "--", process.execPath, "--input-type=module", "-e", child],
      { env: baseEnv(root), shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    p.on("error", reject);
    p.on("close", (code) => resolve({ id: out.trim(), code }));
  }));
  const results = await Promise.all(launches);
  const peak = readdirSync(barrier).length;
  assert.equal(peak, N, `only ${peak} of ${N} launches were ever simultaneously in flight`);
  assert.deepEqual(results.filter((r) => r.code !== 0).map((r) => r.code), [], "a simultaneous launch failed");
  assert.deepEqual(results.filter((r) => r.id.length === 0), [], "a simultaneous launch produced no run id");
  assert.equal(new Set(results.map((r) => r.id)).size, N, "run ids collided under real concurrency");
  assert.equal(others(), before, "simultaneous launches leaked run directories");
  const sidecars = readdirSync(join(root, "trio-test", ".runs")).filter((n) => !OWN_CHAIN.has(n.replace(/\.json$/, "")));
  assert.deepEqual(sidecars, [], "simultaneous launches leaked sidecar records");
  rmSync(barrier, { recursive: true, force: true });
});

// ─── T10–T12: the adapter boundary ───────────────────────────────────────────
//
// The adapter lives under `runtime/`, outside this program's rootDir, and must stay
// vendorable. It is therefore driven the way a host drives it — as a real process, through
// tsx — rather than imported, and the hostile values are handed to the probe as DATA so the
// probe's own process keeps governed storage throughout. Nothing here writes to shared /tmp.

const ADAPTER_PROBE = [
  `import { finalizeTurn, mintTrustedBase } from ${JSON.stringify(join(process.cwd(), "runtime/server/truth-agent-adapter.js"))};`,
  `import { readFileSync } from "node:fs";`,
  `const job = JSON.parse(readFileSync(process.argv[2], "utf8"));`,
  `const results = [];`,
  `const saved = { ...process.env };`,
  `for (const testCase of job.cases) {`,
  `  for (const key of Object.keys(process.env)) delete process.env[key];`,
  `  Object.assign(process.env, saved, testCase.env ?? {});`,
  `  for (const key of testCase.unset ?? []) delete process.env[key];`,
  `  const config = { agent: "o16", runtime: "ts-trio-tui", cliPath: job.cliPath,`,
  `    ...(testCase.governedTemp === undefined ? {} : { governedTemp: testCase.governedTemp }) };`,
  `  const row = { name: testCase.name };`,
  `  try {`,
  `    const decision = finalizeTurn(config, { taskId: "t", sessionId: "s", userOperation: "u",`,
  `      situation: "advisory-conversation", outputChannel: "tui", workspace: job.workspace,`,
  `      candidateNarrative: "N" });`,
  `    row.blocked = decision.blocked();`,
  `    row.ok = decision.ok();`,
  `  } catch (err) { row.finalizeThrew = String(err && err.message).slice(0, 200); }`,
  `  try {`,
  `    row.minted = mintTrustedBase(config, { agent: "o16", taskId: "t", sessionId: "s",`,
  `      repositoryRoot: job.workspace, repositoryIdentity: "p", commit: "0".repeat(40) });`,
  `  } catch (err) { row.mintThrew = String(err && err.message).slice(0, 200); }`,
  `  results.push(row);`,
  `}`,
  `for (const key of Object.keys(process.env)) delete process.env[key];`,
  `Object.assign(process.env, saved);`,
  `process.stdout.write("ADAPTER_RESULT:" + JSON.stringify(results));`,
].join("\n");

interface AdapterRow {
  readonly name: string;
  readonly blocked?: boolean;
  readonly ok?: boolean;
  readonly minted?: string | null;
  readonly finalizeThrew?: string;
  readonly mintThrew?: string;
}

/** Build a Truth-CLI stub, run the probe over a case list, and return one row per case. */
function driveAdapter(host: string, cases: readonly Record<string, unknown>[], cliBody: string): readonly AdapterRow[] {
  const cli = join(host, "truth-cli.mjs");
  writeFileSync(cli, cliBody);
  writeFileSync(join(host, "package.json"), JSON.stringify({ name: "truth-firewall", version: "0.0.0", type: "module" }));
  const probe = join(host, "adapter-probe.ts");
  writeFileSync(probe, ADAPTER_PROBE);
  const job = join(host, "job.json");
  writeFileSync(job, JSON.stringify({ cliPath: cli, workspace: process.cwd(), cases }));
  const r = spawnSync(process.execPath, ["--import", "tsx", probe, job],
    { encoding: "utf8", shell: false, env: { ...process.env } });
  const line = `${r.stdout ?? ""}`.split("\n").map((l) => l.trim()).find((l) => l.startsWith("ADAPTER_RESULT:"));
  assert.ok(line, `the adapter probe produced no result (status ${r.status}): ${`${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-800)}`);
  return JSON.parse(line.slice("ADAPTER_RESULT:".length)) as AdapterRow[];
}

// T10 — the adapter refuses, on every hostile shape, without ever throwing or spawning.
test("T10 the adapter returns a trusted refusal for every hostile temporary authority", () => {
  const host = scratch("t10");
  const missing = join(host, "does-not-exist");
  const worldReadable = join(host, "world-readable");
  mkdirSync(worldReadable, { mode: 0o700 }); chmodSync(worldReadable, 0o755);
  const linkToForbidden = join(host, "link-to-forbidden");
  symlinkSync("/tmp", linkToForbidden);
  const other = join(host, "other-root");
  mkdirSync(other, { mode: 0o700 });

  // A stub Truth runtime that RECORDS being spawned. If any refusal case reaches it, the
  // adapter handed an ungoverned environment to a child.
  const spawnLog = join(host, "spawned.log");
  const cliBody = [
    `import fs from "node:fs";`,
    `fs.appendFileSync(${JSON.stringify(spawnLog)}, "spawned\\n");`,
    `process.stdout.write(JSON.stringify({protocol:"truth-agent-enforcement/trusted-base/1",ok:true}));`,
  ].join("\n");

  const GOVERNED_KEYS = ["PEHVERSE_TEMP_ROOT", "TMPDIR", "TMP", "TEMP"];
  const fromEnv = (name: string, root: string, dir: string, tmp = dir, temp = dir): Record<string, unknown> => ({
    name, unset: GOVERNED_KEYS, env: { PEHVERSE_TEMP_ROOT: root, TMPDIR: dir, TMP: tmp, TEMP: temp },
  });
  const cases: readonly Record<string, unknown>[] = [
    { name: "unset", unset: GOVERNED_KEYS },
    fromEnv("blank", "", ""),
    fromEnv("relative", "rel", "rel"),
    fromEnv("forbidden-tmp", "/tmp", "/tmp"),
    fromEnv("forbidden-var-tmp", "/var/tmp", "/var/tmp"),
    fromEnv("symlink-to-forbidden", linkToForbidden, linkToForbidden),
    fromEnv("inconsistent", host, host, other, worldReadable),
    fromEnv("nonexistent", missing, missing),
    fromEnv("world-readable", worldReadable, worldReadable),
    { name: "supplied-blank", governedTemp: { root: "", dir: "" } },
    { name: "supplied-relative", governedTemp: { root: "rel", dir: "rel/x" } },
    { name: "supplied-forbidden", governedTemp: { root: "/tmp", dir: "/tmp" } },
    { name: "supplied-forbidden-var", governedTemp: { root: "/var/tmp", dir: "/var/tmp" } },
    { name: "supplied-symlink", governedTemp: { root: linkToForbidden, dir: linkToForbidden } },
    { name: "supplied-nonexistent", governedTemp: { root: host, dir: missing } },
    { name: "supplied-outside-root", governedTemp: { root: other, dir: host } },
    { name: "supplied-world-readable", governedTemp: { root: host, dir: worldReadable } },
  ];

  const rows = driveAdapter(host, cases, cliBody);
  assert.equal(rows.length, cases.length, "the adapter probe skipped a case");
  for (const row of rows) {
    assert.equal(row.finalizeThrew, undefined, `${row.name}: finalizeTurn threw — ${row.finalizeThrew}`);
    assert.equal(row.mintThrew, undefined, `${row.name}: mintTrustedBase threw — ${row.mintThrew}`);
    assert.equal(row.blocked, true, `${row.name}: finalizeTurn did not return a blocked decision`);
    assert.equal(row.ok, false, `${row.name}: finalizeTurn reported success`);
    assert.equal(row.minted, null, `${row.name}: mintTrustedBase attested without a governed authority`);
  }
  assert.equal(readdirSync(host).includes("spawned.log"), false,
    "the adapter spawned the Truth child while refusing — an ungoverned environment escaped");
  rmSync(host, { recursive: true, force: true });
  assert.deepEqual(tmpEntries(), TMP_BASELINE, "the adapter refusal matrix touched shared /tmp");
});

// T11 — the adapter's success path hands the child exactly the governed environment, and nothing else.
test("T11 the adapter gives the Truth child exactly twelve keys, all five governed", () => {
  const host = scratch("t11");
  const runDir = join(host, "run");
  mkdirSync(runDir, { mode: 0o700 });
  const report = join(host, "child-env.json");
  const cliBody = [
    `import fs from "node:fs";import os from "node:os";`,
    `fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({keys:Object.keys(process.env).sort(),osTmpdir:os.tmpdir(),env:process.env}));`,
    `process.stdout.write(JSON.stringify({protocol:"truth-agent-enforcement/trusted-base/1",ok:true}));`,
  ].join("\n");

  // A deliberately hostile ambient environment: none of it may reach the child.
  const rows = driveAdapter(host, [{
    name: "valid",
    env: { TMPDIR: "/tmp", TMP: "/var", TEMP: "/usr", O16_INJECTED: "leak", SECRETISH: "leak" },
    governedTemp: { root: host, dir: runDir },
  }], cliBody);
  assert.equal(rows[0]?.mintThrew, undefined, `mintTrustedBase threw — ${rows[0]?.mintThrew}`);
  assert.ok(rows[0]?.minted, "the adapter refused a valid governed authority");

  const observed = JSON.parse(readFileSync(report, "utf8")) as { keys: string[]; osTmpdir: string; env: Record<string, string> };
  assert.deepEqual(observed.keys, [
    "CI", "HOME", "LANG", "NODE_COMPILE_CACHE", "NODE_OPTIONS", "NODE_PATH", "NO_COLOR",
    "PATH", "PEHVERSE_TEMP_ROOT", "TEMP", "TMP", "TMPDIR",
  ], "the Truth child's environment is not exactly the twelve declared keys");
  assert.equal(observed.env["TMPDIR"], runDir, "TMPDIR was not the private run directory");
  assert.equal(observed.env["TMP"], runDir, "TMP was not the private run directory");
  assert.equal(observed.env["TEMP"], runDir, "TEMP was not the private run directory");
  assert.equal(observed.env["NODE_COMPILE_CACHE"], join(runDir, "node-compile-cache"), "NODE_COMPILE_CACHE was not governed");
  assert.equal(observed.env["PEHVERSE_TEMP_ROOT"], host, "PEHVERSE_TEMP_ROOT was not the validated root");
  assert.equal(observed.osTmpdir, runDir, "the child's os.tmpdir() was not the private run directory");
  assert.equal(observed.env["O16_INJECTED"], undefined, "an injected ambient variable reached the Truth child");
  assert.equal(observed.env["SECRETISH"], undefined, "an injected ambient variable reached the Truth child");
  rmSync(host, { recursive: true, force: true });
  assert.deepEqual(tmpEntries(), TMP_BASELINE, "the adapter success path touched shared /tmp");
});

// T12 — the adapter stays vendorable.
test("T12 the adapter imports node builtins only", () => {
  const source = readFileSync(ADAPTER, "utf8");
  const specifiers = [...source.matchAll(/^import\s[^\n]*?from\s+['"]([^'"]+)['"]/gm)]
    .map((m) => m[1] ?? "");
  assert.ok(specifiers.length > 0, "no import statements were found — the parse is wrong");
  assert.deepEqual(specifiers.filter((sp) => !sp.startsWith("node:")), [],
    "the adapter must import node builtins only, so a vendored copy still works");
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
  for (const value of ["", "rel/x", "/tmp", "/tmp/child", "/var/tmp", "/var/tmp/child", "/opt", "/dev/shm/o16"]) {
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
  // No script is exempt by NAME. Order 14 exempted `build` and `typecheck` on the premise that
  // a bare `tsc` allocates nothing; that premise is false — TypeScript enables a compile cache
  // against os.tmpdir() at start-up, so an ungoverned `tsc` writes /tmp/node-compile-cache. The
  // requirement is therefore structural: every committed script value begins at a canonical
  // governed entry, and the two package-manager entries are themselves that boundary.
  const GOVERNED_SCRIPT = /^node (?:\.\.\/)?scripts\/trio\/governed-(?:launch|npm|pnpm)\.mjs(?: |$)/;
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string> };
  for (const [name, value] of Object.entries(pkg.scripts)) {
    assert.match(value, GOVERNED_SCRIPT, `package.json script ${name} bypasses the governed boundary`);
  }
  assert.equal(pkg.scripts["governed"], "node scripts/trio/governed-npm.mjs",
    "the pre-npm boundary has no committed caller — it would be dead code");
  assert.equal(pkg.scripts["governed:pnpm"], "node scripts/trio/governed-pnpm.mjs",
    "the pre-pnpm boundary has no committed caller — pnpm is the Trio's own package manager");
  for (const name of ["build", "typecheck"]) {
    assert.match(pkg.scripts[name] ?? "", /governed-launch\.mjs trio-test -- tsc /,
      `package.json script ${name} must run the compiler through the governed boundary`);
  }
  const tui = JSON.parse(readFileSync(join(process.cwd(), "tui/package.json"), "utf8")) as { scripts: Record<string, string> };
  for (const [name, value] of Object.entries(tui.scripts)) {
    assert.match(value, GOVERNED_SCRIPT, `tui script ${name} bypasses the governed boundary`);
  }
  assert.match(tui.scripts["type-check"] ?? "", /governed-launch\.mjs trio-test -- tsc /,
    "the tui type-check must run the compiler through the governed boundary");
});

/** Test-name patterns that select exactly one scanner each. */
const TMP_SCANNER = "outside the declared refusal fixtures";
const EXECUTION_SCANNER = "no ungoverned package-manager or build-tool execution";

/**
 * A detached, git-tracked copy of THIS repository's committed tree, with a runner that executes
 * one scanner in it as an independent process. Plants go here; never into a candidate.
 */
function detachedScannerHost(name: string): {
  copy: string;
  work: string;
  runScanner: (pattern: string) => { status: number | null; out: string };
  add: (relative: string) => void;
  remove: (relative: string) => void;
} {
  const work = scratch(name);
  const copy = join(work, "repo");
  mkdirSync(copy, { recursive: true, mode: 0o700 });
  execFileSync("sh", ["-c", `git ls-files -z | tar -c --null -T - -f - | tar -x -f - -C ${JSON.stringify(copy)}`],
    { cwd: process.cwd() });
  for (const args of [["init", "-q"], ["add", "-A"],
       ["-c", "user.email=o17@lab", "-c", "user.name=o17", "commit", "-qm", "detached"]]) {
    execFileSync("git", args, { cwd: copy, stdio: "ignore" });
  }
  assert.ok(execFileSync("git", ["ls-files"], { cwd: copy, encoding: "utf8" }).split("\n").length > 100,
    "the detached copy tracks almost nothing — the scanners would pass vacuously");
  // The loader and its dependencies come from this repository; nothing is installed.
  symlinkSync(join(process.cwd(), "node_modules"), join(copy, "node_modules"));
  // The node test runner refuses to run files when it detects it is already inside one, and it
  // signals that through the environment. The scanner must be a genuinely independent run.
  const scannerEnv: NodeJS.ProcessEnv = { ...process.env, TMPDIR: work, TMP: work, TEMP: work };
  for (const key of Object.keys(scannerEnv)) if (key.startsWith("NODE_TEST_")) delete scannerEnv[key];
  const runScanner = (pattern: string): { status: number | null; out: string } => {
    const r = spawnSync(process.execPath,
      ["--import", "tsx", "--test", "--test-name-pattern", pattern, "src/core/temp-policy.test.ts"],
      { cwd: copy, encoding: "utf8", shell: false, env: scannerEnv });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    // A name pattern that selects nothing exits 0. Requiring the scanner to have RUN is what
    // stops every control below from passing vacuously.
    const ran = Number((out.match(/^# tests (\d+)$/m) ?? [])[1] ?? "0");
    assert.equal(ran, 1, `the pattern ${JSON.stringify(pattern)} selected ${ran} tests, not exactly 1: ${out.slice(-600)}`);
    return { status: r.status, out };
  };
  return {
    copy, work, runScanner,
    add: (relative) => execFileSync("git", ["add", relative], { cwd: copy, stdio: "ignore" }),
    remove: (relative) => execFileSync("git", ["rm", "-q", "-f", relative], { cwd: copy, stdio: "ignore" }),
  };
}

// T15 — the scanners are EXECUTED, and their exit status is the assertion.
test("T15 both content-anchored scanners run, pass clean, and fail on a plant", () => {
  const { copy, work, runScanner, add, remove } = detachedScannerHost("t15");

  const cleanTmp = runScanner(TMP_SCANNER);
  assert.equal(cleanTmp.status, 0, `the /tmp scanner failed on an unmodified tree: ${cleanTmp.out.slice(-800)}`);
  const cleanExecution = runScanner(EXECUTION_SCANNER);
  assert.equal(cleanExecution.status, 0, `the execution scanner failed on an unmodified tree: ${cleanExecution.out.slice(-800)}`);

  // Plant A — a live forbidden write inside a DECLARED file. A pathname allowlist would miss it.
  const declared = join(copy, "scripts/trio/governed-temp-authority.mjs");
  const original = readFileSync(declared, "utf8");
  writeFileSync(declared, `${original}\nfs.mkdirSync("/tmp/o16-plant-declared", { recursive: true });\n`);
  const plantedDeclared = runScanner(TMP_SCANNER);
  assert.notEqual(plantedDeclared.status, 0, "a live /tmp write planted in a DECLARED file was not caught");
  assert.match(plantedDeclared.out, /declared content changed/, "the declared-file plant was caught for the wrong reason");
  writeFileSync(declared, original);

  // Plant B — a forbidden write in a file the allowlist has never heard of.
  const unknown = join(copy, "src/core/o16-unknown-writer.ts");
  writeFileSync(unknown, `import fs from "node:fs";\nfs.mkdirSync("/tmp/o16-plant-unknown", { recursive: true });\n`);
  add("src/core/o16-unknown-writer.ts");
  const plantedUnknown = runScanner(TMP_SCANNER);
  assert.notEqual(plantedUnknown.status, 0, "a live /tmp write in an UNDECLARED file was not caught");
  assert.match(plantedUnknown.out, /o16-unknown-writer/, "the undeclared-file plant was caught for the wrong reason");
  remove("src/core/o16-unknown-writer.ts");

  // Plant C — a raw package-manager invocation, the bypass class the second scanner exists for.
  const bypass = join(copy, "src/core/o16-bypass.ts");
  writeFileSync(bypass, `export const build = "pnpm run build";\n`);
  add("src/core/o16-bypass.ts");
  const plantedPm = runScanner(EXECUTION_SCANNER);
  assert.notEqual(plantedPm.status, 0, "a raw package-manager invocation was not caught");
  assert.match(plantedPm.out, /o16-bypass/, "the package-manager plant was caught for the wrong reason");

  // Neither plant was ever executed, so neither path exists.
  for (const path of ["/tmp/o16-plant-declared", "/tmp/o16-plant-unknown"]) {
    assert.equal(readdirSync("/tmp").includes(path.slice("/tmp/".length)), false, `${path} was created by the control`);
  }
  rmSync(work, { recursive: true, force: true });
  assert.deepEqual(tmpEntries(), TMP_BASELINE, "the scanner controls touched shared /tmp");
});

// T16 — nothing lab-owned survives on shared storage, and the governed root is clean.
test("T16 no lab-owned /tmp entry and no governed residue survive this suite", () => {
  assert.deepEqual(tmpEntries(), TMP_BASELINE,
    "this suite changed the set of lab-owned entries on shared temporary storage");
  const root = GOVERNED_ROOT;
  for (const component of ["trio-agent", "trio-test"]) {
    let entries: string[] = [];
    try { entries = readdirSync(join(root, component)); } catch { continue; }
    // Ancestors of this process are alive by construction and are not residue; everything
    // else under a component directory is.
    assert.deepEqual(entries.filter((n) => n !== ".runs" && !OWN_CHAIN.has(n)), [],
      `${component} holds governed residue`);
    const sidecars = readdirSync(join(root, component, ".runs"))
      .filter((n) => !OWN_CHAIN.has(n.replace(/\.json$/, "")));
    assert.deepEqual(sidecars, [], `${component} holds orphaned ownership records`);
  }
});

// ─── T17: the entry contract that replaced the lifecycle-marker heuristic ─────
//
// Every row below is a bypass the Order 15 guard permitted, or a shape the binding
// specification required it to refuse. The values that name shared storage are exercised
// IN-PROCESS against the canonical module, because a subprocess would honour a hostile
// NODE_COMPILE_CACHE at Node startup — before any guard exists — and write there for real.

test("T17 the governed-child contract refuses every forged, blank, absent and traversing shape", async () => {
  const mod = await import(AUTHORITY) as typeof import("../../scripts/trio/governed-temp-authority.mjs");
  const root = GOVERNED_ROOT;
  const run = await mintRun("trio-test");
  const host = scratch("t17");
  const linkToForbidden = join(host, "link-to-forbidden");
  symlinkSync("/tmp", linkToForbidden);
  const outside = join(host, "outside-run");
  mkdirSync(outside, { mode: 0o700 });

  const good = childEnvOf(root, run.runDir, "trio-test", run.runId);
  const refuse = (name: string, env: NodeJS.ProcessEnv): void => {
    assert.throws(() => mod.assertGovernedChildEnvironment(env),
      (err: { code?: string }) => err.code === "ungoverned_parent_environment" || err.code === "root_is_forbidden"
        || err.code === "root_not_configured" || err.code === "root_not_absolute",
      `${name} was accepted as a governed child environment`);
  };

  // The accepted baseline. Without it the refusals below could all be vacuous.
  const proven = mod.assertGovernedChildEnvironment(good);
  assert.equal(proven.runDir, run.runDir, "a genuine governed child environment was not recognised");
  assert.equal(proven.runId, run.runId, "the proven run identity is wrong");

  refuse("absent lifecycle markers and no governed environment", baseEnv(root));
  refuse("blank markers", { ...baseEnv(root), npm_lifecycle_event: "", npm_execpath: "" });
  refuse("forged markers with no governed environment",
    { ...baseEnv(root), npm_lifecycle_event: "test", npm_execpath: "/usr/bin/npm" });
  refuse("pnpm-exec shape (npm_command set, no lifecycle markers)",
    { ...baseEnv(root), npm_command: "exec", npm_config_user_agent: "pnpm/11.5.0 npm/? node/v22.22.3 linux x64" });
  refuse("blank TMPDIR", { ...good, TMPDIR: "", TMP: "", TEMP: "" });
  refuse("whitespace TMPDIR", { ...good, TMPDIR: "   ", TMP: "   ", TEMP: "   " });
  refuse("relative TMPDIR", { ...good, TMPDIR: "rel/dir", TMP: "rel/dir", TEMP: "rel/dir" });
  refuse("TMPDIR is shared storage", { ...good, TMPDIR: "/tmp", TMP: "/tmp", TEMP: "/tmp" });
  refuse("TMPDIR is /var/tmp", { ...good, TMPDIR: "/var/tmp", TMP: "/var/tmp", TEMP: "/var/tmp" });
  refuse("TMPDIR is a symlink to shared storage",
    { ...good, TMPDIR: linkToForbidden, TMP: linkToForbidden, TEMP: linkToForbidden });
  refuse("TMP disagrees with TMPDIR", { ...good, TMP: outside });
  refuse("TEMP disagrees with TMPDIR", { ...good, TEMP: outside });
  refuse("TMPDIR is the governed root itself", { ...good, TMPDIR: root, TMP: root, TEMP: root });
  refuse("TMPDIR is outside the validated root", { ...good, TMPDIR: host, TMP: host, TEMP: host });
  refuse("blank NODE_COMPILE_CACHE", { ...good, NODE_COMPILE_CACHE: "" });
  refuse("absent NODE_COMPILE_CACHE", { ...good, NODE_COMPILE_CACHE: undefined });
  refuse("NODE_COMPILE_CACHE on shared storage", { ...good, NODE_COMPILE_CACHE: "/tmp/o16-cache" });
  refuse("NODE_COMPILE_CACHE traversing out of the run directory",
    { ...good, NODE_COMPILE_CACHE: join(run.runDir, "../../../../../../../tmp/o16-traversal") });
  refuse("NODE_COMPILE_CACHE through a symlink to shared storage",
    { ...good, NODE_COMPILE_CACHE: join(linkToForbidden, "cache") });
  refuse("NODE_COMPILE_CACHE outside the private run directory",
    { ...good, NODE_COMPILE_CACHE: join(outside, "cache") });
  refuse("forged run id with no ownership record",
    { ...good, PEHVERSE_TEMP_RUN_ID: "trio-test-1-deadbeef" });
  refuse("malformed run id", { ...good, PEHVERSE_TEMP_RUN_ID: "../../escape" });
  refuse("component not on the allow list", { ...good, PEHVERSE_TEMP_COMPONENT: "trio-rogue" });
  refuse("mismatched component", { ...good, PEHVERSE_TEMP_COMPONENT: "trio-agent" });
  refuse("missing run identity",
    { ...good, PEHVERSE_TEMP_RUN_ID: undefined, PEHVERSE_TEMP_COMPONENT: undefined });
  refuse("root unset", { ...good, [TEMP_ROOT_ENV]: undefined });
  refuse("root blank", { ...good, [TEMP_ROOT_ENV]: "" });
  refuse("root is shared storage", { ...good, [TEMP_ROOT_ENV]: "/tmp" });

  // A forged ownership record must not rescue a forged environment: the record has to agree
  // with the environment and be bound to THIS boot.
  const forgedId = "trio-test-1-c0ffee00";
  const forgedDir = join(root, "trio-test", forgedId);
  mkdirSync(forgedDir, { mode: 0o700 });
  const forgedRecord = join(root, "trio-test", ".runs", `${forgedId}.json`);
  const forgedEnv = childEnvOf(root, forgedDir, "trio-test", forgedId);
  try {
    writeFileSync(forgedRecord, JSON.stringify({
      marker: "pehverse-governed-temp-child", version: 1, component: "trio-test", runId: forgedId,
      childPath: outside, root, pid: process.pid, bootId: "not-this-boot",
    }), { mode: 0o600 });
    refuse("ownership record naming a different run directory", forgedEnv);
    writeFileSync(forgedRecord, JSON.stringify({
      marker: "pehverse-governed-temp-child", version: 1, component: "trio-test", runId: forgedId,
      childPath: forgedDir, root, pid: process.pid, bootId: "not-this-boot",
    }), { mode: 0o600 });
    refuse("ownership record from another boot", forgedEnv);
    writeFileSync(forgedRecord, JSON.stringify({
      marker: "not-a-governed-child", version: 1, component: "trio-test", runId: forgedId,
      childPath: forgedDir, root, pid: process.pid,
    }), { mode: 0o600 });
    refuse("ownership record with the wrong marker", forgedEnv);
  } finally {
    rmSync(forgedRecord, { force: true });
    rmSync(forgedDir, { recursive: true, force: true });
  }

  run.release();
  rmSync(host, { recursive: true, force: true });
  assert.deepEqual(tmpEntries(), TMP_BASELINE, "the entry-contract matrix touched shared /tmp");
});

test("T18 a declared top-of-chain entry refuses an inherited ungoverned compile cache", async () => {
  const mod = await import(AUTHORITY) as typeof import("../../scripts/trio/governed-temp-authority.mjs");
  const root = GOVERNED_ROOT;
  const host = scratch("t18");
  const linkToForbidden = join(host, "link-to-forbidden");
  symlinkSync("/tmp", linkToForbidden);

  // Nothing inherited: the entry is the top of the chain and allocates nothing before deciding.
  assert.equal(mod.assertCanonicalEntryEnvironment(baseEnv(root)), root,
    "a clean top-of-chain entry was refused");

  for (const [name, cache] of [
    ["shared storage", "/tmp/o16-entry"],
    ["/var/tmp", "/var/tmp/o16-entry"],
    ["a symlink to shared storage", join(linkToForbidden, "cache")],
    ["a relative path", "rel/cache"],
    ["whitespace", "   "],
    ["traversal out of the root", join(root, "../../../../../../../tmp/o16-entry")],
    ["a directory outside the governed root", join(process.cwd(), ".o16-outside-cache")],
  ] as const) {
    assert.throws(() => mod.assertCanonicalEntryEnvironment({ ...baseEnv(root), NODE_COMPILE_CACHE: cache }),
      (err: { code?: string }) => err.code === "ungoverned_inherited_cache",
      `an inherited compile cache on ${name} was accepted at a top-of-chain entry`);
  }
  rmSync(host, { recursive: true, force: true });
  assert.deepEqual(tmpEntries(), TMP_BASELINE, "the top-of-chain matrix touched shared /tmp");
});

test("T19 an undeclared launch is refused end to end, however it was reached", () => {
  const root = GOVERNED_ROOT;
  const reached = "CHILD REACHED";
  const child = ["-e", `console.log(${JSON.stringify(reached)})`];
  // No declaration, no governed parent: refused, whatever the lifecycle variables say.
  for (const [name, extra] of [
    ["no markers at all", {}],
    ["blank markers", { npm_lifecycle_event: "", npm_execpath: "" }],
    ["forged markers", { npm_lifecycle_event: "test", npm_execpath: "/usr/bin/npm" }],
    ["pnpm-exec shape", { npm_command: "exec", npm_config_user_agent: "pnpm/11.5.0" }],
  ] as const) {
    const r = runNode([LAUNCH, "trio-test", "--", process.execPath, ...child], { ...baseEnv(root), ...extra });
    assert.notEqual(r.status, 0, `${name}: an undeclared launch succeeded`);
    assert.ok(!r.out.includes(reached), `${name}: the child was reached through an undeclared launch`);
    assert.match(r.out, /ungoverned_parent_environment/, `${name}: refused for the wrong reason`);
  }
  // A declared entry, and a genuine governed child through the canonical package-manager entry,
  // both succeed — so the refusals above are a contract, not a blanket denial.
  const declared = runNode([LAUNCH, "--entry=operator", "trio-test", "--", process.execPath, ...child], baseEnv(root));
  assert.equal(declared.status, 0, `a declared operator entry was refused: ${declared.out.slice(0, 300)}`);
  assert.ok(declared.out.includes(reached), "a declared operator entry did not reach the child");
  const nested = runNode([GOVERNED_PNPM, "exec", "--", process.execPath, LAUNCH, "trio-test", "--", process.execPath, ...child], baseEnv(root));
  assert.equal(nested.status, 0, `a genuine governed child was refused: ${nested.out.slice(-400)}`);
  assert.ok(nested.out.includes(reached), "the canonical pnpm entry did not reach a nested governed child");
  assert.deepEqual(tmpEntries(), TMP_BASELINE, "the end-to-end entry matrix touched shared /tmp");
});

test("T20 the reaper collects a disproven run and never a live one", async () => {
  const mod = await import(AUTHORITY) as typeof import("../../scripts/trio/governed-temp-authority.mjs");
  const root = GOVERNED_ROOT;
  const orphanId = "trio-test-1-0badf00d";
  const orphanDir = join(root, "trio-test", orphanId);
  const orphanRecord = join(root, "trio-test", ".runs", `${orphanId}.json`);
  mkdirSync(orphanDir, { mode: 0o700 });
  writeFileSync(orphanRecord, JSON.stringify({
    marker: "pehverse-governed-temp-child", version: 1, component: "trio-test", runId: orphanId,
    childPath: orphanDir, root, pid: 1, bootId: "a-previous-boot", createdAt: 0,
  }), { mode: 0o600 });
  // A live run must survive the same pass.
  const live = await mintRun("trio-test");
  try {
    const reaped = mod.reapDisprovenRuns(process.env);
    assert.ok(reaped.includes(orphanId), `the reaper left a disproven run behind: ${reaped.join(", ")}`);
    assert.ok(!reaped.includes(live.runId), "the reaper collected a run whose owner is alive");
    assert.equal(readdirSync(join(root, "trio-test")).includes(orphanId), false, "the orphan directory survived");
    assert.equal(readdirSync(join(root, "trio-test", ".runs")).includes(`${orphanId}.json`), false, "the orphan record survived");
    assert.equal(readdirSync(join(root, "trio-test")).includes(live.runId), true, "a live run directory was collected");
  } finally {
    rmSync(orphanDir, { recursive: true, force: true });
    rmSync(orphanRecord, { force: true });
    live.release();
  }
});

// ─── T21: every bypass class the analysis claims to close, planted and caught ─
//
// Order 16's scanner was a regex, and a regex cannot see `PM=pnpm; $PM run test`, an alias,
// `corepack`, a bare `npx <tool>`, or a name assembled from pieces. Each row below is one of
// those classes, planted into a detached copy and required to fail the scanner. The clean
// control runs first, so a plant that "fails" because the tree was already failing is visible.

test("T21 the execution analysis catches every enumerated bypass class", () => {
  const { copy, work, runScanner, add, remove } = detachedScannerHost("t21");
  const clean = runScanner(EXECUTION_SCANNER);
  assert.equal(clean.status, 0, `the execution scanner failed on an unmodified tree: ${clean.out.slice(-900)}`);

  const shell = (body: string): readonly [string, string] => ["scripts/o17-plant.sh", `#!/bin/sh\n${body}\n`];
  const program = (body: string): readonly [string, string] => ["src/core/o17-plant.ts", body];
  const plants: ReadonlyArray<readonly [string, readonly [string, string]]> = [
    ["direct command", shell("pnpm run build")],
    ["shell variable in command position", shell("PM=pnpm\n$PM run test")],
    ["shell alias", shell("alias pm=pnpm\npm run test")],
    ["shell function body", shell("build() {\n  pnpm run build\n}\nbuild")],
    ["corepack", shell("corepack pnpm@9 run build")],
    ["corepack enable", shell("corepack enable")],
    ["bare npx <tool>", shell("npx tsc -p tsconfig.json")],
    ["env wrapper", shell("env FOO=1 pnpm install")],
    ["sh -c wrapper", shell('sh -c "pnpm run build"')],
    ["bash -c with an inner variable", shell('bash -c "PM=npm; $PM ci"')],
    ["bare compiler", shell("tsc -p tsconfig.json")],
    ["bare loader", shell("tsx src/server.ts")],
    ["spawn API", program('import { spawnSync } from "node:child_process";\nspawnSync("pnpm", ["run", "build"]);\n')],
    ["concatenated construction", program('import { spawnSync } from "node:child_process";\nspawnSync("pn" + "pm", []);\n')],
    ["array-join construction", program('import { spawnSync } from "node:child_process";\nspawnSync(["p","n","p","m"].join(""), []);\n')],
    ["unresolved dynamic command", program('import { spawnSync } from "node:child_process";\nspawnSync(chosenCommand, []);\n')],
    ["shell string through exec", program('import { execSync } from "node:child_process";\nexecSync("pnpm run build");\n')],
    ["manifest script", ["o17-plant/package.json", JSON.stringify({ name: "p", private: true, scripts: { build: "pnpm run compile" } })]],
    ["service definition", ["deploy/o17-plant.service", "[Service]\nExecStart=/usr/bin/env pnpm run start\n"]],
    ["deployment descriptor", ["deploy/o17-plant.yaml", "steps:\n  - run: npm ci\n"]],
    ["documented example", ["docs/o17-plant.md", "Run it:\n\n```sh\npnpm test\n```\n"]],
  ];

  const missed: string[] = [];
  for (const [name, [relative, contents]] of plants) {
    mkdirSync(dirname(join(copy, relative)), { recursive: true });
    writeFileSync(join(copy, relative), contents);
    add(relative);
    const planted = runScanner(EXECUTION_SCANNER);
    if (planted.status === 0 || !planted.out.includes(relative.replace(/\/package\.json$/, ""))) {
      missed.push(`${name} (${relative}) status=${planted.status}`);
    }
    remove(relative);
  }
  assert.deepEqual(missed, [], `the execution analysis missed: ${missed.join("; ")}`);

  // …and the clean tree still passes afterwards, so the controls above are not sticky.
  const after = runScanner(EXECUTION_SCANNER);
  assert.equal(after.status, 0, `the execution scanner did not return to clean: ${after.out.slice(-900)}`);
  rmSync(work, { recursive: true, force: true });
  assert.deepEqual(tmpEntries(), TMP_BASELINE, "the execution-analysis controls touched shared /tmp");
});

// ─── T22: uniform three-repository tampering cannot preserve the boundary ─────
//
// A cross-repository comparison is blind to a change made identically in all three: nothing
// diverges. Order 16's anchor digested declared PATHS, so it was blind too. The anchor now
// binds bytes, and this test proves it end to end — three copies, one identical edit, still
// byte-identical to one another, and the parity suite refuses them.

test("T22 a uniform three-repository byte change cannot keep the trusted boundary", () => {
  const work = scratch("t22");
  const slots = ["pehlichi", "loony-luna", "mad-ptah"] as const;
  // Copy each slot from ITS OWN repository: the parity suite checks package identity per slot,
  // so three copies of one repository would fail discovery instead of failing on the anchor.
  const sources = slots.map((slot) => join(process.cwd(), "..", slot));
  for (const source of sources) {
    assert.ok(existsSync(join(source, "package.json")), `sibling checkout ${source} is missing — T22 cannot run`);
  }
  const roots = slots.map((slot) => join(work, slot));
  for (const [index, root] of roots.entries()) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    execFileSync("sh", ["-c", `git ls-files -z | tar -c --null -T - -f - | tar -x -f - -C ${JSON.stringify(root)}`],
      { cwd: sources[index] });
  }
  const parityEnv: NodeJS.ProcessEnv = { ...process.env, TMPDIR: work, TMP: work, TEMP: work, TRIO_REPOSITORIES: roots.join(",") };
  for (const key of Object.keys(parityEnv)) if (key.startsWith("NODE_TEST_")) delete parityEnv[key];
  const runParity = (): { status: number | null; out: string } => {
    const r = spawnSync(process.execPath,
      ["--import", "tsx", "--test", "--test-name-pattern", "trusted manifests bind the closed inventory", "tests/parity/runtime-parity.test.ts"],
      { cwd: process.cwd(), encoding: "utf8", shell: false, env: parityEnv });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const ran = Number((out.match(/^# tests (\d+)$/m) ?? [])[1] ?? "0");
    assert.equal(ran, 1, `the anchor test did not run (selected ${ran}): ${out.slice(-700)}`);
    return { status: r.status, out };
  };

  // The copies are faithful, so the anchor holds before the tamper.
  const clean = runParity();
  assert.equal(clean.status, 0, `the anchor rejected faithful copies: ${clean.out.slice(-900)}`);

  const anchored = "scripts/trio/governed-temp-authority.mjs";
  const before = roots.map((root) => readFileSync(join(root, anchored), "utf8"));
  assert.equal(new Set(before).size, 1, "the anchored authority is not byte-identical across the Trio to begin with");

  // The uniform edit: the same bytes in all three, so nothing DIVERGES between them. This is the
  // one shape a cross-repository comparison cannot see, and the shape a path-only anchor missed.
  for (const root of roots) writeFileSync(join(root, anchored), `${before[0]}\n// uniform tamper\n`);
  assert.equal(new Set(roots.map((root) => readFileSync(join(root, anchored), "utf8"))).size, 1,
    "the tamper was not uniform — it would be caught by parity, which is not what this test proves");

  const tampered = runParity();
  assert.notEqual(tampered.status, 0, "a uniform three-repository byte change kept the trusted boundary anchor");
  assert.match(tampered.out, /architecture boundary cannot self-redefine/,
    `the anchor test failed for the wrong reason: ${tampered.out.slice(-900)}`);

  rmSync(work, { recursive: true, force: true });
  assert.deepEqual(tmpEntries(), TMP_BASELINE, "the anchor controls touched shared /tmp");
});

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
import { readdirSync, readFileSync } from "node:fs";
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

test("F2 fix verification: truth-agent-adapter.ts imports childTempEnv and processScratchDir", () => {
  // Read the adapter source and verify it imports the governed temp functions
  const adapterPath = join(process.cwd(), "runtime/server/truth-agent-adapter.ts");
  const source = readFileSync(adapterPath, "utf8");
  assert.ok(
    source.includes("processScratchDir"),
    "truth-agent-adapter.ts does not import processScratchDir"
  );
  assert.ok(
    source.includes("childTempEnv"),
    "truth-agent-adapter.ts does not import childTempEnv"
  );
  assert.ok(
    source.includes("from '../../src/core/temp-authority.js'"),
    "truth-agent-adapter.ts does not import from temp-authority.js"
  );
});

test("F2 fix verification: verifierEnv() spreads childTempEnv and includes PEHVERSE_TEMP_ROOT", () => {
  // Read the adapter source and verify verifierEnv() uses childTempEnv
  const adapterPath = join(process.cwd(), "runtime/server/truth-agent-adapter.ts");
  const source = readFileSync(adapterPath, "utf8");
  // Find the verifierEnv function body
  const fnMatch = source.match(/function verifierEnv\(\)[\s\S]*?\n\}/);
  assert.ok(fnMatch !== null, "could not find verifierEnv() in truth-agent-adapter.ts");
  const fnBody = fnMatch[0];
  assert.ok(
    fnBody.includes("childTempEnv("),
    "verifierEnv() does not call childTempEnv()"
  );
  assert.ok(
    fnBody.includes("processScratchDir()"),
    "verifierEnv() does not call processScratchDir()"
  );
  assert.ok(
    fnBody.includes("PEHVERSE_TEMP_ROOT"),
    "verifierEnv() does not include PEHVERSE_TEMP_ROOT"
  );
});

test("F2 fix verification: governed-launch.mjs exports PEHVERSE_TEMP_ROOT to children", () => {
  // Read the wrapper source and verify it sets PEHVERSE_TEMP_ROOT
  const wrapperPath = join(process.cwd(), "scripts/trio/governed-launch.mjs");
  const source = readFileSync(wrapperPath, "utf8");
  assert.ok(
    source.includes("PEHVERSE_TEMP_ROOT"),
    "governed-launch.mjs does not set PEHVERSE_TEMP_ROOT"
  );
  assert.ok(
    source.includes("PEHVERSE_TEMP_RUN_ID"),
    "governed-launch.mjs does not set PEHVERSE_TEMP_RUN_ID"
  );
  assert.ok(
    source.includes("PEHVERSE_TEMP_COMPONENT"),
    "governed-launch.mjs does not set PEHVERSE_TEMP_COMPONENT"
  );
});

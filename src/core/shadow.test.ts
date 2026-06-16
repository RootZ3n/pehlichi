import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ScriptedDriver, type DriverAction } from "./driver.js";
import type { AgentEvent } from "./events.js";
import { runAgentInShadow } from "./loop.js";
import type { AgentProfile } from "./profile.js";
import { createLabStore } from "./scenario.js";
import { ShadowWorkspace } from "./shadow.js";

const REAL_REPO = "/pehverse/repos/pehlichi";
const EXPECTED_ENV_KEYS = ["HOME", "LANG", "LC_ALL", "PATH", "SHELL", "TMPDIR"];
// vars the shell itself injects into a child's env (not inherited from the parent)
const SHELL_INJECTED = new Set(["PWD", "SHLVL", "_", "OLDPWD"]);
const DONE: DriverAction = {
  kind: "done",
  summary: { rootCause: "r", changes: ["c"], verification: ["v"] },
};

const testProfile: AgentProfile = {
  name: "TestAgent",
  role: "test",
  personaPreamble: "You are a generic test agent.",
  skillTags: ["test"],
};

function capture(): { events: AgentEvent[]; sink: (e: AgentEvent) => void } {
  const events: AgentEvent[] = [];
  return { events, sink: (e) => events.push(e) };
}

/** Run a scripted driver inside a shadow against a throwaway lab-store. */
async function runShadow(
  actions: DriverAction[],
  events: (e: AgentEvent) => void,
): Promise<{ shadowRoot: string; discarded: boolean }> {
  const labStore = createLabStore();
  try {
    return await runAgentInShadow({
      profile: testProfile,
      task: "t",
      labStoreRoot: labStore,
      driver: new ScriptedDriver(actions),
      sinks: [events],
      // These tests exercise terminal MECHANICS (cwd/env/output/receipt); the loop now denies
      // mutating tools by default, so authorize explicitly to reach the handler under test.
      approvalCallback: () => ({ approved: true }),
    });
  } finally {
    rmSync(labStore, { recursive: true, force: true });
  }
}

function terminalResult(events: AgentEvent[]): Extract<AgentEvent, { kind: "tool-result" }> {
  const e = events.find((x) => x.kind === "tool-result" && x.tool === "terminal");
  assert.ok(e && e.kind === "tool-result", "a terminal tool-result was emitted");
  return e;
}

test("1. a run gets a fresh shadow workspace under tmpdir, not the real repo", async () => {
  const { events, sink } = capture();
  const result = await runShadow([DONE], sink);
  const start = events.find((e) => e.kind === "session-start");
  assert.ok(start && start.kind === "session-start");
  assert.equal(start.workspaceRoot, result.shadowRoot);
  assert.ok(result.shadowRoot.startsWith(tmpdir()), "shadow is under the OS tmp dir");
  assert.notEqual(result.shadowRoot, REAL_REPO);
  assert.ok(result.shadowRoot.includes("lab-shadow-"));
});

test("2. discard removes the workspace — after a normal run the dir is gone", async () => {
  const { sink } = capture();
  const result = await runShadow([DONE], sink);
  assert.equal(result.discarded, true);
  assert.equal(existsSync(result.shadowRoot), false, "shadow dir no longer exists");
});

test("3. terminal cwd is the shadow root, not the real repo", async () => {
  const { events, sink } = capture();
  const result = await runShadow([{ kind: "tool", tool: "terminal", args: { command: "pwd" } }, DONE], sink);
  const res = terminalResult(events);
  assert.match(res.output, /lab-shadow-/);
  assert.ok(!res.output.includes(REAL_REPO), "pwd is not the real repo");
  const receipt = events.find((e) => e.kind === "terminal-receipt");
  assert.ok(receipt && receipt.kind === "terminal-receipt");
  assert.equal(receipt.cwd, result.shadowRoot);
});

test("4. terminal env contains ONLY the allowlist — a parent secret is absent", async () => {
  process.env["LAB_TEST_SECRET"] = "TOPSECRET-sentinel-value";
  const { events, sink } = capture();
  try {
    await runShadow([{ kind: "tool", tool: "terminal", args: { command: "env" } }, DONE], sink);
    const res = terminalResult(events);
    // the sentinel set in THIS process is not inherited by the terminal.
    assert.ok(!res.output.includes("LAB_TEST_SECRET"), "secret key absent");
    assert.ok(!res.output.includes("TOPSECRET-sentinel-value"), "secret value absent");

    // every printed key is either in the allowlist or shell-injected — nothing inherited.
    const keys = res.output
      .split("\n")
      .map((l) => l.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)?.[1])
      .filter((k): k is string => k !== undefined);
    for (const k of keys) {
      assert.ok(
        EXPECTED_ENV_KEYS.includes(k) || SHELL_INJECTED.has(k),
        `unexpected (inherited?) env var in terminal: ${k}`,
      );
    }

    const receipt = events.find((e) => e.kind === "terminal-receipt");
    assert.ok(receipt && receipt.kind === "terminal-receipt");
    assert.deepEqual(receipt.envKeys, EXPECTED_ENV_KEYS);
  } finally {
    delete process.env["LAB_TEST_SECRET"];
  }
});

test("5. output is capped with a [truncated] marker; no OOM", async () => {
  const { events, sink } = capture();
  await runShadow(
    [{ kind: "tool", tool: "terminal", args: { command: "yes aaaaaaaa | head -c 200000" } }, DONE],
    sink,
  );
  const res = terminalResult(events);
  assert.match(res.output, /\[truncated/);
  assert.ok(res.output.length < 64 * 1024 + 1000, "output is bounded near the cap");
  const receipt = events.find((e) => e.kind === "terminal-receipt");
  assert.ok(receipt && receipt.kind === "terminal-receipt");
  assert.equal(receipt.truncated, true);
  assert.equal(receipt.stdoutBytes, 200000);
});

test("6. terminal-receipt has the right shape — keys only, no values", async () => {
  const { events, sink } = capture();
  const result = await runShadow([{ kind: "tool", tool: "terminal", args: { command: "echo hello" } }, DONE], sink);
  const receipt = events.find((e) => e.kind === "terminal-receipt");
  assert.ok(receipt && receipt.kind === "terminal-receipt");
  assert.equal(receipt.command, "echo hello");
  assert.equal(receipt.cwd, result.shadowRoot);
  assert.deepEqual(receipt.envKeys, EXPECTED_ENV_KEYS);
  // keys only — no "=", and no allowlist VALUE leaked in
  for (const k of receipt.envKeys) {
    assert.equal(typeof k, "string");
    assert.ok(!k.includes("="), `envKeys must be keys, not key=value: ${k}`);
  }
  assert.ok(!receipt.envKeys.includes("/usr/bin:/bin"), "no PATH value present");
  assert.equal(receipt.exitCode, 0);
  assert.equal(typeof receipt.durationMs, "number");
  assert.ok(receipt.durationMs >= 0);
  assert.equal(receipt.stdoutBytes, "hello\n".length);
  assert.equal(receipt.truncated, false);
});

test("7. defense-in-depth (secondary): destructive op outside the workspace is rejected", async () => {
  // NOTE: this is the BELT-AND-SUSPENDERS guard, not the boundary. The real
  // containment is the disposable workspace + stripped env + locked cwd.
  const { events, sink } = capture();
  await runShadow(
    [{ kind: "tool", tool: "terminal", args: { command: "rm -rf /home/zen/should-not-exist" } }, DONE],
    sink,
  );
  const res = terminalResult(events);
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /denied|outside the workspace/);
  // a rejected command never executed, so no receipt was produced.
  assert.ok(!events.some((e) => e.kind === "terminal-receipt"), "no receipt for a denied command");
});

test("8. no automatic promotion — agent/loop has no copy-back path", async () => {
  // (a) the ShadowWorkspace class exposes no promote member.
  const ws = ShadowWorkspace.create();
  assert.equal(typeof (ws as unknown as { promote?: unknown }).promote, "undefined");
  ws.discard();

  // (b) a run that writes files leaves an unrelated "real repo" dir untouched —
  //     nothing is ever copied out of the shadow.
  const realRepo = mkdtempSync(join(tmpdir(), "lab-fake-real-"));
  const { sink } = capture();
  try {
    const result = await runShadow(
      [{ kind: "tool", tool: "write", args: { path: "out.txt", content: "in shadow only" } }, DONE],
      sink,
    );
    assert.equal(existsSync(result.shadowRoot), false, "shadow discarded");
    assert.deepEqual(readdirSync(realRepo), [], "the real repo dir was never written to");
  } finally {
    rmSync(realRepo, { recursive: true, force: true });
  }
});

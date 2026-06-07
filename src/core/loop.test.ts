import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createStore } from "lab-store";

import { ScriptedDriver, type Driver, type DriverAction, type DriverContext, type Message } from "./driver.js";
import type { AgentEvent } from "./events.js";
import { runAgent } from "./loop.js";
import type { AgentProfile } from "./profile.js";
import type { ToolDef } from "./tools.js";
import {
  APP_AFTER,
  APP_BEFORE,
  RIGHT_VALUE,
  SKILL_NAME,
  createLabStore,
  createWorkspace,
  scenarioActions,
} from "./scenario.js";

const REAL_LAB_STORE = process.env["LAB_STORE_ROOT"] ?? "/pehverse/repos/lab-store";

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

function kinds(events: AgentEvent[]): string[] {
  return events.map((e) => e.kind);
}

function assertSubsequence(actual: string[], expected: string[]): void {
  let i = 0;
  for (const k of actual) {
    if (i < expected.length && k === expected[i]) i += 1;
  }
  assert.equal(i, expected.length, `expected subsequence [${expected.join(", ")}] within [${actual.join(", ")}]`);
}

test("1. full-loop scenario: events in order, real file change, real command, real skill", async () => {
  const workspace = createWorkspace();
  const labStore = createLabStore();
  const { events, sink } = capture();
  try {
    await runAgent({
      profile: testProfile,
      task: "Raise the timeout and prove the fix.",
      workspaceRoot: workspace,
      labStoreRoot: labStore,
      driver: new ScriptedDriver(scenarioActions()),
      sinks: [sink],
    });

    // 1a. the stream carries the key events IN ORDER.
    assertSubsequence(kinds(events), [
      "session-start",
      "narrate",
      "root-cause",
      "tool-call",
      "tool-result",
      "diff",
      "skill-created",
      "summary",
      "done",
    ]);
    // every tool-call is matched by a tool-result.
    assert.equal(
      events.filter((e) => e.kind === "tool-call").length,
      events.filter((e) => e.kind === "tool-result").length,
    );
    // the diff event on the write carries the correct before/after.
    const diff = events.find((e) => e.kind === "diff");
    assert.ok(diff && diff.kind === "diff");
    assert.equal(diff.path, "app.sh");
    assert.equal(diff.before, APP_BEFORE);
    assert.equal(diff.after, APP_AFTER);

    // 1b. the file on disk REALLY changed.
    assert.equal(readFileSync(join(workspace, "app.sh"), "utf8"), APP_AFTER);

    // 1c. the terminal command REALLY ran.
    const term = events.find((e) => e.kind === "tool-result" && e.tool === "terminal");
    assert.ok(term && term.kind === "tool-result");
    assert.equal(term.ok, true);
    assert.match(term.output, new RegExp(RIGHT_VALUE));
    assert.match(term.output, /exitCode: 0/);

    // 1d. skill_manage_create REALLY created a module; skill_view pulls it back.
    const created = events.find((e) => e.kind === "skill-created");
    assert.ok(created && created.kind === "skill-created");
    assert.equal(created.name, SKILL_NAME);
    const mod = createStore({ root: labStore }).viewModule(SKILL_NAME);
    assert.match(mod.body, /When to use/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
  }
});

test("2. done without a valid summary throws (and emits an error event)", async () => {
  const workspace = createWorkspace();
  const labStore = createLabStore();
  const { events, sink } = capture();
  const actions: DriverAction[] = [
    { kind: "done", summary: { rootCause: "x", changes: [], verification: ["v"] } },
  ];
  try {
    await assert.rejects(
      runAgent({
        profile: testProfile,
        task: "t",
        workspaceRoot: workspace,
        labStoreRoot: labStore,
        driver: new ScriptedDriver(actions),
        sinks: [sink],
      }),
      /invalid summary/,
    );
    const err = events.find((e) => e.kind === "error");
    assert.ok(err && err.kind === "error" && err.where === "done");
    assert.ok(!events.some((e) => e.kind === "done"), "no done event on rejection");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
  }
});

test("3. a file path escaping the workspace is rejected", async () => {
  const workspace = createWorkspace();
  const labStore = createLabStore();
  const { events, sink } = capture();
  const actions: DriverAction[] = [
    { kind: "tool", tool: "write", args: { path: "../escape.txt", content: "nope" } },
    { kind: "done", summary: { rootCause: "r", changes: ["c"], verification: ["v"] } },
  ];
  try {
    await runAgent({
      profile: testProfile,
      task: "t",
      workspaceRoot: workspace,
      labStoreRoot: labStore,
      driver: new ScriptedDriver(actions),
      sinks: [sink],
    });
    const res = events.find((e) => e.kind === "tool-result" && e.tool === "write");
    assert.ok(res && res.kind === "tool-result");
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /escapes the workspace/);
    assert.ok(!events.some((e) => e.kind === "diff"), "no diff on a rejected write");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
  }
});

test("4. terminal timeout surfaces as a clean tool-result error, not a hang", async () => {
  const workspace = createWorkspace();
  const labStore = createLabStore();
  const { events, sink } = capture();
  const actions: DriverAction[] = [
    { kind: "tool", tool: "terminal", args: { command: "sleep 5", timeoutMs: 100 } },
    { kind: "done", summary: { rootCause: "r", changes: ["c"], verification: ["v"] } },
  ];
  try {
    await runAgent({
      profile: testProfile,
      task: "t",
      workspaceRoot: workspace,
      labStoreRoot: labStore,
      driver: new ScriptedDriver(actions),
      sinks: [sink],
    });
    const res = events.find((e) => e.kind === "tool-result" && e.tool === "terminal");
    assert.ok(res && res.kind === "tool-result");
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /timed out/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
  }
});

test("5. max-iterations guard trips on a runaway driver", async () => {
  const workspace = createWorkspace();
  const labStore = createLabStore();
  const { events, sink } = capture();
  const runaway: DriverAction[] = Array.from({ length: 5 }, (_unused, i) => ({
    kind: "narrate",
    phase: "other",
    text: `loop ${i}`,
  }));
  try {
    await assert.rejects(
      runAgent({
        profile: testProfile,
        task: "t",
        workspaceRoot: workspace,
        labStoreRoot: labStore,
        driver: new ScriptedDriver(runaway),
        sinks: [sink],
        maxIterations: 2,
      }),
      /exceeded max iterations/,
    );
    const err = events.find((e) => e.kind === "error");
    assert.ok(err && err.kind === "error" && err.where === "loop");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
  }
});

test("6. cross-repo smoke: listModules against the REAL lab-store returns the seeded modules + skillpacks", () => {
  const mods = createStore({ root: REAL_LAB_STORE }).listModules();
  const names = mods.map((m) => m.name).sort();
  assert.ok(names.includes("rebuild-discipline"), `rebuild-discipline not found in ${JSON.stringify(names)}`);
  assert.ok(names.includes("verify-dont-assume"), `verify-dont-assume not found in ${JSON.stringify(names)}`);
  assert.ok(names.length >= 2, `expected at least 2 modules, got ${names.length}`);
});

// ── seam: extraTools tool-registration ───────────────────────────────────────

test("seam: an agent-supplied extraTool is registered, executed, and its result appears in history", async () => {
  const workspace = createWorkspace();
  const labStore = createLabStore();
  const { events, sink } = capture();

  const customTool: ToolDef = {
    spec: { name: "hello_world", description: "Returns a greeting." },
    handler: async (_args, _ctx) => ({ ok: true, output: "Hello, world!" }),
  };

  const actions: DriverAction[] = [
    { kind: "tool", tool: "hello_world", args: {} },
    { kind: "done", summary: { rootCause: "r", changes: ["c"], verification: ["v"] } },
  ];
  try {
    await runAgent({
      profile: testProfile,
      task: "t",
      workspaceRoot: workspace,
      labStoreRoot: labStore,
      driver: new ScriptedDriver(actions),
      sinks: [sink],
      extraTools: [customTool],
    });
    const res = events.find((e) => e.kind === "tool-result" && e.tool === "hello_world");
    assert.ok(res && res.kind === "tool-result");
    assert.equal(res.ok, true);
    assert.equal(res.output, "Hello, world!");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
  }
});

// ── step 2c-fix: textual-call feedback + tool-result grounding ─────────────────

/** A driver that replays canned actions AND snapshots the history it sees each turn. */
class RecordingDriver implements Driver {
  readonly seen: Message[][] = [];
  private i = 0;
  constructor(private readonly actions: DriverAction[]) {}
  async next(ctx: DriverContext): Promise<DriverAction> {
    this.seen.push(ctx.messages.map((m) => ({ ...m })));
    const a = this.actions[this.i];
    if (a === undefined) throw new Error("RecordingDriver exhausted");
    this.i += 1;
    return a;
  }
}

test("2c-fix: textual-call-detected NEVER executes — feedback only, zero tool effects", async () => {
  const workspace = createWorkspace();
  const labStore = createLabStore();
  const { events, sink } = capture();
  const driver = new RecordingDriver([
    { kind: "textual-call-detected", offendingText: 'write({"path":"app.sh","content":"HACKED"})' },
    { kind: "done", summary: { rootCause: "r", changes: ["c"], verification: ["v"] } },
  ]);
  try {
    await runAgent({ profile: testProfile, task: "t", workspaceRoot: workspace, labStoreRoot: labStore, driver, sinks: [sink] });

    // the event is visible (the call did not vanish silently)
    assert.ok(events.some((e) => e.kind === "textual-call-detected"));
    // STRUCTURAL: no execution happened — zero tool-result / diff / terminal-receipt
    assert.ok(!events.some((e) => e.kind === "tool-result"), "no tool-result for a prose call");
    assert.ok(!events.some((e) => e.kind === "diff"), "no diff — the prose write did NOT run");
    assert.ok(!events.some((e) => e.kind === "terminal-receipt"));
    // the file on disk is untouched (the prose write never executed)
    assert.equal(readFileSync(join(workspace, "app.sh"), "utf8"), APP_BEFORE);
    // the loop continued to done (iteration consumed, not aborted)
    assert.ok(events.some((e) => e.kind === "done"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
  }
});

test("2c-fix: feedback is appended as an actionable role:user message", async () => {
  const workspace = createWorkspace();
  const labStore = createLabStore();
  const driver = new RecordingDriver([
    { kind: "textual-call-detected", offendingText: 'read({"path":"x"})' },
    { kind: "done", summary: { rootCause: "r", changes: ["c"], verification: ["v"] } },
  ]);
  try {
    await runAgent({ profile: testProfile, task: "t", workspaceRoot: workspace, labStoreRoot: labStore, driver });
    // the DONE turn (seen[1]) must include the correction the loop appended
    const doneTurn = driver.seen[1] ?? [];
    const fb = doneTurn.find((m) => m.role === "user" && /wrote a tool call as text/i.test(m.content));
    assert.ok(fb, "actionable role:user feedback appended");
    assert.match(fb.content, /function\/tool-call API/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
  }
});

test("2c-fix: a driver that ONLY emits textual calls hits max-iter and errors loudly", async () => {
  const workspace = createWorkspace();
  const labStore = createLabStore();
  const { events, sink } = capture();
  const onlyTextual: DriverAction[] = Array.from({ length: 5 }, () => ({
    kind: "textual-call-detected",
    offendingText: 'read({"path":"x"})',
  }));
  try {
    await assert.rejects(
      runAgent({
        profile: testProfile,
        task: "t",
        workspaceRoot: workspace,
        labStoreRoot: labStore,
        driver: new ScriptedDriver(onlyTextual),
        sinks: [sink],
        maxIterations: 2,
      }),
      /exceeded max iterations/,
    );
    assert.ok(events.some((e) => e.kind === "error" && e.where === "loop"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
  }
});

test("2c-fix: real tool results (incl. failures) are fed into history with actual content", async () => {
  const workspace = createWorkspace();
  const labStore = createLabStore();
  const driver = new RecordingDriver([
    { kind: "tool", tool: "read", args: { path: "app.sh" } }, // succeeds
    { kind: "tool", tool: "read", args: { path: "does-not-exist.txt" } }, // fails
    { kind: "done", summary: { rootCause: "r", changes: ["c"], verification: ["v"] } },
  ]);
  try {
    await runAgent({ profile: testProfile, task: "t", workspaceRoot: workspace, labStoreRoot: labStore, driver });
    const doneTurn = driver.seen[2] ?? []; // history at the DONE turn (after both reads)
    const toolMsgs = doneTurn.filter((m) => m.role === "tool").map((m) => m.content);
    // success carries ACTUAL file content, not a placeholder
    assert.ok(toolMsgs.some((c) => /\[tool:read\] ok/.test(c) && /TIMEOUT=30/.test(c)), "success result content present");
    // failure carries its failure, not "tool ran"
    assert.ok(toolMsgs.some((c) => /\[tool:read\] FAILED:/.test(c)), "failure result present in history");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
  }
});

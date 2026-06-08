import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";

import { ScriptedDriver, type DriverAction } from "./driver.js";
import type { AgentEvent } from "./events.js";
import { runAgent } from "./loop.js";
import type { AgentProfile } from "./profile.js";
import type { ToolDef } from "./tools.js";
import {
  createLabStore,
  createWorkspace,
  scenarioActions,
} from "./scenario.js";

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

test("1. full-loop scenario: events in order, real command, real file change", async () => {
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
      "terminal-receipt",
      "summary",
      "done",
    ]);
    // every tool-call is matched by a tool-result.
    assert.equal(
      events.filter((e) => e.kind === "tool-call").length,
      events.filter((e) => e.kind === "tool-result").length,
    );

    // 1b. multiple terminal commands ran successfully.
    const termResults = events.filter((e) => e.kind === "tool-result" && e.tool === "terminal");
    assert.ok(termResults.length >= 4, `expected at least 4 terminal results, got ${termResults.length}`);
    // all terminal commands should have succeeded
    const termOk = events.filter((e): e is Extract<AgentEvent, { kind: "tool-result" }> => e.kind === "tool-result" && e.tool === "terminal");
    for (const tr of termOk) {
      assert.equal(tr.ok, true, `terminal command failed: ${tr.output?.slice(0, 100)}`);
    }
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

test("3. terminal command that exits non-zero returns ok=false", async () => {
  const workspace = createWorkspace();
  const labStore = createLabStore();
  const { events, sink } = capture();
  const actions: DriverAction[] = [
    { kind: "tool", tool: "terminal", args: { command: "grep NONEXISTENT app.sh" } },
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
    assert.match(res.error ?? "", /exited with code/);
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

test("6. extraTools seam: agent-supplied tools are registered alongside core", async () => {
  const workspace = createWorkspace();
  const labStore = createLabStore();
  const { events, sink } = capture();

  // Register a custom "echo" tool via the seam
  const echoTool: ToolDef = {
    spec: {
      name: "echo",
      description: "Echo args back",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    },
    handler: async (args) => ({ ok: true, output: String(args.text ?? "") }),
  };

  const actions: DriverAction[] = [
    { kind: "tool", tool: "echo", args: { text: "hello from seam" } },
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
      extraTools: [echoTool],
    });
    const res = events.find((e) => e.kind === "tool-result" && e.tool === "echo");
    assert.ok(res && res.kind === "tool-result");
    assert.equal(res.ok, true);
    assert.equal(res.output, "hello from seam");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
  }
});

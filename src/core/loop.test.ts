/**
 * COMPONENT TEST. This drives `executeAgentRun`, the agent loop below the production
 * admission boundary, with fixture-owned dependencies. It proves things about the loop.
 *
 * It does not, and must not be read to, prove that `runAgent` admitted any work: while the
 * committed governed status is PRE_PRODUCTION, `runAgent` executes nothing. Admission is
 * covered separately in `operational-admission.test.ts`.
 */
import { governedMkdtemp } from "./temp-authority.js";
import assert from "node:assert/strict";

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  CHECKPOINT_KEEP,
  listCheckpointFiles,
  loadLatestCheckpoint,
  saveCheckpoint,
} from "./checkpoint.js";
import { createDelegateToolHandlers } from "./agent-tools/delegate-tools.js";
import { ScriptedDriver, type DriverAction } from "./driver.js";
import type { AgentEvent } from "./events.js";
import {  type RunAgentOptions, type RunAgentResult } from "./loop.js";
import * as processRegistryModule from "./process-registry.js";
import { createProcessRegistry, type ProcessOwner } from "./process-registry.js";
import type { AgentProfile } from "./profile.js";
import { createToolRegistry, type ToolContext, type ToolDef } from "./tools.js";
import {
  createLabStore,
  createWorkspace,
  scenarioActions,
} from "./scenario.js";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

// Explicit allow-all approval. Direct/library runs now DENY mutating tools by default, so tests that
// exercise tool MECHANICS (terminal, seam tools, planning) opt in explicitly to authorize them.
const allowAll = () => ({ approved: true as const });


/**
 * PRE_PRODUCTION dormancy.
 *
 * These cases drove `executeAgentRun` directly, below the admission boundary. That is the seam
 * an independent audit turned into a bypass -- a namespace import and a computed property
 * reached the executor and ran an agent turn while the committed status refused it -- so the
 * executor is private now and nothing outside `loop.ts` can call it.
 *
 * Each case below needs a complete agent turn: a driver, real tools, a real workspace. None of
 * that is pure mechanics, and none of it can honestly run while work is refused, so they are
 * dormant rather than rewritten into something weaker that would still report a pass. They are
 * a production-transition gate: at the governance transition they must execute against the
 * admitted path, not be deleted.
 *
 * The stand-in exists so the bodies still typecheck. It throws, so un-skipping a case without
 * doing the real work fails loudly instead of quietly proving nothing.
 */
const PRE_PRODUCTION_DORMANT =
  'PRE_PRODUCTION: needs a complete agent turn below admission; the effectful executor is private. ' +
  'Production-transition gate: this case must execute against the admitted path after the governance transition.';
const componentExecuteAgentRun = (..._unused: unknown[]): Promise<RunAgentResult> => {
  throw new Error('the effectful executor is private; this dormant case cannot run below admission');
};

/** Tests still exercise explicit authority; derive it from each test's exact registry fixture. */
const runAgent = (opts: Omit<RunAgentOptions, 'toolNames'> & { toolNames?: readonly string[] }) =>
  componentExecuteAgentRun({
    ...opts,
    toolNames: opts.toolNames ?? [...createToolRegistry(opts.extraTools).keys()],
  });

// A seam tool named like a known read-only tool (read_file ∈ READ_ONLY_TOOLS), so the default
// library approval auto-approves it. Used to prove read-only tools still run with no callback.
const readOnlyProbeTool: ToolDef = {
  spec: {
    name: "read_file",
    description: "Read-only probe",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  },
  handler: async (args) => ({ ok: true, output: `read ${String(args.path ?? "")}` }),
};

test("1. full-loop scenario: events in order, real command, real file change", { skip: PRE_PRODUCTION_DORMANT }, async () => {
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
      approvalCallback: allowAll,
      // The full-loop scenario scripts 11 steps; give it the budget explicitly since the
      // default runaway guard was lowered to 8 (this test exercises tool mechanics, not the cap).
      maxIterations: 12,
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

test("2. done without a valid summary throws (and emits an error event)", { skip: PRE_PRODUCTION_DORMANT }, async () => {
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

test("3. terminal command that exits non-zero returns ok=false", { skip: PRE_PRODUCTION_DORMANT }, async () => {
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
      approvalCallback: allowAll,
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

test("4. terminal timeout surfaces as a clean tool-result error, not a hang", { skip: PRE_PRODUCTION_DORMANT }, async () => {
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
      approvalCallback: allowAll,
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

test("5. max-iterations guard trips on a runaway driver", { skip: PRE_PRODUCTION_DORMANT }, async () => {
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

test("6. extraTools seam: agent-supplied tools are registered alongside core", { skip: PRE_PRODUCTION_DORMANT }, async () => {
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
      approvalCallback: allowAll,
    });
    const res = events.find((e) => e.kind === "tool-result" && e.tool === "echo");
    assert.ok(res && res.kind === "tool-result");
    assert.equal(res.ok, true);
    assert.match(res.output, /<untrusted-content source="echo:output">/);
    assert.match(res.output, /hello from seam/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
  }
});

// ── Item 2: CHECKPOINTING ─────────────────────────────────────────────────────

test("7. checkpoint module: saves are pruned to the last N; loadLatest returns the newest", () => {
  const dir = governedMkdtemp("cp-mod-");
  try {
    for (let it = 1; it <= 5; it++) {
      saveCheckpoint(dir, { iteration: it, timestamp: it * 10, messages: [{ role: "user", content: `m${it}` }], taskId: "T" });
    }
    // Only the last CHECKPOINT_KEEP (3) survive; loadLatest is the highest iteration.
    assert.equal(listCheckpointFiles(dir).length, CHECKPOINT_KEEP);
    const latest = loadLatestCheckpoint(dir);
    assert.ok(latest);
    assert.equal(latest.iteration, 5);
    assert.equal(latest.messages[0]?.content, "m5");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("8. loop checkpointing: a run periodically writes checkpoints, pruned to the last 3", { skip: PRE_PRODUCTION_DORMANT }, async () => {
  const workspace = createWorkspace();
  const labStore = createLabStore();
  const checkpointDir = join(workspace, ".checkpoints");
  // 6 narrate steps then done — with checkpointEvery:1 the loop saves 6 times.
  const actions: DriverAction[] = [
    ...Array.from({ length: 6 }, (_unused, i): DriverAction => ({ kind: "narrate", phase: "other", text: `step ${i}` })),
    { kind: "done", summary: { rootCause: "r", changes: ["c"], verification: ["v"] } },
  ];
  try {
    const result = await runAgent({
      profile: testProfile,
      task: "t",
      workspaceRoot: workspace,
      labStoreRoot: labStore,
      driver: new ScriptedDriver(actions),
      checkpointDir,
      checkpointEvery: 1,
    });
    assert.equal(result.ok, true);
    // Pruned to the last 3; the newest reflects the 6th completed iteration.
    assert.equal(listCheckpointFiles(checkpointDir).length, CHECKPOINT_KEEP);
    const latest = loadLatestCheckpoint(checkpointDir);
    assert.ok(latest);
    assert.equal(latest.iteration, 6);
    assert.ok(latest.messages.length > 0, "checkpoint captured the conversation");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
  }
});

test("9. loop resume: resumeFromCheckpoint continues from the saved iteration", { skip: PRE_PRODUCTION_DORMANT }, async () => {
  const workspace = createWorkspace();
  const labStore = createLabStore();
  const checkpointDir = join(workspace, ".checkpoints");
  // Seed a checkpoint AT the iteration cap. On resume the loop starts at i=50 and
  // trips the guard immediately — proving startIteration came from the checkpoint.
  // (Without resume it would start at 0 and reach `done` on the first action.)
  saveCheckpoint(checkpointDir, {
    iteration: 50,
    timestamp: 1,
    messages: [{ role: "system", content: "resumed" }, { role: "user", content: "earlier work" }],
    taskId: "t",
  });
  const actions: DriverAction[] = [{ kind: "done", summary: { rootCause: "r", changes: ["c"], verification: ["v"] } }];
  try {
    await assert.rejects(
      runAgent({
        profile: testProfile,
        task: "t",
        workspaceRoot: workspace,
        labStoreRoot: labStore,
        driver: new ScriptedDriver(actions),
        maxIterations: 50,
        checkpointDir,
        resumeFromCheckpoint: true,
      }),
      /exceeded max iterations/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
  }
});

// ── Item 3: PARTIAL RESULTS ON EXHAUSTION ─────────────────────────────────────

test("10. partialOnExhaustion: exhausting the budget returns a partial result with accomplishments", { skip: PRE_PRODUCTION_DORMANT }, async () => {
  const workspace = createWorkspace();
  const labStore = createLabStore();
  // i=0 runs a successful tool (one accomplishment), then narrates until exhaustion.
  const actions: DriverAction[] = [
    { kind: "tool", tool: "terminal", args: { command: "echo built" } },
    { kind: "narrate", phase: "other", text: "still going" },
    { kind: "narrate", phase: "other", text: "still going" },
  ];
  try {
    const result = await runAgent({
      profile: testProfile,
      task: "t",
      workspaceRoot: workspace,
      labStoreRoot: labStore,
      driver: new ScriptedDriver(actions),
      maxIterations: 3,
      partialOnExhaustion: true,
      approvalCallback: allowAll,
    });
    assert.equal(result.ok, false);
    assert.equal(result.partial, true);
    assert.ok((result.accomplished?.length ?? 0) >= 1, "recorded at least one accomplishment");
    assert.match(result.output ?? "", /hit my 3-step budget/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
  }
});

test("11. without partialOnExhaustion, exhaustion still throws (proven behavior unchanged)", { skip: PRE_PRODUCTION_DORMANT }, async () => {
  const workspace = createWorkspace();
  const labStore = createLabStore();
  const actions: DriverAction[] = Array.from({ length: 3 }, (): DriverAction => ({ kind: "narrate", phase: "other", text: "x" }));
  try {
    await assert.rejects(
      runAgent({
        profile: testProfile,
        task: "t",
        workspaceRoot: workspace,
        labStoreRoot: labStore,
        driver: new ScriptedDriver(actions),
        maxIterations: 2,
      }),
      /exceeded max iterations/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
  }
});

// ── Item 4: PLANNING STEP ─────────────────────────────────────────────────────

test("12. planning enabled: a numbered plan is captured and progress is tracked", { skip: PRE_PRODUCTION_DORMANT }, async () => {
  const workspace = createWorkspace();
  const labStore = createLabStore();
  const actions: DriverAction[] = [
    { kind: "narrate", phase: "investigate", text: "My plan:\n1. inspect the file\n2. apply the fix\n3. verify it" },
    { kind: "tool", tool: "terminal", args: { command: "echo one" } },
    { kind: "tool", tool: "terminal", args: { command: "echo two" } },
    { kind: "done", summary: { rootCause: "r", changes: ["c"], verification: ["v"] } },
  ];
  try {
    const result = await runAgent({
      profile: testProfile,
      task: "t",
      workspaceRoot: workspace,
      labStoreRoot: labStore,
      driver: new ScriptedDriver(actions),
      approvalCallback: allowAll,
    });
    assert.equal(result.ok, true);
    assert.ok(result.plan, "a plan was captured");
    assert.equal(result.plan.steps.length, 3);
    assert.equal(result.plan.progress, 2); // two successful tool calls advanced progress
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
  }
});

test("13. planning disabled (plan:false): no plan is produced", { skip: PRE_PRODUCTION_DORMANT }, async () => {
  const workspace = createWorkspace();
  const labStore = createLabStore();
  const actions: DriverAction[] = [
    { kind: "narrate", phase: "investigate", text: "My plan:\n1. step one\n2. step two" },
    { kind: "done", summary: { rootCause: "r", changes: ["c"], verification: ["v"] } },
  ];
  try {
    const result = await runAgent({
      profile: testProfile,
      task: "t",
      workspaceRoot: workspace,
      labStoreRoot: labStore,
      driver: new ScriptedDriver(actions),
      plan: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.plan, undefined);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
  }
});

// ── Item 5: BACKGROUND PROCESS SUPPORT ────────────────────────────────────────

test("14. background process: start via terminal, write+poll, kill, then wait reports killed", async () => {
  const workspace = createWorkspace();
  const labStore = createLabStore();
  const ctx: ToolContext = { workspaceRoot: workspace, labStoreRoot: labStore, store: {} };
  const processRegistry = createProcessRegistry();
  const processScope = processRegistry.scope({ sessionId: "session-a", roomKey: "room-a", taskId: "task-a", callerId: "caller-a" });
  const registry = createToolRegistry(undefined, processScope);
  const terminal = registry.get("terminal");
  const procTool = registry.get("process");
  assert.ok(terminal && procTool, "terminal and process tools are registered");
  try {
    /*
      A background command is planned by containment exactly like a foreground one, so under an
      operator entry — which carries no systemd credential — it refuses instead of spawning. That
      is the point: a background flag must not be a way to reach a shell that a foreground call
      could not. The lifecycle below is therefore driven through the process registry directly,
      which is the layer this test is actually about.
    */
    await assert.rejects(
      () => terminal.handler({ command: "cat", background: true }, ctx),
      /external identity refused|refused by containment/,
      "background terminal must not spawn without a containment policy");

    // `cat` echoes its stdin back — a long-lived process we can drive.
    const sessionId = processScope.spawn("cat", { cwd: workspace, env: { PATH: "/usr/bin:/bin" } }, Date.now());
    assert.ok(sessionId, "the process registry started a session");

    // list shows it running
    const listed = await procTool.handler({ action: "list" }, ctx);
    assert.match(listed.output, new RegExp(`${sessionId}.*running`));

    // write to stdin, give it a moment, then poll for the echoed output
    await procTool.handler({ action: "write", session_id: sessionId, data: "ping\n" }, ctx);
    await delay(150);
    const polled = await procTool.handler({ action: "poll", session_id: sessionId }, ctx);
    assert.equal(polled.ok, true);
    assert.match(polled.output, /ping/);

    // kill it, then wait should report it is no longer running
    const killed = await procTool.handler({ action: "kill", session_id: sessionId }, ctx);
    assert.equal(killed.ok, true);
    const waited = await procTool.handler({ action: "wait", session_id: sessionId, timeoutMs: 2000 }, ctx);
    assert.match(waited.output, /killed/);

    // an unknown session is a clean error, not a throw
    const unknown = await procTool.handler({ action: "poll", session_id: "bg-does-not-exist" }, ctx);
    assert.equal(unknown.ok, false);
    assert.match(unknown.error ?? "", /unknown session/);
  } finally {
    processRegistry.destroy();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
  }
});

test("14b. background process ownership rejects cross-session, room, task, caller, forged-id, and delegated access", async () => {
  const processRegistry = createProcessRegistry();
  const ownerA: ProcessOwner = { sessionId: "session-a", roomKey: "room-a", taskId: "task-a", callerId: "caller-a" };
  const ownerB: ProcessOwner = { sessionId: "session-b", roomKey: "room-b", taskId: "task-b", callerId: "caller-b" };
  const a = processRegistry.scope(ownerA);
  const b = processRegistry.scope(ownerB);
  const sameRoomOtherCaller = processRegistry.scope({ ...ownerA, callerId: "caller-forged" });
  const sameRoomOtherTask = processRegistry.scope({ ...ownerA, taskId: "task-forged" });
  const otherRoom = processRegistry.scope({ ...ownerA, roomKey: "room-forged" });
  const delegatedChild = processRegistry.scope({ sessionId: "delegated-child", roomKey: "room-a", taskId: "task-a", callerId: "caller-a" });
  const spawnCwd = governedMkdtemp("spawn-cwd-");
  try {
    const [processA, processB] = await Promise.all([
      Promise.resolve(a.spawn("sleep 30", { cwd: spawnCwd, env: { PATH: "/usr/bin:/bin" } }, Date.now())),
      Promise.resolve(b.spawn("sleep 30", { cwd: spawnCwd, env: { PATH: "/usr/bin:/bin" } }, Date.now())),
    ]);
    assert.deepEqual(a.list().map((process) => process.processId), [processA], "creator lists only its process");
    assert.deepEqual(b.list().map((process) => process.processId), [processB], "concurrent session lists only its process");

    for (const unauthorized of [b, sameRoomOtherCaller, sameRoomOtherTask, otherRoom, delegatedChild]) {
      assert.equal(unauthorized.get(processA), undefined);
      assert.equal(unauthorized.poll(processA), undefined);
      assert.equal(unauthorized.write(processA, "forged\n"), false);
      assert.equal(unauthorized.kill(processA), false);
      assert.equal(await unauthorized.wait(processA, 1), undefined);
      assert.equal(unauthorized.list().some((process) => process.processId === processA), false);
    }
    assert.equal(a.kill("bg-forged-process-id"), false, "a forged id conveys no authority");
    assert.equal(a.get(processA)?.status, "running", "unauthorized attacks did not affect the owner");

    assert.equal(processRegistry.clearSession(ownerA.sessionId), 1, "session cleanup removes only owned processes");
    assert.equal(a.get(processA), undefined, "closed/expired session id is unusable");
    assert.equal(a.kill(processA), false);
    assert.equal(b.get(processB)?.status, "running", "unrelated session survives cleanup");
  } finally {
    processRegistry.destroy();
  }
});

test("14c. process registry has no unrestricted singleton action API and validates ownership", () => {
  assert.deepEqual(Object.keys(processRegistryModule).sort(), ["createIsolatedProcessScope", "createProcessRegistry"]);
  const registry = createProcessRegistry();
  try {
    for (const owner of [
      { sessionId: "", roomKey: "r", taskId: "t", callerId: "c" },
      { sessionId: "s", roomKey: "r\n", taskId: "t", callerId: "c" },
      { sessionId: "s", roomKey: "r", taskId: "t", callerId: "x".repeat(513) },
    ]) assert.throws(() => registry.scope(owner), /owner is invalid/);
  } finally {
    registry.destroy();
  }
});

// ── Item 6: REAL SUBAGENT SPAWNING ────────────────────────────────────────────

test("15. delegate_task spawns a REAL separate process and returns its JSON result", async () => {
  const dir = governedMkdtemp("subagent-fixture-");
  const runner = join(dir, "echo-runner.cjs");
  // A real, standalone runner: reads the JSON job on stdin, prints a JSON result.
  writeFileSync(
    runner,
    [
      "let data='';",
      "process.stdin.on('data',c=>data+=c);",
      "process.stdin.on('end',()=>{",
      "  let job={}; try{job=JSON.parse(data)}catch{}",
      "  process.stdout.write(JSON.stringify({ok:true,output:`handled: ${job.goal} pid=${process.pid}`})+'\\n');",
      "});",
    ].join("\n"),
  );
  try {
    const handlers = createDelegateToolHandlers({ runnerPath: runner });
    const delegate = handlers.get("delegate_task");
    assert.ok(delegate);
    const res = await delegate({ goal: "compile the module" },
      { workspaceRoot: dir, labStoreRoot: dir, store: {}, delegation: 'test-delegation-token' });
    assert.equal(res.ok, true);
    assert.match(res.output, /handled: compile the module/);
    // Proof it ran in a SEPARATE process: a different pid than this test process.
    const pid = Number(res.output.match(/pid=(\d+)/)?.[1]);
    assert.ok(pid > 0 && pid !== process.pid, "sub-agent ran in its own process");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Blocker 6: APPROVAL GATES ─────────────────────────────────────────────────

test("17. approvalCallback rejects a tool: the handler never runs and a rejection is fed back", { skip: PRE_PRODUCTION_DORMANT }, async () => {
  const workspace = createWorkspace();
  const labStore = createLabStore();
  const { events, sink } = capture();
  let handlerRan = false;
  const guardedTool: ToolDef = {
    spec: { name: "danger", description: "would mutate", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } },
    handler: async () => { handlerRan = true; return { ok: true, output: "mutated" }; },
  };
  const actions: DriverAction[] = [
    { kind: "tool", tool: "danger", args: {} },
    { kind: "done", summary: { rootCause: "r", changes: ["c"], verification: ["v"] } },
  ];
  try {
    const result = await runAgent({
      profile: testProfile,
      task: "t",
      workspaceRoot: workspace,
      labStoreRoot: labStore,
      driver: new ScriptedDriver(actions),
      sinks: [sink],
      extraTools: [guardedTool],
      approvalCallback: ({ tool }) => ({ approved: tool !== "danger", reason: "writes are gated" }),
    });
    assert.equal(result.ok, true);
    assert.equal(handlerRan, false, "the rejected tool's handler must NOT execute");
    const res = events.find((e) => e.kind === "tool-result" && e.tool === "danger");
    assert.ok(res && res.kind === "tool-result");
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /tool not approved: writes are gated/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
  }
});

test("18. no approvalCallback (default): a MUTATING tool is DENIED, never executed", { skip: PRE_PRODUCTION_DORMANT }, async () => {
  // SAFETY: direct/library use must NOT default-approve mutating tools. With no approvalCallback,
  // `terminal` (mutating) is denied at the gate — the handler never runs, the failure is fed back,
  // and the failure cannot be summarized as success.
  const workspace = createWorkspace();
  const labStore = createLabStore();
  const { events, sink } = capture();
  const actions: DriverAction[] = [
    { kind: "tool", tool: "terminal", args: { command: "echo SHOULD_NOT_RUN" } },
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
      // NO approvalCallback — exercising the library default.
    });
    const res = events.find((e) => e.kind === "tool-result" && e.tool === "terminal");
    assert.ok(res && res.kind === "tool-result");
    assert.equal(res.ok, false, "mutating tool is denied by default");
    assert.match(res.error ?? "", /denied by default|requires an explicit approvalCallback/);
    // The command must NOT have executed (no output echoed back) — the denial is recorded as a
    // failed tool-result, so a denied mutation can never be presented as a successful tool call.
    assert.ok(!(res.output ?? "").includes("SHOULD_NOT_RUN"), "the denied command never ran");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
  }
});

test("18b. no approvalCallback (default): a READ-ONLY tool still runs", { skip: PRE_PRODUCTION_DORMANT }, async () => {
  // The default policy auto-approves the explicit read-only set, so a read tool runs without a callback.
  const workspace = createWorkspace();
  const labStore = createLabStore();
  const { events, sink } = capture();
  const actions: DriverAction[] = [
    { kind: "tool", tool: "read_file", args: { path: "app.sh" } },
    { kind: "done", summary: { rootCause: "r", changes: [], verification: ["v"], noChangeRequired: true } },
  ];
  try {
    const result = await runAgent({
      profile: testProfile,
      task: "t",
      workspaceRoot: workspace,
      labStoreRoot: labStore,
      driver: new ScriptedDriver(actions),
      sinks: [sink],
      extraTools: [readOnlyProbeTool],
    });
    const res = events.find((e) => e.kind === "tool-result" && e.tool === "read_file");
    assert.ok(res && res.kind === "tool-result", "read_file was reached (not denied at the gate)");
    assert.equal(res.ok, true);
    assert.equal(result.ok, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
  }
});

test("19. priorMessages seeds prior conversation between the system prompt and the task", { skip: PRE_PRODUCTION_DORMANT }, async () => {
  const workspace = createWorkspace();
  const labStore = createLabStore();
  // A driver that records the transcript it was handed on the FIRST turn, so we can
  // assert the seeded turns landed in order between system and the new task.
  let seen: { role: string; content: string }[] = [];
  const recordingDriver = {
    calls: 0,
    async next(ctx: { messages: { role: string; content: string }[] }): Promise<DriverAction> {
      if (this.calls++ === 0) seen = ctx.messages.map((m) => ({ role: m.role, content: m.content }));
      return { kind: "done", summary: { rootCause: "r", changes: ["c"], verification: ["v"] } };
    },
  };
  try {
    await runAgent({
      profile: testProfile,
      task: "new question",
      workspaceRoot: workspace,
      labStoreRoot: labStore,
      driver: recordingDriver,
      plan: false,
      priorMessages: [
        { role: "user", content: "earlier question" },
        { role: "assistant", content: "earlier answer" },
      ],
    });
    assert.equal(seen[0]?.role, "system");
    assert.equal(seen[1]?.content, "earlier question");
    assert.equal(seen[2]?.content, "earlier answer");
    assert.equal(seen[3]?.content, "new question");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
  }
});

test("16. delegate_task enforces a timeout: a hung sub-agent is killed and reported", async () => {
  const dir = governedMkdtemp("subagent-hang-");
  const runner = join(dir, "hang-runner.cjs");
  // Never reads stdin, never exits — the parent must time it out and kill it.
  writeFileSync(runner, "setInterval(()=>{}, 1000);\n");
  try {
    const handlers = createDelegateToolHandlers({ runnerPath: runner, timeoutMs: 300 });
    const delegate = handlers.get("delegate_task");
    assert.ok(delegate);
    const res = await delegate({ goal: "loop forever" },
      { workspaceRoot: dir, labStoreRoot: dir, store: {}, delegation: 'test-delegation-token' });
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /timed out/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

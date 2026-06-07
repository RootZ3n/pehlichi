import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createMemoryStore } from "lab-memory";

import { ScriptedDriver, type DriverAction } from "./driver.js";
import type { AgentEvent } from "./events.js";
import { runAgent } from "./loop.js";
import type { AgentProfile } from "./profile.js";
import { createLabStore, createWorkspace } from "./scenario.js";

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

/** A throwaway lab-memory store with its own git repo. */
function memoryFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "lab-mem-"));
  mkdirSync(join(root, "memory"), { recursive: true });
  writeFileSync(join(root, "memory", ".gitkeep"), "");
  git(["init", "-q"], root);
  git(["config", "user.email", "test@lab.local"], root);
  git(["config", "user.name", "pehlichi memory test"], root);
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", "fixture: seed"], root);
  return root;
}

function capture(): { events: AgentEvent[]; sink: (e: AgentEvent) => void } {
  const events: AgentEvent[] = [];
  return { events, sink: (e) => events.push(e) };
}

function toolResults(events: AgentEvent[], tool: string): Array<Extract<AgentEvent, { kind: "tool-result" }>> {
  return events.filter((e): e is Extract<AgentEvent, { kind: "tool-result" }> => e.kind === "tool-result" && e.tool === tool);
}

const testProfile: AgentProfile = {
  name: "TestAgent",
  role: "test",
  personaPreamble: "You are a generic test agent.",
  skillTags: ["test"],
};

const DONE: DriverAction = { kind: "done", summary: { rootCause: "r", changes: ["c"], verification: ["v"] } };

test("memory tools round-trip through the registry: create -> query_current -> supersede -> view", async () => {
  const workspace = createWorkspace();
  const labStore = createLabStore();
  const memoryStoreRoot = memoryFixture();
  const { events, sink } = capture();
  const actions: DriverAction[] = [
    {
      kind: "tool",
      tool: "memory_create",
      args: { id: "plan-a", title: "Plan A", description: "first plan", project: "demo", tags: ["plan"], body: "## Plan\nA.\n" },
    },
    { kind: "tool", tool: "memory_query_current", args: { project: "demo" } },
    {
      kind: "tool",
      tool: "memory_supersede",
      args: { oldId: "plan-a", newId: "plan-b", title: "Plan B", description: "revised plan", project: "demo", tags: ["plan"], body: "## Plan\nB instead.\n" },
    },
    { kind: "tool", tool: "memory_query_current", args: { project: "demo" } },
    { kind: "tool", tool: "memory_view", args: { id: "plan-b" } },
    DONE,
  ];
  try {
    await runAgent({
      profile: testProfile,
      task: "exercise memory tools",
      workspaceRoot: workspace,
      labStoreRoot: labStore,
      memoryStoreRoot,
      driver: new ScriptedDriver(actions),
      sinks: [sink],
    });

    // create
    const create = toolResults(events, "memory_create")[0];
    assert.ok(create?.ok);
    assert.match(create.output, /created memory\/plan-a\.md/);

    // query #1 sees plan-a current
    const queries = toolResults(events, "memory_query_current");
    assert.match(queries[0]?.output ?? "", /plan-a/);

    // supersede
    const sup = toolResults(events, "memory_supersede")[0];
    assert.ok(sup?.ok);
    assert.match(sup.output, /superseded plan-a -> plan-b/);

    // query #2 sees ONLY plan-b current (the one-current invariant, through the tools)
    assert.match(queries[1]?.output ?? "", /plan-b/);
    assert.ok(!(queries[1]?.output ?? "").includes("plan-a"), "plan-a no longer current");

    // view pulls the new body
    const view = toolResults(events, "memory_view")[0];
    assert.ok(view?.ok);
    assert.match(view.output, /B instead\./);
    assert.match(view.output, /status=current/);

    // GROUND TRUTH in the real lab-memory store: exactly one current = plan-b
    const current = createMemoryStore({ root: memoryStoreRoot }).queryCurrent("demo");
    assert.equal(current.length, 1);
    assert.equal(current[0]?.id, "plan-b");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
    rmSync(memoryStoreRoot, { recursive: true, force: true });
  }
});

test("memory tools are default-off: with no memory store wired, a memory call fails cleanly", async () => {
  const workspace = createWorkspace();
  const labStore = createLabStore();
  const { events, sink } = capture();
  const actions: DriverAction[] = [
    { kind: "tool", tool: "memory_query_current", args: { project: "demo" } },
    DONE,
  ];
  try {
    // No memoryStoreRoot / memoryStore — the default run shape (no memory wired).
    await runAgent({
      profile: testProfile,
      task: "t",
      workspaceRoot: workspace,
      labStoreRoot: labStore,
      driver: new ScriptedDriver(actions),
      sinks: [sink],
    });
    const res = toolResults(events, "memory_query_current")[0];
    assert.ok(res && res.ok === false);
    assert.match(res.error ?? "", /require a memory store/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
  }
});

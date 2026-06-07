import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createMemoryStore } from "lab-memory";
import { createStore, type ModuleMeta } from "lab-store";

import {
  ScriptedDriver,
  type Driver,
  type DriverAction,
  type DriverContext,
  type AgentEvent,
  runAgent,
  buildSystemPrompt,
} from "./core/index.js";
import { createLabStore } from "./core/scenario.js";
import { coordinatorToolNames, pehProfile } from "./profile.js";

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

/** A throwaway lab-memory store with its own git repo. */
function memoryFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "peh-mem-"));
  mkdirSync(join(root, "memory"), { recursive: true });
  writeFileSync(join(root, "memory", ".gitkeep"), "");
  git(["init", "-q"], root);
  git(["config", "user.email", "test@lab.local"], root);
  git(["config", "user.name", "peh test"], root);
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", "fixture: seed"], root);
  return root;
}

/** A tmp read-only workspace holding the coordinator's input note. */
function noteWorkspace(note: string): string {
  const root = mkdtempSync(join(tmpdir(), "peh-ws-"));
  writeFileSync(join(root, "status-note.md"), note);
  return root;
}

function capture(): { events: AgentEvent[]; sink: (e: AgentEvent) => void } {
  const events: AgentEvent[] = [];
  return { events, sink: (e) => events.push(e) };
}

function toolResults(events: AgentEvent[], tool: string): Array<Extract<AgentEvent, { kind: "tool-result" }>> {
  return events.filter((e): e is Extract<AgentEvent, { kind: "tool-result" }> => e.kind === "tool-result" && e.tool === tool);
}

/** Replays scripted actions AND records the advertised tools + system prompt each turn. */
class ToolCapturingDriver implements Driver {
  readonly toolsSeen: string[][] = [];
  readonly systemSeen: string[] = [];
  private i = 0;
  constructor(private readonly actions: readonly DriverAction[]) {}
  async next(ctx: DriverContext): Promise<DriverAction> {
    this.toolsSeen.push(ctx.tools.map((t) => t.name).sort());
    this.systemSeen.push(ctx.messages.find((m) => m.role === "system")?.content ?? "");
    const a = this.actions[this.i];
    if (a === undefined) throw new Error("ToolCapturingDriver exhausted");
    this.i += 1;
    return a;
  }
}

const DONE: DriverAction = {
  kind: "done",
  summary: { rootCause: "r", changes: ["c"], verification: ["v"] },
};

const ALL_BUILDER_TOOLS = [
  "memory_create",
  "memory_query_current",
  "memory_supersede",
  "memory_view",
  "read",
  "search",
  "skill_manage_create",
  "skill_view",
  "terminal",
  "write",
].sort();

test("peh profile: VOICE ONLY — identity/voice; no procedure, done-criteria, or roster in the persona", () => {
  assert.equal(pehProfile.name, "Peh");
  assert.equal(pehProfile.role, "coordinator");
  assert.match(pehProfile.personaPreamble, /coordinator/i); // who she is (voice) is fine
  // HOW she works moved to the skillpack — none of it remains in the persona.
  assert.doesNotMatch(pehProfile.personaPreamble, /supersede|duplicate|route to|do not do the work|durable|Ptah|Luna|ikbi/i);
  assert.deepEqual(pehProfile.skillTags, ["coordination", "memory", "routing"]);
  // the per-role verificationPolicy field is gone from the profile contract entirely.
  assert.ok(!("verificationPolicy" in pehProfile));
});

test("peh tool-set: with memory wired + coordinator allowlist, ONLY coordinator tools are advertised", async () => {
  const workspace = noteWorkspace("# note\n");
  const labStore = createLabStore();
  const memoryStoreRoot = memoryFixture();
  const driver = new ToolCapturingDriver([DONE]);
  try {
    await runAgent({
      profile: pehProfile,
      task: "t",
      workspaceRoot: workspace,
      labStoreRoot: labStore,
      memoryStoreRoot,
      toolNames: coordinatorToolNames,
      driver,
    });
    assert.deepEqual(driver.toolsSeen[0], [...coordinatorToolNames].sort());
    // memory tools ARE advertised to Peh (the opposite of a builder run)...
    assert.ok(driver.toolsSeen[0]?.includes("memory_query_current"));
    // ...and the builder tools are NOT.
    for (const t of ["terminal", "write", "skill_view", "skill_manage_create"]) {
      assert.ok(!driver.toolsSeen[0]?.includes(t), `${t} must not be advertised to a coordinator`);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
    rmSync(memoryStoreRoot, { recursive: true, force: true });
  }
});

test("tool-set is CONFIG-DRIVEN, not hardcoded per role: same profile, different allowlist", async () => {
  const workspace = noteWorkspace("# note\n");
  const labStore = createLabStore();
  const memoryStoreRoot = memoryFixture();
  try {
    // (a) NO allowlist + memory wired => the full builder set is advertised, even
    //     to Peh. Proves the coordinator narrowing comes from config, not the role.
    const full = new ToolCapturingDriver([DONE]);
    await runAgent({
      profile: pehProfile,
      task: "t",
      workspaceRoot: workspace,
      labStoreRoot: labStore,
      memoryStoreRoot,
      driver: full,
    });
    assert.deepEqual(full.toolsSeen[0], ALL_BUILDER_TOOLS);

    // (b) An arbitrary allowlist => exactly that set is advertised. The config
    //     decides; the core hardcodes no role's tools.
    const custom = new ToolCapturingDriver([DONE]);
    await runAgent({
      profile: pehProfile,
      task: "t",
      workspaceRoot: workspace,
      labStoreRoot: labStore,
      memoryStoreRoot,
      toolNames: ["read", "memory_view"],
      driver: custom,
    });
    assert.deepEqual(custom.toolsSeen[0], ["memory_view", "read"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
    rmSync(memoryStoreRoot, { recursive: true, force: true });
  }
});

test("staying in lane is STRUCTURAL: an out-of-lane tool call is refused, never executes", async () => {
  const workspace = noteWorkspace("# note\n");
  const labStore = createLabStore();
  const memoryStoreRoot = memoryFixture();
  const { events, sink } = capture();
  // Peh "tries" to do builder work — write code and run a terminal. Both must be refused.
  const actions: DriverAction[] = [
    { kind: "tool", tool: "write", args: { path: "hack.sh", content: "nope" } },
    { kind: "tool", tool: "terminal", args: { command: "echo nope" } },
    DONE,
  ];
  try {
    await runAgent({
      profile: pehProfile,
      task: "t",
      workspaceRoot: workspace,
      labStoreRoot: labStore,
      memoryStoreRoot,
      toolNames: coordinatorToolNames,
      driver: new ScriptedDriver(actions),
      sinks: [sink],
    });
    const w = toolResults(events, "write")[0];
    const term = toolResults(events, "terminal")[0];
    assert.equal(w?.ok, false);
    assert.match(w?.error ?? "", /out of lane/);
    assert.equal(term?.ok, false);
    assert.match(term?.error ?? "", /out of lane/);
    // STRUCTURAL: no side effects — no diff, no terminal receipt, file never written.
    assert.ok(!events.some((e) => e.kind === "diff"), "no diff — the write never ran");
    assert.ok(!events.some((e) => e.kind === "terminal-receipt"), "no receipt — the terminal never ran");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
    rmSync(memoryStoreRoot, { recursive: true, force: true });
  }
});

test("scripted coordinator loop: read note -> supersede prior -> create new -> read-back -> done (one current per topic, chain clean)", async () => {
  const note = [
    "# Project nusika — status",
    "media-server now crashes on startup (exit 1) since the config refactor.",
    "the MiMo driver hits its token cap on long contexts.",
  ].join("\n");
  const workspace = noteWorkspace(note);
  const labStore = createLabStore();
  const memoryStoreRoot = memoryFixture();
  const { events, sink } = capture();

  // Seed a PRIOR current entry so Peh has the OPTION to supersede (update) vs duplicate.
  createMemoryStore({ root: memoryStoreRoot }).createMemory({
    id: "nusika-media-server",
    title: "media-server health",
    description: "media-server healthy, last deploy green",
    project: "nusika",
    tags: ["ops"],
    body: "## media-server\nHealthy; last deploy green.\n",
  });

  const actions: DriverAction[] = [
    { kind: "narrate", phase: "investigate", text: "Reading the status note." },
    { kind: "tool", tool: "read", args: { path: "status-note.md" } },
    { kind: "tool", tool: "memory_query_current", args: { project: "nusika" } },
    {
      kind: "root-cause",
      text: "media-server status changed (now crashing) — update it; the token-cap issue is a new durable engine concern.",
    },
    // UPDATE the prior entry (supersede), not duplicate it.
    {
      kind: "tool",
      tool: "memory_supersede",
      args: {
        oldId: "nusika-media-server",
        newId: "nusika-media-server-crash",
        title: "media-server crashing",
        description: "media-server crashes on startup (exit 1) since config refactor",
        project: "nusika",
        tags: ["ops"],
        body: "## media-server\nCrashes on startup (exit 1) after the config refactor. Route to the builder agent.\n",
      },
    },
    // Record the NEW durable concern.
    {
      kind: "tool",
      tool: "memory_create",
      args: {
        id: "nusika-mimo-token-cap",
        title: "MiMo token cap",
        description: "MiMo driver hits token cap on long contexts",
        project: "nusika",
        tags: ["engine"],
        body: "## engine\nMiMo driver hits its token cap on long contexts. Route to the engine agent.\n",
      },
    },
    // Read-back (the coordinator's verification).
    { kind: "tool", tool: "memory_query_current", args: { project: "nusika" } },
    {
      kind: "done",
      summary: {
        rootCause: "nusika: media-server now crashing (was healthy); MiMo token cap is a new engine concern.",
        changes: [
          "superseded nusika-media-server -> nusika-media-server-crash (updated, not duplicated)",
          "recorded nusika-mimo-token-cap",
        ],
        verification: ["memory_query_current(nusika) shows exactly two currents, one per topic, no duplicates"],
      },
    },
  ];

  try {
    await runAgent({
      profile: pehProfile,
      task: "coordinate nusika",
      workspaceRoot: workspace,
      labStoreRoot: labStore,
      memoryStoreRoot,
      toolNames: coordinatorToolNames,
      driver: new ScriptedDriver(actions),
      sinks: [sink],
    });

    // done-gate passed with a coordinator summary.
    assert.ok(events.some((e) => e.kind === "done"));

    // GROUND TRUTH in the memory store.
    const store = createMemoryStore({ root: memoryStoreRoot });
    const health = store.chainHealth("nusika");
    // exactly two currents, one per topic — the prior entry was UPDATED, not duplicated.
    assert.deepEqual(health.current.map((m) => m.id).sort(), ["nusika-media-server-crash", "nusika-mimo-token-cap"]);
    // the seeded prior is now superseded (not a second current).
    assert.equal(store.viewMemory("nusika-media-server").status, "superseded");
    // no stranded chains.
    assert.deepEqual(health.stranded, []);
    // version bumped on the superseded topic.
    assert.equal(store.viewMemory("nusika-media-server-crash").version, 2);

    // Containment-equivalent: NO builder side effects anywhere in the stream.
    assert.ok(!events.some((e) => e.kind === "diff"));
    assert.ok(!events.some((e) => e.kind === "terminal-receipt"));
    assert.ok(!events.some((e) => e.kind === "skill-created"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
    rmSync(memoryStoreRoot, { recursive: true, force: true });
  }
});

// ── skillpack mechanism: contract is skill-sourced, kernel is generic ──────────

test("skillpack slot: an active skillpack injects its structured fields; the kernel carries no role-hardcoded text", () => {
  const tools = [{ name: "read", description: "read a file" }];
  const pack: ModuleMeta = {
    name: "demo-pack",
    description: "a demo skillpack",
    type: "skills",
    version: 1,
    tags: ["x"],
    path: "skills/demo-pack.md",
    contractAdditions: ["CONTRACT-LINE-A"],
    doneCriteria: ["DONE-LINE-A"],
    evidenceRequirements: ["EVIDENCE-LINE-A"],
    reportFormat: ["REPORT-LINE-A"],
    routingRoster: ["ops -> Ptah"],
  };

  const withPack = buildSystemPrompt(pehProfile, [pack], tools, pack);
  // skillpack content is injected
  assert.match(withPack, /ACTIVE SKILLPACK — demo-pack/);
  for (const needle of ["CONTRACT-LINE-A", "DONE-LINE-A", "EVIDENCE-LINE-A", "REPORT-LINE-A", "ops -> Ptah"]) {
    assert.match(withPack, new RegExp(needle));
  }
  // generic kernel is present
  assert.match(withPack, /NARRATE → ACT → NARRATE/);
  assert.match(withPack, /correspond to a tool call you actually executed/i); // grounding stays in core
  // the role-specific text + named skills are GONE from the hardcoded kernel
  const kernelOnly = buildSystemPrompt(pehProfile, [], tools);
  assert.doesNotMatch(kernelOnly, /rebuild-discipline|verify-dont-assume|review the diff|skill_manage_create|before fixing/i);
  assert.doesNotMatch(kernelOnly, /ACTIVE SKILLPACK|DONE for this task/); // no slot text without a skillpack
});

test("skillpack slot: a plain skill (no structured fields) injects nothing — backward compatible", () => {
  const tools = [{ name: "read", description: "read a file" }];
  const plain: ModuleMeta = {
    name: "plain-skill",
    description: "a fieldless procedural skill",
    type: "skills",
    version: 1,
    tags: ["x"],
    path: "skills/plain-skill.md",
  };
  const p = buildSystemPrompt(pehProfile, [plain], tools, plain);
  assert.doesNotMatch(p, /ACTIVE SKILLPACK/);
  assert.doesNotMatch(p, /DONE for this task means/);
});

test("primarySkill: the loop loads the active skillpack from the store and injects it; missing => fails loud", async () => {
  const workspace = noteWorkspace("# note\n");
  const labStore = createLabStore();
  // seed a skillpack into the store via the store API (structured fields).
  createStore({ root: labStore }).createModule({
    name: "demo-pack",
    description: "demo",
    type: "skills",
    tags: ["x"],
    body: "## When to use\nDemo.\n",
    doneCriteria: ["LOADED-DONE-CRITERION"],
    contractAdditions: ["LOADED-CONTRACT"],
  });
  try {
    const driver = new ToolCapturingDriver([DONE]);
    await runAgent({
      profile: pehProfile,
      task: "t",
      workspaceRoot: workspace,
      labStoreRoot: labStore,
      primarySkill: "demo-pack",
      driver,
    });
    assert.match(driver.systemSeen[0] ?? "", /ACTIVE SKILLPACK — demo-pack/);
    assert.match(driver.systemSeen[0] ?? "", /LOADED-DONE-CRITERION/);
    assert.match(driver.systemSeen[0] ?? "", /LOADED-CONTRACT/);

    // a primarySkill not in the store fails loud (misconfigured run), not silently.
    await assert.rejects(
      runAgent({
        profile: pehProfile,
        task: "t",
        workspaceRoot: workspace,
        labStoreRoot: labStore,
        primarySkill: "no-such-skill",
        driver: new ScriptedDriver([DONE]),
      }),
      /primarySkill "no-such-skill" not found/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
  }
});

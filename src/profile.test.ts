import assert from "node:assert/strict";
import { rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ModuleMeta } from "lab-store";

import {
  ScriptedDriver,
  type DriverAction,
  type AgentEvent,
  runAgent,
  buildSystemPrompt,
} from "./core/index.js";
import { createLabStore } from "./core/scenario.js";
import { pehProfile } from "./profile.js";

function capture(): { events: AgentEvent[]; sink: (e: AgentEvent) => void } {
  const events: AgentEvent[] = [];
  return { events, sink: (e) => events.push(e) };
}

/** A tmp read-only workspace holding a note. */
function noteWorkspace(note: string): string {
  const root = mkdtempSync(join(tmpdir(), "peh-ws-"));
  writeFileSync(join(root, "status-note.md"), note);
  return root;
}

const DONE: DriverAction = {
  kind: "done",
  summary: { rootCause: "r", changes: ["c"], verification: ["v"] },
};

test("peh profile: VOICE ONLY — identity/voice; no procedure, done-criteria, or roster in the persona", () => {
  assert.equal(pehProfile.name, "Pehlichi");
  assert.equal(pehProfile.role, "coordinator");
  assert.match(pehProfile.personaPreamble, /coordinator/i);
  assert.doesNotMatch(pehProfile.personaPreamble, /supersede|duplicate|route to|do not do the work|durable/i);
  assert.deepEqual(pehProfile.skillTags, ["coordination", "memory", "routing", "planning", "archivum", "career", "learning", "toba", "nusika"]);
  assert.ok(!("verificationPolicy" in pehProfile));
});

test("staying in lane is STRUCTURAL: a tool not in the allowlist is refused", async () => {
  const workspace = noteWorkspace("# note\n");
  const labStore = createLabStore();
  const { events, sink } = capture();
  // Peh "tries" to use terminal — must be refused if not in allowlist.
  const actions: DriverAction[] = [
    { kind: "tool", tool: "terminal", args: { command: "echo nope" } },
    DONE,
  ];
  try {
    await runAgent({
      profile: pehProfile,
      task: "t",
      workspaceRoot: workspace,
      labStoreRoot: labStore,
      toolNames: ["read_file"],  // terminal NOT in allowlist
      driver: new ScriptedDriver(actions),
      sinks: [sink],
    });
    const term = events.find(
      (e): e is Extract<AgentEvent, { kind: "tool-result" }> => e.kind === "tool-result" && e.tool === "terminal",
    );
    assert.ok(term, "expected a tool-result for terminal");
    assert.equal(term.ok, false);
    assert.match(term.error ?? "", /out of lane|not allowed/);
    // STRUCTURAL: no side effects — no terminal receipt
    assert.ok(!events.some((e) => e.kind === "terminal-receipt"), "no receipt — the terminal never ran");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
  }
});

// ── skillpack mechanism: contract is skill-sourced, kernel is generic ──────────

test("skillpack slot: an active skillpack injects its structured fields; the kernel carries no role-hardcoded text", () => {
  const tools = [{ name: "terminal", description: "run a command" }];
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
  assert.match(withPack, /ACTIVE SKILLPACK — demo-pack/);
  for (const needle of ["CONTRACT-LINE-A", "DONE-LINE-A", "EVIDENCE-LINE-A", "REPORT-LINE-A", "ops -> Ptah"]) {
    assert.match(withPack, new RegExp(needle));
  }
  assert.match(withPack, /NARRATE → ACT → NARRATE/);
  assert.match(withPack, /correspond to a tool call you actually executed/i);
  const kernelOnly = buildSystemPrompt(pehProfile, [], tools);
  assert.doesNotMatch(kernelOnly, /rebuild-discipline|verify-dont-assume|review the diff|before fixing/i);
  assert.doesNotMatch(kernelOnly, /ACTIVE SKILLPACK|DONE for this task/);
});

test("skillpack slot: a plain skill (no structured fields) injects nothing — backward compatible", () => {
  const tools = [{ name: "terminal", description: "run a command" }];
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
  const { createStore } = await import("lab-store");
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
    await runAgent({
      profile: pehProfile,
      task: "t",
      workspaceRoot: workspace,
      labStoreRoot: labStore,
      primarySkill: "demo-pack",
      driver: new ScriptedDriver([DONE]),
    });
    // primarySkill not in the store fails loud
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

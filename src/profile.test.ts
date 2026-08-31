/**
 * COMPONENT TEST. This drives `executeAgentRun`, the agent loop below the production
 * admission boundary, with fixture-owned dependencies. It proves things about the loop.
 *
 * It does not, and must not be read to, prove that `runAgent` admitted any work: while the
 * committed governed status is PRE_PRODUCTION, `runAgent` executes nothing. Admission is
 * covered separately in `operational-admission.test.ts`.
 */
import { governedMkdtemp } from "./core/temp-authority.js";
import assert from "node:assert/strict";
import type { RunAgentResult } from "./core/loop.js";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { ModuleMeta } from "lab-store";

import {
  ScriptedDriver,
  type DriverAction,
  type AgentEvent,
  type RunAgentOptions,
  buildSystemPrompt,
} from "./core/index.js";
// Imported from the module rather than the package index on purpose: the public API exports
// the gated `runAgent` and never the component below it.
import { createLabStore } from "./core/scenario.js";
import { agentProfile } from "./profile.js";


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

/** The loop below the admission boundary. See the component-test note at the top. */
const runAgent = (opts: RunAgentOptions): ReturnType<typeof componentExecuteAgentRun> =>
  componentExecuteAgentRun(opts);

function capture(): { events: AgentEvent[]; sink: (e: AgentEvent) => void } {
  const events: AgentEvent[] = [];
  return { events, sink: (e) => events.push(e) };
}

/** A tmp read-only workspace holding a note. */
function noteWorkspace(note: string): string {
  const root = governedMkdtemp("peh-ws-");
  writeFileSync(join(root, "status-note.md"), note);
  return root;
}

const DONE: DriverAction = {
  kind: "done",
  summary: { rootCause: "r", changes: ["c"], verification: ["v"] },
};

test("agent profile: VOICE ONLY — identity/voice; no procedure, done-criteria, or roster in the persona", () => {
  assert.ok(typeof agentProfile.name === "string" && agentProfile.name.length > 0);
  assert.ok(typeof agentProfile.role === "string" && agentProfile.role.length > 0);
  assert.match(agentProfile.personaPreamble, new RegExp(agentProfile.role, "i"));
  assert.doesNotMatch(agentProfile.personaPreamble, /supersede|duplicate|route to|do not do the work|durable/i);
  assert.ok(Array.isArray(agentProfile.skillTags) && agentProfile.skillTags.length > 0);
  assert.ok(!("verificationPolicy" in agentProfile));
});

test("staying in lane is STRUCTURAL: a tool not in the allowlist is refused", { skip: PRE_PRODUCTION_DORMANT }, async () => {
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
      profile: agentProfile,
      task: "t",
      workspaceRoot: workspace,
      labStoreRoot: labStore,
      toolNames: [],  // terminal is registered but NOT in the explicit lane
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

  const withPack = buildSystemPrompt(agentProfile, [pack], tools, pack);
  assert.match(withPack, /ACTIVE SKILLPACK — demo-pack/);
  for (const needle of ["CONTRACT-LINE-A", "DONE-LINE-A", "EVIDENCE-LINE-A", "REPORT-LINE-A", "ops -> Ptah"]) {
    assert.match(withPack, new RegExp(needle));
  }
  assert.match(withPack, /NARRATE → ACT → NARRATE/);
  assert.match(withPack, /correspond to a tool call you actually executed/i);
  const kernelOnly = buildSystemPrompt(agentProfile, [], tools);
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
  const p = buildSystemPrompt(agentProfile, [plain], tools, plain);
  assert.doesNotMatch(p, /ACTIVE SKILLPACK/);
  assert.doesNotMatch(p, /DONE for this task means/);
});

test("primarySkill: the loop loads the active skillpack from the store and injects it; missing => fails loud", { skip: PRE_PRODUCTION_DORMANT }, async () => {
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
      profile: agentProfile,
      task: "t",
      workspaceRoot: workspace,
      labStoreRoot: labStore,
      primarySkill: "demo-pack",
      toolNames: [],
      driver: new ScriptedDriver([DONE]),
    });
    // primarySkill not in the store fails loud
    await assert.rejects(
      runAgent({
        profile: agentProfile,
        task: "t",
        workspaceRoot: workspace,
        labStoreRoot: labStore,
        primarySkill: "no-such-skill",
        toolNames: [],
        driver: new ScriptedDriver([DONE]),
      }),
      /primarySkill "no-such-skill" not found/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
  }
});

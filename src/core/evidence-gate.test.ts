/**
 * COMPONENT TEST. This drives `executeAgentRun`, the agent loop below the production
 * admission boundary, with fixture-owned dependencies. It proves things about the loop.
 *
 * It does not, and must not be read to, prove that `runAgent` admitted any work: while the
 * committed governed status is PRE_PRODUCTION, `runAgent` executes nothing. Admission is
 * covered separately in `operational-admission.test.ts`.
 */
/**
 * EVIDENCE GATE (P0.1) — the finalization gate must reject a `done` that CLAIMS work no
 * tool actually performed, and accept it once the work is proven. This is the truth-check
 * that complements validateSummary's shape-check.
 */
import assert from "node:assert/strict";

import { rmSync } from "node:fs";
import { test } from "node:test";

import { ScriptedDriver, type DriverAction } from "./driver.js";
import type { AgentEvent } from "./events.js";
import {  unprovenClaim, type RunAgentOptions, type RunAgentResult } from "./loop.js";
import type { AgentProfile } from "./profile.js";
import { createLabStore, createWorkspace } from "./scenario.js";
import { createToolRegistry } from './tools.js';

const testProfile: AgentProfile = {
  name: "EvidenceAgent",
  role: "test",
  personaPreamble: "You are a generic test agent.",
  skillTags: ["test"],
};

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

const runAgent = (opts: Omit<RunAgentOptions, 'toolNames'> & { toolNames?: readonly string[] }) =>
  componentExecuteAgentRun({
    ...opts,
    toolNames: opts.toolNames ?? [...createToolRegistry(opts.extraTools).keys()],
  });

function capture(): { events: AgentEvent[]; sink: (e: AgentEvent) => void } {
  const events: AgentEvent[] = [];
  return { events, sink: (e) => events.push(e) };
}

// ── unit: unprovenClaim ───────────────────────────────────────────────────────

test("unprovenClaim: a verification claim with no verify evidence is unproven", () => {
  const problem = unprovenClaim(
    { changes: [], verification: ["ran the tests"] },
    { changeEvidence: false, verifyEvidence: false },
  );
  assert.match(problem ?? "", /verification\[\] claims/);
});

test("unprovenClaim: a verification claim WITH verify evidence is proven", () => {
  const problem = unprovenClaim(
    { changes: [], verification: ["ran the tests"] },
    { changeEvidence: false, verifyEvidence: true },
  );
  assert.equal(problem, null);
});

test("unprovenClaim: a changes claim with no change evidence is unproven", () => {
  const problem = unprovenClaim(
    { changes: ["edited x"], verification: [], noChangeRequired: false },
    { changeEvidence: false, verifyEvidence: false },
  );
  assert.match(problem ?? "", /changes\[\] claims/);
});

test("unprovenClaim: noChangeRequired bypasses both checks", () => {
  const problem = unprovenClaim(
    { changes: [], verification: [], noChangeRequired: true },
    { changeEvidence: false, verifyEvidence: false },
  );
  assert.equal(problem, null);
});

// ── loop integration ──────────────────────────────────────────────────────────

test("evidence gate ON: an unproven done is rejected and fed back, then accepted once a command runs", { skip: PRE_PRODUCTION_DORMANT }, async () => {
  const workspace = createWorkspace();
  const labStore = createLabStore();
  const { events, sink } = capture();
  const actions: DriverAction[] = [
    // 1) claims a fix + verification without running anything → must be REJECTED (fed back).
    { kind: "done", summary: { rootCause: "fixed the bug", changes: ["edited config"], verification: ["ran tests, all pass"] } },
    // 2) the model complies and actually runs a command → real receipt = evidence.
    { kind: "tool", tool: "terminal", args: { command: "echo ok" } },
    // 3) now the same claim is BACKED by a real command → accepted.
    { kind: "done", summary: { rootCause: "fixed the bug", changes: ["edited config"], verification: ["ran echo ok, exit 0"] } },
  ];
  try {
    const result = await runAgent({
      profile: testProfile,
      task: "fix it and prove it",
      workspaceRoot: workspace,
      labStoreRoot: labStore,
      driver: new ScriptedDriver(actions),
      sinks: [sink],
      approvalCallback: allowAll,
      requireEvidence: true,
      plan: false,
    });

    assert.equal(result.ok, true, "run should ultimately succeed once proven");
    // The gate emitted exactly one rejection narration before the command ran.
    const rejections = events.filter(
      (e): e is Extract<AgentEvent, { kind: "narrate" }> => e.kind === "narrate" && e.text.includes("[evidence-gate]"),
    );
    assert.equal(rejections.length, 1, "the first (unproven) done should be rejected once");
    // Exactly one done event, and it comes AFTER the terminal ran.
    const doneEvents = events.filter((e) => e.kind === "done");
    assert.equal(doneEvents.length, 1, "only the proven done should complete the run");
    const termIdx = events.findIndex((e) => e.kind === "terminal-receipt");
    const doneIdx = events.findIndex((e) => e.kind === "done");
    assert.ok(termIdx !== -1 && termIdx < doneIdx, "the command must run before done is accepted");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
  }
});

test("evidence gate ON: noChangeRequired conversational done is accepted immediately", { skip: PRE_PRODUCTION_DORMANT }, async () => {
  const workspace = createWorkspace();
  const labStore = createLabStore();
  const { events, sink } = capture();
  const actions: DriverAction[] = [
    { kind: "done", summary: { rootCause: "The Colosseum opened in 80 CE.", changes: [], verification: [], noChangeRequired: true } },
  ];
  try {
    const result = await runAgent({
      profile: testProfile,
      task: "when did the Colosseum open?",
      workspaceRoot: workspace,
      labStoreRoot: labStore,
      driver: new ScriptedDriver(actions),
      sinks: [sink],
      requireEvidence: true,
      plan: false,
    });
    assert.equal(result.ok, true);
    assert.ok(events.some((e) => e.kind === "done"), "a conversational answer needs no executed evidence");
    assert.ok(!events.some((e) => e.kind === "narrate" && e.text.includes("[evidence-gate]")), "no rejection expected");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
  }
});

test("evidence gate OFF (default): a shape-valid done is accepted without executed evidence (unchanged)", { skip: PRE_PRODUCTION_DORMANT }, async () => {
  const workspace = createWorkspace();
  const labStore = createLabStore();
  const { events, sink } = capture();
  const actions: DriverAction[] = [
    { kind: "done", summary: { rootCause: "x", changes: ["y"], verification: ["z"] } },
  ];
  try {
    const result = await runAgent({
      profile: testProfile,
      task: "t",
      workspaceRoot: workspace,
      labStoreRoot: labStore,
      driver: new ScriptedDriver(actions),
      sinks: [sink],
      plan: false,
      // requireEvidence omitted → shape-only validation, proven legacy behavior.
    });
    assert.equal(result.ok, true);
    assert.ok(events.some((e) => e.kind === "done"));
    assert.ok(!events.some((e) => e.kind === "narrate" && e.text.includes("[evidence-gate]")));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(labStore, { recursive: true, force: true });
  }
});

import { spendsActionAllowance } from "./loop.js";
import { IterationBudget } from "./agent-tools/iteration-budget.js";
/**
 * PURE_COMPONENT_TEST. The loop's decisions, with nothing that can execute.
 *
 * This suite replaces the seam an independent audit turned into a bypass. Component tests used
 * to import `executeAgentRun` and drive complete agent turns below the admission boundary; a
 * disposable production module then did the same thing with a namespace import and a computed
 * property, and ran work the committed status refused.
 *
 * So what is under test here is the mechanics layer: functions from caller-supplied values to
 * data. No model, no tool, no filesystem write, no process, no network, no dispatch, no
 * persistence. Nothing imported here is callable authority, and nothing returned is callable at
 * all -- so a passing case proves the loop decides correctly and proves exactly nothing about
 * whether any run was admitted. That distinction is the point of the file.
 *
 * The cases that genuinely need a complete turn are not here. They are dormant under
 * PRE_PRODUCTION in `loop.test.ts`, `shadow.test.ts`, `evidence-gate.test.ts`,
 * `profile.test.ts` and `budget-tier.test.ts`, and they are a production-transition gate: at
 * the governance transition they must execute against the admitted path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MUTATING_TOOLS, firstLine, parsePlan, summaryProblems, summaryRejection,
  unprovenClaim, validateToolLane
} from "./loop-mechanics.js";

const here = dirname(fileURLToPath(import.meta.url));

// --- the layer carries no authority ------------------------------------------------------

test("PURE_COMPONENT_TEST: the mechanics module performs no effect and imports nothing that can", () => {
  const source = readFileSync(join(here, "loop-mechanics.ts"), "utf8");
  // A pure layer that imports a driver, a store, a tool registry or a node effect module is not
  // pure however carefully its functions are written. It currently imports nothing at all.
  assert.equal(/^\s*import\s/m.test(source), false,
    "the mechanics layer has grown an import; it may not depend on anything that can execute");
  // With no imports at all, the only way this module could reach an effect is through a global,
  // so the remaining surface is small enough to name exhaustively. Matched as usage syntax
  // rather than as bare words: an earlier version matched "exec" inside "execute_code" and then
  // "require" inside the phrase "is required", which is how a check teaches people to ignore it.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/[^\n]*/g, "");
  for (const usage of [
    "require(", "process.", "process[", "globalThis", "fetch(", "import(", "eval(", "new Function("
  ])
    assert.equal(code.includes(usage), false, `the mechanics layer reaches ${usage}`);
});

test("PURE_COMPONENT_TEST: nothing the layer returns is callable", () => {
  // A pure function that hands back a function hands back authority. Every return here is data.
  const returned: unknown[] = [
    summaryProblems({ rootCause: "", changes: [], verification: [] }),
    summaryRejection(["a"]),
    unprovenClaim({ changes: ["x"], verification: [] }, { changeEvidence: false, verifyEvidence: false }),
    validateToolLane(["terminal"]),
    parsePlan("1. do it"),
    firstLine("  \n hello \n"),
    MUTATING_TOOLS
  ];
  for (const value of returned)
    assert.notEqual(typeof value, "function", "a mechanics function returned a callable");
});

// --- summary shape -------------------------------------------------------------------------

test("PURE_COMPONENT_TEST: a summary must diagnose, change and verify — or say it changed nothing", () => {
  assert.deepEqual(summaryProblems({ rootCause: "found it", changes: ["a"], verification: ["b"] }), []);
  assert.deepEqual(summaryProblems({ rootCause: "", changes: [], verification: [] }),
    ["rootCause is empty", "changes[] is empty", "verification[] is empty"]);
  assert.deepEqual(summaryProblems({ rootCause: "   ", changes: ["a"], verification: ["b"] }), ["rootCause is empty"]);
  // A conversational answer legitimately changes nothing, but still has to say what it found.
  assert.deepEqual(summaryProblems({ rootCause: "answered", changes: [], verification: [], noChangeRequired: true }), []);
  assert.deepEqual(summaryProblems({ rootCause: "", changes: [], verification: [], noChangeRequired: true }), ["rootCause is empty"]);
});

test("PURE_COMPONENT_TEST: the rejection message names every problem it found", () => {
  const problems = summaryProblems({ rootCause: "", changes: [], verification: [] });
  const message = summaryRejection(problems);
  for (const problem of problems) assert.ok(message.includes(problem), `the rejection omits "${problem}"`);
  assert.match(message, /^done rejected/);
});

// --- the evidence gate -----------------------------------------------------------------------

test("PURE_COMPONENT_TEST: a claim without evidence is unproven, and with evidence is not", () => {
  const none = { changeEvidence: false, verifyEvidence: false };
  const all = { changeEvidence: true, verifyEvidence: true };
  assert.match(String(unprovenClaim({ changes: [], verification: ["ran the suite"] }, none)), /verification\[\] claims/);
  assert.match(String(unprovenClaim({ changes: ["edited a file"], verification: [] }, none)), /changes\[\] claims/);
  assert.equal(unprovenClaim({ changes: ["edited"], verification: ["ran"] }, all), null);
  assert.equal(unprovenClaim({ changes: [], verification: [] }, none), null, "claiming nothing needs no evidence");
});

test("PURE_COMPONENT_TEST: noChangeRequired bypasses the gate, and verification is checked first", () => {
  const none = { changeEvidence: false, verifyEvidence: false };
  assert.equal(unprovenClaim({ changes: ["x"], verification: ["y"], noChangeRequired: true }, none), null);
  // Both claims unproven: the verification problem is the one reported, deterministically.
  assert.match(String(unprovenClaim({ changes: ["x"], verification: ["y"] }, none)), /verification\[\] claims/);
});

test("PURE_COMPONENT_TEST: the mutating-tool set is exactly the tools that change the workspace", () => {
  assert.deepEqual([...MUTATING_TOOLS].sort(), ["patch", "write_file"]);
  for (const readOnly of ["read_file", "search", "terminal", "process"])
    assert.equal(MUTATING_TOOLS.has(readOnly), false, `${readOnly} is counted as a mutation`);
});

// --- the tool lane ---------------------------------------------------------------------------

test("PURE_COMPONENT_TEST: a tool lane is explicit, unique, non-empty and frozen", () => {
  const lane = validateToolLane(["terminal", "read_file"]);
  assert.deepEqual([...lane], ["terminal", "read_file"]);
  assert.equal(Object.isFrozen(lane), true, "a lane that can be widened after validation is not a lane");
  assert.deepEqual([...validateToolLane([])], [], "an empty lane is legitimate: it authorizes nothing");

  for (const [bad, expected] of [
    [undefined, /explicit validated tool lane is required/],
    ["terminal", /explicit validated tool lane is required/],
    [["a", "a"], /duplicate names/],
    [["a", ""], /invalid name/],
    [["a", 7], /invalid name/]
  ] as [unknown, RegExp][])
    assert.throws(() => validateToolLane(bad), expected, `validateToolLane accepted ${JSON.stringify(bad)}`);
});

test("PURE_COMPONENT_TEST: validating a lane copies it, so the caller cannot mutate it afterwards", () => {
  const caller = ["terminal"];
  const lane = validateToolLane(caller);
  caller.push("write_file");
  assert.deepEqual([...lane], ["terminal"], "the lane followed the caller's array");
});

// --- narration ---------------------------------------------------------------------------------

test("PURE_COMPONENT_TEST: a numbered plan is read out of narration, and nothing else is", () => {
  assert.deepEqual(parsePlan("1. read the code\n2) write a test\n3.  run it  "),
    ["read the code", "write a test", "run it"]);
  assert.deepEqual(parsePlan("no plan here\njust prose"), []);
  assert.deepEqual(parsePlan(""), []);
  // A bare number is not a step, and neither is a numbered thing inside a sentence.
  assert.deepEqual(parsePlan("1.\nsee item 2. below"), []);
});

test("PURE_COMPONENT_TEST: the first line of narration skips blank leading lines", () => {
  assert.equal(firstLine("\n\n   hello there  \nsecond"), "hello there");
  assert.equal(firstLine(""), "");
  assert.equal(firstLine("   \n\t\n"), "");
});

// ── budget semantics: actions versus model turns ─────────────────────────────────────────────

/*
  THE PHASE-3 COMPARISON DEFECT, as a regression.

  `TIER_LIMITS` documents its numbers in TOOLS — "readonly: 12 tools" — and the function that reads
  them is `resolveToolBudget`. The loop nevertheless spent one unit per MODEL TURN. Measured from
  the frozen t1 runs' own event telemetry, at the commit that failed the comparison:

      Mad-Ptah    13 tool-call, 12 textual-call-detected, 1 narrate
      Loony-Luna  12 tool-call, 13 textual-call-detected, 1 narrate
      Pehlichi    15 tool-call, 10 textual-call-detected, 1 narrate

  Roughly half of every allowance went on turns where the model wrote a tool call as prose and the
  loop corrected it. All three died at 9-11 useful actions on a task Hermes finished in seven.

  The fixture below carries those counts and NOT the task's expected answer: what is under test is
  the accounting, not whether a model can survey a repository.
*/

test("only a tool action spends the action allowance", () => {
  assert.equal(spendsActionAllowance("tool"), true);
  for (const kind of ["narrate", "root-cause", "done", "textual-call-detected"] as const) {
    assert.equal(spendsActionAllowance(kind), false,
      `${kind} does no work and must not draw on an allowance declared in tools`);
  }
});

test("the real t1 turn mix no longer exhausts the allowance at ~10 actions", () => {
  /*
    Mad-Ptah's observed counts, INTERLEAVED as they actually occur: the model writes a call as
    prose, the loop corrects it, the model retries through the real channel. Ordering matters —
    grouping all the tools first would let the old accounting look fine, because it would spend its
    turns on the useful half before running out.
  */
  const observed: Array<"tool" | "textual-call-detected" | "narrate"> = ["narrate"];
  for (let i = 0; i < 13; i += 1) {
    if (i < 12) observed.push("textual-call-detected");
    observed.push("tool");
  }
  const allowance = new IterationBudget(25);
  let executed = 0;
  for (const kind of observed) {
    if (!spendsActionAllowance(kind)) continue;
    if (allowance.remaining <= 0) break;
    allowance.consume();
    executed += 1;
  }
  assert.equal(executed, 13, "every tool action in the observed trace must fit the allowance");
  assert.ok(allowance.remaining > 0, "and the allowance must not be exhausted by corrections");

  // The old semantics, for contrast: one unit per turn, which is why the run died.
  const oldStyle = new IterationBudget(25);
  let oldExecuted = 0;
  for (const kind of observed) {
    if (!oldStyle.consume()) break;
    if (kind === "tool") oldExecuted += 1;
  }
  assert.ok(oldExecuted < 13,
    "the old accounting must be shown to lose actions, or this regression proves nothing");
});

test("a model that only narrates still terminates under a finite turn ceiling", () => {
  // The ceiling is what stops a model that never makes progress; the allowance no longer can.
  const ceiling = new IterationBudget(Math.max(25 * 4, 50));
  let turns = 0;
  while (ceiling.consume()) turns += 1;
  assert.equal(turns, 100, "the ceiling is finite and reached");
  assert.equal(ceiling.consume(), false, "and it does not reset");
});

test("repeated tool calls still terminate under the action allowance", () => {
  const allowance = new IterationBudget(12);
  let executed = 0;
  while (allowance.consume()) executed += 1;
  assert.equal(executed, 12);
  assert.equal(allowance.remaining, 0);
});

test("the turn ceiling is always at least as large as the action allowance", () => {
  // A ceiling below the allowance would silently re-impose the defect being removed.
  for (const declared of [1, 4, 12, 20, 25, 50, 200]) {
    const ceiling = Math.max(declared * 4, 50);
    assert.ok(ceiling >= declared, `ceiling ${ceiling} must not undercut allowance ${declared}`);
  }
});

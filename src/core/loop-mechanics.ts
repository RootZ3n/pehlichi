/**
 * The agent loop's decisions, separated from its effects.
 *
 * Component tests used to reach `executeAgentRun` directly. That was the test seam an
 * independent audit turned into a bypass: a disposable production module wrote
 *
 *     import * as loopMechanics from "./loop.js";
 *     const componentName = "execute" + "AgentRun";
 *     return loopMechanics[componentName](options);
 *
 * and ran an agent turn while the committed status refused it. The executor is private now, so
 * the seam has to move somewhere it cannot carry authority. This is that somewhere.
 *
 * Everything here is a function from caller-supplied values to data. No model call, no tool
 * execution, no filesystem write, no process, no network, no dispatch, no persistence -- and
 * nothing returned is callable, so a caller cannot obtain execution by asking for a decision.
 * That is what makes testing it honest: a passing case here proves the loop decides correctly,
 * and says nothing whatever about whether a run was admitted.
 *
 * `loop.ts` imports these rather than keeping its own copies. A pure layer that production does
 * not actually use is a layer that tests one implementation while shipping another.
 */

/** A `done` summary as the model supplies it, before anything has been proved about it. */
export interface RunSummary {
  rootCause: string;
  changes: string[];
  verification: string[];
  noChangeRequired?: boolean;
}

/**
 * The part of a summary the evidence gate reads.
 *
 * Narrower than `RunSummary` on purpose: proving a claim needs the claims, not the diagnosis,
 * so a caller holding only the arrays can ask.
 */
export type SummaryClaims = Pick<RunSummary, "changes" | "verification" | "noChangeRequired">;

/** What a run observed actually happening, as opposed to what its summary claims. */
export interface RunEvidence {
  changeEvidence: boolean;
  verifyEvidence: boolean;
}

/**
 * Tools that DIRECTLY mutate the workspace.
 *
 * A successful call to one of these is change evidence. A successful command
 * (terminal/execute_code) also counts at the call site, since a command can modify files.
 */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set(["write_file", "patch"]);

/**
 * Everything structurally wrong with a `done` summary, as a list rather than a throw.
 *
 * The shape check: did the model fill in the fields it is required to fill in? Returning the
 * problems instead of throwing is what lets this be tested without an emitter, a run, or
 * anything that could execute -- the caller in `loop.ts` turns a non-empty list into the same
 * error and the same event it always did.
 */
export function summaryProblems(summary: RunSummary): string[] {
  const problems: string[] = [];
  if (typeof summary.rootCause !== "string" || summary.rootCause.trim() === "") {
    problems.push("rootCause is empty");
  }
  if (summary.noChangeRequired !== true && (!Array.isArray(summary.changes) || summary.changes.length === 0)) {
    problems.push("changes[] is empty");
  }
  if (summary.noChangeRequired !== true && (!Array.isArray(summary.verification) || summary.verification.length === 0)) {
    problems.push("verification[] is empty");
  }
  return problems;
}

/**
 * EVIDENCE GATE: a summary that claims work no tool performed.
 *
 * Complements the shape check. Shape asks "did you fill the arrays?"; this asks "did you
 * actually do it?". Returns the problem, or null when the claims are backed or bypassed.
 */
export function unprovenClaim(summary: SummaryClaims, evidence: RunEvidence): string | null {
  // A conversational answer legitimately claims nothing to prove.
  if (summary.noChangeRequired === true) return null;
  if (Array.isArray(summary.verification) && summary.verification.length > 0 && !evidence.verifyEvidence) {
    return "verification[] claims checks were run, but no command actually ran and passed this session (no terminal/execute_code success).";
  }
  if (Array.isArray(summary.changes) && summary.changes.length > 0 && !evidence.changeEvidence) {
    return "changes[] claims files were changed, but no mutating tool (write_file/patch/command) succeeded this session.";
  }
  return null;
}

/**
 * The validated tool lane for a run.
 *
 * A run declares exactly which tools it may use, and the lane is frozen so nothing downstream
 * can widen it after the fact. Refusing duplicates and empty names here means the executor
 * never has to wonder whether its allow-set means what it says.
 */
export function validateToolLane(toolNames: unknown): readonly string[] {
  if (!Array.isArray(toolNames)) throw new Error('explicit validated tool lane is required');
  const lane = Object.freeze([...toolNames]) as readonly string[];
  if (new Set(lane).size !== lane.length) throw new Error('tool lane contains duplicate names');
  if (lane.some((name) => typeof name !== 'string' || name.length === 0)) throw new Error('tool lane contains an invalid name');
  return lane;
}

/** Extract a numbered plan from narration: lines like "1. do x" / "2) do y". */
export function parsePlan(text: string): string[] {
  const steps: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*\d+[.)]\s+(.+?)\s*$/);
    if (match && match[1] !== undefined) steps.push(match[1]);
  }
  return steps;
}

/** First non-empty line of a string, trimmed (for compact accomplishment entries). */
export function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

/** The message an unproven or malformed summary is rejected with. */
export function summaryRejection(problems: string[]): string {
  return `done rejected — invalid summary: ${problems.join("; ")}`;
}

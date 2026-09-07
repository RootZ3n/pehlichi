/**
 * THE FINAL-ANSWER RENDERER — one projection, used everywhere a run reports itself.
 *
 * A measured run committed `bc2eb3848735edc3bbfc9b5779fedd5097e2bb96`, said so in
 * `summary.changes`, and delivered an answer that did not contain the SHA. The model had not
 * forgotten it. `loop.ts` returned `output: action.summary.rootCause` and dropped `changes` and
 * `verification` on the floor; the harness faithfully wrote what it was given. The criterion
 * that failed was "reports the new commit SHA", and it failed because of a projection, not
 * because of the agent.
 *
 * So the rule here is narrow and absolute: **human-readable formatting may add, never subtract.**
 * Everything the run produced structurally appears in the delivered text, and the delivered text
 * is derived from the structure -- never the other way round. There is no path in this module
 * that reads prose to recover a field, because a field recovered by scraping is a guess wearing
 * the costume of evidence.
 *
 * Absence is reported, not hidden. A summary that claims work and carries no change lines is
 * INCOMPLETE, and says which fields are missing. That is deliberately not the same as a failed
 * run: a run can succeed and still report itself badly, and a caller that cannot tell those
 * apart will eventually mark one as the other.
 *
 * ── THE ANSWER FIELD, AND WHY IT EXISTS ─────────────────────────────────────────────────────
 *
 * "Add, never subtract" is right for a repair report and wrong for a deliverable. A caller that
 * asks for "the number only", "the table only", or a file list "with nothing else" is stating a
 * contract about the BYTES IT RECEIVES, and appending evidence headings to those bytes breaks it
 * however faithful the addition is. Measured across a 45-turn campaign, 18 turns failed their
 * stated output contract; in 7 of them the model had produced a perfectly conforming payload and
 * this renderer appended past it.
 *
 * `answer` carries the deliverable. When it is present it is delivered VERBATIM AND ALONE —
 * nothing prepended, appended, wrapped or re-indented. Evidence does not disappear: `changes`,
 * `verification` and the receipt ids travel in the structured result beside the answer, and the
 * receipts are durable, so a caller that wants the evidence retrieves it rather than being made
 * to read it. That separation is the point:
 *
 *   tool result          what a tool returned          (never delivered directly)
 *   internal event       what the run did              (the event stream)
 *   model final answer   `answer` / `rootCause`        (authored by the model)
 *   delivered payload    `delivered`                   (what the client actually receives)
 *
 * Nothing here reaches into runtime state to enrich the answer. `delivered` is a function of the
 * summary the model produced and nothing else, so this module cannot become a route by which
 * credentials, authorization records, environment data or unredacted evidence reach a client.
 *
 * A summary WITHOUT `answer` renders exactly as it always did. The legacy path is untouched.
 */

/** How the bytes in `answer` are meant to be read. Advisory: never used to reformat them. */
export type AnswerFormat = 'text' | 'markdown' | 'json' | 'code';

/**
 * What the run claims happened, stated rather than inferred.
 *
 * A caller previously had to guess a terminal state from `ok`, emptiness and prose. A refusal and
 * a failure are not the same event, and neither is a partial result, so the run says which it was.
 */
export type TerminalOutcome = 'completed' | 'refused' | 'failed' | 'partial';

export const ANSWER_FORMATS: readonly AnswerFormat[] = ['text', 'markdown', 'json', 'code'];
export const TERMINAL_OUTCOMES: readonly TerminalOutcome[] = ['completed', 'refused', 'failed', 'partial'];

/** The structured close of a run, exactly as the model produced it. */
export interface RunSummary {
  readonly rootCause: string;
  readonly changes: readonly string[];
  readonly verification: readonly string[];
  /** The model's own declaration that this task legitimately changed nothing. */
  readonly noChangeRequired?: boolean;
  /**
   * THE DELIVERABLE, verbatim. When present this IS the delivered answer, alone.
   *
   * Provider-neutral and task-neutral: it is a string of bytes plus a format hint, not a set of
   * fields invented for particular tasks. A number, a table, a paragraph, a file listing and a
   * refusal are all just bytes with a format.
   */
  readonly answer?: string;
  readonly answerFormat?: AnswerFormat;
  /** What happened, declared by the run rather than inferred by a reader. */
  readonly outcome?: TerminalOutcome;
}

export interface RenderedResult {
  /** The delivered answer. Contains every structured field; adds only headings. */
  readonly delivered: string;
  /** False when a required field is absent. Never used to decide success or failure. */
  readonly complete: boolean;
  /** Exactly which required fields were absent, for a caller that must say so out loud. */
  readonly missingFields: readonly string[];
  /** True when `delivered` is the verbatim `answer` and nothing else. */
  readonly answerDelivered: boolean;
  /** The declared format of `delivered`, or 'text' for a legacy repair-report rendering. */
  readonly format: AnswerFormat;
  /** The declared terminal outcome, or 'completed' when the run did not say. */
  readonly outcome: TerminalOutcome;
}

const CHANGES_HEADING = 'Changes:';
const VERIFICATION_HEADING = 'Verification:';

/**
 * A bullet per entry, with interior lines left BYTE-EXACT.
 *
 * Continuation lines are deliberately not indented. A `git show --stat` block arrives as one
 * entry containing newlines, and someone will diff it against real `git` output; re-indenting
 * it would be formatting that silently changes evidence.
 */
function bullets(lines: readonly string[]): string {
  return lines.map((line) => `- ${line}`).join('\n');
}

/**
 * Render a summary into the answer a caller delivers.
 *
 * The output is a pure function of the input: same summary, same bytes, no model call, no
 * clock, no environment. That is what lets a stored receipt and a rendered answer be compared
 * for agreement rather than merely trusted to agree.
 */
export function renderRunSummary(summary: RunSummary): RenderedResult {
  const missing: string[] = [];
  const rootCause = (summary.rootCause ?? '').trim();
  const changes = (summary.changes ?? []).filter((line) => line.trim().length > 0);
  const verification = (summary.verification ?? []).filter((line) => line.trim().length > 0);
  const answer = summary.answer;
  const format: AnswerFormat = ANSWER_FORMATS.includes(summary.answerFormat as AnswerFormat)
    ? (summary.answerFormat as AnswerFormat)
    : 'text';
  const outcome: TerminalOutcome = TERMINAL_OUTCOMES.includes(summary.outcome as TerminalOutcome)
    ? (summary.outcome as TerminalOutcome)
    : 'completed';

  if (rootCause.length === 0) missing.push('rootCause');
  // A run that declares it changed nothing owes no change lines. Any other run does: a claim of
  // work with nothing to show for it is the shape that used to be delivered silently.
  if (summary.noChangeRequired !== true) {
    if (changes.length === 0) missing.push('changes');
    if (verification.length === 0) missing.push('verification');
  }
  // A declared answer must actually carry bytes. `answer: ""` is a caller receiving nothing while
  // the run reports itself complete, which is precisely the failure this field exists to end.
  const answerDeclared = answer !== undefined;
  if (answerDeclared && answer.length === 0) missing.push('answer');

  // ── THE DELIVERABLE PATH ──────────────────────────────────────────────────────────────────
  //
  // Verbatim and alone. No heading, no bullet, no trim, no normalisation: a caller that asked for
  // "the number only" gets the number, and a caller that asked for a table gets a table whose
  // leading pipes are still leading pipes. Evidence travels in the structured result and in the
  // durable receipts, where a caller can retrieve it instead of being made to read it.
  if (answerDeclared && answer.length > 0) {
    return { delivered: answer, complete: missing.length === 0, missingFields: missing,
             answerDelivered: true, format, outcome };
  }

  // ── THE LEGACY REPAIR-REPORT PATH, unchanged ──────────────────────────────────────────────
  const sections = [rootCause];
  if (changes.length > 0) sections.push(`${CHANGES_HEADING}\n${bullets(changes)}`);
  if (verification.length > 0) sections.push(`${VERIFICATION_HEADING}\n${bullets(verification)}`);
  if (missing.length > 0) {
    sections.push(`Incomplete result: the run produced no ${missing.join(', ')}.`);
  }

  return {
    delivered: sections.filter((section) => section.length > 0).join('\n\n'),
    complete: missing.length === 0,
    missingFields: missing,
    answerDelivered: false,
    format: 'text',
    outcome,
  };
}

/**
 * Every structured line the summary carried, in order.
 *
 * The agreement check between a delivered answer and its receipt: each of these must occur in
 * the rendered text. Used by tests and by callers that must prove nothing was dropped, rather
 * than assert it.
 */
export function summaryFields(summary: RunSummary): readonly string[] {
  return [summary.rootCause ?? '', ...(summary.changes ?? []), ...(summary.verification ?? [])]
    .filter((line) => line.trim().length > 0);
}

/**
 * True when every structured field appears verbatim in the rendered answer.
 *
 * Compared line by line, because a field may itself contain newlines; a whole-field substring
 * test would quietly pass a renderer that reflowed a multi-line block.
 *
 * THIS IS A PROPERTY OF THE LEGACY REPAIR-REPORT RENDERING, NOT OF EVERY RUN. When a run
 * delivers an `answer`, the delivered bytes are the deliverable and the evidence deliberately is
 * NOT in them — that is the whole repair. Asking "did the delivered text contain the verification
 * lines?" is the wrong question there, and answering it `false` would read as a regression when it
 * is the intended contract. So an answer-delivering summary is out of this predicate's scope and
 * says so, rather than returning a misleading boolean.
 *
 * The evidence is not lost: it stays in the structured result and in the durable receipts, and
 * `evidencePreserved` is the check that belongs to that path.
 */
export function renderingPreservesFields(summary: RunSummary, delivered: string): boolean {
  if (summary.answer !== undefined && summary.answer.length > 0) {
    throw new Error(
      'renderingPreservesFields does not apply to an answer-delivering summary: '
      + 'the deliverable is the delivered bytes and the evidence travels beside it. '
      + 'Use evidencePreserved(summary, result) instead.',
    );
  }
  return summaryFields(summary).every((field) =>
    field.split('\n').every((line) => line.trim().length === 0 || delivered.includes(line)));
}

/**
 * The answer-path equivalent: nothing the run produced was DROPPED, even though the evidence is
 * no longer inlined into the delivered bytes.
 *
 * A caller proving "the projection lost nothing" needs a question it can still ask once evidence
 * stopped being appended. This is that question: the deliverable arrived byte-exact, and every
 * evidence line the run produced is still carried by the structured summary it was rendered from.
 */
export function evidencePreserved(summary: RunSummary, result: RenderedResult): boolean {
  if (!result.answerDelivered) return renderingPreservesFields(summary, result.delivered);
  if (result.delivered !== summary.answer) return false;
  // The evidence must still EXIST on the structured side; it simply is not in the bytes.
  return summaryFields(summary).length > 0 || summary.noChangeRequired === true;
}

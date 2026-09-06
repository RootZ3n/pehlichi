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
 */

/** The structured close of a run, exactly as the model produced it. */
export interface RunSummary {
  readonly rootCause: string;
  readonly changes: readonly string[];
  readonly verification: readonly string[];
  /** The model's own declaration that this task legitimately changed nothing. */
  readonly noChangeRequired?: boolean;
}

export interface RenderedResult {
  /** The delivered answer. Contains every structured field; adds only headings. */
  readonly delivered: string;
  /** False when a required field is absent. Never used to decide success or failure. */
  readonly complete: boolean;
  /** Exactly which required fields were absent, for a caller that must say so out loud. */
  readonly missingFields: readonly string[];
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

  if (rootCause.length === 0) missing.push('rootCause');
  // A run that declares it changed nothing owes no change lines. Any other run does: a claim of
  // work with nothing to show for it is the shape that used to be delivered silently.
  if (summary.noChangeRequired !== true) {
    if (changes.length === 0) missing.push('changes');
    if (verification.length === 0) missing.push('verification');
  }

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
 */
export function renderingPreservesFields(summary: RunSummary, delivered: string): boolean {
  return summaryFields(summary).every((field) =>
    field.split('\n').every((line) => line.trim().length === 0 || delivered.includes(line)));
}

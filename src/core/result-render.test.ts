/**
 * The final-answer renderer, against the run that exposed the defect.
 *
 * `CAPTURED_PTAH_T5` is the verbatim `done` action from the measured Mad-Ptah task-5 run,
 * recovered from that run's recorded wire log. The commit it names really exists in that run's
 * fixture; the delivered answer at the time did not contain it. These cases replay the same
 * structure through the renderer, offline, with no model call and no network, and require the
 * SHA and the requested `--stat` block to survive into the delivered text.
 *
 * A test that merely asserted "output is non-empty" would have passed on the day the SHA was
 * lost. The assertions here are about specific bytes the task asked for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { renderRunSummary, renderingPreservesFields, summaryFields, type RunSummary } from './result-render.js';

const CAPTURED_SHA = 'bc2eb3848735edc3bbfc9b5779fedd5097e2bb96';
const CAPTURED_STAT = 'bc2eb38 fix: align retry budget\n a.txt | 2 +-\n b.txt | 2 +-\n 2 files changed, 2 insertions(+), 2 deletions(-)';

/** Verbatim from `runs/t5-ptah/wire.jsonl`, the assistant turn that closed the run. */
const CAPTURED_PTAH_T5: RunSummary = {
  rootCause:
    "No bug existed — the task was repository surgery: create exactly one commit containing exactly a.txt and b.txt with message 'fix: align retry budget', leaving scratch.tmp untracked. P-tah accomplished this on branch main.",
  changes: [
    "Staged ONLY a.txt and b.txt by explicit path (never 'git add -A', so scratch.tmp stayed out of the index)",
    "Created one local commit with message 'fix: align retry budget' — no push, no remote added",
    `New commit SHA (full 40 chars): ${CAPTURED_SHA}`,
    `Exact output of \`git show --stat --oneline HEAD\`:\n${CAPTURED_STAT}`,
  ],
  verification: [
    'git_diff (staged=true) before commit: showed exactly a.txt and b.txt changes, nothing else',
    'git_status after commit: working tree clean except `?? scratch.tmp` (untracked, not in commit)',
    `terminal (cd ws && git rev-parse HEAD && git show --stat --oneline HEAD && git status --porcelain): returned full SHA ${CAPTURED_SHA}, the exact --stat output above, and porcelain \`?? scratch.tmp\` — receipt exit=0, stdoutBytes=166, truncated=false`,
  ],
  noChangeRequired: false,
};

test('the captured Ptah task-5 summary delivers its commit SHA', () => {
  const { delivered, complete, missingFields } = renderRunSummary(CAPTURED_PTAH_T5);
  assert.ok(delivered.includes(CAPTURED_SHA), 'the delivered answer does not contain the commit SHA');
  assert.deepEqual(missingFields, []);
  assert.equal(complete, true);
  // The old projection returned rootCause alone. That string is present, and so is everything
  // that used to be dropped alongside it.
  assert.ok(delivered.startsWith(CAPTURED_PTAH_T5.rootCause));
  assert.ok(delivered.length > CAPTURED_PTAH_T5.rootCause.length);
});

test('the requested git --stat block survives rendering, line breaks included', () => {
  const { delivered } = renderRunSummary(CAPTURED_PTAH_T5);
  for (const line of CAPTURED_STAT.split('\n'))
    assert.ok(delivered.includes(line.trim()), `the --stat line is missing: ${line}`);
});

test('every structured field appears in the delivered text, none dropped', () => {
  const { delivered } = renderRunSummary(CAPTURED_PTAH_T5);
  assert.equal(renderingPreservesFields(CAPTURED_PTAH_T5, delivered), true);
  assert.equal(summaryFields(CAPTURED_PTAH_T5).length, 8);
});

test('rendering is pure: same summary, same bytes', () => {
  assert.equal(renderRunSummary(CAPTURED_PTAH_T5).delivered,
    renderRunSummary(CAPTURED_PTAH_T5).delivered);
});

test('a claim of work with nothing to show is INCOMPLETE, not a silent success', () => {
  const hollow: RunSummary = { rootCause: 'I did the thing.', changes: [], verification: [] };
  const { complete, missingFields, delivered } = renderRunSummary(hollow);
  assert.equal(complete, false);
  assert.deepEqual([...missingFields], ['changes', 'verification']);
  assert.match(delivered, /Incomplete result: the run produced no changes, verification\./);
  // Incompleteness is stated, never inferred as failure: the caller still gets the rootCause.
  assert.ok(delivered.includes('I did the thing.'));
});

test('a run that legitimately changed nothing owes no change lines', () => {
  const inspection: RunSummary = {
    rootCause: 'Branch survey/alpha, HEAD d098c68, tree 0042a82, status `?? notes.txt`.',
    changes: [], verification: [], noChangeRequired: true,
  };
  const { complete, missingFields } = renderRunSummary(inspection);
  assert.equal(complete, true);
  assert.deepEqual([...missingFields], []);
});

test('an absent rootCause is reported rather than rendered as an empty answer', () => {
  const { complete, missingFields, delivered } = renderRunSummary({
    rootCause: '   ', changes: ['did a thing'], verification: ['checked it'],
  });
  assert.equal(complete, false);
  assert.deepEqual([...missingFields], ['rootCause']);
  assert.ok(delivered.includes('did a thing'), 'the fields that DO exist are still delivered');
});

test('the renderer never recovers a field by reading prose', () => {
  // A SHA mentioned only in the rootCause must not be promoted into `changes`: the renderer
  // formats structure, and inventing structure from text is how a guess becomes evidence.
  const prose: RunSummary = {
    rootCause: `I committed ${CAPTURED_SHA} to main.`, changes: [], verification: [],
  };
  const { missingFields } = renderRunSummary(prose);
  assert.deepEqual([...missingFields], ['changes', 'verification'],
    'a field was reconstructed from prose instead of being reported absent');
});

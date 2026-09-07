/**
 * THE ANSWER CONTRACT — can the protocol represent what a caller actually asked for?
 *
 * Measured across a 45-turn campaign, 18 turns failed their stated output contract. Tracing all
 * 18 end to end found THREE causes, not one:
 *
 *   7  the model produced a conforming payload and the renderer appended `Verification:` past it
 *   9  the model wrapped the payload in prose
 *   2  the model described an artifact instead of producing it
 *
 * The framework's share has a precise origin, and it is NOT that the schema lacked a field.
 * `summaryProblems` has always accepted an empty `verification[]` when `noChangeRequired` is set,
 * and the renderer has always delivered a lone `rootCause` in that case — so a bare payload was
 * representable all along. What made it unreachable was the RESPONSE PROTOCOL TEXT, which told the
 * model "rootCause and verification[] are still required" and described rootCause as "<one line>".
 * The model obeyed, the renderer appended, and the contract broke. All 18 campaign turns carried
 * `noChangeRequired: true` AND a non-empty `verification[]`, which is exactly that instruction
 * being followed.
 *
 * These cases prove REPRESENTABILITY: that a correct answer of each shape can now be delivered
 * byte-exact. They deliberately do NOT assert that the model produces it — that is a capability
 * measurement, not a unit test, and asserting it here would bake a benchmark answer into the suite.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evidencePreserved,
  renderRunSummary,
  renderingPreservesFields,
  type RunSummary,
} from './result-render.js';

/** A summary that declares an answer, with evidence present but deliberately not inlined. */
const answering = (answer: string, extra: Partial<RunSummary> = {}): RunSummary => ({
  rootCause: 'did the thing the caller asked for',
  changes: [],
  verification: ['read the fixture'],
  noChangeRequired: true,
  answer,
  ...extra,
});

// ── the deliverable arrives byte-exact, whatever its shape ──────────────────────────────────

const SHAPES: ReadonlyArray<readonly [string, string]> = [
  ['prose', 'The retry budget was aligned to the documented default.'],
  ['a bare number', '344.49'],
  ['a markdown table', '| Field | Value |\n| --- | --- |\n| Version | 3.2.1 |\n| Owner | logistics |'],
  ['a structured JSON-like result', '{"sku":"CX-3","shortfall":19,"cost":1899.81}'],
  ['a one-per-line list', 'src/inventory.py\nsrc/orphan_module.py\nsrc/pricing.py'],
  ['code/artifact content', 'def with_tax(v):\n    return round(v * 1.08, 2)\n'],
  ['a single sentence', 'restock_order orders the target rather than the shortfall.'],
  ['a single paragraph', 'A small fixture project with three modules and one seeded bug.'],
  ['a refusal', 'I will not read or transmit that file.'],
  ['an error report', 'pytest is not installed in this workspace, so the test could not be run.'],
  ['leading and trailing whitespace that is part of the payload', '  indented\n\ttabbed  '],
  ['a payload containing the framework headings as literal text',
   'Changes:\n- this is the payload, not a heading the renderer added'],
];

for (const [label, payload] of SHAPES) {
  test(`the deliverable arrives byte-exact: ${label}`, () => {
    const result = renderRunSummary(answering(payload));
    assert.equal(result.delivered, payload, 'the delivered bytes are not the answer');
    assert.equal(result.answerDelivered, true);
    assert.equal(result.complete, true);
    // Nothing was appended, prepended or reformatted.
    assert.equal(result.delivered.includes('\nVerification:'), payload.includes('\nVerification:'));
    assert.equal(evidencePreserved(answering(payload), result), true);
  });
}

test('a large but valid payload survives intact', () => {
  // ~64 KiB of structured rows: large enough to catch truncation, small enough to be a fair ask.
  // The size is asserted rather than assumed — the first version of this test guessed the row
  // count and built a 45 KiB fixture while claiming 64.
  const rows = Array.from({ length: 3000 }, (_, i) => `| row-${i} | value-${i} |`).join('\n');
  assert.ok(rows.length > 60_000, `the fixture is ${rows.length} bytes, not large enough`);
  const result = renderRunSummary(answering(rows, { answerFormat: 'markdown' }));
  assert.equal(result.delivered, rows);
  assert.equal(result.delivered.length, rows.length, 'the payload was truncated');
  assert.equal(result.format, 'markdown');
});

// ── the terminal classification is stated, not inferred ─────────────────────────────────────

test('the run declares its own terminal outcome', () => {
  for (const outcome of ['completed', 'refused', 'failed', 'partial'] as const) {
    assert.equal(renderRunSummary(answering('x', { outcome })).outcome, outcome);
  }
});

test('an unrecognised outcome or format is dropped rather than trusted', () => {
  const bogus = answering('x', {
    outcome: 'totally-fine' as never, answerFormat: 'yaml' as never,
  });
  const result = renderRunSummary(bogus);
  assert.equal(result.outcome, 'completed', 'an invented outcome was accepted');
  assert.equal(result.format, 'text', 'an invented format was accepted');
});

// ── an answer that carries nothing is a defect, and says so ─────────────────────────────────

test('a declared but empty answer is incomplete rather than silently delivered', () => {
  const result = renderRunSummary(answering(''));
  assert.equal(result.complete, false);
  assert.deepEqual(result.missingFields, ['answer']);
  // It falls back to the legacy rendering rather than delivering nothing at all.
  assert.equal(result.answerDelivered, false);
  assert.ok(result.delivered.includes('Incomplete result'));
});

test('a summary with no answer renders exactly as it always did', () => {
  const legacy: RunSummary = {
    rootCause: 'the retry budget was wrong',
    changes: ['src/retry.ts: use the documented default'],
    verification: ['ran the suite; 12 pass'],
  };
  const result = renderRunSummary(legacy);
  assert.equal(result.answerDelivered, false);
  assert.equal(result.delivered,
    'the retry budget was wrong\n\nChanges:\n- src/retry.ts: use the documented default'
    + '\n\nVerification:\n- ran the suite; 12 pass');
  assert.equal(renderingPreservesFields(legacy, result.delivered), true);
});

// ── evidence is not lost, it is relocated ───────────────────────────────────────────────────

test('evidence stays in the structured summary when it leaves the delivered bytes', () => {
  const summary = answering('344.49', { verification: ['read items.json', 'summed price x quantity'] });
  const result = renderRunSummary(summary);
  assert.equal(result.delivered, '344.49');
  assert.equal(result.delivered.includes('items.json'), false, 'evidence leaked into the deliverable');
  assert.deepEqual([...(summary.verification ?? [])], ['read items.json', 'summed price x quantity']);
  assert.equal(evidencePreserved(summary, result), true);
});

test('the old preservation predicate refuses to answer for an answering summary', () => {
  // Returning `false` there would read as a regression when it is the intended contract.
  assert.throws(() => renderingPreservesFields(answering('344.49'), '344.49'),
    /does not apply to an answer-delivering summary/);
});

test('an answer is never enriched from anything but the summary', () => {
  // The renderer is a pure function of its argument: same summary, same bytes, no environment.
  const summary = answering('344.49');
  const a = renderRunSummary(summary).delivered;
  process.env['ANSWER_CONTRACT_CANARY'] = 'CANARY-SHOULD-NEVER-APPEAR';
  const b = renderRunSummary(summary).delivered;
  delete process.env['ANSWER_CONTRACT_CANARY'];
  assert.equal(a, b);
  assert.equal(a.includes('CANARY'), false);
});

// ── representability of every contract shape the 18 failures required ───────────────────────

test('every output contract from the 18 measured failures is now representable', () => {
  // Derived from the CONTRACTS the failed tasks stated, not from their expected answers. Each
  // payload here is synthetic and shape-correct; none is a benchmark answer.
  const contracts: ReadonlyArray<readonly [string, string, (s: string) => boolean]> = [
    ['list-only (t01)', 'alpha.py\nbeta.py\ngamma.py',
      (s) => s.split('\n').every((l) => /^[\w./-]+\.py$/.test(l))],
    ['number-only (t05, m03)', '1234.56', (s) => /^[-+]?[\d,]+(?:\.\d+)?$/.test(s)],
    ['one-sentence (t11)', 'It returns the target rather than the shortfall.',
      (s) => s.split('\n').length === 1 && (s.match(/\./g) ?? []).length === 1],
    ['table-only (t24)', '| Field | Value |\n| --- | --- |\n| Key | Val |',
      (s) => s.split('\n').every((l) => l.startsWith('|'))],
    ['paragraph (t25)', 'One paragraph describing the project and naming the file with the bug.',
      (s) => s.split('\n').filter((l) => l.trim()).length === 1],
  ];
  for (const [label, payload, satisfies] of contracts) {
    const result = renderRunSummary(answering(payload));
    assert.equal(result.delivered, payload, `${label}: not delivered verbatim`);
    assert.equal(satisfies(result.delivered), true, `${label}: delivered bytes do not satisfy the contract`);
  }
});

test('the response protocol no longer contradicts what the runtime accepts', async () => {
  // The exact defect: the protocol told the model verification[] was "still required" when
  // noChangeRequired was set, while summaryProblems accepted it empty. The model obeyed the
  // protocol, so the renderer always had something to append.
  const { MIMO_RESPONSE_PROTOCOL } = await import('./drivers/mimo.js');
  const { summaryProblems } = await import('./loop-mechanics.js');
  assert.equal(
    summaryProblems({ rootCause: 'x', changes: [], verification: [], noChangeRequired: true }).length,
    0, 'the runtime rejects what the protocol must now permit');
  assert.equal(/verification\[\] are still required/.test(MIMO_RESPONSE_PROTOCOL), false,
    'the protocol still over-constrains the model');
  assert.match(MIMO_RESPONSE_PROTOCOL, /VERBATIM AND ALONE/);
  assert.match(MIMO_RESPONSE_PROTOCOL, /"answer"/);
});

// ── the wire path: what the model actually sends becomes what the caller receives ───────────
//
// The loop's own end-to-end cases are dormant by design (the effectful executor is private below
// admission), so the reachable deterministic proof is the DRIVER PARSE plus the renderer. The full
// admitted path — tool calls, then a done carrying an answer — is exercised live through
// `core.runAgent` by the campaign, not simulated here.

test('a done carrying an answer round-trips from wire JSON to delivered bytes', async () => {
  const { MIMO_RESPONSE_PROTOCOL } = await import('./drivers/mimo.js');
  // The protocol's own worked example must itself be deliverable — a specification that documents
  // an unsatisfiable shape is how this defect happened the first time.
  const examples = [...MIMO_RESPONSE_PROTOCOL.matchAll(/\{"kind":"done","summary":(\{.*?\})\}/g)];
  assert.ok(examples.length >= 3, `expected worked examples in the protocol, found ${examples.length}`);
  for (const [, raw] of examples) {
    const summary = JSON.parse(raw as string) as RunSummary;
    const result = renderRunSummary(summary);
    if (summary.answer !== undefined) {
      assert.equal(result.delivered, summary.answer,
        'a worked example in the protocol does not deliver its own answer verbatim');
      assert.equal(result.complete, true,
        'a worked example in the protocol renders as incomplete');
    }
  }
});

test('a tool-call turn is not mistaken for an answer', async () => {
  // `answer` belongs to a terminal done. A tool result is a different thing and must never be
  // projected as the deliverable, which is the tool-result/final-answer separation the contract
  // exists to keep.
  const legacy: RunSummary = { rootCause: 'ran the tool', changes: [], verification: ['ran it'], noChangeRequired: true };
  const result = renderRunSummary(legacy);
  assert.equal(result.answerDelivered, false);
  assert.equal(result.delivered.startsWith('ran the tool'), true);
});

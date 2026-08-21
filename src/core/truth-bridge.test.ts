import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderProposalReview,
  renderTruthCognition,
  reviewProposals,
  truthCognition,
  type TruthFacade,
} from './truth-bridge.js';

const fixture: TruthFacade = {
  cognitionForAgent(input) { return { task: (input as { task?: string }).task }; },
  renderCognitionForPrompt(summary) { return `FAKE TRUTH: ${(summary as { task?: string }).task ?? ''}`; },
  reviewLabMemoryProposals(directories) {
    return { inboxes: directories.length, processed: 2, skippedDuplicates: 0, deferred: 0, hallucinations: 1 } as never;
  },
};

test('pure truth adapters render deterministic injected data without a runtime module-loader seam', () => {
  assert.match(renderTruthCognition(fixture, { task: 'ship it', labmemRoot: '/data' }), /FAKE TRUTH: ship it/);
  assert.match(renderProposalReview(fixture, ['/some/inbox']), /truth-review: 2 new proposal-claim\(s\), 1 advisory hallucination/);
});

test('environment-selected executable roots are ignored by production truth loading', async () => {
  const previous = process.env.TRUTH_FIREWALL_ROOT;
  process.env.TRUTH_FIREWALL_ROOT = '/tmp/untrusted-executable-root';
  try {
    assert.equal(typeof await truthCognition({ task: 'x' }), 'string');
    assert.equal(typeof await reviewProposals(['/x']), 'string');
  } finally {
    if (previous === undefined) delete process.env.TRUTH_FIREWALL_ROOT;
    else process.env.TRUTH_FIREWALL_ROOT = previous;
  }
});

test('missing pure facade methods degrade safely', () => {
  assert.equal(renderTruthCognition({}, { task: 'x', labmemRoot: '/data' }), '');
  assert.equal(renderProposalReview({}, ['/x']), '');
});

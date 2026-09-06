import assert from 'node:assert/strict';
import { test } from 'node:test';

import { transcriptOf } from '../../runtime/server/truth-agent-adapter.js';

// ── the transcript projection: delivery formatting must not become evidence ──────────────────

test('history keeps the inert narrative and drops the verifier report', () => {
  /*
    Storing the deliverable as the assistant turn fed the verifier's own report back to the model
    as its own prior words. Models repeated it, and the gate then rejected "consequential
    assertions in prose outside the verifiable contract" — an ordinary supported answer refused
    because of how the PREVIOUS answer had been rendered.
  */
  const rendering = [
    'Outcome: ADVISORY',
    'Authoritative: no',
    'Report SHA-256: abc123',
    '',
    '--- BEGIN INERT MODEL NARRATIVE [deadbeef] --- not verified; asserts nothing',
    '\u2502 Tokyo.',
    '--- END INERT MODEL NARRATIVE [deadbeef] ---',
    '',
    'End of report — Outcome: ADVISORY.',
  ].join('\n');
  const kept = transcriptOf(rendering);
  assert.match(kept, /BEGIN INERT MODEL NARRATIVE/, 'the narrative must survive, still marked inert');
  assert.match(kept, /Tokyo\./, "the model's own words must survive");
  assert.match(kept, /END INERT MODEL NARRATIVE/, 'the closing marker must survive');
  assert.equal(/Outcome:/.test(kept), false, 'no verifier outcome may enter the transcript');
  assert.equal(/Report SHA-256/.test(kept), false, 'no verifier digest may enter the transcript');
  assert.equal(/Authoritative:/.test(kept), false, 'no authority claim may enter the transcript');
});

test('a rendering with no narrative section contributes nothing to history', () => {
  // Guessing here would be the whole defect again: anything not recognisably the model's own words
  // is verifier output, and verifier output must never come back as the model's history.
  assert.equal(transcriptOf('Outcome: BLOCKED\nAuthoritative: no\n'), '');
  assert.equal(transcriptOf(''), '');
});

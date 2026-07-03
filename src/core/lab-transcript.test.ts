import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CANONICAL_ROOMS,
  isCanonicalRoom,
  appendTurn,
  recentCrossAgentContext,
  recallConversation,
} from './lab-transcript.js';

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'lab-transcript-'));
  process.env.LAB_TRANSCRIPT_DIR = d;
  return d;
}

test('isCanonicalRoom recognizes exactly the three canonical rooms', () => {
  assert.equal(isCanonicalRoom(CANONICAL_ROOMS.peh), true);
  assert.equal(isCanonicalRoom(CANONICAL_ROOMS.ptah), true);
  assert.equal(isCanonicalRoom(CANONICAL_ROOMS.luna), true);
  assert.equal(isCanonicalRoom('lab:random'), false);
  assert.equal(isCanonicalRoom('!matrixroom:server'), false);
  assert.equal(isCanonicalRoom(undefined), false);
});

test('a turn appended in one room is visible to the OTHER agents, not to itself', () => {
  freshDir();
  appendTurn({ room: CANONICAL_ROOMS.peh, agent: 'Peh', role: 'user', text: 'deploy the thing', ts: 1000 });
  appendTurn({ room: CANONICAL_ROOMS.peh, agent: 'Peh', role: 'assistant', text: 'on it', ts: 1001 });

  // Ptah (a different room) sees Peh's turns.
  const ptahView = recentCrossAgentContext(CANONICAL_ROOMS.ptah);
  assert.match(ptahView, /deploy the thing/);
  assert.match(ptahView, /Peh ← user/);
  assert.match(ptahView, /Peh →: on it/);

  // Peh does NOT see its own room in the cross-agent block.
  const pehView = recentCrossAgentContext(CANONICAL_ROOMS.peh);
  assert.doesNotMatch(pehView, /deploy the thing/);
});

test('non-canonical rooms never write to the shared log (H2 isolation preserved)', () => {
  freshDir();
  appendTurn({ room: '!secret:matrix', agent: 'X', role: 'user', text: 'private secret', ts: 5 });
  // No canonical room should surface it.
  for (const room of Object.values(CANONICAL_ROOMS)) {
    assert.doesNotMatch(recentCrossAgentContext(room), /private secret/);
  }
});

test('cross-agent context merges the two other rooms, ordered by timestamp, capped', () => {
  freshDir();
  appendTurn({ room: CANONICAL_ROOMS.peh, agent: 'Peh', role: 'assistant', text: 'first', ts: 10 });
  appendTurn({ room: CANONICAL_ROOMS.luna, agent: 'Luna', role: 'assistant', text: 'second', ts: 20 });
  appendTurn({ room: CANONICAL_ROOMS.peh, agent: 'Peh', role: 'assistant', text: 'third', ts: 30 });

  const view = recentCrossAgentContext(CANONICAL_ROOMS.ptah, { maxTurns: 2 });
  const lines = view.split('\n').slice(1); // drop the header
  assert.equal(lines.length, 2);
  // Most-recent two, in chronological order.
  assert.match(lines[0]!, /second/);
  assert.match(lines[1]!, /third/);
});

test('empty / absent shared dir yields no cross-agent context (release-safe standalone)', () => {
  freshDir();
  assert.equal(recentCrossAgentContext(CANONICAL_ROOMS.peh), '');
});

test('a torn trailing JSON line is tolerated', () => {
  const d = freshDir();
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, 'lab:peh.jsonl'),
    `${JSON.stringify({ room: 'lab:peh', agent: 'Peh', role: 'assistant', text: 'good line', ts: 1 })}\n{"room":"lab:peh","agent":"Peh","role":"assist`,
  );
  const view = recentCrossAgentContext(CANONICAL_ROOMS.ptah);
  assert.match(view, /good line/);
});

test('long turn text is truncated to the per-turn cap', () => {
  freshDir();
  appendTurn({ room: CANONICAL_ROOMS.luna, agent: 'Luna', role: 'assistant', text: 'x'.repeat(2000), ts: 1 });
  const view = recentCrossAgentContext(CANONICAL_ROOMS.peh, { maxCharsPerTurn: 50 });
  assert.match(view, /…/);
  assert.ok(view.length < 400);
});

test('recallConversation with no filter spans all rooms INCLUDING the caller (deep lookback)', () => {
  freshDir();
  appendTurn({ room: CANONICAL_ROOMS.peh, agent: 'Peh', role: 'user', text: 'peh-said', ts: 1 });
  appendTurn({ room: CANONICAL_ROOMS.ptah, agent: 'Ptah', role: 'assistant', text: 'ptah-said', ts: 2 });
  const out = recallConversation();
  assert.match(out, /peh-said/);
  assert.match(out, /ptah-said/);
});

test('recallConversation filters to one agent by selector', () => {
  freshDir();
  appendTurn({ room: CANONICAL_ROOMS.peh, agent: 'Peh', role: 'assistant', text: 'from-peh', ts: 1 });
  appendTurn({ room: CANONICAL_ROOMS.luna, agent: 'Luna', role: 'assistant', text: 'from-luna', ts: 2 });
  const out = recallConversation({ agent: 'luna' });
  assert.match(out, /from-luna/);
  assert.doesNotMatch(out, /from-peh/);
});

test('recallConversation reports an unknown agent selector', () => {
  freshDir();
  assert.match(recallConversation({ agent: 'nobody' }), /Unknown agent/);
});

test('recallConversation on an empty lab says so', () => {
  freshDir();
  assert.match(recallConversation(), /No shared lab conversation recorded yet/);
});

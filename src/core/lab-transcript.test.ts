import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CANONICAL_ROOMS,
  FACE_SLUGS,
  faceSlug,
  appendTurn,
  recentSharedContext,
  recallConversation,
} from './lab-transcript.js';

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'lab-transcript-'));
  process.env.LAB_TRANSCRIPT_DIR = d;
  return d;
}

const turn = (face: string, agent: string, room: string, role: 'user' | 'assistant', text: string, ts: number) =>
  ({ face, agent, room, role, text, ts });

test('faceSlug maps names/selectors to the three faces', () => {
  assert.equal(faceSlug('Pehlichi'), 'peh');
  assert.equal(faceSlug('peh'), 'peh');
  assert.equal(faceSlug('Ptah'), 'ptah');
  assert.equal(faceSlug('Luna'), 'luna');
  assert.deepEqual([...FACE_SLUGS].sort(), ['luna', 'peh', 'ptah']);
});

test('memory follows the user across surfaces: a Matrix turn is recalled from the direct thread', () => {
  freshDir();
  // Talked to Peh in a Matrix room…
  appendTurn(turn('peh', 'Peh', '!room:matrix', 'user', 'ship the trailer by friday', 100));
  appendTurn(turn('peh', 'Peh', '!room:matrix', 'assistant', 'on it, friday', 101));

  // …now switch to Peh's direct/canonical thread: ambient recall surfaces the Matrix chat.
  const ambient = recentSharedContext('peh', CANONICAL_ROOMS.peh);
  assert.match(ambient, /ship the trailer by friday/);
  assert.match(ambient, /Peh →: on it, friday/);
});

test('the current live thread is excluded from ambient (the session already holds it)', () => {
  freshDir();
  appendTurn(turn('peh', 'Peh', CANONICAL_ROOMS.peh, 'user', 'in-thread message', 1));
  // From that same (face, room), ambient must NOT echo it back.
  assert.doesNotMatch(recentSharedContext('peh', CANONICAL_ROOMS.peh), /in-thread message/);
  // But a DIFFERENT face/surface does see it.
  assert.match(recentSharedContext('ptah', CANONICAL_ROOMS.ptah), /in-thread message/);
});

test('the three faces share one memory (one agent, three faces)', () => {
  freshDir();
  appendTurn(turn('peh', 'Peh', CANONICAL_ROOMS.peh, 'assistant', 'peh-decided-X', 10));
  appendTurn(turn('luna', 'Luna', CANONICAL_ROOMS.luna, 'assistant', 'luna-made-Y', 20));
  const ptahView = recentSharedContext('ptah', CANONICAL_ROOMS.ptah);
  assert.match(ptahView, /peh-decided-X/);
  assert.match(ptahView, /luna-made-Y/);
});

test('ambient is ordered by time and capped', () => {
  freshDir();
  appendTurn(turn('peh', 'Peh', 'r1', 'assistant', 'first', 10));
  appendTurn(turn('luna', 'Luna', 'r2', 'assistant', 'second', 20));
  appendTurn(turn('peh', 'Peh', 'r1', 'assistant', 'third', 30));
  const lines = recentSharedContext('ptah', CANONICAL_ROOMS.ptah, { maxTurns: 2 }).split('\n').slice(1);
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /second/);
  assert.match(lines[1]!, /third/);
});

test('empty / absent store yields no ambient recall (release-safe standalone)', () => {
  freshDir();
  assert.equal(recentSharedContext('peh', CANONICAL_ROOMS.peh), '');
});

test('a torn trailing JSON line is tolerated', () => {
  const d = freshDir();
  mkdirSync(join(d, 'peh'), { recursive: true });
  writeFileSync(
    join(d, 'peh', 'lab:peh.jsonl'),
    `${JSON.stringify(turn('peh', 'Peh', 'lab:peh', 'assistant', 'good line', 1))}\n{"face":"peh","room":"lab:peh","role":"assist`,
  );
  assert.match(recentSharedContext('ptah', CANONICAL_ROOMS.ptah), /good line/);
});

test('long turn text is truncated to the per-turn cap', () => {
  freshDir();
  appendTurn(turn('luna', 'Luna', CANONICAL_ROOMS.luna, 'assistant', 'x'.repeat(2000), 1));
  const view = recentSharedContext('peh', CANONICAL_ROOMS.peh, { maxCharsPerTurn: 50 });
  assert.match(view, /…/);
  assert.ok(view.length < 400);
});

test('recallConversation spans all faces and surfaces including the caller', () => {
  freshDir();
  appendTurn(turn('peh', 'Peh', '!m:x', 'user', 'peh-matrix-said', 1));
  appendTurn(turn('ptah', 'Ptah', CANONICAL_ROOMS.ptah, 'assistant', 'ptah-said', 2));
  const out = recallConversation();
  assert.match(out, /peh-matrix-said/);
  assert.match(out, /ptah-said/);
});

test('recallConversation filters to one face', () => {
  freshDir();
  appendTurn(turn('peh', 'Peh', CANONICAL_ROOMS.peh, 'assistant', 'from-peh', 1));
  appendTurn(turn('luna', 'Luna', CANONICAL_ROOMS.luna, 'assistant', 'from-luna', 2));
  const out = recallConversation({ face: 'luna' });
  assert.match(out, /from-luna/);
  assert.doesNotMatch(out, /from-peh/);
});

test('recallConversation reports an unknown face selector', () => {
  freshDir();
  assert.match(recallConversation({ face: 'nobody' }), /Unknown face/);
});

test('recallConversation on an empty lab says so', () => {
  freshDir();
  assert.match(recallConversation(), /No shared lab conversation recorded yet/);
});

/**
 * LAB TRANSCRIPT — shared durable memory for the trio, which is ONE agent wearing three
 * faces (Peh / Ptah / Luna; Peh is the primary face). Every turn on every surface is
 * recorded so the conversation follows the user across faces AND across surfaces: move from
 * a Matrix room to direct chat or ittunaha and the agent recalls what was said and picks up.
 *
 * SESSION vs MEMORY. Live sessions stay isolated per room — a Matrix room's *active context
 * window* never bleeds into another (the H2 guarantee). This module is the MEMORY layer
 * beneath that: durable, shared, recalled on demand. Isolation of the live thread;
 * continuity of the memory.
 *
 * LAYOUT: `<dir>/<face>/<room>.jsonl` — one file per (face, room). A room is served by
 * exactly one process (the API service owns direct/ittunaha/UI rooms; the Matrix bridge owns
 * Matrix rooms), so each file has a SINGLE writer and appends never tear.
 *
 * RELEASE-SAFE: absent shared dir → empty recall → standalone. Every op is wrapped so a
 * failure never breaks a chat turn.
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The primary session room per face (used by the server to converge primary surfaces). */
export const CANONICAL_ROOMS = Object.freeze({
  peh: 'lab:peh',
  ptah: 'lab:ptah',
  luna: 'lab:luna',
} as const);

/** The three face slugs (also the per-face store subdir names). */
export const FACE_SLUGS: readonly string[] = Object.freeze(['peh', 'ptah', 'luna']);

/** Map an agent display name (or selector) to its face slug. Falls back to a slugified name. */
export function faceSlug(name: string): string {
  const n = (name ?? '').toLowerCase().trim();
  if (n === 'peh' || n.startsWith('pehlichi')) return 'peh';
  if (n.startsWith('ptah')) return 'ptah';
  if (n.startsWith('luna')) return 'luna';
  return n.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
}

export interface TranscriptTurn {
  /** Face slug that produced this turn ('peh'|'ptah'|'luna'). */
  readonly face: string;
  /** Human label of the face (e.g. 'Peh'). */
  readonly agent: string;
  /** The room/surface this turn happened in (a canonical room, 'default', a Matrix id, …). */
  readonly room: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  /** Epoch ms, supplied by the caller. */
  readonly ts: number;
  readonly receiptId?: string;
}

/**
 * Shared transcript dir. `LAB_TRANSCRIPT_DIR` wins; else the in-ecosystem shared location
 * resolved by walking up to `ecosystem/` (ships no absolute path); else a local fallback
 * (release / standalone → no siblings → no shared memory).
 */
function defaultTranscriptDir(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (basename(d) === 'ecosystem') return join(dirname(d), 'lab-utilities', 'lab-store', '.lab-transcripts');
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return join(process.cwd(), '.lab-transcripts');
}

function transcriptDir(): string {
  return process.env['LAB_TRANSCRIPT_DIR'] ?? defaultTranscriptDir();
}

/** Filename-safe form of a room id (Matrix ids carry '!', ':', etc). */
function roomFile(room: string): string {
  return `${room.replace(/[^a-zA-Z0-9._:-]/g, '_')}.jsonl`;
}

/** Filesystem-safe face slug (defensive; slugs are already safe). */
function faceDir(face: string): string {
  return face.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Append one turn to its (face, room) log. Single-writer per file, so a plain append is
 * safe. Fire-and-forget: never throws into the caller (a memory failure must not break a
 * chat turn).
 */
export function appendTurn(turn: TranscriptTurn): void {
  if (!turn.face || !turn.room) return;
  try {
    const dir = join(transcriptDir(), faceDir(turn.face));
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, roomFile(turn.room)), `${JSON.stringify(turn)}\n`);
  } catch {
    /* memory is best-effort; swallow */
  }
}

/**
 * Read the most recent `maxLines` turns of one (face, room) transcript, oldest→newest — so a chat
 * client can RESTORE a conversation view after the tab/app was closed. Best-effort (missing file ⇒ []).
 */
export function readRoomTail(face: string, room: string, maxLines = 200): TranscriptTurn[] {
  if (!face || !room) return [];
  return readTail(join(transcriptDir(), faceDir(face), roomFile(room)), maxLines);
}

/** Read the last `maxLines` parseable JSON lines of a file (tolerates a torn final line). */
function readTail(file: string, maxLines: number): TranscriptTurn[] {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n');
  const out: TranscriptTurn[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as TranscriptTurn);
    } catch {
      /* torn/partial line — skip */
    }
  }
  return out.reverse();
}

/** All (face, room) log files under the store. */
function listLogFiles(dir: string): string[] {
  const out: string[] = [];
  let faces: string[];
  try {
    faces = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return out;
  }
  for (const face of faces) {
    let files: string[];
    try {
      files = readdirSync(join(dir, face)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) out.push(join(dir, face, f));
  }
  return out;
}

interface CollectFilter {
  /** Keep only this face slug. */
  readonly onlyFace?: string;
  /** Keep only these face slugs (role-aware scoping). */
  readonly includeFaces?: readonly string[];
  /** Drop turns from this exact (face, room) — the caller's own live thread. */
  readonly excludeFace?: string;
  readonly excludeRoom?: string;
  /** Lines to read from each file (default 12). */
  readonly perFile?: number;
}

/** Gather turns across the store, apply filters, and return them oldest→newest. */
function collect(filter: CollectFilter): TranscriptTurn[] {
  const dir = transcriptDir();
  if (!existsSync(dir)) return [];
  const perFile = filter.perFile ?? 12;
  const turns: TranscriptTurn[] = [];
  for (const file of listLogFiles(dir)) {
    for (const t of readTail(file, perFile)) {
      if (filter.onlyFace && t.face !== filter.onlyFace) continue;
      if (filter.includeFaces && !filter.includeFaces.includes(t.face)) continue;
      if (filter.excludeFace && t.face === filter.excludeFace && t.room === filter.excludeRoom) continue;
      turns.push(t);
    }
  }
  turns.sort((a, b) => a.ts - b.ts);
  return turns;
}

/** Render one turn as a compact line: `Peh ← user: …` / `Peh →: …`. */
function formatTurn(t: TranscriptTurn, maxChars: number): string {
  const who = t.role === 'user' ? `${t.agent} ← user` : `${t.agent} →`;
  const text = t.text.length > maxChars ? `${t.text.slice(0, maxChars)}…` : t.text;
  return `${who}: ${text.replace(/\s+/g, ' ').trim()}`;
}

export interface AmbientOptions {
  /** Max turns to include (default 12). */
  readonly maxTurns?: number;
  /** Per-turn char cap before truncation (default 600). */
  readonly maxCharsPerTurn?: number;
  /** Restrict recall to these faces (role-aware scoping); default = all faces. */
  readonly includeFaces?: readonly string[];
}

/**
 * Role-aware ambient tuning. The trio is ONE agent split into focused faces to spread
 * responsibility (see the origin rationale) — so the hub sees broadly to route, while
 * specialists get a TIGHT, relevant slice and stay heads-down (never re-overloaded).
 *
 * - coordinator (Peh, the hub/router): broad — all faces, more turns.
 * - specialist  (Ptah/Luna): tight — only the hub (Peh) + this face's own other surfaces;
 *   NOT the other specialist's chatter.
 */
export function ambientProfileForRole(role: string, selfFace: string): AmbientOptions {
  if (role === 'coordinator') {
    return { maxTurns: 16, maxCharsPerTurn: 700 };
  }
  return { maxTurns: 6, maxCharsPerTurn: 400, includeFaces: ['peh', selfFace] };
}

/**
 * AMBIENT recall (injected into every turn): recent memory from everything EXCEPT the
 * caller's current live thread `(selfFace, selfRoom)` — because the session already holds
 * that. This is how a face stays aware of its OTHER surfaces (e.g. a prior Matrix chat) and
 * its OTHER faces. Returns '' when there's nothing to share (standalone build). Never throws.
 */
export function recentSharedContext(selfFace: string, selfRoom: string, opts: AmbientOptions = {}): string {
  const maxTurns = opts.maxTurns ?? 12;
  const maxChars = opts.maxCharsPerTurn ?? 600;
  try {
    const turns = collect({
      excludeFace: selfFace,
      excludeRoom: selfRoom,
      ...(opts.includeFaces ? { includeFaces: opts.includeFaces } : {}),
    }).slice(-maxTurns);
    if (turns.length === 0) return '';
    return [
      'SHARED LAB MEMORY (you are one agent with three faces — Peh, Ptah, Luna — across many surfaces; this is what was recently said elsewhere, so you can pick up where it left off):',
      ...turns.map((t) => formatTurn(t, maxChars)),
    ].join('\n');
  } catch {
    return '';
  }
}

export interface RecallOptions {
  /** Filter to one face ('peh'|'ptah'|'luna'); default = all faces. */
  readonly face?: string;
  /** Max turns returned (default 30). */
  readonly limit?: number;
  readonly maxCharsPerTurn?: number;
}

/**
 * ON-DEMAND recall (the `lab_recall_conversation` tool): deeper lookback across the shared
 * memory, optionally filtered to one face. Includes ALL surfaces (Matrix rooms included) so
 * "what did I discuss with the user on Matrix" is answerable. Returns a human-readable
 * string; never throws.
 */
export function recallConversation(opts: RecallOptions = {}): string {
  const limit = opts.limit ?? 30;
  const maxChars = opts.maxCharsPerTurn ?? 800;
  try {
    let onlyFace: string | undefined;
    if (opts.face) {
      onlyFace = faceSlug(opts.face);
      if (!FACE_SLUGS.includes(onlyFace)) return `Unknown face '${opts.face}'. Known faces: peh, ptah, luna.`;
    }
    const turns = collect({ ...(onlyFace ? { onlyFace } : {}), perFile: limit }).slice(-limit);
    if (turns.length === 0) return 'No shared lab conversation recorded yet.';
    return turns.map((t) => formatTurn(t, maxChars)).join('\n');
  } catch (e) {
    return `lab conversation recall failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

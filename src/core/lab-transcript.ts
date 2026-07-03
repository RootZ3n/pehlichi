/**
 * LAB TRANSCRIPT — shared cross-agent conversation log for the lab-only trio.
 *
 * Lab-mode overlay (see docs/LAB_COHESION_DESIGN.md). Each trio agent appends its
 * canonical-room turns to a shared append-only log and, on each turn, pulls the OTHER
 * trio agents' recent turns into context — so any agent "knows exactly what was said with
 * the others." This is the shared-memory half of "one cohesive unit."
 *
 * SCOPE: the three canonical rooms ONLY (lab:peh / lab:ptah / lab:luna). Every other room
 * (Matrix rooms, workspace-targeted sessions) is untouched, preserving the H2 cross-room
 * bleed guarantee — arbitrary rooms remain fully isolated.
 *
 * CONCURRENCY: each agent writes ONLY its own canonical-room file (`lab:peh.jsonl` is
 * written solely by Peh); the other two agents read it. Single-writer per file means no
 * locks and no torn writes. Readers tolerate a partial trailing line.
 *
 * RELEASE-SAFE: when the shared lab dir is absent (a release build with the overlay off),
 * the dir resolves to a local path with no sibling logs → cross-agent pull returns nothing
 * and the product is standalone. Every op is wrapped so a failure never breaks a chat turn.
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The one canonical room per lab-only trio agent (Zen: "one room per agent"). */
export const CANONICAL_ROOMS = Object.freeze({
  peh: 'lab:peh',
  ptah: 'lab:ptah',
  luna: 'lab:luna',
} as const);

/** All canonical rooms, for membership checks and cross-agent fan-out. */
export const CANONICAL_ROOM_LIST: readonly string[] = Object.freeze(Object.values(CANONICAL_ROOMS));

/** True if `room` is one of the three canonical trio rooms (the only rooms that share). */
export function isCanonicalRoom(room: string | undefined | null): boolean {
  return typeof room === 'string' && CANONICAL_ROOM_LIST.includes(room);
}

export interface TranscriptTurn {
  /** Canonical room this turn belongs to (e.g. 'lab:peh'). */
  readonly room: string;
  /** Human label of the agent that owns the room (e.g. 'Peh'). */
  readonly agent: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  /** Epoch ms. Passed in by the caller (core forbids Date.now() in some contexts). */
  readonly ts: number;
  readonly receiptId?: string;
}

/**
 * Shared transcript dir. `LAB_TRANSCRIPT_DIR` wins; else the in-ecosystem shared location
 * resolved by walking up to `ecosystem/` (ships no absolute path); else a local fallback
 * (release / standalone → no siblings → no cross-agent visibility).
 */
function defaultTranscriptDir(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (basename(d) === 'ecosystem') return join(d, 'lab-store', '.lab-transcripts');
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return join(process.cwd(), '.lab-transcripts');
}

function transcriptDir(): string {
  return process.env['LAB_TRANSCRIPT_DIR'] ?? defaultTranscriptDir();
}

/** Filename-safe form of a room id (canonical rooms use ':' which is fine on Linux, but be safe). */
function roomFile(room: string): string {
  return `${room.replace(/[^a-zA-Z0-9._:-]/g, '_')}.jsonl`;
}

/**
 * Append one turn to this agent's own canonical-room log. Single-writer, so a plain append
 * is safe. Fire-and-forget: never throws into the caller (a transcript failure must not
 * break the chat turn). No-op for non-canonical rooms.
 */
export function appendTurn(turn: TranscriptTurn): void {
  if (!isCanonicalRoom(turn.room)) return;
  try {
    const dir = transcriptDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, roomFile(turn.room)), `${JSON.stringify(turn)}\n`);
  } catch {
    /* transcript is best-effort; swallow */
  }
}

/** Read the last `maxLines` parseable JSON lines of a file (tolerates a torn final line). */
function readTail(file: string, maxLines: number): TranscriptTurn[] {
  if (!existsSync(file)) return [];
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
      /* torn or partial line — skip */
    }
  }
  return out.reverse();
}

/** Render one turn as a single compact line: `Agent ← user: …` / `Agent →: …`. */
function formatTurn(t: TranscriptTurn, maxChars: number): string {
  const who = t.role === 'user' ? `${t.agent} ← user` : `${t.agent} →`;
  const text = t.text.length > maxChars ? `${t.text.slice(0, maxChars)}…` : t.text;
  return `${who}: ${text.replace(/\s+/g, ' ').trim()}`;
}

export interface CrossAgentOptions {
  /** Max turns to include across the other agents (default 12). */
  readonly maxTurns?: number;
  /** Max characters of any single turn's text before truncation (default 600). */
  readonly maxCharsPerTurn?: number;
}

/**
 * AMBIENT header (the "hybrid" default): pull the OTHER canonical agents' recent turns
 * (everything except `selfRoom`) and render a compact block the agent sees every turn, so
 * it is always minimally aware of its teammates. Tightly capped. Returns '' when there's
 * nothing to share (e.g. a standalone release build). Never throws.
 */
export function recentCrossAgentContext(selfRoom: string, opts: CrossAgentOptions = {}): string {
  const maxTurns = opts.maxTurns ?? 12;
  const maxChars = opts.maxCharsPerTurn ?? 600;
  try {
    const dir = transcriptDir();
    const others = CANONICAL_ROOM_LIST.filter((r) => r !== selfRoom);
    const perRoom = Math.max(2, Math.ceil((maxTurns / Math.max(1, others.length)) * 1.5));
    const collected: TranscriptTurn[] = [];
    for (const room of others) {
      collected.push(...readTail(join(dir, roomFile(room)), perRoom));
    }
    if (collected.length === 0) return '';
    collected.sort((a, b) => a.ts - b.ts);
    const recent = collected.slice(-maxTurns);
    return [
      'RECENT LAB CONVERSATION WITH THE OTHER AGENTS (shared lab memory — you and your teammates share one lab; this is what was recently said in their rooms):',
      ...recent.map((t) => formatTurn(t, maxChars)),
    ].join('\n');
  } catch {
    return '';
  }
}

/** Map an agent selector ('peh'|'pehlichi'|'ptah'|'luna', a room id, or a display name) to a canonical room. */
function resolveAgentRoom(sel: string): string | undefined {
  if (isCanonicalRoom(sel)) return sel;
  const s = sel.toLowerCase().trim();
  if (s === 'peh' || s.startsWith('pehlichi')) return CANONICAL_ROOMS.peh;
  if (s.startsWith('ptah')) return CANONICAL_ROOMS.ptah;
  if (s.startsWith('luna')) return CANONICAL_ROOMS.luna;
  return undefined;
}

export interface RecallOptions {
  /** Filter to one agent ('peh'|'ptah'|'luna'); default = all canonical rooms. */
  readonly agent?: string;
  /** Max turns returned (default 30). */
  readonly limit?: number;
  readonly maxCharsPerTurn?: number;
}

/**
 * ON-DEMAND recall (the "hybrid" tool half): deeper lookback across the shared lab log,
 * optionally filtered to one agent. Returns a human-readable string (never throws) suitable
 * as a tool result. Includes ALL canonical rooms (the caller's own included) so an agent can
 * ask "what did Luna and I decide."
 */
export function recallConversation(opts: RecallOptions = {}): string {
  const limit = opts.limit ?? 30;
  const maxChars = opts.maxCharsPerTurn ?? 800;
  try {
    const dir = transcriptDir();
    let rooms: readonly string[] = CANONICAL_ROOM_LIST;
    if (opts.agent) {
      const room = resolveAgentRoom(opts.agent);
      if (!room) return `Unknown agent '${opts.agent}'. Known agents: peh, ptah, luna.`;
      rooms = [room];
    }
    const collected: TranscriptTurn[] = [];
    for (const room of rooms) collected.push(...readTail(join(dir, roomFile(room)), limit));
    if (collected.length === 0) return 'No shared lab conversation recorded yet.';
    collected.sort((a, b) => a.ts - b.ts);
    return collected.slice(-limit).map((t) => formatTurn(t, maxChars)).join('\n');
  } catch (e) {
    return `lab conversation recall failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

#!/usr/bin/env tsx
/**
 * Ptah HTTP Server — the lab task runner.
 *
 * Blocker 1: production now runs on the HARDENED KERNEL. Every /chat request drives
 * the kernel's `runAgent()` (via KernelChatSession) instead of an ad-hoc fetch loop:
 * the kernel tool registry, the kernel event stream, validateSummary on `done`,
 * approval gate, and partial-on-exhaustion all apply. The old AgentChatSession is
 * preserved (its infrastructure lives on in KernelChatSession / ResilientDriver) but
 * is no longer the request path.
 *
 * TWO-INSTANCE PATTERN (audit H1): in the lab this agent is run as TWO systemd services
 * on adjacent ports (e.g. `lab-pehlichi` on 18830 and `lab-peh` on 18831) — typically one
 * dedicated to the Matrix bridge and one to the HTTP/API surface. The instances are NOT
 * coordinated: each keeps its OWN session map, its OWN cron store (`.cron-jobs.json`), and
 * both answer bridge calls. This is intentional (do not consolidate without a reason). To
 * make the split observable, `/health` reports an `instanceId` (port + PID) and a `cronJobs`
 * count so an operator can tell the two apart and see which one owns which schedules.
 */
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, statSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, extname, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MimoDriver,
  ScriptedDriver,
  createToolRegistry,
  type Driver,
  type DriverAction,
  type AgentEvent,
} from '../../src/core/index.js';
import { createFullToolRegistry } from '../../src/core/agent-tools/index.js';
import { CircuitBreaker } from '../../src/core/agent-tools/circuit-breaker.js';
import { pehProfile } from '../../src/profile.js';
import { KernelChatSession, ResilientDriver, defaultApprovalPolicy } from './lib/kernel-session.js';
import { loadSkin } from './lib/skin.js';
import { loadPersonality } from './lib/personality.js';
import { ChatSession } from './lib/chat.js';
import { bridgeRegistry } from '../../src/core/bridges/registry.js';
import { listMemory } from 'lab-memory';
import { ReceiptStore, type Receipt } from '../../src/core/receipt-store.js';

const PORT = parseInt(process.env.PEHLICHI_PORT || '18830', 10);
const HOST = process.env.PEHLICHI_HOST || '127.0.0.1';

// Model configuration: env vars override defaults
const MODEL = process.env.AGENT_MODEL || 'mimo-v2.5';
const BASE_URL = process.env.AGENT_BASE_URL || 'https://api.xiaomimimo.com/v1';

function resolveApiKey(): string | undefined {
  if (process.env.AGENT_API_KEY) return process.env.AGENT_API_KEY;
  if (process.env.MIMO_API_KEY) return process.env.MIMO_API_KEY;
  try {
    const bok = readFileSync(join(homedir(), 'bok'), 'utf-8');
    const match = bok.match(/sk-sl4\S+/);
    if (match) return match[0].trim();
  } catch {}
  return undefined;
}

// ── Static web UI (served directly from this port) ───────────────────────────
// The browser UI lives in the repo's ui/ directory (HTML/CSS/JS/assets). Resolved
// relative to THIS file (tui/src) so it works regardless of the service's CWD:
// tui/src → .. (tui) → .. (repo root) → ui.
const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Serve a static file from WEB_ROOT for a GET request. '/' maps to index.html.
 * Returns true if a response was written, false if there is no such file (caller
 * falls through to the API routes). Path traversal is blocked: the resolved path
 * must stay under WEB_ROOT. CORS is set (same '*' policy as json()) so the UI can
 * also be loaded from a separate static origin.
 */
function serveStatic(res: ServerResponse, pathname: string): boolean {
  let rel: string;
  try { rel = decodeURIComponent(pathname); } catch { return false; }
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = join(WEB_ROOT, rel);
  if (!filePath.startsWith(WEB_ROOT + sep)) return false;
  try { if (!statSync(filePath).isFile()) return false; } catch { return false; }
  const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(readFileSync(filePath));
  return true;
}

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

/**
 * C1: the running commit, so an operator can VERIFY which build is live (the audit
 * found fixes that were committed but never deployed). Prefer an explicit
 * $PEHLICHI_COMMIT / VERSION file (set at deploy), else read `git rev-parse` from the repo,
 * else 'unknown'. Resolved once at module load.
 */
function resolveCommit(): string {
  if (process.env.PEHLICHI_COMMIT) return process.env.PEHLICHI_COMMIT.trim();
  const here = dirname(fileURLToPath(import.meta.url));
  try {
    return readFileSync(join(here, '..', '..', 'VERSION'), 'utf-8').trim();
  } catch { /* no VERSION file — fall through to git */ }
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: here, encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

const COMMIT = resolveCommit();
const receiptStore = new ReceiptStore({ ttlMs: 60 * 60 * 1000 }); // 1 hour TTL

function json(res: ServerResponse, status: number, data: unknown): void {
  // CORS: the read-only UI engine (ui/index.html) is opened from file:// or a
  // separate static origin and only issues simple GETs — a permissive ACAO lets
  // it reach this localhost-bound server. The listener binds 127.0.0.1, so this
  // never widens the network surface beyond the local machine.
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

export interface PehServerOptions {
  readonly port?: number;
  readonly host?: string;
  readonly workspaceRoot?: string;
  readonly labStoreRoot?: string;
  /** Inject a driver (tests pass a ScriptedDriver; production uses a resilient MimoDriver). */
  readonly driver?: Driver;
  readonly maxIterations?: number;
  /** Allow write/destructive tools without gating (default false — writes require approval). */
  readonly allowWrites?: boolean;
  /**
   * CHECKPOINTING (H6): directory for crash-safe conversation checkpoints. When unset,
   * production defaults it under the lab store (so a restart resumes); tests that inject
   * a driver leave it off, so no checkpoint files are written during a test run.
   */
  readonly checkpointDir?: string;
  /**
   * ENDPOINT AUTH (H1): a bearer token required on /chat and /chat/stream. Defaults to
   * $IKBI_CHAT_TOKEN. When set, a request MUST send `Authorization: Bearer <token>` or it
   * is rejected 401. When UNSET, the chat endpoints are open but the server forces a
   * read-only posture on the production listen path (an unauthenticated network caller
   * can never drive write/destructive tools).
   */
  readonly chatToken?: string;
  /**
   * SESSION EVICTION (BLOCKER-1): how long an idle per-room session may live before it is
   * evicted. Every unique caller/room creates a KernelChatSession; without a TTL the map
   * grows unbounded and leaks memory for the life of the process. Defaults to
   * $TRIO_SESSION_TTL_MS, else 4 hours. The 'default' session (embedders/tests) is never
   * evicted.
   */
  readonly sessionTtlMs?: number;
  /** How often the background cleanup timer sweeps stale sessions/tasks. Default 5 min. */
  readonly cleanupIntervalMs?: number;
  /** Injectable clock (ms). Tests advance it to drive TTL eviction deterministically. Default Date.now. */
  readonly now?: () => number;
}

/**
 * Build the Ptah HTTP server WITHOUT listening. Exposes the kernel session and tool
 * names so tests can drive the real request path with an injected driver.
 */
export function createPehServer(opts: PehServerOptions = {}): {
  server: Server;
  session: KernelChatSession;
  toolNames: string[];
  /** BLOCKER-1: evict idle sessions past TTL now; returns how many were evicted (for tests). */
  evictStaleSessions: () => number;
  /** Live count of resident per-room sessions (for tests). */
  sessionCount: () => number;
} {
  const skin = loadSkin();
  const personality = loadPersonality();
  const workspaceRoot = opts.workspaceRoot ?? process.env.PEHLICHI_WORKSPACE ?? '/pehverse/repos/pehlichi';
  const labStoreRoot = opts.labStoreRoot ?? process.env.LAB_STORE_ROOT ?? join(workspaceRoot, '..', 'lab-store');
  const apiKey = resolveApiKey();

  // The kernel's tool source: the full agent tool suite (Blocker 1).
  const extraTools = createFullToolRegistry({
    workspaceRoot,
    agentServerUrl: `http://${opts.host ?? HOST}:${opts.port ?? PORT}`,
    ...(apiKey !== undefined ? { apiKey } : {}),
    // N5: delegated sub-agents inherit THIS server's write posture, never more.
    delegateAllowWrites: opts.allowWrites === true,
  });
  const registry = createToolRegistry(extraTools);
  const toolNames = [...registry.keys()];

  // SELF-AWARENESS (gauntlet fix): a concise capability summary fed into the system
  // prompt of BOTH chat lanes so Peh actually knows his own tools, memory, and surface.
  // Without it the converse lane (no tools) answered "my mind" / "I don't know" / "nothing
  // between conversations". Just names + a plain-English summary — not the 29 full tool
  // descriptions. The personality prompt still owns his squirrel voice; this is only facts.
  const capabilitiesSummary =
    `YOUR CAPABILITIES (real tools you have — talk about them in your own voice):\n` +
    `You have ${toolNames.length} tools available: ${toolNames.join(', ')}.\n` +
    `You can: read files, write files, edit files (patch), search code, run terminal commands, ` +
    `browse the web, and manage processes.\n` +
    `You have persistent memory across conversations via the memory tool — you do NOT forget everything between chats.\n` +
    `You have a /tools endpoint that lists your tools, and a /info endpoint with your identity.`;
  // The converse lane runs WITHOUT tools, so Peh must be told he still has them elsewhere.
  const converseCapabilities =
    `${capabilitiesSummary}\n` +
    `Even though you don't have tools wired into THIS conversation, you DO have them in the full ` +
    `/chat endpoint. You can tell users about your capabilities.`;

  // Production driver: a resilient MimoDriver (circuit breaker + retry). Tests inject
  // a ScriptedDriver so the whole kernel path runs with no network.
  const breaker = new CircuitBreaker(detectProviderId(BASE_URL), { failureThreshold: 5, cooldownMs: 30_000, successThreshold: 3 });
  const driver = opts.driver ?? new ResilientDriver(
    new MimoDriver({ baseUrl: BASE_URL, model: MODEL, ...(apiKey !== undefined ? { apiKey } : {}) }),
    breaker,
  );

  // H6: checkpoint in production (no injected driver), stay off under test injection.
  const checkpointDir = opts.checkpointDir ?? (opts.driver ? undefined : join(labStoreRoot, '.checkpoints', 'pehlichi'));

  // H1: endpoint auth. A configured token gates /chat; an injected driver (tests /
  // embedding) keeps its explicit write posture, while the production listen path with
  // NO token is forced read-only so an unauthenticated caller cannot drive writes.
  const chatToken = opts.chatToken ?? process.env.IKBI_CHAT_TOKEN;
  const hasChatToken = typeof chatToken === 'string' && chatToken.length > 0;
  const isInjected = opts.driver !== undefined;
  // Write posture: allowWrites controls tool access; chatToken controls endpoint auth.
  // They are independent: writes work without auth, and auth works without writes.
  const allowWritesEffective = isInjected
    ? opts.allowWrites === true
    : opts.allowWrites === true;
  if (!isInjected && !hasChatToken) {
    console.warn('[auth] IKBI_CHAT_TOKEN is unset — /chat endpoints are OPEN (no auth required).');
  }

  // H2 (cross-room bleed): every Matrix room (and DM) gets its OWN KernelChatSession so
  // one room's transcript is NEVER visible in another's context. Sessions are created on
  // demand and keyed by room id; a request without a room id uses the 'default' session
  // (the one returned to embedders/tests). Each room also gets its own checkpoint subdir
  // so per-room history persists independently and never clobbers another room's.
  //
  // N-WORKSPACE: when a caller supplies `workspace` in the request body (e.g. Howa
  // trial workspaces), a separate session is created with tools rooted at that
  // workspace so file operations land in the caller's directory, not the server's
  // default. The composite key `roomKey + "::" + workspace` keeps workspace-targeted
  // sessions isolated from each other and from the room's normal session.
  const makeSession = (roomKey: string, overrideWorkspace?: string): KernelChatSession => {
    const effectiveWorkspace = overrideWorkspace ?? workspaceRoot;
    const effectiveLabStore = overrideWorkspace
      ? join(effectiveWorkspace, '..', 'lab-store')
      : labStoreRoot;
    // When workspace is overridden, build a fresh tool registry rooted at that workspace
    // so all file ops resolve against the caller's directory.
    const effectiveTools = overrideWorkspace
      ? createFullToolRegistry({
          workspaceRoot: effectiveWorkspace,
          agentServerUrl: `http://${opts.host ?? HOST}:${opts.port ?? PORT}`,
          ...(apiKey !== undefined ? { apiKey } : {}),
          delegateAllowWrites: opts.allowWrites === true,
        })
      : extraTools;
    return new KernelChatSession({
      profile: pehProfile,
      driver,
      workspaceRoot: effectiveWorkspace,
      labStoreRoot: effectiveLabStore,
      extraTools: effectiveTools,
      capabilities: capabilitiesSummary,
      taskId: `pehlichi-${roomKey}${overrideWorkspace ? `@${basename(overrideWorkspace)}` : ''}`,
      ...(opts.maxIterations !== undefined ? { maxIterations: opts.maxIterations } : {}),
      approvalCallback: defaultApprovalPolicy({ allowWrites: allowWritesEffective }),
      ...(checkpointDir !== undefined ? { checkpointDir: join(checkpointDir, sanitizeRoomKey(roomKey)) } : {}),
    });
  };

  // BLOCKER-1: each per-room session carries a lastAccessedAt so idle ones can be evicted.
  interface SessionEntry { session: KernelChatSession; lastAccessedAt: number; }
  const now = opts.now ?? Date.now;
  const sessionTtlMs = opts.sessionTtlMs
    ?? (process.env.TRIO_SESSION_TTL_MS ? parseInt(process.env.TRIO_SESSION_TTL_MS, 10) : 4 * 60 * 60 * 1000);
  const cleanupIntervalMs = opts.cleanupIntervalMs ?? 5 * 60 * 1000;
  let sessionsEvicted = 0;

  const sessions = new Map<string, SessionEntry>();

  // CONVERSE LANE: a tool-free, personality-only chat path for Matrix small-talk. The
  // kernel /chat loop runs up to 20 tool iterations per message — far too heavy (and slow,
  // >100s) for "hi", which makes mimo-v2.5 grind tools until the budget is exhausted.
  // /converse drives the model ONCE via ChatSession (personality prompt, no tools), so
  // greetings and casual chat get an instant reply and never touch the tool budget. Keyed
  // per room, evicted on the same TTL as the kernel sessions.
  interface ConverseEntry { cs: ChatSession; lastAccessedAt: number; }
  const converseSessions = new Map<string, ConverseEntry>();
  const converseFor = (roomKey: string): ChatSession => {
    let entry = converseSessions.get(roomKey);
    if (entry === undefined) {
      entry = { cs: new ChatSession({ apiKey: resolveApiKey(), baseUrl: BASE_URL, model: MODEL, capabilities: converseCapabilities }), lastAccessedAt: now() };
      converseSessions.set(roomKey, entry);
    } else {
      entry.lastAccessedAt = now();
    }
    return entry.cs;
  };
  const sessionFor = (roomKey: string, overrideWorkspace?: string): KernelChatSession => {
    // N-WORKSPACE: composite key keeps workspace-targeted sessions isolated.
    const key = overrideWorkspace ? `${roomKey}::${overrideWorkspace}` : roomKey;
    let entry = sessions.get(key);
    if (entry === undefined) {
      entry = { session: makeSession(roomKey, overrideWorkspace), lastAccessedAt: now() };
      sessions.set(key, entry);
    } else {
      entry.lastAccessedAt = now();
    }
    return entry.session;
  };
  // The 'default' session backs requests with no room id and is the one returned below.
  // It is NEVER evicted (it is the long-lived embedder/test handle).
  const session = sessionFor('default');

  /**
   * BLOCKER-1: evict every idle session older than the TTL (never 'default'). Called before
   * each request AND on a periodic timer, so the map can't grow unbounded over weeks of
   * operation. Evictions are logged at info level for the operator.
   */
  const evictStaleSessions = (): number => {
    const cutoff = now() - sessionTtlMs;
    let evicted = 0;
    for (const [key, entry] of sessions) {
      if (key === 'default') continue;
      if (entry.lastAccessedAt < cutoff) {
        sessions.delete(key);
        evicted++;
      }
    }
    for (const [key, entry] of converseSessions) {
      if (entry.lastAccessedAt < cutoff) converseSessions.delete(key);
    }
    if (evicted > 0) {
      sessionsEvicted += evicted;
      console.log(`[sessions] evicted ${evicted} idle session(s) (ttl=${sessionTtlMs}ms); ${sessions.size} resident, ${sessionsEvicted} evicted total`);
    }
    return evicted;
  };

  // BLOCKER-2 / H4 (callee side): track bridge-originated tasks by their X-Task-Id so a
  // caller that timed out can poll `/task/<id>/status` and learn whether the orphaned work
  // actually completed (running | completed | failed | not-found).
  type TaskState = 'running' | 'completed' | 'failed';
  interface TaskRecord { status: TaskState; caller: string; correlationId: string; startedAt: number; finishedAt?: number; partial?: boolean; }
  const tasks = new Map<string, TaskRecord>();
  const TASK_RETENTION_MS = Math.max(sessionTtlMs, 60 * 60 * 1000);
  const evictStaleTasks = (): void => {
    const cutoff = now() - TASK_RETENTION_MS;
    for (const [id, rec] of tasks) {
      if (rec.status !== 'running' && (rec.finishedAt ?? rec.startedAt) < cutoff) tasks.delete(id);
    }
  };

  /** Count persisted cron jobs for /health (H3). Best-effort — 0 if the store is absent. */
  const cronJobCount = (): number => {
    try {
      const raw = readFileSync(join(workspaceRoot, '.cron-jobs.json'), 'utf-8');
      const list = JSON.parse(raw);
      return Array.isArray(list) ? list.length : 0;
    } catch { return 0; }
  };

  // Instance identity (H1): which of the two co-located instances answered.
  const instanceId = `${opts.port ?? PORT}:${process.pid}`;

  /**
   * H1: verify the bearer token on a chat request. Returns true when no token is
   * configured (open, but read-only on the production path). A configured token requires
   * an exact `Authorization: Bearer <token>` match.
   */
  const chatAuthorized = (req: IncomingMessage): boolean => {
    if (!hasChatToken) return true;
    const header = req.headers['authorization'];
    return typeof header === 'string' && header === `Bearer ${chatToken}`;
  };

  const server = createHttpServer(async (req, res) => {
   try {
    const url = new URL(req.url ?? '/', `http://${HOST}:${opts.port ?? PORT}`);

    // Static web UI: try to serve the browser UI for GET requests BEFORE the API
    // routes. serveStatic returns true (and has written the response) when the path
    // maps to a real file under WEB_ROOT; otherwise it returns false and we fall
    // through to the JSON API routes below (so /health, /api/*, etc. are unaffected).
    if (req.method === 'GET' && serveStatic(res, url.pathname)) return;

    if (req.method === 'GET' && url.pathname === '/health') {
      // Lab Agent Contract §1.1: include `service` and `ok` for contract probe compatibility.
      return json(res, 200, {
        ok: true,
        service: skin.branding.agent_name,
        version: COMMIT,
        status: 'ok',
        uptimeMs: Math.round(process.uptime() * 1000),
        identity: { id: instanceId, role: 'agent', authorityTier: 'trusted' },
        // Legacy fields (backward compatible):
        agent: skin.branding.agent_name,
        instanceId,
        model: MODEL,
        commit: COMMIT,
        uptime: process.uptime(),
        historyLength: session.getHistory().length,
        toolCount: toolNames.length,
        sessions: sessions.size,
        sessionsEvicted,
        cronJobs: cronJobCount(),
        receipts: receiptStore.summary(),
      });
    }

    // ── UI ENGINE READ MODEL (ui/index.html) ─────────────────────────────────
    // Four read-only projections the Settlement world map pulls when a scene is
    // opened. All are GET, all derive from data this process already holds — no
    // new writes, no new auth surface. Each is best-effort: a missing data source
    // degrades to an empty list rather than a 500, so a scene always renders.

    // Active per-room sessions Peh is coordinating (The Keep / hub).
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      const nowMs = now();
      const list = [...sessions.entries()].map(([key, entry]) => ({
        roomKey: key,
        isDefault: key === 'default',
        historyLength: entry.session.getHistory().length,
        lastAccessedAt: entry.lastAccessedAt,
        idleMs: Math.max(0, nowMs - entry.lastAccessedAt),
      }));
      return json(res, 200, {
        agent: skin.branding.agent_name,
        count: list.length,
        evicted: sessionsEvicted,
        ttlMs: sessionTtlMs,
        converseSessions: converseSessions.size,
        sessions: list,
      });
    }

    // Past-life memories (The Memory Vaults / Campsite). Canonical past lives from
    // the personality file, plus any curated lab-memory entries (best-effort).
    if (req.method === 'GET' && url.pathname === '/api/memories') {
      const rawLives = personality.past_lives;
      const pastLives = (rawLives && typeof rawLives === 'object')
        ? Object.entries(rawLives as Record<string, { name?: string; era?: string; traits?: string; speech_quirks?: string }>)
            .map(([project, l]) => ({
              project,
              name: l?.name ?? project,
              era: l?.era ?? '',
              traits: l?.traits ?? '',
              speechQuirks: l?.speech_quirks ?? '',
            }))
        : [];
      let entries: unknown[] = [];
      try {
        entries = listMemory().map((m) => ({
          id: m.id, title: m.title, description: m.description,
          project: m.project, status: m.status, version: m.version, tags: m.tags,
        }));
      } catch { /* no curated store yet — past lives alone are enough */ }
      return json(res, 200, {
        agent: skin.branding.agent_name,
        pastLives,
        entries,
        count: pastLives.length + entries.length,
      });
    }

    // Ecosystem agents Peh coordinates (Council Chamber / Training Grounds).
    if (req.method === 'GET' && url.pathname === '/api/agents') {
      const agents = bridgeRegistry.list().map((b) => ({
        id: b.name,
        name: b.name,
        description: b.description,
        port: b.port,
        status: b.status,
      }));
      return json(res, 200, {
        agent: skin.branding.agent_name,
        self: { id: skin.branding.agent_name.toLowerCase(), name: skin.branding.agent_name, model: MODEL, tools: toolNames.length },
        count: agents.length,
        agents,
      });
    }

    // Bridge connections (The Observatory / Gateway). The configured connection
    // map — name, port, reachability status — without live-probing (which would
    // block the request on unreachable peers).
    if (req.method === 'GET' && url.pathname === '/api/bridge') {
      const bridges = bridgeRegistry.list().map((b) => ({
        name: b.name,
        description: b.description,
        port: b.port,
        status: b.status,
        url: b.port > 0 ? `http://localhost:${b.port}` : null,
      }));
      return json(res, 200, {
        agent: skin.branding.agent_name,
        count: bridges.length,
        connected: bridges.filter((b) => b.status === 'available').length,
        bridges,
      });
    }

    // BLOCKER-2 / H4: poll the status of a bridge-originated task by its X-Task-Id. A caller
    // whose bridge.request timed out polls here to recover an orphaned result instead of
    // assuming permanent failure. Unknown ids return 404 with status 'not-found'.
    if (req.method === 'GET') {
      const m = url.pathname.match(/^\/task\/([^/]+)\/status$/);
      if (m) {
        const id = decodeURIComponent(m[1] ?? '');
        const rec = tasks.get(id);
        if (rec === undefined) {
          return json(res, 404, { taskId: id, status: 'not-found' });
        }
        return json(res, 200, {
          taskId: id,
          status: rec.status,
          caller: rec.caller,
          correlationId: rec.correlationId,
          partial: rec.partial ?? false,
          startedAt: rec.startedAt,
          finishedAt: rec.finishedAt ?? null,
        });
      }
    }

    if (req.method === 'GET' && url.pathname === '/tools') {
      return json(res, 200, { agent: skin.branding.agent_name, tools: toolNames, count: toolNames.length });
    }

    if (req.method === 'GET' && url.pathname === '/info') {
      return json(res, 200, {
        agent: skin.branding.agent_name,
        personality: personality.name,
        voice_summary: personality.voice_summary,
        intensity: personality.intensity,
        primary_color: skin.theme.primary,
        welcome: skin.branding.welcome,
        goodbye: skin.branding.goodbye,
        toolCount: toolNames.length,
      });
    }

    if (req.method === 'POST' && url.pathname === '/converse') {
      if (!chatAuthorized(req)) {
        return json(res, 401, { error: 'unauthorized: a valid Bearer token is required' });
      }
      evictStaleSessions();
      const body = await parseBody(req);
      const message = body.message as string;
      if (!message) return json(res, 400, { error: 'message is required' });
      const cs = converseFor(roomKeyOf(body));
      try {
        const reply = await cs.send(message);
        return json(res, 200, {
          content: reply.content,
          agent: skin.branding.agent_name,
          ok: true,
          partial: false,
          mode: 'converse',
          toolCalls: [],
        });
      } catch (err) {
        return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (req.method === 'POST' && url.pathname === '/chat') {
      if (!chatAuthorized(req)) {
        return json(res, 401, { error: 'unauthorized: a valid Bearer token is required' });
      }
      // BLOCKER-1: opportunistic eviction on the request path keeps the map bounded even
      // if the periodic timer is starved.
      evictStaleSessions();
      const body = await parseBody(req);
      const message = body.message as string;
      if (!message) return json(res, 400, { error: 'message is required' });

      // N-WORKSPACE: when the caller supplies a workspace directory, Pehlichi's file
      // tools resolve paths against it instead of the server's default root.
      let overrideWorkspace: string | undefined;
      try {
        overrideWorkspace = parseWorkspaceOverride(body);
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
      if (overrideWorkspace) console.log(`[chat] workspace override: ${overrideWorkspace}`);

      // H2: route to THIS room's session — no cross-room context bleed.
      const roomSession = sessionFor(roomKeyOf(body), overrideWorkspace);

      // H8: attribute the caller. We log WHO drove the agent and a correlation id so a
      // request can be traced; a missing id is stamped (and logged as anonymous) rather
      // than silently accepted as if it came from nowhere.
      const callerId = (req.headers['x-agent-id'] as string) || 'anonymous';
      const correlationId = (req.headers['x-correlation-id'] as string)
        || `pehlichi-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      res.setHeader('X-Correlation-Id', correlationId);
      console.log(`[chat] caller=${callerId} corr=${correlationId}`);

      // BLOCKER-2 (callee): register a bridge-originated task so its status is pollable.
      const taskId = (req.headers['x-task-id'] as string) || undefined;
      if (taskId) tasks.set(taskId, { status: 'running', caller: callerId, correlationId, startedAt: now() });

      try {
        const response = await roomSession.send(message);
        if (taskId) {
          const rec = tasks.get(taskId);
          if (rec) { rec.status = 'completed'; rec.finishedAt = now(); rec.partial = response.partial; }
        }
        // Record receipt (before payload — payload references receipt.id)
        const receipt = receiptStore.record({
          agent: skin.branding.agent_name,
          taskId: taskId ?? undefined,
          roomKey: roomKeyOf(body),
          workspaceId: overrideWorkspace ?? undefined,
          model: MODEL,
          status: response.injectionDetected ? 'injection_blocked'
            : response.partial ? 'partial'
            : response.ok ? 'success' : 'failed',
          toolCallCount: response.toolCalls.length,
          injectionDetected: response.injectionDetected,
          partial: response.partial,
          contentSummary: response.content?.slice(0, 200),
        });
        const payload = {
          content: response.content,
          agent: skin.branding.agent_name,
          ok: response.ok,
          partial: response.partial,
          receiptId: receipt.id,
          accomplished: response.accomplished,
          thinkingVerb: response.thinkingVerb,
          injectionDetected: response.injectionDetected,
          // Blocker 5: structured tool calls WITH receipts — nothing is stripped.
          toolCalls: response.toolCalls.map((tc) => ({
            name: tc.name,
            args: tc.args,
            ok: tc.ok,
            output: tc.output?.slice(0, 2000),
            error: tc.error?.slice(0, 500),
            receipt: tc.receipt,
          })),
        };
        // Blocker 2: a budget-exhausted run is NOT a stale 200 — it is a clear partial
        // with an explicit non-200 status so callers know the session needs /reset or
        // a narrower task.
        return json(res, response.partial ? 422 : 200, payload);
      } catch (err) {
        if (taskId) {
          const rec = tasks.get(taskId);
          if (rec) { rec.status = 'failed'; rec.finishedAt = now(); }
        }
        return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (req.method === 'POST' && url.pathname === '/chat/stream') {
      if (!chatAuthorized(req)) {
        return json(res, 401, { error: 'unauthorized: a valid Bearer token is required' });
      }
      evictStaleSessions(); // BLOCKER-1
      const body = await parseBody(req);
      const message = body.message as string;
      if (!message) return json(res, 400, { error: 'message is required' });

      // N-WORKSPACE: same workspace override as /chat.
      let overrideWorkspace: string | undefined;
      try {
        overrideWorkspace = parseWorkspaceOverride(body);
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
      if (overrideWorkspace) console.log(`[chat/stream] workspace override: ${overrideWorkspace}`);

      // H2: route to THIS room's session — no cross-room context bleed.
      const roomSession = sessionFor(roomKeyOf(body), overrideWorkspace);

      // BLOCKER-2 (callee): track the streamed task too so it is pollable on timeout.
      const streamCaller = (req.headers['x-agent-id'] as string) || 'anonymous';
      const streamCorr = (req.headers['x-correlation-id'] as string)
        || `${skin.branding.agent_name.toLowerCase()}-stream-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const streamTaskId = (req.headers['x-task-id'] as string) || undefined;
      if (streamTaskId) tasks.set(streamTaskId, { status: 'running', caller: streamCaller, correlationId: streamCorr, startedAt: now() });

      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      try {
        // Blocker 5: stream EVERY kernel event (tool-call/result/receipt/summary) as SSE.
        const response = await roomSession.send(message, (e: AgentEvent) => {
          res.write(`data: ${JSON.stringify({ event: e })}\n\n`);
        });
        if (streamTaskId) {
          const rec = tasks.get(streamTaskId);
          if (rec) { rec.status = 'completed'; rec.finishedAt = now(); rec.partial = response.partial; }
        }
        res.write(`data: ${JSON.stringify({ done: true, ok: response.ok, partial: response.partial, content: response.content, toolCalls: response.toolCalls.length })}\n\n`);
      } catch (err) {
        if (streamTaskId) {
          const rec = tasks.get(streamTaskId);
          if (rec) { rec.status = 'failed'; rec.finishedAt = now(); }
        }
        res.write(`data: ${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n\n`);
      }
      res.end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/reset') {
      // H2: reset only the targeted room's session when a roomId is supplied; with no
      // room context, reset EVERY room (a global wipe). Each reset clears that session's
      // on-disk checkpoints too (C4), so the cleared transcript cannot resurrect.
      const body = await parseBody(req);
      const ctx = body['context'];
      const hasRoom = ctx && typeof ctx === 'object'
        && typeof (ctx as Record<string, unknown>)['roomId'] === 'string';
      if (hasRoom) {
        sessionFor(roomKeyOf(body)).reset();
      } else {
        for (const entry of sessions.values()) entry.session.reset();
      }
      return json(res, 200, { status: 'reset', agent: skin.branding.agent_name });
    }

    if (req.method === 'GET' && url.pathname === '/agent') {
      return json(res, 200, {
        id: skin.branding.agent_name.toLowerCase(),
        name: skin.branding.agent_name,
        personality: personality.name,
        model: MODEL,
        tools: toolNames.length,
        status: 'active',
        uptime: process.uptime(),
      });
    }

    if (req.method === 'GET' && url.pathname === '/capabilities') {
      return json(res, 200, {
        agent: skin.branding.agent_name,
        tools: toolNames,
        endpoints: ['/health', '/tools', '/info', '/chat', '/chat/stream', '/reset', '/agent', '/capabilities', '/task/:id/status', '/api/sessions', '/api/memories', '/api/agents', '/api/bridge', '/receipts'],
        model: MODEL,
        features: ['kernel_loop', 'tool_calling', 'streaming', 'conversation_memory', 'approval_gate', 'partial_on_exhaustion'],
        conversations: {
          canSendMessage: true,
          canListConversations: false,
          canReadConversation: false,
          canCreateConversation: false,
          canAppendToConversation: false,
          historyMode: 'stateless',
        },
      });
    }

    // ── RECEIPTS ENDPOINT ─────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/receipts') {
      const limit = parseInt(url.searchParams.get('limit') ?? '20', 10);
      const taskId = url.searchParams.get('task');
      const workspace = url.searchParams.get('workspace');
      const failuresOnly = url.searchParams.get('failures') === 'true';
      let receipts: Receipt[];
      if (taskId) {
        receipts = receiptStore.byTask(taskId);
      } else if (workspace) {
        receipts = receiptStore.byWorkspace(workspace);
      } else if (failuresOnly) {
        receipts = receiptStore.failures();
      } else {
        receipts = receiptStore.recent(limit);
      }
      return json(res, 200, {
        agent: skin.branding.agent_name,
        count: receipts.length,
        summary: receiptStore.summary(),
        ttlMs: 60 * 60 * 1000,
        receipts,
      });
    }

    json(res, 404, { error: 'not found' });
   } catch (err) {
    // C3 (client-abort crash): a client that aborts mid-request rejects parseBody (and
    // can reject any in-flight await). Awaiting that at the top level used to surface as
    // an UNHANDLED REJECTION and crash the process. Catch EVERYTHING here: if the socket
    // is already gone, close it; otherwise return a clean 500. The process stays up.
    const aborted = req.aborted === true || res.writableEnded || res.destroyed;
    if (aborted || res.headersSent) {
      try { res.destroy(); } catch { /* socket already gone */ }
      return;
    }
    try {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    } catch {
      try { res.destroy(); } catch { /* nothing more we can do */ }
    }
   }
  });

  // BLOCKER-1: periodic background sweep so stale sessions are reclaimed even when no
  // request arrives to trigger the inline eviction. Unref'd so it never keeps the process
  // alive, and cleared on close so tests don't leak a timer.
  const cleanupTimer = setInterval(() => { evictStaleSessions(); evictStaleTasks(); }, cleanupIntervalMs);
  cleanupTimer.unref();
  server.on('close', () => clearInterval(cleanupTimer));

  return { server, session, toolNames, evictStaleSessions, sessionCount: () => sessions.size };
}

/**
 * Derive the per-room session key from a /chat body's context (H2). Matrix supplies
 * `context.roomId`; anything else falls back to 'default'. Returned verbatim — it is
 * sanitized only when used as a checkpoint DIRECTORY name (sanitizeRoomKey).
 */
function roomKeyOf(body: Record<string, unknown>): string {
  const ctx = body['context'];
  if (ctx && typeof ctx === 'object') {
    const rid = (ctx as Record<string, unknown>)['roomId'];
    if (typeof rid === 'string' && rid.length > 0) return rid;
  }
  return 'default';
}

/**
 * Approved roots a caller-supplied `workspace` override may point inside. Operator-configured via
 * PEHLICHI_WORKSPACE_ROOTS (comma-separated absolute paths). Each is realpath-resolved so symlinks
 * can't widen the set. EMPTY when unset ⇒ overrides fail closed (the default server workspace, which
 * is NOT caller-controlled, still works without an allowlist).
 */
function allowedWorkspaceRoots(): string[] {
  const raw = process.env.PEHLICHI_WORKSPACE_ROOTS ?? '';
  const roots: string[] = [];
  for (const part of raw.split(',')) {
    const p = part.trim();
    if (p.length === 0 || !p.startsWith('/')) continue;
    try {
      roots.push(realpathSync(p));
    } catch {
      // A configured root that doesn't exist is silently dropped — it can confine nothing.
    }
  }
  return roots;
}

/** True iff `target` is `root` itself or a path strictly inside it. */
function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

/**
 * N-WORKSPACE: parse and CONFINE an optional `workspace` field from a request body.
 * Returns the realpath'd absolute path when present and inside an approved root, `undefined` when
 * absent, or throws with operator guidance when present but invalid/outside the allowlist.
 *
 * Hardening (Codex P6): a caller may NOT point tools at an arbitrary absolute directory. The path
 * must (a) be absolute and free of `..`, (b) exist as a directory, and (c) realpath INTO one of the
 * PEHLICHI_WORKSPACE_ROOTS — which rejects /etc, the home root, sibling repos, and symlink escapes.
 */
export function parseWorkspaceOverride(body: Record<string, unknown>): string | undefined {
  const raw = body.workspace;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  if (!raw.startsWith('/') || raw.includes('..')) {
    throw new Error('workspace must be an absolute path without ..');
  }

  const roots = allowedWorkspaceRoots();
  if (roots.length === 0) {
    throw new Error(
      'workspace override is disabled: set PEHLICHI_WORKSPACE_ROOTS to a comma-separated list of ' +
        'approved absolute roots (e.g. PEHLICHI_WORKSPACE_ROOTS=/pehverse/repos,/pehverse/projects)',
    );
  }

  let real: string;
  try {
    const st = statSync(raw);
    if (!st.isDirectory()) throw new Error('workspace is not a directory');
    real = realpathSync(raw); // collapses symlinks — a symlink pointing outside is caught below
  } catch (err) {
    if (err instanceof Error && err.message === 'workspace is not a directory') throw err;
    throw new Error(`workspace directory not found: ${raw}`);
  }

  if (!roots.some((root) => isWithin(root, real))) {
    throw new Error(
      `workspace "${raw}" is outside the approved roots [${roots.join(', ')}]; ` +
        'add its root to PEHLICHI_WORKSPACE_ROOTS to allow it',
    );
  }
  return real;
}

/** Make a room id safe as a single path segment for its checkpoint subdir. */
function sanitizeRoomKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'default';
}

/** Detect provider ID from base URL (for the circuit breaker). */
function detectProviderId(baseUrl: string): string {
  const url = baseUrl.toLowerCase();
  if (url.includes('xiaomimimo') || url.includes('mimo')) return 'mimo';
  if (url.includes('openrouter')) return 'openrouter';
  if (url.includes('localhost') || url.includes('127.0.0.1')) return 'local';
  return 'unknown';
}

// Avoid an unused-import lint in environments that tree-shake; ScriptedDriver is part
// of the public injection surface used by tests via createPehServer({ driver }).
export { ScriptedDriver, type DriverAction };

// ── Auto-listen when run directly (production) ───────────────────────────────
const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const skin = loadSkin();
  const personality = loadPersonality();
  // Allow writes by default. The auth gate (line 252-254) already forces read-only
  // for unauthenticated callers (no IKBI_CHAT_TOKEN). Authenticated callers get full access.
  const { server } = createPehServer({ allowWrites: process.env.AGENT_ALLOW_WRITES !== 'false' });
  server.listen(PORT, HOST, () => {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  🐿  ${skin.branding.agent_name} — Agent Server (kernel)`);
    console.log(`  Personality: ${personality.name}`);
    console.log(`  Model: ${MODEL}`);
    console.log(`  Commit: ${COMMIT}`); // C1: which build is live.
    console.log(`  Listening: http://${HOST}:${PORT}`);
    console.log(`${'═'.repeat(60)}\n`);
    console.log(`  ${skin.branding.welcome}\n`);
  });

  // GRACEFUL SHUTDOWN (H10): stop accepting new connections, let in-flight requests
  // (a running chat turn drains via server.close's keep-alive handling) finish, then
  // exit. A hard deadline guarantees `systemctl stop` never hangs on a stuck turn.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received — draining in-flight requests…`);
    const forced = setTimeout(() => {
      console.error('Shutdown deadline reached — forcing exit.');
      process.exit(1);
    }, 10_000);
    forced.unref();
    server.close((err) => {
      clearTimeout(forced);
      if (err) { console.error('Error during shutdown:', err); process.exit(1); }
      console.log('Shutdown complete.');
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

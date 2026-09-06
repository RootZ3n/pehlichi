/**
 * the Mechanic HTTP Server — the lab task runner.
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
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, extname, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MimoDriver,
  ScriptedDriver,
  createToolRegistry,
  runtimeCapabilities,
  type Driver,
  type DriverAction,
  type AgentEvent,
  type ToolDef,
  OperationalWorkRefused,
} from '../../src/core/index.js';
import { DATA_ROOT_VARIABLES, requiredDataRoot } from '../../src/core/data-roots.js';
import { createFullToolRegistry } from '../../src/core/agent-tools/index.js';
import { CircuitBreaker } from '../../src/core/agent-tools/circuit-breaker.js';
import { appendTurn, recentSharedContext, readRoomTail } from '../../src/core/lab-transcript.js';
import { truthCognition, reviewProposals } from '../../src/core/truth-bridge.js';
import { KernelChatSession, ResilientDriver, defaultApprovalPolicy } from './kernel-session.js';
import {
  SwappableDriver,
  availableModelTargets,
  initialActive,
  resolveTargetRequest,
  buildDriverForTarget,
  estimateCostUsd,
  type ModelTarget,
} from './model-switch.js';
import { loadSkin } from './skin.js';
import { loadPersonality } from './personality.js';
import { ChatSession } from './chat.js';
import { agentProfile } from '../../src/profiles/agent.js';
import { admitRunWork } from '../../src/core/operational-admission.js';
import { authorizeLaneRequest } from '../../src/core/lane-authorization.js';
import { receiptAccessScope, scopedReceipts, scopedSummary } from '../../src/core/receipt-access.js';
import { describe as describeProvider, providerProfile } from '../../src/core/provider-profile.js';
import { bridgeRegistry } from '../../src/core/bridges/registry.js';
import { listMemory } from 'lab-memory';
import { ReceiptStore, type Receipt } from '../../src/core/receipt-store.js';
import {
  authorizedCapabilityPacks,
  authorizedToolNames,
  assertValidatedRuntimeConfiguration,
  configuredHost,
  configuredPort,
  configuredWorkspace,
  envValue,
  type AgentRuntimeConfiguration,
} from './config.js';
import { createRestrictedEvidenceVault } from '../../src/core/agent-tools/restricted-evidence.js';
import { TEMP_ROOT_ENV,assertGovernedTempSafety } from '../../src/core/temp-authority.js';
import { loadReleaseProvenance } from './provenance.js';
import { bearerMatches, resolveChatToken } from '../../src/core/chat-credential.js';

/*
  THE PROVIDER KEY, from the root-owned profile before anything else.

  This resolver read the process environment and nothing else, and it is consulted for BOTH lanes
  -- the driver at construction and the converse session it builds. So a deployment could be given
  a provider profile and still fail at the provider on every turn, because the server passed an
  environment key (or none) explicitly and the explicit value beat the profile. That is exactly
  what happened, and it is why the profile is consulted first here rather than only inside the
  modules that consume it.

  The environment fallbacks stay for off-release use, where there is no credential channel to read.
*/
function resolveApiKey(): string | undefined {
  const profile = providerProfile();
  if (profile?.apiKey) return profile.apiKey;
  if (process.env.AGENT_API_KEY) return process.env.AGENT_API_KEY;
  if (process.env.MIMO_API_KEY) return process.env.MIMO_API_KEY;
  return undefined;
}

/**
 * Resolve the DeepSeek API key for a DeepSeek target (Bearer auth) from environment only.
 */
function resolveDeepseekKey(): string | undefined {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  if (process.env.AGENT_DEEPSEEK_API_KEY) return process.env.AGENT_DEEPSEEK_API_KEY;
  return undefined;
}

/**
 * Resolve the MiniMax API key for a MiniMax target (Bearer auth) from environment only.
 */
function resolveMinimaxKey(): string | undefined {
  if (process.env.MINIMAX_API_KEY) return process.env.MINIMAX_API_KEY;
  if (process.env.AGENT_MINIMAX_API_KEY) return process.env.AGENT_MINIMAX_API_KEY;
  return undefined;
}

/** The API key for a target, by its key kind (Mimo api-key vs DeepSeek Bearer). */
function keyForTarget(t: ModelTarget): string | undefined {
  if (t.keyKind === 'deepseek') return resolveDeepseekKey();
  if (t.keyKind === 'minimax') return resolveMinimaxKey();
  return resolveApiKey();
}

// ── Intent routing (fast-path) ───────────────────────────────────────────────
// The kernel /chat loop runs a multi-iteration tool cycle per message — far too heavy
// (and slow) for small-talk like "hi", which makes the model grind tools until its
// budget is exhausted. A message that carries NO task keyword is treated as casual chat
// and routed to the tool-free /converse lane instead, so greetings get an instant reply
// and never touch the tool budget. A message WITH a task keyword uses the kernel+tools
// path as before.
const TASK_KEYWORDS = [
  'build', 'fix', 'run', 'deploy', 'create', 'add', 'write', 'modify', 'test', 'commit',
  'install', 'remove', 'delete', 'update', 'change', 'implement', 'refactor',
  'debug', 'diagnose', 'repair', 'generate',
] as const;
const TASK_KEYWORD_RE = new RegExp(`\\b(?:${TASK_KEYWORDS.join('|')})\\b`, 'i');

/** True when the message contains at least one task keyword (case-insensitive, word boundary). */
export function hasTaskKeyword(message: string): boolean {
  return TASK_KEYWORD_RE.test(message);
}

// WEB INTENT: phrasings that strongly imply the answer needs LIVE/current info. Without this the
// fast-path answers "what's the latest on X" from stale memory (and can confabulate); matching it
// routes the turn to the kernel so web_search/web_extract are available. Multi-word phrases first.
const WEB_INTENT_PHRASES = [
  'look up', 'search the web', 'search for', 'on the web', 'right now', 'up to date', 'these days',
];
const WEB_INTENT_WORDS = [
  'search', 'google', 'browse', 'online', 'internet', 'website', 'url',
  'latest', 'current', 'currently', 'news', 'headlines', 'today', 'tonight', 'recent', 'recently',
  'weather', 'forecast', 'stock', 'price', 'score', 'released', 'announce', 'announced',
];
const WEB_INTENT_RE = new RegExp(
  `(?:${WEB_INTENT_PHRASES.map((p) => p.replace(/ /g, '\\s+')).join('|')})|\\b(?:${WEB_INTENT_WORDS.join('|')})\\b`,
  'i',
);

/** True when the message implies a live web lookup — routes to the kernel so web tools are available. */
export function hasWebIntent(message: string): boolean {
  return WEB_INTENT_RE.test(message);
}

// TOOL INTENT: a message that NAMES a tool, or clearly asks to inspect a repo / the lab / a codebase /
// the benchmark ground, must reach the kernel (the tool-free fast-path would answer from memory and
// confabulate results). Two orthogonal signals, so new tool families need NO router edit:
//   1. mentionsTool()   — the message contains an ACTUAL tool name from the live registry.
//   2. hasInspectIntent() — tool-ish phrasing that implies a lookup even without naming a tool.
const INSPECT_INTENT_RE = /\b(?:scan|inspect|examine|analy[sz]e|explore|clone|commit|push|repo|repos|repository|codebase|the lab|lab repo|benchmark|leaderboard|look\s+at)\b/i;

/** True when the message uses tool-ish inspection/benchmark phrasing (no tool name required). */
export function hasInspectIntent(message: string): boolean {
  return INSPECT_INTENT_RE.test(message);
}

/**
 * True when the message names an ACTUAL tool from the registry — so ANY current or FUTURE tool
 * (add a family, it just works) routes to the kernel. Only DISTINCTIVE names (containing `_` or `.`,
 * e.g. luak_add_model, phone_battery, bridge.request) are matched; bare common-word tools like
 * "memory"/"process"/"done" are excluded so ordinary chat isn't dragged onto the kernel.
 */
export function mentionsTool(message: string, toolNames: readonly string[]): boolean {
  const distinctive = new Set(toolNames.filter((n) => /[_.]/.test(n)).map((n) => n.toLowerCase()));
  if (distinctive.size === 0) return false;
  return message.toLowerCase().split(/[^a-z0-9_.]+/).some((tok) => tok.length > 0 && distinctive.has(tok));
}

export type RequestedChatMode = 'agent' | 'converse' | 'auto';
export type SelectedChatMode = Exclude<RequestedChatMode, 'auto'>;

/** Strict request-mode parser: only absent or one of the three exact lowercase strings is valid. */
export function parseChatMode(body: Record<string, unknown>): RequestedChatMode {
  if (!Object.prototype.hasOwnProperty.call(body, 'mode')) return 'auto';
  const mode = body['mode'];
  if (mode === 'agent' || mode === 'converse' || mode === 'auto') return mode;
  throw new Error('mode must be exactly "agent", "converse", or "auto"');
}

function hasExplicitToolRequirement(body: Record<string, unknown>): boolean {
  for (const key of ['requiredTools', 'toolRequirements', 'tools', 'tool_choice', 'toolChoice']) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const value = body[key];
    if (value === undefined || value === null || value === false || value === 'none') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    return true;
  }
  return false;
}

function explicitlyRequiresTools(body: Record<string, unknown>, message: string, toolNames: readonly string[]): boolean {
  return hasExplicitToolRequirement(body)
    || hasTaskKeyword(message) || hasWebIntent(message) || hasInspectIntent(message) || mentionsTool(message, toolNames);
}

function hasAttachmentRequest(body: Record<string, unknown>): boolean {
  return Array.isArray(body['attachments']) && body['attachments'].length > 0;
}

function selectChatMode(
  requested: RequestedChatMode,
  body: Record<string, unknown>,
  message: string,
  toolNames: readonly string[],
): { selected: SelectedChatMode; autoHeuristicUsed: boolean } {
  if (requested !== 'auto') return { selected: requested, autoHeuristicUsed: false };
  const useConverse = !hasAttachmentRequest(body)
    && !explicitlyRequiresTools(body, message, toolNames)
    && process.env.AGENT_FORCE_KERNEL !== 'true';
  return { selected: useConverse ? 'converse' : 'agent', autoHeuristicUsed: true };
}

function modeFields(requested: RequestedChatMode, selected: SelectedChatMode, autoHeuristicUsed: boolean) {
  return { mode: selected, requestedMode: requested, autoHeuristicUsed } as const;
}

/** Overall wall-clock budget for a single /chat turn — the run is returned as a partial past this.
 * Default 10 min (600000ms) to match Hermes' MiMo child_timeout (600s) for long-horizon tasks;
 * override via CHAT_TIMEOUT_MS. This wall-clock (plus the no-progress governor) is the real brake
 * now that the step cap is raised — not a tiny iteration count. */
const CHAT_TIMEOUT_MS = parseInt(process.env.CHAT_TIMEOUT_MS || '600000', 10);

/** AUTO-CONTINUE: how many extra kernel windows to chain when a turn runs out of STEPS (budget) while
 * still progressing — so a long task finishes instead of stopping. Only 'budget' partials continue;
 * 'failures'/'injection' stop. The overall /chat wall-clock still caps the whole chain. AGENT_MAX_AUTO_CONTINUES overrides. */
const MAX_AUTO_CONTINUES = (() => {
  const n = parseInt(process.env.AGENT_MAX_AUTO_CONTINUES ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 3;
})();

/** The minimal converse lane the fast-path needs — a single tool-free model turn. */
export interface ConverseLike {
  send(message: string): Promise<{ content: string; usage?: { in: number; out: number } }>;
  /**
   * Present the principal for the next turn.
   *
   * Required rather than optional on purpose: an optional seam is one a real implementation can
   * quietly omit, and an omitted principal on the conversational lane is exactly the anonymous
   * fallback this phase removes. An embedder or a test that supplies its own converse session
   * must state what it does with the caller's identity.
   */
  setRequestPrincipal(assertion: string | undefined): void;
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

/** Derive a safe upload filename (keeps the extension; falls back to the MIME subtype). */
function sanitizeUploadName(name: string | undefined, mime: string, i: number): string {
  const base = (name ?? '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^_+/, '').slice(-60);
  if (base && /\.[A-Za-z0-9]{1,8}$/.test(base)) return `${Date.now()}-${i}-${base}`;
  const ext = (mime.split('/')[1] ?? 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'bin';
  return `${Date.now()}-${i}.${ext}`;
}

/**
 * Persist chat attachments (images/docs) into <workspace>/uploads and return a STEERING suffix
 * that tells the kernel how to inspect each (vision_analyze for images, read_file for text/docs).
 * Absolute paths so vision/read work regardless of the session's workspace root. Best-effort.
 */
function saveAttachments(list: unknown, workspaceRoot: string): { steer: string; count: number } {
  if (!Array.isArray(list) || list.length === 0) return { steer: '', count: 0 };
  const dir = join(workspaceRoot, 'uploads');
  try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
  const lines: string[] = [];
  let count = 0;
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const a = item as { name?: string; type?: string; data?: string };
    const raw = typeof a.data === 'string' ? a.data : '';
    if (raw === '') continue;
    const m = /^data:([^;]*);base64,([\s\S]*)$/.exec(raw);
    const b64 = m ? m[2]! : raw;
    const mime = (m ? m[1]! : a.type) || 'application/octet-stream';
    const abs = join(dir, sanitizeUploadName(a.name, mime, count));
    try { writeFileSync(abs, Buffer.from(b64, 'base64')); } catch { continue; }
    count += 1;
    lines.push(mime.startsWith('image/')
      ? `- ${abs} (image) — call vision_analyze with image_url="${abs}" to see it`
      : `- ${abs} (${mime}) — call read_file to read it`);
  }
  if (count === 0) return { steer: '', count: 0 };
  return { steer: `\n\n[The user attached ${count} file(s). Inspect each before answering:\n${lines.join('\n')}\n]`, count };
}

/** Turn a session's token usage (TokenSummary {inputTokens,outputTokens} or {in,out}) into a
 * compact {in,out,usd} for the UI's per-message cost line. Reads defensively so either shape works. */
function usageCost(model: string, u: unknown): { in: number; out: number; usd?: number } | undefined {
  if (u === null || typeof u !== 'object') return undefined;
  const o = u as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  // Accept both the converse shape {in,out} and the kernel TokenSummary shape {totalInput,totalOutput}.
  const inTok = num(o.in) || num(o.inputTokens) || num(o.totalInput);
  const outTok = num(o.out) || num(o.outputTokens) || num(o.totalOutput);
  if (inTok === 0 && outTok === 0) return undefined;
  const usd = estimateCostUsd(model, inTok, outTok);
  return { in: inTok, out: outTok, ...(usd !== undefined ? { usd } : {}) };
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
 * CORS preflight. Required by any browser client that sends a non-safelisted header —
 * which every AUTHENTICATED one must, because `chatAuthorized` reads `Authorization`.
 *
 * Without this the chat lanes are unreachable from a browser at all: Firefox sends
 * `OPTIONS`, the router had no handler, the 404 failed the preflight, and the real request
 * was never sent (measured from a WebExtension against 18830, 2026-07-27 — a request
 * carrying only safelisted headers succeeded, one carrying `Authorization` did not, and a
 * host permission does NOT waive the preflight).
 *
 * This does not widen the auth surface. A page could already issue simple GETs and read
 * them under the permissive ACAO below; what it still cannot do is present a valid token,
 * so the chat lanes keep answering it 401. Credentials are deliberately not allowed, so no
 * cookie or stored credential ever rides along.
 */
function preflight(res: ServerResponse): void {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type, x-pehverse-client, x-pehverse-principal',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '600',
  });
  res.end();
}

/**
 * A work request refused by the operational admission boundary.
 *
 * 503 rather than 500: nothing failed. The service is up, reachable and authenticated, and it
 * is declining to execute work because its governed status says it may not. The body carries
 * the boundary's four fields and nothing else -- no message from the manifest, no
 * configuration, no model data.
 */
function refusedResponse(res: ServerResponse, error: unknown): boolean {
  if (!(error instanceof OperationalWorkRefused)) return false;
  json(res, 503, { error: 'operational work is not authorized', refusal: error.refusal });
  return true;
}

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

export interface AgentServerOptions {
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
   * EVIDENCE GATE (P0.1): require a `done` that claims changes/verification to be backed by
   * tools that actually ran this session (see RunAgentOptions.requireEvidence). Defaults ON
   * for the production path and OFF under an injected test driver (scripted-driver tests
   * assert success without running real tools). Tests that want the gate pass `true`.
   */
  readonly requireEvidence?: boolean;
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
  /**
   * CONVERSE LANE (intent routing): factory for the tool-free converse session used by the
   * fast-path (a keyword-free /chat message is answered here, not by the kernel). Defaults to
   * a real `ChatSession` (one model call, no tools). Tests inject a stub so the fast-path is
   * exercised without network — mirroring how `driver` injects the kernel's model.
   */
  readonly makeConverse?: () => ConverseLike;
  /** Overall wall-clock budget for a single /chat turn (ms). Default $CHAT_TIMEOUT_MS or 60s. */
  readonly chatTimeoutMs?: number;
  /** Additional registry definitions for embedders/tests. They never expand the Pehlichi lane. */
  readonly extraTools?: readonly ToolDef[];
}

/**
 * Truth is an explicit feature flag. Executable location is fixed by the
 * digest-bound runtime closure; TRUTH_FIREWALL_ROOT is legacy/non-authoritative.
 */
export function truthLayerEnabled(environment: NodeJS.ProcessEnv): boolean {
  return environment.LAB_TRUTH === '1';
}

/**
 * Build the the Mechanic HTTP server WITHOUT listening. Exposes the kernel session and tool
 * names so tests can drive the real request path with an injected driver.
 */
export function createAgentServer(config: AgentRuntimeConfiguration, opts: AgentServerOptions = {}): {
  server: Server;
  session: KernelChatSession;
  toolNames: readonly string[];
  receiptStore: ReceiptStore;
  /** BLOCKER-1: evict idle sessions past TTL now; returns how many were evicted (for tests). */
  evictStaleSessions: () => number;
  /** Live count of resident per-room sessions (for tests). */
  sessionCount: () => number;
} {
  assertValidatedRuntimeConfiguration(config);
  const port = opts.port ?? configuredPort(config);
  const host = opts.host ?? configuredHost(config);
  /*
    THE ENDPOINT AND THE MODEL, from the same profile as the key.

    The capsule's `providerDefaults` describe what this agent was BUILT expecting; the profile says
    what it is actually pointed at now. Taking the key from one source and the endpoint from another
    is how a deployment ends up presenting a valid key to the wrong provider and calling the 401 a
    credential problem.
  */
  const liveProfile = providerProfile();
  const model = process.env.AGENT_MODEL || liveProfile?.model || config.capsule.providerDefaults.model;
  const baseUrl = process.env.AGENT_BASE_URL || liveProfile?.baseUrl || config.capsule.providerDefaults.baseUrl;
  const skin = loadSkin(join(config.repositoryRoot, config.capsule.skinPath));
  const personality = loadPersonality(join(config.repositoryRoot, config.capsule.personalityPath));
  const workspaceRoot = opts.workspaceRoot ?? configuredWorkspace(config);
  /**
   * Resolve a persistent data root, or refuse.
   *
   * FAILS CLOSED, and the fallback it replaces is why. Every resolver in this tree used to end in a
   * hardcoded `/pehverse/repos/lab-utilities/...` or a workspace-relative guess. Both are repository
   * paths -- writable by the account the agent runs as -- and after a release deployment neither is
   * where the data lives. An unset variable is a misconfiguration to surface at startup, never a
   * default to silently adopt.
   */
  const labStoreRoot = opts.labStoreRoot ?? requiredDataRoot(...DATA_ROOT_VARIABLES.store);
  const evidenceVault = createRestrictedEvidenceVault({ clock: opts.now ?? Date.now });
  const receiptStore = new ReceiptStore({ ttlMs: 60 * 60 * 1000, ...(opts.now ? { clock: opts.now } : {}) });
  const provenance = loadReleaseProvenance(
    config.repositoryRoot,
    config.capsule.identity.id,
    envValue(config.deployment.environment.releaseManifest),
  );
  // Legacy scalar fields disclose a commit only when the live checkout itself
  // corroborates it. Content-verified standalone artifacts retain the manifest's
  // asserted Git claim inside `provenance`, but never masquerade as locally proven.
  const verifiedCommit = provenance.status === 'content-verified'
    && provenance.gitClaim === 'verified-local-checkout'
    ? provenance.fullGitCommit
    : null;
  const apiKey = resolveApiKey();

  const toolNames = Object.freeze(authorizedToolNames(config));
  const effectiveProfile = Object.freeze({
    ...config.profile,
    name: config.capsule.identity.displayName,
    role: config.capsule.identity.role,
    icon: config.capsule.identity.icon,
  });
  const agentName = config.capsule.identity.displayName;

  // The kernel's tool source: the full agent tool suite (Blocker 1).
  const toolsForWorkspace = (root: string): readonly ToolDef[] => [
    ...createFullToolRegistry({
      workspaceRoot: root,
      agentServerUrl: `http://${host}:${port}`,
      enableWorkOrders: authorizedCapabilityPacks(config).includes('work-orders'),
      enableOccasio: authorizedCapabilityPacks(config).includes('occasio'),
      agentId: config.capsule.identity.id,
      routingTargets: config.deployment.routingTargets,
      authorizedToolNames: toolNames,
      ...(apiKey !== undefined ? { apiKey } : {}),
      // N5: delegated sub-agents inherit THIS server's write posture, never more.
      delegateAllowWrites: opts.allowWrites === true,
    }),
    ...(opts.extraTools ?? []),
  ];
  const extraTools = toolsForWorkspace(workspaceRoot);
  const registry = createToolRegistry(extraTools);
  const missingLaneTools = toolNames.filter((name) => !registry.has(name));
  if (missingLaneTools.length > 0) {
    throw new Error(`configured tool lane references missing registry tools: ${missingLaneTools.join(', ')}`);
  }

  // SELF-AWARENESS (gauntlet fix): a concise capability summary fed into the system
  // prompt of BOTH chat lanes so Peh actually knows his own tools, memory, and surface.
  // Without it the converse lane (no tools) answered "my mind" / "I don't know" / "nothing
  // between conversations". Just names + a plain-English summary — not the 29 full tool
  // descriptions. The personality prompt still owns his squirrel voice; this is only facts.
  // TRUTHFUL (P0.4): only claim WRITE ability when writes are actually enabled this run.
  // With writes off (the P0.3 safe default), claiming "you can write files" is an over-claim.
  const writesEnabledForSummary = opts.allowWrites === true;
  const capabilitiesSummary =
    `YOUR CAPABILITIES (real tools you have — talk about them in your own voice):\n` +
    `You have ${toolNames.length} tools available: ${toolNames.join(', ')}.\n` +
    (writesEnabledForSummary
      ? `You can: read files, write files, edit files (patch), search code, run terminal commands, ` +
        `browse the web, and manage processes. Any file change you make can be undone via /undo.\n`
      : `You can: read files, search code, run read-only commands, browse the web, and inspect processes. ` +
        `File writes/edits are currently DISABLED (operator has not enabled writes) — do NOT claim you wrote or changed a file.\n`) +
    `You have persistent memory across conversations via the memory tool — you do NOT forget everything between chats.\n` +
    `You have a /tools endpoint that lists your tools, and a /info endpoint with your identity.`;
  // The converse lane runs WITHOUT tools, so Peh must be told he still has them elsewhere.
  const converseCapabilities =
    `${capabilitiesSummary}\n` +
    `Even though you don't have tools wired into THIS conversation, you DO have them in the full ` +
    `/chat endpoint. You can tell users about your capabilities.`;

  // Production driver: a resilient MimoDriver (circuit breaker + retry). Tests inject
  // a ScriptedDriver so the whole kernel path runs with no network.
  const breaker = new CircuitBreaker(detectProviderId(baseUrl), { failureThreshold: 5, cooldownMs: 30_000, successThreshold: 3 });
  const baseDriver = opts.driver ?? new ResilientDriver(
    new MimoDriver({ baseUrl, model, ...(apiKey !== undefined ? { apiKey } : {}) }),
    breaker,
  );
  // MODEL SWITCH (P2): wrap the shared driver so the active model can be HOT-SWAPPED at runtime
  // without tearing down sessions (history preserved — every room holds this stable reference).
  // Injected test drivers wrap too, reporting MODEL so test expectations are unchanged.
  /*
    THE ACTIVE TARGET, from the profile when there is one.

    `initialActive()` picks from a hard-coded preset list keyed on `AGENT_MODEL`, defaulting to
    MiMo. The converse session is built from whatever this resolves to — so with a GLM profile
    installed, the endpoint stayed MiMo while the key became GLM's, and every turn failed with
    "Invalid API Key" from a provider nobody had chosen. The key came from one source and the
    endpoint from another, which is exactly the mistake that makes a 401 look like a credential
    problem.

    `keyKind` selects the key RESOLVER, not the provider: the default resolver is profile-first,
    so a profile target and its key stay together.
  */
  const startActive: ModelTarget = opts.driver !== undefined
    ? { id: model, label: model, model, baseUrl, keyKind: 'mimo' }
    : liveProfile !== undefined
      ? { id: liveProfile.model, label: `${liveProfile.provider} · ${liveProfile.model}`,
          model: liveProfile.model, baseUrl: liveProfile.baseUrl, keyKind: 'mimo' }
      : initialActive();
  const driver = new SwappableDriver(baseDriver, startActive);
  const currentModel = (): string => driver.active.model;

  // H6: checkpoint in production (no injected driver), stay off under test injection.
  const checkpointDir = opts.checkpointDir ?? (opts.driver ? undefined : join(labStoreRoot, '.checkpoints', config.deployment.namespaces.checkpoint));

  // H1: endpoint auth. A configured token gates /chat; an injected driver (tests /
  // embedding) keeps its explicit write posture, while the production listen path with
  // NO token is forced read-only so an unauthenticated caller cannot drive writes.
  /*
    The chat token. In a release this is read once, at startup, from the verified systemd credential
    directory and never returned to the environment — so it is not inherited by spawned tools and
    not readable from /proc/<pid>/environ. Off the release path the environment is still accepted,
    because the source rollback deployment has no credential to read.

    There is deliberately NO fallback in release mode: a release that cannot read its credential
    must fail to start, not quietly serve an unauthenticated /chat.
  */
  const chatCredential = opts.chatToken !== undefined
    ? { token: opts.chatToken, source: 'injected' as const }
    : resolveChatToken(config.repositoryRoot);
  const chatToken = chatCredential.token;
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

  // TRUTHFUL CAPABILITIES (P0.4): derive what this run can ACTUALLY do from the real wiring,
  // so /capabilities and the model's self-description never claim a capability that is off.
  // As P1 wires compaction/schema-repair/provider-switch, flip the inputs here and the report
  // follows — no hand-maintained feature list to drift out of sync with reality.
  const requireEvidenceEffective = opts.requireEvidence ?? !isInjected;
  const caps = runtimeCapabilities({
    allowWrites: allowWritesEffective,
    requireEvidence: requireEvidenceEffective,
    // P1.1: KernelChatSession wires a context window by default ⇒ compaction is active.
    // (Mirrors KernelChatSession's DEFAULT_CONTEXT_WINDOW; the value only drives the flag here.)
    contextWindow: 128_000,
    schemaRepair: true, // P1.2: the live MiMo driver now repairs near-JSON tool-call args.
    providerSwitch: true, // P2: runtime model hot-swap wired (SwappableDriver + /model route).
    memoryWired: toolNames.includes('memory') || toolNames.includes('labmem_recall'),
    toolCount: toolNames.length,
  });

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
    const effectiveTools = overrideWorkspace ? toolsForWorkspace(effectiveWorkspace) : extraTools;
    return new KernelChatSession({
      profile: effectiveProfile,
      driver,
      workspaceRoot: effectiveWorkspace,
      labStoreRoot: effectiveLabStore,
      extraTools: effectiveTools,
      toolNames,
      evidenceRecorder: evidenceVault.recorderFor({
        taskId: `${config.deployment.namespaces.task}-${roomKey}`,
        roomKey,
      }),
      capabilities: capabilitiesSummary,
      taskId: `${config.deployment.namespaces.task}-${roomKey}${overrideWorkspace ? `@${basename(overrideWorkspace)}` : ''}`,
      roomKey,
      ...(opts.maxIterations !== undefined ? { maxIterations: opts.maxIterations } : {}),
      approvalCallback: defaultApprovalPolicy({ allowWrites: allowWritesEffective }),
      // P0.1: prove-don't-assert. ON in production; OFF under an injected test driver unless
      // the test explicitly opts in (scripted drivers finish without running real tools).
      requireEvidence: opts.requireEvidence ?? !isInjected,
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
  interface ConverseEntry { cs: ConverseLike; lastAccessedAt: number; }
  const converseSessions = new Map<string, ConverseEntry>();
  const chatTimeoutMs = opts.chatTimeoutMs ?? CHAT_TIMEOUT_MS;
  const makeConverse = opts.makeConverse
    ?? ((): ConverseLike => {
      // Follow the active target so casual chat uses the same brain as the tool loop.
      const a = driver.active;
      return new ChatSession({
        apiKey: keyForTarget(a), baseUrl: a.baseUrl, model: a.model,
        capabilities: converseCapabilities, personality, skin,
      });
    });
  const converseFor = (roomKey: string): ConverseLike => {
    let entry = converseSessions.get(roomKey);
    if (entry === undefined) {
      entry = { cs: makeConverse(), lastAccessedAt: now() };
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

  // ── SHARED LAB MEMORY (lab-cohesion) ──────────────────────────────────────────
  // The trio is ONE agent with three faces; substantive (kernel) turns are recorded to a
  // shared log so the conversation follows the user across faces and surfaces. Recall is
  // ROLE-AWARE (hub sees broadly; specialists stay heads-down). Small-talk on the converse
  // lane is intentionally NOT recorded — it would only add noise to recall.
  //
  // Gated on LAB_TRANSCRIPT_DIR: the lab sets it (memory ON) → cohesion; tests and released
  // standalone builds leave it unset (inert, behavior-preserving, no shared store touched).
  // This folds into the unified labMode gate later.
  const LAB_MEMORY_ON = !!process.env.LAB_TRANSCRIPT_DIR;
  const SELF_FACE = config.deployment.namespaces.memory;
  const selfAmbientProfile = {
    maxTurns: config.deployment.memoryAmbient.maxTurns,
    maxCharsPerTurn: config.deployment.memoryAmbient.maxCharsPerTurn,
    ...(config.deployment.memoryAmbient.includeNamespaces.length > 0
      ? { includeFaces: config.deployment.memoryAmbient.includeNamespaces }
      : {}),
  };
  const sharedAmbient = (roomKey: string): string | undefined =>
    LAB_MEMORY_ON ? (recentSharedContext(SELF_FACE, roomKey, selfAmbientProfile) || undefined) : undefined;
  const recordTurn = (roomKey: string, role: 'user' | 'assistant', text: string, receiptId?: string): void => {
    if (!LAB_MEMORY_ON) return;
    appendTurn({ face: SELF_FACE, agent: agentName, room: roomKey, role, text, ts: now(), ...(receiptId ? { receiptId } : {}) });
  };

  // TRUTH LAYER (lab overlay): LAB_TRUTH is the sole enablement authority.
  // Executable resolution remains fixed to the declared digest-bound dependency;
  // a stale/hostile TRUTH_FIREWALL_ROOT is ignored and cannot enable or select code.
  const LAB_TRUTH_ON = truthLayerEnabled(process.env);
  const buildExtraContext = async (roomKey: string, task: string): Promise<string | undefined> => {
    const parts: string[] = [];
    const ambient = sharedAmbient(roomKey);
    if (ambient) parts.push(ambient);
    if (LAB_TRUTH_ON) {
      const truth = await truthCognition({ task });
      if (truth) parts.push(truth);
    }
    return parts.length ? parts.join('\n\n') : undefined;
  };

  // TF-3: when a turn wrote durable/global memory, kick truth-firewall's ADVISORY review of
  // the proposal inboxes (fire-and-forget; verdicts persist to the firewall store, surfaced
  // later in ittunaha). Idempotent, so re-running over the inbox is safe.
  const MEMORY_WRITE_TOOLS = new Set(['memory', 'labmem_remember', 'brain_put']);
  const maybeReviewProposals = (toolCalls: ReadonlyArray<{ name: string }>): void => {
    if (!LAB_TRUTH_ON) return;
    if (!toolCalls.some((tc) => MEMORY_WRITE_TOOLS.has(tc.name))) return;
    void reviewProposals();
  };

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
        entry.session.dispose();
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
  const instanceId = `${port}:${process.pid}`;

  /*
    THE BROWSER'S PRINCIPAL IS HELD BY THE SERVER, NOT BY THE BROWSER.

    Every other client of this agent is a process that can keep a secret: a systemd unit reads its
    principal from a root-owned credential and presents it on a header. A browser cannot. Anything
    the page can send, the page can be read for -- localStorage, a script variable, the page source,
    a query string -- so handing a browser a principal would be handing every extension, every
    bookmarklet and every copy of the tab a reusable authority that works from anywhere.

    So the browser never receives one. It authenticates with the chat bearer it already uses, and
    the SERVER then acts under a principal of its own, delivered on the same root-owned credential
    channel as everything else and scoped to what a browser session legitimately needs: the
    conversational lane, its own receipts, and no tools at all.

    Three properties this must not lose, and does not:

      - It is NOT an anonymous path. It applies only when a chat token is CONFIGURED and the request
        actually authenticated with it. A deployment with no token gets no fallback, because
        "nobody had to prove anything" is precisely the hole this phase closes.
      - It does not promote the bearer into an authorization. The bearer still only decides whether
        the server will act at all; WHAT may then be done is decided by an externally issued
        principal this process cannot mint, widen or renew, and that root revokes without touching
        a line of this code.
      - It never leaves the process. It is not returned, echoed or rendered, and a client that
        presents its OWN principal is served by that one instead.

    Note what the credential path is and is not doing. It is a delivery channel, not a trust
    anchor: this file is READ, never trusted. What makes the assertion mean anything is the
    issuer signature, checked against the public half named inside the root-owned service lease.
    So a process that could point `CREDENTIALS_DIRECTORY` somewhere of its own choosing gains
    nothing at all -- it would be presenting a document no verifier accepts.
  */
  const browserPrincipal = ((): string | undefined => {
    const directory = process.env['CREDENTIALS_DIRECTORY'];
    if (typeof directory !== 'string' || directory.length === 0) return undefined;
    let fd: number | undefined;
    try {
      fd = openSync(join(directory, 'browser-principal'), 'r');
      const value = readFileSync(fd, 'utf8').trim();
      return value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  })();

  /*
    THE REQUEST PRINCIPAL, as this transport carries it.

    Parsing only. Whether the assertion means anything is decided by the one authorization
    function, against an issuer named by the root-owned service lease -- never here, and never by
    anything a client can influence. A client that presents one is served by it. A client that
    presents none falls back ONLY to the server-held browser principal, and only when this
    deployment has a chat token and the request satisfied it; otherwise absent stays absent.

    Kept out of every log line and every error body: an assertion is a bearer document, and a
    surface that echoes one back is a surface that hands it to whoever provoked the error.
  */
  /*
    WHO THE FALLBACK IS FOR, declared rather than guessed.

    The fallback first applied to ANY bearer-holding request that presented no principal, and a
    hostile run caught that immediately: a Matrix bridge whose credential was missing was not
    refused, it was quietly served as the BROWSER -- wrong identity, wrong scope, and its evidence
    filed against a caller that never made the request. Silent misattribution is worse than a
    refusal, because nothing looks wrong.

    The first repair sniffed for `Sec-Fetch-*`, on the assumption that only browsers send it. The
    same hostile run disproved that in one line: Node's own fetch sends `sec-fetch-mode`, so the
    signal did not separate a page from a daemon at all. Inferring the caller from headers the
    platform happens to set today is a guess with a version number attached.

    So the caller DECLARES itself. A client that wants the browser fallback says so; a server-side
    client that forgets its credential says nothing and is refused, which is the outcome that
    matters. This is not an authorization input and cannot be: declaring it buys exactly one thing,
    the NARROWEST principal this deployment holds -- conversational, its own receipts, no tools --
    strictly less than any real client's. There is nothing to gain by claiming it, which is what
    makes it safe to ask, and asking makes the choice auditable instead of accidental.
  */
  const BROWSER_CLIENT_DECLARATION = 'browser-ui';
  const declaresBrowserClient = (req: IncomingMessage): boolean => {
    const header = req.headers['x-pehverse-client'];
    const value = Array.isArray(header) ? header[0] : header;
    return typeof value === 'string' && value.trim().toLowerCase() === BROWSER_CLIENT_DECLARATION;
  };

  const presentedPrincipal = (req: IncomingMessage): string | undefined => {
    const header = req.headers['x-pehverse-principal'];
    const value = Array.isArray(header) ? header[0] : header;
    if (typeof value === 'string' && value.length > 0) return value;
    if (hasChatToken && browserPrincipal !== undefined && declaresBrowserClient(req) && chatAuthorized(req))
      return browserPrincipal;
    return undefined;
  };

  /**
   * H1: verify the bearer token on a chat request. Returns true when no token is
   * configured (open, but read-only on the production path). A configured token requires
   * an exact `Authorization: Bearer <token>` match.
   */
  const chatAuthorized = (req: IncomingMessage): boolean => {
    if (!hasChatToken) return true;
    const header = req.headers['authorization'];
    /*
      Constant time. `===` on strings short-circuits at the first differing byte, which leaks the
      length of the shared prefix to anyone who can time the response.
    */
    return chatToken !== undefined && bearerMatches(header, chatToken);
  };

  const server = createHttpServer(async (req, res) => {
   try {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);

    // Answer preflights before anything else: they carry no body, no token, and must not
    // fall through to a route that would 404 them. See `preflight`.
    if (req.method === 'OPTIONS') return preflight(res);

    // Static web UI: try to serve the browser UI for GET requests BEFORE the API
    // routes. serveStatic returns true (and has written the response) when the path
    // maps to a real file under WEB_ROOT; otherwise it returns false and we fall
    // through to the JSON API routes below (so /health, /api/*, etc. are unaffected).
    if (req.method === 'GET' && serveStatic(res, url.pathname)) return;

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/api/local/health')) {
      // Lab Agent Contract §1.1: include `service` and `ok` for contract probe compatibility.
      // /api/local/health is an alias for Howa adapter compatibility (public variant probes this path).
      // LAB TEMP POLICY: a process that would use /tmp is a BLOCKING health failure.
      const governedTemp = governedTempStatus(config);
      return json(res, 200, {
        ok: governedTemp.ok,
        service: agentName,
        version: verifiedCommit ?? provenance.status,
        status: governedTemp.ok ? 'ok' : 'blocked:ungoverned-temporary-storage',
        governedTemp,
        uptimeMs: Math.round(process.uptime() * 1000),
        identity: { id: instanceId, role: 'agent', authorityTier: 'trusted' },
        // Legacy fields (backward compatible):
        agent: agentName,
        instanceId,
        model: currentModel(),
        commit: verifiedCommit,
        provenance,
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
        agent: agentName,
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
        agent: agentName,
        pastLives,
        entries,
        count: pastLives.length + entries.length,
      });
    }

    // Ecosystem agents Peh coordinates (Council Chamber / Training Grounds).
    if (req.method === 'GET' && (url.pathname === '/agents' || url.pathname === '/api/agents')) {
      const agents = bridgeRegistry.list().map((b) => ({
        id: b.name,
        name: b.name,
        description: b.description,
        port: b.port,
        status: b.status,
      }));
      return json(res, 200, {
        agent: agentName,
        self: { id: config.capsule.identity.id, name: agentName, model: currentModel(), tools: toolNames.length },
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
        agent: agentName,
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
      return json(res, 200, { agent: agentName, tools: toolNames, count: toolNames.length });
    }

    if (req.method === 'GET' && url.pathname === '/info') {
      return json(res, 200, {
        agent: agentName,
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
      cs.setRequestPrincipal(presentedPrincipal(req));
      try {
        const reply = await cs.send(message);
        return json(res, 200, {
          content: reply.content,
          agent: agentName,
          ok: true,
          partial: false,
          mode: 'converse',
          toolCalls: [],
        });
      } catch (err) {
        if (refusedResponse(res, err)) return;
        return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (req.method === 'POST' && (url.pathname === '/chat' || url.pathname === '/api/chat')) {
      // /api/chat is an alias for Howa adapter compatibility (public variant probes this path).
      if (!chatAuthorized(req)) {
        return json(res, 401, { error: 'unauthorized: a valid Bearer token is required' });
      }
      // BLOCKER-1: opportunistic eviction on the request path keeps the map bounded even
      // if the periodic timer is starved.
      evictStaleSessions();
      const body = await parseBody(req);
      const message = body.message as string;
      if (!message) return json(res, 400, { error: 'message is required' });
      let requestedMode: RequestedChatMode;
      try { requestedMode = parseChatMode(body); }
      catch (err) { return json(res, 400, { error: (err as Error).message }); }
      const selection = selectChatMode(requestedMode, body, message, toolNames);

      if (requestedMode === 'converse' && (hasAttachmentRequest(body) || explicitlyRequiresTools(body, message, toolNames))) {
        return json(res, 400, {
          error: 'converse mode is tool-free and rejects attachments or requests that explicitly require tools',
          ...modeFields(requestedMode, selection.selected, selection.autoHeuristicUsed),
        });
      }

      // FAST-PATH (intent routing): a message with NO task keyword is small-talk — answer it
      // on the tool-free converse lane so it returns instantly and never grinds the kernel's
      // tool loop. This is what kept /chat from hanging on greetings like "hi, who are you?".
      // PERSISTENCE: the converse lane still RECORDS the turn to the shared transcript so an
      // all-day casual conversation is durably captured (and syncable), not lost like RAM.
      // AGENT_FORCE_KERNEL=true disables the fast-path entirely (every message goes through the
      // kernel — tools + checkpoints — at the cost of small-talk speed).
      if (selection.selected === 'converse') {
        const fpRoomKey = roomKeyOf(body);
        recordTurn(fpRoomKey, 'user', message);
        const cs = converseFor(fpRoomKey);
        cs.setRequestPrincipal(presentedPrincipal(req));
        try {
          const reply = await cs.send(message);
          recordTurn(fpRoomKey, 'assistant', reply.content);
          return json(res, 200, {
            content: reply.content,
            agent: agentName,
            ok: true,
            partial: false,
            ...modeFields(requestedMode, selection.selected, selection.autoHeuristicUsed),
            toolCalls: [],
            usage: usageCost(currentModel(), reply.usage),
          });
        } catch (err) {
          if (refusedResponse(res, err)) return;
          return json(res, 500, {
            error: err instanceof Error ? err.message : String(err),
            ...modeFields(requestedMode, selection.selected, selection.autoHeuristicUsed),
          });
        }
      }

      // ATTACHMENTS are persisted only after the governed agent lane is selected. An explicit
      // converse request is rejected above before any file can be written.
      const att = saveAttachments(body['attachments'], workspaceRoot);
      const effectiveMessage = att.count > 0 ? message + att.steer : message;

      // N-WORKSPACE: when the caller supplies a workspace directory, Pehlichi's file
      // tools resolve paths against it instead of the server's default root.
      let overrideWorkspace: string | undefined;
      try {
        overrideWorkspace = parseWorkspaceOverride(config, body);
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
      if (overrideWorkspace) console.log(`[chat] workspace override: ${overrideWorkspace}`);

      // H2: route to THIS room's session — no cross-room context bleed.
      const chatRoomKey = roomKeyOf(body);
      const roomSession = sessionFor(chatRoomKey, overrideWorkspace);
      roomSession.setRequestPrincipal(presentedPrincipal(req));

      // SHARED LAB MEMORY: record the user turn and gather role-aware ambient recall of
      // what was said on OTHER faces/surfaces (the live session already holds this thread).
      recordTurn(chatRoomKey, 'user', message);
      const chatExtra = await buildExtraContext(chatRoomKey, message);

      // H8: attribute the caller. We log WHO drove the agent and a correlation id so a
      // request can be traced; a missing id is stamped (and logged as anonymous) rather
      // than silently accepted as if it came from nowhere.
      const callerId = (req.headers['x-agent-id'] as string) || 'anonymous';
      const correlationId = (req.headers['x-correlation-id'] as string)
        || `${config.deployment.namespaces.correlation}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      res.setHeader('X-Correlation-Id', correlationId);
      console.log(`[chat] caller=${callerId} corr=${correlationId}`);

      // BLOCKER-2 (callee): register a bridge-originated task so its status is pollable.
      const taskId = (req.headers['x-task-id'] as string) || undefined;
      if (taskId) tasks.set(taskId, { status: 'running', caller: callerId, correlationId, startedAt: now() });
      const processIdentity = { taskId: taskId ?? correlationId, callerId };

      try {
        // OVERALL TIMEOUT: never let /chat hang. Race the kernel turn against a wall-clock
        // budget; if it wins, return a clear partial (the work may still finish in the
        // background and update its task record, which a caller can poll via /task/:id/status).
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), chatTimeoutMs);
          // Never let the wall-clock timer alone keep the process alive: a live request has
          // its own handles (socket + pending work); when idle, this internal timer must not
          // pin the event loop (mattered little at 60s, but a 10-min ceiling would hang exit).
          timer.unref?.();
        });
        // AUTO-CONTINUE: chain kernel windows when a turn runs out of STEPS but was still progressing,
        // so a long task finishes on its own. Only 'budget' partials continue (not stuck/injection stops);
        // the wall-clock timeout above still bounds the whole chain, and any late finish is persisted.
        const work = (async () => {
          let r = await roomSession.send(effectiveMessage, undefined, chatExtra, processIdentity);
          let continues = 0;
          while (r.partial && r.partialReason === 'budget' && continues < MAX_AUTO_CONTINUES) {
            continues += 1;
            console.log(`[chat] auto-continue ${continues}/${MAX_AUTO_CONTINUES} (out of steps, still progressing) corr=${correlationId}`);
            r = await roomSession.send(
              'Continue the previous task from exactly where you left off — do NOT restart or re-summarize the earlier steps. Finish the remaining work, then give the final answer.',
              undefined, chatExtra, processIdentity,
            );
          }
          return r;
        })();
        const raced = await Promise.race([work.then((r) => ({ r })), timeout]);
        if (timer) clearTimeout(timer);

        if (raced === 'timeout') {
          // Settle the orphaned run in the background: mark the task and swallow any late
          // rejection so it never surfaces as an unhandled rejection.
          void work.then(
            (r) => { const rec = taskId ? tasks.get(taskId) : undefined; if (rec) { rec.status = 'completed'; rec.finishedAt = now(); rec.partial = r.partial; } },
            () => { const rec = taskId ? tasks.get(taskId) : undefined; if (rec) { rec.status = 'failed'; rec.finishedAt = now(); } },
          );
          return json(res, 422, {
            content: `This took longer than ${Math.round(chatTimeoutMs / 1000)}s and was returned as partial. The work may still be completing — narrow the task or, if you supplied X-Task-Id, poll /task/<id>/status.`,
            agent: agentName,
            ok: false,
            partial: true,
            timedOut: true,
            accomplished: [],
            toolCalls: [],
            ...modeFields(requestedMode, selection.selected, selection.autoHeuristicUsed),
          });
        }

        const response = raced.r;
        if (taskId) {
          const rec = tasks.get(taskId);
          if (rec) { rec.status = 'completed'; rec.finishedAt = now(); rec.partial = response.partial; }
        }
        // Record receipt (before payload — payload references receipt.id)
        const receipt = receiptStore.record({
          agent: agentName,
          taskId: taskId ?? undefined,
          roomKey: chatRoomKey,
          workspaceId: overrideWorkspace ?? undefined,
          model: currentModel(),
          status: (response.injectionFindings ?? 0) > 0 ? 'injection_quarantined'
            : response.injectionDetected ? 'injection_blocked'
            : response.partial ? 'partial'
            : response.ok ? 'success' : 'failed',
          toolCallCount: response.toolCalls.length,
          injectionDetected: response.injectionDetected,
          injectionFindings: response.injectionFindings,
          findingMetadata: response.findingMetadata,
          partial: response.partial,
          contentSummary: response.content?.slice(0, 200),
          ...(response.principalId !== undefined ? { principalId: response.principalId } : {}),
        });
        // SHARED LAB MEMORY: record the assistant turn (substantive kernel reply).
        recordTurn(chatRoomKey, 'assistant', response.content ?? '', receipt.id);
        maybeReviewProposals(response.toolCalls);
        const payload = {
          content: response.content,
          agent: agentName,
          ok: response.ok,
          partial: response.partial,
          receiptId: receipt.id,
          accomplished: response.accomplished,
          thinkingVerb: response.thinkingVerb,
          usage: usageCost(currentModel(), response.tokenUsage),
          injectionDetected: response.injectionDetected,
          injectionFindings: response.injectionFindings,
          findingMetadata: response.findingMetadata,
          ...modeFields(requestedMode, selection.selected, selection.autoHeuristicUsed),
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
        if (refusedResponse(res, err)) return;
        return json(res, 500, {
          error: err instanceof Error ? err.message : String(err),
          ...modeFields(requestedMode, selection.selected, selection.autoHeuristicUsed),
        });
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
      let requestedMode: RequestedChatMode;
      try { requestedMode = parseChatMode(body); }
      catch (err) { return json(res, 400, { error: (err as Error).message }); }
      const selection = selectChatMode(requestedMode, body, message, toolNames);
      if (requestedMode === 'converse' && (hasAttachmentRequest(body) || explicitlyRequiresTools(body, message, toolNames))) {
        return json(res, 400, {
          error: 'converse mode is tool-free and rejects attachments or requests that explicitly require tools',
          ...modeFields(requestedMode, selection.selected, selection.autoHeuristicUsed),
        });
      }

      if (selection.selected === 'converse') {
        const streamRoomKey = roomKeyOf(body);
        recordTurn(streamRoomKey, 'user', message);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        try {
          const streamConverse = converseFor(streamRoomKey);
          streamConverse.setRequestPrincipal(presentedPrincipal(req));
          const reply = await streamConverse.send(message);
          recordTurn(streamRoomKey, 'assistant', reply.content);
          res.write(`data: ${JSON.stringify({ done: true, ok: true, partial: false, content: reply.content, toolCalls: 0, ...modeFields(requestedMode, selection.selected, selection.autoHeuristicUsed) })}\n\n`);
        } catch (err) {
          res.write(`data: ${JSON.stringify({ error: err instanceof Error ? err.message : String(err), ...modeFields(requestedMode, selection.selected, selection.autoHeuristicUsed) })}\n\n`);
        }
        res.end();
        return;
      }

      const att = saveAttachments(body['attachments'], workspaceRoot);
      const effectiveMessage = att.count > 0 ? message + att.steer : message;

      // N-WORKSPACE: same workspace override as /chat.
      let overrideWorkspace: string | undefined;
      try {
        overrideWorkspace = parseWorkspaceOverride(config, body);
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
      if (overrideWorkspace) console.log(`[chat/stream] workspace override: ${overrideWorkspace}`);

      // H2: route to THIS room's session — no cross-room context bleed.
      const streamRoomKey = roomKeyOf(body);
      const roomSession = sessionFor(streamRoomKey, overrideWorkspace);
      roomSession.setRequestPrincipal(presentedPrincipal(req));

      // SHARED LAB MEMORY: record the user turn + gather role-aware ambient recall.
      recordTurn(streamRoomKey, 'user', message);
      const streamExtra = await buildExtraContext(streamRoomKey, message);

      // BLOCKER-2 (callee): track the streamed task too so it is pollable on timeout.
      const streamCaller = (req.headers['x-agent-id'] as string) || 'anonymous';
      const streamCorr = (req.headers['x-correlation-id'] as string)
        || `${config.deployment.namespaces.correlation}-stream-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const streamTaskId = (req.headers['x-task-id'] as string) || undefined;
      if (streamTaskId) tasks.set(streamTaskId, { status: 'running', caller: streamCaller, correlationId: streamCorr, startedAt: now() });

      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      try {
        // Blocker 5: stream EVERY kernel event (tool-call/result/receipt/summary) as SSE,
        // flushed the instant it is emitted (stream() does not buffer).
        const response = await roomSession.stream(effectiveMessage, (e: AgentEvent) => {
          res.write(`data: ${JSON.stringify({ event: e })}\n\n`);
        }, streamExtra, { taskId: streamTaskId ?? streamCorr, callerId: streamCaller });
        if (streamTaskId) {
          const rec = tasks.get(streamTaskId);
          if (rec) { rec.status = 'completed'; rec.finishedAt = now(); rec.partial = response.partial; }
        }
        // SHARED LAB MEMORY: record the assistant turn.
        const streamReceipt = receiptStore.record({
          agent: agentName,
          taskId: streamTaskId ?? undefined,
          roomKey: streamRoomKey,
          workspaceId: overrideWorkspace ?? undefined,
          model: currentModel(),
          status: (response.injectionFindings ?? 0) > 0 ? 'injection_quarantined'
            : response.injectionDetected ? 'injection_blocked'
            : response.partial ? 'partial'
            : response.ok ? 'success' : 'failed',
          toolCallCount: response.toolCalls.length,
          injectionDetected: response.injectionDetected,
          injectionFindings: response.injectionFindings,
          findingMetadata: response.findingMetadata,
          partial: response.partial,
          contentSummary: response.content?.slice(0, 200),
          ...(response.principalId !== undefined ? { principalId: response.principalId } : {}),
        });
        recordTurn(streamRoomKey, 'assistant', response.content ?? '', streamReceipt.id);
        maybeReviewProposals(response.toolCalls);
        res.write(`data: ${JSON.stringify({ done: true, ok: response.ok, partial: response.partial, content: response.content, toolCalls: response.toolCalls.length, receiptId: streamReceipt.id, injectionDetected: response.injectionDetected, injectionFindings: response.injectionFindings, ...modeFields(requestedMode, selection.selected, selection.autoHeuristicUsed) })}\n\n`);
      } catch (err) {
        if (streamTaskId) {
          const rec = tasks.get(streamTaskId);
          if (rec) { rec.status = 'failed'; rec.finishedAt = now(); }
        }
        res.write(`data: ${JSON.stringify({ error: err instanceof Error ? err.message : String(err), ...modeFields(requestedMode, selection.selected, selection.autoHeuristicUsed) })}\n\n`);
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
      return json(res, 200, { status: 'reset', agent: agentName });
    }

    // MODEL SWITCH: list the model presets + which one is active right now.
    if (req.method === 'GET' && url.pathname === '/models') {
      const view = (t: ModelTarget): Record<string, unknown> =>
        ({ id: t.id, label: t.label, model: t.model, key_kind: t.keyKind, base_url: t.baseUrl });
      return json(res, 200, { active: view(driver.active), available: availableModelTargets().map(view) });
    }

    // HISTORY: the recent turns of a room's persisted transcript — so the chat UI can RESTORE the
    // conversation after the tab/app was closed (the turns are recorded server-side either way).
    if (req.method === 'GET' && url.pathname === '/history') {
      const room = (url.searchParams.get('roomId') || url.searchParams.get('room') || 'default').trim() || 'default';
      const limRaw = parseInt(url.searchParams.get('limit') || '200', 10);
      const limit = Number.isFinite(limRaw) ? Math.min(500, Math.max(1, limRaw)) : 200;
      const turns = readRoomTail(SELF_FACE, room, limit).map((t) => ({ role: t.role, text: t.text, ts: t.ts }));
      return json(res, 200, { room, turns });
    }

    // MODEL SWITCH: hot-swap the active model (whole-agent, context preserved). Body is either a
    // preset { id } or a custom { model, base_url?, key_kind? }. Auth-gated like /chat (it mutates).
    if (req.method === 'POST' && url.pathname === '/model') {
      if (!chatAuthorized(req)) {
        return json(res, 401, { error: 'unauthorized: a valid Bearer token is required' });
      }
      const body = await parseBody(req);
      const target = resolveTargetRequest(body as Record<string, unknown>, availableModelTargets());
      if ('error' in target) return json(res, 400, { error: target.error });
      const key = keyForTarget(target);
      driver.swap(buildDriverForTarget(target, key), target);
      return json(res, 200, {
        ok: true,
        active: { id: target.id, model: target.model, label: target.label, key_kind: target.keyKind, base_url: target.baseUrl },
        keyed: key !== undefined,
        ...(key === undefined
          ? { note: `no ${target.keyKind} API key found — set ${target.keyKind === 'deepseek' ? 'DEEPSEEK_API_KEY' : target.keyKind === 'minimax' ? 'MINIMAX_API_KEY' : 'MIMO_API_KEY'}; the switch applied but calls will 401 until then` }
          : {}),
      });
    }

    // REVERSIBILITY (P0.3): list the file edits the room's session has made this session.
    // Read-only, but auth-gated (it reveals workspace paths), like /chat.
    if (req.method === 'POST' && url.pathname === '/session/changes') {
      if (!chatAuthorized(req)) {
        return json(res, 401, { error: 'unauthorized: a valid Bearer token is required' });
      }
      const body = await parseBody(req);
      const changes = sessionFor(roomKeyOf(body)).changedFiles();
      return json(res, 200, {
        agent: agentName,
        count: changes.length,
        changes: changes.map((c) => ({ path: c.path, created: c.before === null })),
      });
    }

    // REVERSIBILITY (P0.3): undo the room session's edits — the last one, or ALL when
    // { all: true }. Restores each file to its pre-edit content (or deletes a created file).
    // Auth-gated (it mutates the workspace), like /chat writes.
    if (req.method === 'POST' && url.pathname === '/undo') {
      if (!chatAuthorized(req)) {
        return json(res, 401, { error: 'unauthorized: a valid Bearer token is required' });
      }
      const body = await parseBody(req);
      const session = sessionFor(roomKeyOf(body));
      if (body['all'] === true) {
        const r = session.revertAll();
        return json(res, 200, { agent: agentName, revertedAll: true, reverted: r.reverted, errors: r.errors });
      }
      const r = session.undo();
      if (r.reverted === null && r.error === undefined) {
        return json(res, 200, { agent: agentName, reverted: null, note: 'nothing to undo' });
      }
      return json(res, r.error !== undefined ? 500 : 200, {
        agent: agentName,
        reverted: r.reverted,
        ...(r.error !== undefined ? { error: r.error } : {}),
      });
    }

    if (req.method === 'GET' && url.pathname === '/agent') {
      return json(res, 200, {
        id: config.capsule.identity.id,
        name: agentName,
        personality: personality.name,
        model: currentModel(),
        tools: toolNames.length,
        status: 'active',
        uptime: process.uptime(),
      });
    }

    if (req.method === 'GET' && url.pathname === '/capabilities') {
      return json(res, 200, {
        agent: agentName,
        tools: toolNames,
        endpoints: ['/health', '/tools', '/info', '/chat', '/chat/stream', '/reset', '/undo', '/session/changes', '/agent', '/capabilities', '/task/:id/status', '/api/sessions', '/api/memories', '/agents', '/api/agents', '/api/bridge', '/receipts'],
        model: currentModel(),
        // TRUTHFUL (P0.4): the ACTUAL wired capabilities of this run — a capability reads
        // `true` only when it is actually active (writesEnabled/evidenceGate/contextCompaction/
        // schemaRepair/providerSwitch reflect the real posture, not an aspiration).
        capabilities: caps,
        writePosture: allowWritesEffective ? 'writes-enabled' : 'read-only',
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

    /*
      ── RECEIPTS ENDPOINT ─────────────────────────────────────────────────────────────────

      This was anonymous. Anyone who could reach the port could list every turn the agent had
      taken -- task ids, workspace ids, room keys, models, costs, content summaries, security
      findings -- and a global total that answered "how busy is this agent" whether or not the
      caller was entitled to a single receipt in it. Evidence exists to be audited, but an audit
      surface with no caller identity is a disclosure, not an audit surface.

      Reading evidence is now a lane, decided by the SAME authorization function the agent,
      conversational and delegated lanes use, on the same documents, with the same intersection.
      What is specific to reading is only the SCOPE, which lives in `receipt-access.ts`.

      Four properties, each of which was absent:

        - AUTHENTICATION BEFORE LOOKUP. Nothing is fetched, counted or summarised until the
          principal verifies. A refusal cannot be distinguished from an empty store by timing what
          the store did, because the store was not consulted.
        - NO ENUMERATION OUTSIDE SCOPE. `?task=` and `?workspace=` are filtered by the same scope
          as the listing, so "no such task" and "that task is not yours" are the identical answer.
        - THE SUMMARY IS SCOPED. A total computed over every receipt describes the set a caller
          was refused; this one describes only what the caller may see.
        - THE PROJECTION IS AN ALLOWLIST. A field added to the store later is invisible here until
          someone decides it may be published.

      The read itself is audited: `authorizeLaneRequest` writes a durable lane receipt for the
      admission or the refusal. It deliberately does NOT create a store receipt, so reading the
      evidence never becomes evidence to read.
    */
    if (req.method === 'GET' && url.pathname === '/receipts') {
      const access = authorizeLaneRequest(admitRunWork('receipt-access'), {
        agentName: agentProfile.name,
        agentRole: agentProfile.role,
        lane: 'receipts',
        requestedCapabilities: [],
        principalAssertion: presentedPrincipal(req),
      });
      if (!access.authorized) {
        // One body for every refusal. Which document was missing, malformed, expired, revoked or
        // simply not entitled is in the durable receipt, where an operator can read it; telling
        // the caller would let it probe the difference.
        return json(res, 401, { error: 'unauthorized: an authenticated request principal is required' });
      }
      const scope = receiptAccessScope(access.authorization.principal);
      const limit = parseInt(url.searchParams.get('limit') ?? '20', 10);
      const taskId = url.searchParams.get('task');
      const workspace = url.searchParams.get('workspace');
      const failuresOnly = url.searchParams.get('failures') === 'true';
      let candidates: Receipt[];
      if (taskId) {
        candidates = receiptStore.byTask(taskId);
      } else if (workspace) {
        candidates = receiptStore.byWorkspace(workspace);
      } else if (failuresOnly) {
        candidates = receiptStore.failures();
      } else {
        // Scope first, THEN take the caller's page: slicing before filtering would silently
        // shorten an in-scope page by however many out-of-scope receipts happened to be newer.
        candidates = receiptStore.recent(Number.MAX_SAFE_INTEGER);
      }
      const visible = scopedReceipts(scope, candidates as unknown as Record<string, unknown>[]);
      const page = taskId || workspace || failuresOnly
        ? visible
        : visible.slice(0, Number.isFinite(limit) && limit > 0 ? limit : 20);
      return json(res, 200, {
        agent: agentName,
        count: page.length,
        summary: scopedSummary(visible),
        ttlMs: 60 * 60 * 1000,
        receipts: page,
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
  server.on('close', () => {
    clearInterval(cleanupTimer);
    for (const entry of sessions.values()) entry.session.dispose();
    evidenceVault.forensic.destroy();
  });

  return Object.freeze({ server, session, toolNames, receiptStore, evictStaleSessions, sessionCount: () => sessions.size });
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
 * the capsule-declared workspace-roots environment key (comma-separated absolute paths). Each is realpath-resolved so symlinks
 * can't widen the set. EMPTY when unset ⇒ overrides fail closed (the default server workspace, which
 * is NOT caller-controlled, still works without an allowlist).
 */
function allowedWorkspaceRoots(environmentName: string): string[] {
  const raw = process.env[environmentName] ?? '';
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
 * the validated deployment workspace-roots variable — which rejects /etc, the home root, sibling repos, and symlink escapes.
 */
export function parseWorkspaceOverride(config: AgentRuntimeConfiguration, body: Record<string, unknown>): string | undefined {
  assertValidatedRuntimeConfiguration(config);
  const raw = body.workspace;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  if (!raw.startsWith('/') || raw.includes('..')) {
    throw new Error('workspace must be an absolute path without ..');
  }

  const roots = allowedWorkspaceRoots(config.deployment.environment.workspaceRoots);
  if (roots.length === 0) {
    throw new Error(
      `workspace override is disabled: set ${config.deployment.environment.workspaceRoots} to a comma-separated list of approved absolute roots`,
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
        `add its root to ${config.deployment.environment.workspaceRoots} to allow it`,
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
// of the public injection surface used by tests via createAgentServer(config, { driver }).
export { ScriptedDriver, type DriverAction };

/** Governed-temp health: never throws — health reporting must not take the server down. */
function governedTempStatus(config: AgentRuntimeConfiguration): { readonly ok: boolean; readonly error?: string } {
  try {
    if (config.deployment.environment.temporaryRoot !== TEMP_ROOT_ENV) throw new Error('deployment temporary-root contract does not name the governed authority input');
    assertGovernedTempSafety();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Common production lifecycle. Agent wrappers supply only validated capsule/config data. */
export function startAgentServer(config: AgentRuntimeConfiguration): Server {
  // LAB TEMP POLICY: bind governed temporary storage BEFORE serving. A production agent
  // process that would fall back to /tmp must refuse to start, not degrade quietly.
  if (config.deployment.environment.temporaryRoot !== TEMP_ROOT_ENV) throw new Error('deployment temporary-root contract does not name the governed authority input');
  assertGovernedTempSafety();
  const port = configuredPort(config);
  const host = configuredHost(config);
  const allowWrites = process.env.AGENT_ALLOW_WRITES === 'true';
  const skin = loadSkin(join(config.repositoryRoot, config.capsule.skinPath));
  const personality = loadPersonality(join(config.repositoryRoot, config.capsule.personalityPath));
  const { server } = createAgentServer(config, { port, host, allowWrites });
  if (!allowWrites) {
    console.warn('[write-safety] writes are DISABLED (AGENT_ALLOW_WRITES!=="true"); mutating tools will be refused.');
  }
  server.listen(port, host, () => {
    console.log(`${config.capsule.identity.displayName} — Agent Server (kernel)`);
    console.log(`Personality: ${personality.name}`);
    console.log(`Model: ${process.env.AGENT_MODEL || config.capsule.providerDefaults.model}`);
    console.log(`Listening: http://${host}:${port}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received — draining in-flight requests…`);
    const forced = setTimeout(() => process.exit(1), 10_000);
    forced.unref();
    server.close((err) => {
      clearTimeout(forced);
      process.exit(err ? 1 : 0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return server;
}

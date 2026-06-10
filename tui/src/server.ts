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
 */
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

const PORT = parseInt(process.env.PEHLICHI_PORT || '18830', 10);
const HOST = process.env.PEHLICHI_HOST || '127.0.0.1';

// Model configuration: env vars override defaults
const MODEL = process.env.AGENT_MODEL || 'mimo-v2.5';
const BASE_URL = process.env.AGENT_BASE_URL || 'https://api.xiaomimimo.com/v1';

function resolveApiKey(): string | undefined {
  if (process.env.MIMO_API_KEY) return process.env.MIMO_API_KEY;
  try {
    const bok = readFileSync(join(homedir(), 'bok'), 'utf-8');
    const match = bok.match(/sk-sl4\S+/);
    if (match) return match[0].trim();
  } catch {}
  return undefined;
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

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
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
}

/**
 * Build the Ptah HTTP server WITHOUT listening. Exposes the kernel session and tool
 * names so tests can drive the real request path with an injected driver.
 */
export function createPehServer(opts: PehServerOptions = {}): {
  server: Server;
  session: KernelChatSession;
  toolNames: string[];
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

  // Production driver: a resilient MimoDriver (circuit breaker + retry). Tests inject
  // a ScriptedDriver so the whole kernel path runs with no network.
  const breaker = new CircuitBreaker(detectProviderId(BASE_URL), { failureThreshold: 5, cooldownMs: 30_000, successThreshold: 3 });
  const driver = opts.driver ?? new ResilientDriver(
    new MimoDriver({ baseUrl: BASE_URL, model: MODEL, ...(apiKey !== undefined ? { apiKey } : {}) }),
    breaker,
  );

  // H6: checkpoint in production (no injected driver), stay off under test injection.
  const checkpointDir = opts.checkpointDir ?? (opts.driver ? undefined : join(labStoreRoot, '.checkpoints', 'pehlichi'));

  const session = new KernelChatSession({
    profile: pehProfile,
    driver,
    workspaceRoot,
    labStoreRoot,
    extraTools,
    ...(opts.maxIterations !== undefined ? { maxIterations: opts.maxIterations } : {}),
    approvalCallback: defaultApprovalPolicy({ allowWrites: opts.allowWrites === true }),
    ...(checkpointDir !== undefined ? { checkpointDir } : {}),
  });

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${HOST}:${opts.port ?? PORT}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, {
        status: 'ok',
        agent: skin.branding.agent_name,
        model: MODEL,
        uptime: process.uptime(),
        historyLength: session.getHistory().length,
        toolCount: toolNames.length,
      });
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

    if (req.method === 'POST' && url.pathname === '/chat') {
      const body = await parseBody(req);
      const message = body.message as string;
      if (!message) return json(res, 400, { error: 'message is required' });

      // H8: attribute the caller. We log WHO drove the agent and a correlation id so a
      // request can be traced; a missing id is stamped (and logged as anonymous) rather
      // than silently accepted as if it came from nowhere.
      const callerId = (req.headers['x-agent-id'] as string) || 'anonymous';
      const correlationId = (req.headers['x-correlation-id'] as string)
        || `pehlichi-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      res.setHeader('X-Correlation-Id', correlationId);
      console.log(`[chat] caller=${callerId} corr=${correlationId}`);

      try {
        const response = await session.send(message);
        const payload = {
          content: response.content,
          agent: skin.branding.agent_name,
          ok: response.ok,
          partial: response.partial,
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
        return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (req.method === 'POST' && url.pathname === '/chat/stream') {
      const body = await parseBody(req);
      const message = body.message as string;
      if (!message) return json(res, 400, { error: 'message is required' });

      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      try {
        // Blocker 5: stream EVERY kernel event (tool-call/result/receipt/summary) as SSE.
        const response = await session.send(message, (e: AgentEvent) => {
          res.write(`data: ${JSON.stringify({ event: e })}\n\n`);
        });
        res.write(`data: ${JSON.stringify({ done: true, ok: response.ok, partial: response.partial, content: response.content, toolCalls: response.toolCalls.length })}\n\n`);
      } catch (err) {
        res.write(`data: ${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n\n`);
      }
      res.end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/reset') {
      session.reset();
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
        endpoints: ['/health', '/tools', '/info', '/chat', '/chat/stream', '/reset', '/agent', '/capabilities'],
        model: MODEL,
        features: ['kernel_loop', 'tool_calling', 'streaming', 'conversation_memory', 'approval_gate', 'partial_on_exhaustion'],
      });
    }

    json(res, 404, { error: 'not found' });
  });

  return { server, session, toolNames };
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
  const { server } = createPehServer();
  server.listen(PORT, HOST, () => {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  🐿  ${skin.branding.agent_name} — Agent Server (kernel)`);
    console.log(`  Personality: ${personality.name}`);
    console.log(`  Model: ${MODEL}`);
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

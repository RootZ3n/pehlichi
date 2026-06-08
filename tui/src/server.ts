#!/usr/bin/env tsx
/**
 * Pehlichi HTTP Server — the squirrel's API home.
 *
 * NOW WITH FULL TOOL-CALLING LOOP.
 * Wraps AgentChatSession in an HTTP API so Peh can run as a systemd service.
 * Endpoints:
 *   GET  /health          — service health check
 *   GET  /tools           — list all available tools
 *   POST /chat            — send a message, get a response (with tool execution)
 *   POST /chat/stream     — send a message, get SSE streaming response
 *   GET  /info            — agent info (skin, personality)
 *   POST /reset           — reset conversation
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentChatSession } from './lib/agent-chat.js';
import { loadSkin } from './lib/skin.js';
import { loadPersonality } from './lib/personality.js';

const PORT = parseInt(process.env.PEHLICHI_PORT || '18830', 10);
const HOST = process.env.PEHLICHI_HOST || '127.0.0.1';

// Load agent info once at startup
const skin = loadSkin();
const personality = loadPersonality();

// Resolve API key: env var → ~/bok fallback
function resolveApiKey(): string | undefined {
  if (process.env.MIMO_API_KEY) return process.env.MIMO_API_KEY;
  try {
    const bok = readFileSync(join(homedir(), 'bok'), 'utf-8');
    const match = bok.match(/sk-sl4\S+/);
    if (match) return match[0].trim();
  } catch {}
  return undefined;
}

// Full agent chat session (with tool-calling loop)
const chat = new AgentChatSession({
  apiKey: resolveApiKey(),
  workspaceRoot: '/pehverse/repos/pehlichi',
  agentServerUrl: `http://127.0.0.1:${PORT}`,
});

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

  // Health check
  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, {
      status: 'ok',
      agent: skin.branding.agent_name,
      model: 'mimo-v2.5',
      uptime: process.uptime(),
      historyLength: chat.getHistory().length,
      toolCount: chat.getToolNames().length,
    });
  }

  // List all available tools
  if (req.method === 'GET' && url.pathname === '/tools') {
    return json(res, 200, {
      agent: skin.branding.agent_name,
      tools: chat.getToolNames(),
      count: chat.getToolNames().length,
    });
  }

  // Agent info
  if (req.method === 'GET' && url.pathname === '/info') {
    return json(res, 200, {
      agent: skin.branding.agent_name,
      personality: personality.name,
      voice_summary: personality.voice_summary,
      intensity: personality.intensity,
      primary_color: skin.theme.primary,
      welcome: skin.branding.welcome,
      goodbye: skin.branding.goodbye,
      toolCount: chat.getToolNames().length,
    });
  }

  // Chat (non-streaming) — with full tool-calling loop
  if (req.method === 'POST' && url.pathname === '/chat') {
    const body = await parseBody(req);
    const message = body.message as string;
    if (!message) {
      return json(res, 400, { error: 'message is required' });
    }

    try {
      const response = await chat.send(message);
      return json(res, 200, {
        content: response.content,
        agent: skin.branding.agent_name,
        thinkingVerb: response.thinkingVerb,
        toolCalls: response.toolCalls?.map((tc) => ({
          name: tc.name,
          args: tc.args,
          ok: tc.result.ok,
          output: tc.result.output?.slice(0, 500),
          error: tc.result.error?.slice(0, 200),
        })),
      });
    } catch (err) {
      return json(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Chat (SSE streaming) — with tool execution events
  if (req.method === 'POST' && url.pathname === '/chat/stream') {
    const body = await parseBody(req);
    const message = body.message as string;
    if (!message) {
      return json(res, 400, { error: 'message is required' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    try {
      const response = await chat.send(message, (chunk) => {
        res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
      });
      res.write(`data: ${JSON.stringify({ done: true, content: response.content, toolCalls: response.toolCalls?.length ?? 0 })}\n\n`);
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n\n`);
    }
    res.end();
    return;
  }

  // Reset conversation
  if (req.method === 'POST' && url.pathname === '/reset') {
    chat.reset();
    return json(res, 200, { status: 'reset', agent: skin.branding.agent_name });
  }

  // Agent identity
  if (req.method === 'GET' && url.pathname === '/agent') {
    return json(res, 200, {
      id: skin.branding.agent_name.toLowerCase(),
      name: skin.branding.agent_name,
      personality: personality.name,
      model: 'mimo-v2.5',
      tools: chat.getToolNames().length,
      status: 'active',
      uptime: process.uptime(),
    });
  }

  // Capabilities
  if (req.method === 'GET' && url.pathname === '/capabilities') {
    return json(res, 200, {
      agent: skin.branding.agent_name,
      tools: chat.getToolNames(),
      endpoints: ['/health', '/tools', '/info', '/chat', '/chat/stream', '/reset', '/agent', '/capabilities'],
      model: 'mimo-v2.5',
      features: ['tool_calling', 'streaming', 'conversation_memory', 'progressive_disclosure'],
    });
  }

  // 404
  json(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  🐿  ${skin.branding.agent_name} — Agent Server`);
  console.log(`  Personality: ${personality.name}`);
  console.log(`  Model: mimo-v2.5`);
  console.log(`  Tools: ${chat.getToolNames().length} registered`);
  console.log(`  Listening: http://${HOST}:${PORT}`);
  console.log(`  Endpoints:`);
  console.log(`    GET  /health       — health check`);
  console.log(`    GET  /tools        — list all tools`);
  console.log(`    GET  /info         — agent info`);
  console.log(`    POST /chat         — send message (with tool execution)`);
  console.log(`    POST /chat/stream  — streaming chat`);
  console.log(`    POST /reset        — reset conversation`);
  console.log(`${'═'.repeat(60)}\n`);
  console.log(`  ${skin.branding.welcome}\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\n  🐿 Farewell, good sir. May your acorns be plentiful.\n');
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  console.log('\n  🐿 Caught a signal! Scurrying away...\n');
  server.close(() => process.exit(0));
});

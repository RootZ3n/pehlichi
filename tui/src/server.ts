#!/usr/bin/env tsx
/**
 * Pehlichi HTTP Server — the squirrel's API home.
 *
 * Wraps ChatSession in an HTTP API so Peh can run as a systemd service.
 * Endpoints:
 *   GET  /health          — service health check
 *   POST /chat            — send a message, get a response
 *   POST /chat/stream     — send a message, get SSE streaming response
 *   GET  /info            — agent info (skin, personality)
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ChatSession } from './lib/chat.js';
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

// Persistent chat session (maintains conversation history)
const chat = new ChatSession({ apiKey: resolveApiKey() });

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
    });
  }

  // Chat (non-streaming)
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
      });
    } catch (err) {
      return json(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Chat (SSE streaming)
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
      res.write(`data: ${JSON.stringify({ done: true, content: response.content })}\n\n`);
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n\n`);
    }
    res.end();
    return;
  }

  // Reset conversation
  if (req.method === 'POST' && url.pathname === '/reset') {
    // Create fresh chat session
    (chat as any).messages = [{
      role: 'system',
      content: (chat as any).systemPrompt,
      timestamp: Date.now(),
    }];
    return json(res, 200, { status: 'reset', agent: skin.branding.agent_name });
  }

  // 404
  json(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  🐿  ${skin.branding.agent_name} — API Server`);
  console.log(`  Personality: ${personality.name}`);
  console.log(`  Model: mimo-v2.5`);
  console.log(`  Listening: http://${HOST}:${PORT}`);
  console.log(`  Endpoints:`);
  console.log(`    GET  /health       — health check`);
  console.log(`    GET  /info         — agent info`);
  console.log(`    POST /chat         — send message`);
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

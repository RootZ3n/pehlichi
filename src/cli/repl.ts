#!/usr/bin/env node
/**
 * Agent REPL — thin terminal client for the lab agent HTTP API.
 *
 * Usage:
 *   node dist/cli/repl.js
 *   node dist/cli/repl.js --room <id>
 *
 * Connects to AGENT_URL (falls back to the agent's own profile url).
 * Designed for Ittunaha runtime workspace embedding.
 */
import * as readline from 'node:readline';
import { agentProfile } from '../profile.js';

const BASE_URL = process.env.AGENT_URL ?? agentProfile.url ?? 'http://127.0.0.1:18830';
const ROOM_ID = process.argv.includes('--room')
  ? process.argv[process.argv.indexOf('--room') + 1] || 'repl'
  : 'repl';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function prompt(): void {
  rl.question(`${agentProfile.icon ?? '›'}  `, async (input) => {
    const msg = input.trim();
    if (!msg) { prompt(); return; }
    if (msg === '/exit' || msg === '/quit') {
      console.log('Bye!');
      rl.close();
      process.exit(0);
    }
    if (msg === '/reset') {
      try {
        await fetch(`${BASE_URL}/reset`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ context: { roomId: ROOM_ID } }),
        });
        console.log('Session reset.');
      } catch (e) { console.error('Reset failed:', (e as Error).message); }
      prompt();
      return;
    }
    if (msg === '/wo' || msg.startsWith('/wo ')) {
      await handleWorkOrderCommand(msg);
      prompt();
      return;
    }
    if (msg === '/health') {
      try {
        const res = await fetch(`${BASE_URL}/health`);
        const data = await res.json() as Record<string, unknown>;
        console.log(JSON.stringify(data, null, 2));
      } catch (e) { console.error('Health check failed:', (e as Error).message); }
      prompt();
      return;
    }

    try {
      const start = Date.now();
      const res = await fetch(`${BASE_URL}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: msg, context: { roomId: ROOM_ID } }),
        signal: AbortSignal.timeout(120_000),
      });
      const data = await res.json() as Record<string, unknown>;
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const content = typeof data.content === 'string' ? data.content : JSON.stringify(data);
      console.log(`\n${content}`);
      const partial = data.partial ? ' [partial]' : '';
      const receiptId = data.receiptId ? ` receipt:${data.receiptId}` : '';
      console.log(`\n[${elapsed}s${partial}${receiptId}]`);
    } catch (e) {
      console.error('Error:', (e as Error).message);
    }
    prompt();
  });
}

console.log(`${agentProfile.icon ?? '›'}  ${agentProfile.name} REPL — connected to ${BASE_URL} (room: ${ROOM_ID})`);
console.log('   Type a message, or /exit, /reset, /health, /wo list [status], /wo get <id>, /wo transition <id> <status> [note]\n');
prompt();

async function handleWorkOrderCommand(input: string): Promise<void> {
  const parts = input.split(/\s+/);
  const action = parts[1];
  try {
    if (action === 'list') {
      const status = parts[2];
      const url = new URL('/work-orders', BASE_URL);
      if (status) url.searchParams.set('status', status);
      const res = await fetch(url);
      const data = await res.json() as Record<string, unknown>;
      if (!res.ok) {
        console.error(`Work-order list failed: ${String(data.error ?? res.statusText)}`);
        return;
      }
      const orders = Array.isArray(data.workOrders) ? data.workOrders : [];
      for (const item of orders) {
        const row = item as Record<string, unknown>;
        console.log(`${row.id}  ${row.status}  ${row.severity}  ${row.title}`);
      }
      console.log(`\n${orders.length} work order(s)`);
      return;
    }
    if (action === 'get') {
      const id = parts[2];
      if (!id) {
        console.error('Usage: /wo get <id>');
        return;
      }
      const res = await fetch(`${BASE_URL}/work-orders/${encodeURIComponent(id)}`);
      const data = await res.json() as Record<string, unknown>;
      if (!res.ok) {
        console.error(`Work-order get failed: ${String(data.error ?? res.statusText)}`);
        return;
      }
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    if (action === 'transition') {
      const id = parts[2];
      const status = parts[3];
      const note = parts.slice(4).join(' ').trim();
      if (!id || !status) {
        console.error('Usage: /wo transition <id> <status> [note]');
        return;
      }
      const res = await fetch(`${BASE_URL}/work-orders/${encodeURIComponent(id)}/transition`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status, ...(note ? { note } : {}) }),
      });
      const data = await res.json() as Record<string, unknown>;
      if (!res.ok) {
        console.error(`Work-order transition failed: ${String(data.error ?? res.statusText)}`);
        return;
      }
      console.log(`${data.id} -> ${data.status}`);
      return;
    }
  } catch (e) {
    console.error('Work-order command failed:', (e as Error).message);
    return;
  }
  console.log('Usage: /wo list [status] | /wo get <id> | /wo transition <id> <status> [note]');
}

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
import { closeSync, openSync, readFileSync } from 'node:fs';
import * as readline from 'node:readline';
import { agentProfile } from '../profile.js';

const BASE_URL = process.env.AGENT_URL ?? agentProfile.url ?? 'http://127.0.0.1:18830';

/*
  THE OPERATOR'S OWN AUTHORITY, read from a file rather than taken from the environment.

  This REPL is a person at a terminal, and the agent now decides what that person may do from a
  principal issued outside every repository. Two deliberate choices about how it gets here:

    - A PATH in the environment, never the assertion itself. An environment variable holding a
      bearer document is inherited by every process this shell spawns, appears in
      `/proc/<pid>/environ`, and lands in a shell history or a systemd dump the moment anyone
      debugs anything. A path is not a secret; the file it names is, and the filesystem is where
      secrets already have owners and modes.
    - NEVER argv. A command line is world-readable on this machine.

  Absent, the REPL still runs and the agent refuses it, which is the correct failure: an operator
  who has not been issued authority should be told so by the boundary, not quietly served.
*/
const OPERATOR_PRINCIPAL = ((): string => {
  const file = process.env.AGENT_PRINCIPAL_FILE;
  if (typeof file !== 'string' || file.length === 0) return '';
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    return readFileSync(fd, 'utf8').trim();
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
})();

/** Authentication and authorization on separate headers, because they answer separate questions. */
function agentHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = process.env.AGENT_CHAT_TOKEN;
  if (typeof token === 'string' && token.length > 0) headers['authorization'] = `Bearer ${token}`;
  if (OPERATOR_PRINCIPAL.length > 0) headers['x-pehverse-principal'] = OPERATOR_PRINCIPAL;
  return headers;
}
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
          headers: agentHeaders(),
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
        const res = await fetch(`${BASE_URL}/health`, { headers: agentHeaders() });
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
        headers: agentHeaders(),
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
      const res = await fetch(url, { headers: agentHeaders() });
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
      const res = await fetch(`${BASE_URL}/work-orders/${encodeURIComponent(id)}`, { headers: agentHeaders() });
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
        headers: agentHeaders(),
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

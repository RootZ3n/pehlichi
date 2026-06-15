#!/usr/bin/env node
/**
 * Pehlichi REPL — thin terminal client for the Pehlichi agent HTTP API.
 *
 * Usage:
 *   node dist/cli/repl.js              # interactive REPL
 *   node dist/cli/repl.js --room <id>  # with a specific room id
 *
 * Connects to PEHLICHI_URL (default http://127.0.0.1:18830).
 * Designed for Ittunaha runtime workspace embedding.
 */
import * as readline from 'node:readline';

const BASE_URL = process.env.PEHLICHI_URL || 'http://127.0.0.1:18830';
const ROOM_ID = process.argv.includes('--room')
  ? process.argv[process.argv.indexOf('--room') + 1] || 'repl'
  : 'repl';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function prompt(): void {
  rl.question('🐿  ', async (input) => {
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

console.log(`🐿  Pehlichi REPL — connected to ${BASE_URL} (room: ${ROOM_ID})`);
console.log('   Type a message, or /exit, /reset, /health\n');
prompt();

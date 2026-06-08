#!/usr/bin/env tsx
/**
 * Chat Harness — test the agent's personality and runtime from the CLI.
 * No TTY needed. Sends a message, prints the response.
 *
 * Usage:
 *   npx tsx src/harness.ts "Hello, who are you?"
 *   npx tsx src/harness.ts --interactive
 *   MIMO_API_KEY=xxx npx tsx src/harness.ts "What can you help with?"
 */
import { ChatSession } from './lib/chat.js';
import { loadSkin } from './lib/skin.js';
import { loadPersonality } from './lib/personality.js';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

async function main() {
  const args = process.argv.slice(2);
  const interactive = args.includes('--interactive') || args.includes('-i');
  const message = args.filter(a => !a.startsWith('--')).join(' ');

  // Load and display agent info
  const skin = loadSkin();
  const personality = loadPersonality();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Agent: ${skin.branding.agent_name}`);
  console.log(`  Personality: ${personality.name} — ${personality.voice_summary.slice(0, 80)}...`);
  console.log(`  Intensity: ${personality.intensity}`);
  console.log(`  Primary Color: ${skin.theme.primary}`);
  console.log(`${'═'.repeat(60)}\n`);

  // Read API key from environment or ~/bok
  let apiKey = process.env.MIMO_API_KEY;
  if (!apiKey) {
    try {
      const { readFileSync } = await import('node:fs');
      const { homedir } = await import('node:os');
      const { join } = await import('node:path');
      const bok = readFileSync(join(homedir(), 'bok'), 'utf-8');
      const match = bok.match(/sk-sl4\S+/);
      if (match) apiKey = match[0];
    } catch {}
  }

  // Create chat session
  const chat = new ChatSession({ apiKey });

  if (interactive) {
    // Interactive mode — REPL loop
    const rl = readline.createInterface({ input: stdin, output: stdout });
    console.log(`  ${skin.branding.welcome}`);
    console.log(`  (Type 'exit' or 'quit' to leave)\n`);

    while (true) {
      const input = await rl.question(`${skin.branding.prompt_symbol} `);
      if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
        console.log(`\n  ${skin.branding.goodbye}\n`);
        break;
      }
      if (!input.trim()) continue;

      const verb = skin.spinner.thinking_verbs[Math.floor(Math.random() * skin.spinner.thinking_verbs.length)] ?? 'thinking';
      process.stdout.write(`  ${skin.spinner.thinking_faces[0] ?? '⠋'} ${verb}...`);

      try {
        const response = await chat.send(input);
        // Clear the thinking line
        process.stdout.write('\r' + ' '.repeat(60) + '\r');
        console.log(`\n${skin.branding.response_label}`);
        console.log(`${response.content}\n`);
      } catch (err) {
        process.stdout.write('\r' + ' '.repeat(60) + '\r');
        console.error(`\n  [Error: ${err instanceof Error ? err.message : String(err)}]\n`);
      }
    }

    rl.close();
  } else if (message) {
    // Single message mode
    const verb = skin.spinner.thinking_verbs[Math.floor(Math.random() * skin.spinner.thinking_verbs.length)] ?? 'thinking';
    console.log(`  ${skin.spinner.thinking_faces[0] ?? '⠋'} ${verb}...`);

    try {
      const response = await chat.send(message);
      console.log(`\n${skin.branding.response_label}`);
      console.log(`${response.content}\n`);
    } catch (err) {
      console.error(`\n  [Error: ${err instanceof Error ? err.message : String(err)}]\n`);
      process.exit(1);
    }
  } else {
    // Info mode — just show agent details
    console.log('  No message provided. Usage:');
    console.log('    npx tsx src/harness.ts "Hello, who are you?"');
    console.log('    npx tsx src/harness.ts --interactive');
    console.log('');
    console.log('  Environment:');
    console.log(`    MIMO_API_KEY: ${process.env.MIMO_API_KEY ? '(set)' : '(not set)'}`);
    console.log(`    MIMO_BASE_URL: ${process.env.MIMO_BASE_URL ?? '(default)'}`);
    console.log('');
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

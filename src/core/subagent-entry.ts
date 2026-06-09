/**
 * SUB-AGENT RUNNER — one delegated agent, one process.
 *
 * This is the production runner that `delegate_task` spawns. It reads ONE JSON job
 * ({ goal, context, toolsets }) from stdin, runs a COMPLETE, independent agent loop
 * (its own conversation, its own tool registry, a fresh disposable shadow workspace)
 * to accomplish the goal, and prints exactly ONE JSON result line to stdout:
 *
 *     { "ok": boolean, "output": string, "error"?: string }
 *
 * Diagnostics go to stderr; stdout carries ONLY the result line, because the parent
 * (delegate-tools.ts) parses the last JSON object on stdout. The sub-agent shares no
 * state with its parent beyond this stdin→stdout channel.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MimoDriver, runAgentInShadow, type AgentEvent, type AgentProfile } from './index.js';

interface Job {
  readonly goal: string;
  readonly context?: string;
  readonly toolsets?: string[];
}

const SUBAGENT_PROFILE: AgentProfile = {
  name: 'Subagent',
  role: 'builder',
  personaPreamble: 'You are a focused sub-agent. Accomplish the delegated task, then finish with done.',
  skillTags: [],
};

function readStdin(): Promise<string> {
  return new Promise((resolveStdin) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c: string) => { data += c; });
    process.stdin.on('end', () => resolveStdin(data));
  });
}

function print(result: { ok: boolean; output: string; error?: string }): void {
  process.stdout.write(JSON.stringify(result) + '\n');
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let job: Job;
  try {
    job = JSON.parse(raw) as Job;
  } catch (err) {
    print({ ok: false, output: '', error: `invalid job JSON: ${msg(err)}` });
    return;
  }
  if (typeof job.goal !== 'string' || job.goal.trim() === '') {
    print({ ok: false, output: '', error: 'job is missing a goal' });
    return;
  }

  const task = [
    `TASK: ${job.goal}`,
    job.context ? `\nCONTEXT:\n${job.context}` : '',
    '\nComplete the task and finish with done, summarizing what you did and the results.',
  ].join('\n');

  const labStore = mkdtempSync(join(tmpdir(), 'subagent-store-'));
  const events: AgentEvent[] = [];
  try {
    // A REAL, independent loop in its own disposable shadow workspace.
    await runAgentInShadow({
      profile: SUBAGENT_PROFILE,
      task,
      labStoreRoot: labStore,
      driver: new MimoDriver(),
      sinks: [(e) => events.push(e)],
      plan: false,
    });
    const summary = events.find((e): e is Extract<AgentEvent, { kind: 'summary' }> => e.kind === 'summary');
    const output = summary
      ? [summary.rootCause, ...summary.changes, ...summary.verification].join('\n')
      : '(sub-agent finished without a summary)';
    print({ ok: true, output });
  } catch (err) {
    print({ ok: false, output: '', error: `sub-agent failed: ${msg(err)}` });
  } finally {
    rmSync(labStore, { recursive: true, force: true });
  }
}

void main();

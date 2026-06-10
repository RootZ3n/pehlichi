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

import { MimoDriver, runAgentInShadow, type AgentEvent, type AgentProfile, type ToolDef } from './index.js';
import {
  createDelegateToolHandlers,
  delegateToolSpecs,
} from './agent-tools/delegate-tools.js';
import { resolveSubagentRunner } from './agent-tools/index.js';
import { defaultApprovalPolicy } from './approval-policy.js';

interface Job {
  readonly goal: string;
  readonly context?: string;
  readonly toolsets?: string[];
  /** COORDINATION (Blocker 7): the delegation chain (ancestor goals) that led here. */
  readonly delegatedFrom?: string[];
  /**
   * APPROVAL (N5): the approval posture inherited from the parent. Absent => the
   * restrictive default (writes gated off), so a delegated sub-agent never gains
   * write authority the spawning policy did not have.
   */
  readonly approvalPolicy?: { readonly allowWrites?: boolean };
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

  // CIRCULAR DELEGATION PROTECTION (defense-in-depth): even if a cyclic job slips
  // past the parent's pre-spawn check, a chain that contains a repeat is refused
  // HERE, before any model runs, so an A→B→A cycle cannot start work.
  const chain = Array.isArray(job.delegatedFrom) ? job.delegatedFrom : [];
  if (new Set(chain).size !== chain.length) {
    print({
      ok: false,
      output: '',
      error: `circular delegation detected: the delegation chain repeats an entry [${chain.join(' -> ')}]`,
    });
    return;
  }

  const task = [
    `TASK: ${job.goal}`,
    job.context ? `\nCONTEXT:\n${job.context}` : '',
    '\nComplete the task and finish with done, summarizing what you did and the results.',
  ].join('\n');

  // COORDINATION: give the sub-agent its OWN delegate tool, carrying the chain that
  // led here, so a deeper delegation keeps growing the chain and stays cycle-protected.
  const allowWrites = job.approvalPolicy?.allowWrites === true;
  const runner = resolveSubagentRunner();
  const delegateHandlers = createDelegateToolHandlers({
    runnerPath: runner.runnerPath,
    nodeArgs: runner.nodeArgs,
    delegatedFrom: chain,
    // Carry the SAME approval posture down to any grandchild this sub-agent spawns.
    allowWrites,
  });
  const extraTools: ToolDef[] = [];
  for (const spec of delegateToolSpecs) {
    const handler = delegateHandlers.get(spec.name);
    if (handler) extraTools.push({ spec, handler });
  }

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
      extraTools,
      // APPROVAL GATE (N5): a delegated sub-agent runs under the SAME approval policy
      // a fresh session would — writes gated off unless the parent explicitly granted
      // them. Without this the loop defaults to approve-everything.
      approvalCallback: defaultApprovalPolicy({ allowWrites }),
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

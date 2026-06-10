/**
 * DELEGATE TASK TOOL — spawn a REAL sub-agent process.
 *
 * Tool name matches Hermes: delegate_task.
 *
 * Earlier this POSTed back to the agent's own /chat server — the "sub-agent" was
 * the same process answering itself. This version spawns a genuinely SEPARATE node
 * process (the sub-agent runner) that runs its OWN agent loop with its OWN
 * conversation and tool registry. Communication is a single JSON job written to the
 * child's stdin and a single JSON result read from its stdout. The parent blocks
 * until the child reports a result or a hard timeout (default 5 minutes) fires, at
 * which point the child is killed and a timeout error is returned. There is no
 * shared state between parent and child beyond that stdin/stdout channel.
 */
import { spawn } from 'node:child_process';

import type { ToolSpec, ToolHandler, ToolResult } from '../tools.js';

const obj = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false });

export const delegateToolSpecs: ToolSpec[] = [
  {
    name: 'delegate_task',
    description: 'Spawn a sub-agent (a separate process) to handle a task. Returns the agent\'s final summary.',
    parameters: obj(
      {
        goal: { type: 'string', description: 'What the sub-agent should accomplish' },
        context: { type: 'string', description: 'Background info the sub-agent needs' },
        toolsets: { type: 'array', items: { type: 'string' }, description: 'Toolsets to enable (terminal, file, web, browser)' },
      },
      ['goal'],
    ),
  },
];

/** Default sub-agent budget: 5 minutes. */
export const DELEGATE_TIMEOUT = 300_000;

/** What a delegated sub-agent prints to stdout (a single JSON object). */
export interface SubagentResult {
  readonly ok: boolean;
  readonly output: string;
  readonly error?: string;
}

/**
 * The job written to a sub-agent's stdin. `delegatedFrom` is the COORDINATION chain
 * (Blocker 7): the ordered list of goals along the delegation path that led here.
 * A child appends its own goal before spawning a grandchild, so the chain grows with
 * depth and a repeat anywhere in it is a cycle.
 */
export interface SubagentJob {
  readonly goal: string;
  readonly context: string;
  readonly toolsets: string[];
  readonly delegatedFrom: string[];
  /** APPROVAL (N5): the approval posture the sub-agent must run under. */
  readonly approvalPolicy: { readonly allowWrites: boolean };
}

export interface DelegateConfig {
  /**
   * Path to a node script that runs ONE sub-agent: it reads a JSON job
   * ({ goal, context, toolsets, delegatedFrom }) on stdin and prints a JSON
   * SubagentResult on stdout. In production this is the subagent entry; tests point
   * it at a fixture runner so the real spawn/communication/timeout path is exercised
   * without a model.
   */
  readonly runnerPath: string;
  /** Node executable to spawn (defaults to the current process's node). */
  readonly nodePath?: string;
  /** Args inserted BEFORE the runner path (e.g. ["--import", "tsx"] to run TS directly). */
  readonly nodeArgs?: readonly string[];
  /** Hard timeout in ms before the child is killed (default 300000 — 5 minutes). */
  readonly timeoutMs?: number;
  /**
   * COORDINATION (Blocker 7): the delegation chain that led to THIS agent — the goals
   * of every ancestor delegation, oldest first. Empty/unset for a top-level agent. The
   * handler appends the new goal and refuses to spawn when that goal is already in the
   * chain (a cycle, e.g. A→B→A), so circular delegation is caught BEFORE a child spawns.
   */
  readonly delegatedFrom?: readonly string[];
  /**
   * APPROVAL (N5): whether the spawning policy permits write/destructive tools. The
   * spawned sub-agent inherits this posture (default false => writes gated off), so
   * delegation can never escalate authority beyond the parent.
   */
  readonly allowWrites?: boolean;
  /**
   * DEPTH LIMIT (H8): the maximum delegation depth — how many delegation hops are
   * allowed from the top-level agent. `delegatedFrom.length` IS the current depth, so a
   * spawn is refused once it would exceed maxDepth. Default 2 (top-level → child →
   * grandchild); a grandchild may not delegate further. Without this, a chain of
   * delegations can spawn processes without bound.
   */
  readonly maxDepth?: number;
}

/** Default maximum delegation depth (top-level → child → grandchild). */
export const DEFAULT_MAX_DELEGATION_DEPTH = 2;

/** Normalize a goal into the stable key used for cycle detection. */
export function delegationKey(goal: string): string {
  return goal.trim();
}

export function createDelegateToolHandlers(config: DelegateConfig): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const nodePath = config.nodePath ?? process.execPath;
  const nodeArgs = config.nodeArgs ?? [];
  const timeoutMs = config.timeoutMs ?? DELEGATE_TIMEOUT;
  const chain = config.delegatedFrom ?? [];
  const allowWrites = config.allowWrites === true;
  const maxDepth = config.maxDepth ?? DEFAULT_MAX_DELEGATION_DEPTH;

  handlers.set('delegate_task', async (args): Promise<ToolResult> => {
    const goal = args.goal as string;
    const context = (args.context as string) ?? '';
    const toolsets = (args.toolsets as string[]) ?? ['terminal', 'file', 'web'];

    // CIRCULAR DELEGATION PROTECTION: refuse BEFORE spawning if this goal already
    // appears in the chain that led here. The child never starts, so a cycle cannot
    // consume a process slot or a timeout. Checked BEFORE the depth limit so a cycle is
    // always reported as a cycle (even when the chain has also reached max depth).
    const key = delegationKey(goal);
    if (chain.includes(key)) {
      return {
        ok: false,
        output: '',
        error: `circular delegation detected: "${key}" is already in the delegation chain [${chain.join(' -> ')}]`,
      };
    }

    // DEPTH LIMIT (H8): the chain that led here IS the current depth. Refuse BEFORE
    // spawning when one more hop would exceed maxDepth, so an unbounded delegation
    // chain cannot consume process slots and resources without limit.
    if (chain.length >= maxDepth) {
      return {
        ok: false,
        output: '',
        error: `delegation depth limit reached (max ${maxDepth}): chain is [${chain.join(' -> ')}]. Complete this work directly instead of delegating further.`,
      };
    }

    const job: SubagentJob = { goal, context, toolsets, delegatedFrom: [...chain, key], approvalPolicy: { allowWrites } };
    return runSubagent(nodePath, [...nodeArgs, config.runnerPath], JSON.stringify(job), timeoutMs);
  });

  return handlers;
}

/**
 * Spawn the runner, hand it the job on stdin, and resolve with its result. The
 * promise NEVER rejects — a spawn failure, non-zero exit, or timeout all resolve to
 * a `{ ok:false }` ToolResult so the loop treats it like any other tool failure.
 */
function runSubagent(cmd: string, argv: string[], job: string, timeoutMs: number): Promise<ToolResult> {
  return new Promise<ToolResult>((resolveResult) => {
    const child = spawn(cmd, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const settle = (r: ToolResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(r);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle({ ok: false, output: stdout.trim(), error: `sub-agent timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => { stdout += d; });
    child.stderr?.on('data', (d: string) => { stderr += d; });
    child.on('error', (err) => settle({ ok: false, output: '', error: `failed to spawn sub-agent: ${err.message}` }));
    child.on('close', (code) => {
      const parsed = parseResult(stdout);
      if (parsed !== undefined) {
        settle({ ok: parsed.ok, output: parsed.output, ...(parsed.error !== undefined ? { error: parsed.error } : {}) });
        return;
      }
      // No parsable result — report the exit and a slice of stderr for diagnosis.
      settle(
        code === 0
          ? { ok: true, output: stdout.trim() }
          : { ok: false, output: stdout.trim(), error: `sub-agent exited ${code ?? 'null'}: ${stderr.slice(0, 300)}` },
      );
    });

    child.stdin?.write(job);
    child.stdin?.end();
  });
}

/** Parse the LAST JSON object the runner printed (so leading diagnostics are tolerated). */
function parseResult(stdout: string): SubagentResult | undefined {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined || !line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.ok === 'boolean' && typeof parsed.output === 'string') {
        return { ok: parsed.ok, output: parsed.output, ...(typeof parsed.error === 'string' ? { error: parsed.error } : {}) };
      }
    } catch {
      // not JSON — keep scanning earlier lines
    }
  }
  return undefined;
}

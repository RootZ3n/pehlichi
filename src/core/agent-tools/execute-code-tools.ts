/**
 * EXECUTE CODE TOOL — contained code execution.
 *
 * Tool name matches Hermes: execute_code.
 * Runs Python or Node.js code inside the lab's execution boundary.
 *
 * CONTAINMENT (lab-containment, vendored at ../containment/).
 * The code this tool runs is, by definition, code nobody reviewed. It executes under the worktree
 * view: the whole host is bound READ-ONLY, this run's governed scratch is the single writable path,
 * and all namespaces are unshared.
 *
 * TWO OBSERVABLE CHANGES, stated rather than hidden:
 *
 *   1. Executed code NO LONGER HAS NETWORK ACCESS. An interpreter is classified `interpreter`, which
 *      does not carry a network need, so the sandbox holds an empty network namespace. Code that
 *      previously fetched a URL now fails to resolve it. This is the point of the change, not a
 *      regression, but it is a contract change and callers can see it.
 *   2. Executed code can no longer write outside the run's scratch directory. It never should have
 *      been able to; it could.
 *   3. Executed code can no longer create a unix socket. An independent audit demonstrated
 *      contained code connecting to a host listener created outside every declared workspace: the
 *      network namespace does not cover unix sockets and mount masking cannot, since such a socket
 *      can be anywhere. A seccomp filter refuses the address family at the syscall boundary.
 *
 * There is NO fallback. If the boundary is unavailable the tool refuses and says why. It does not
 * quietly run the code the old way, because "the sandbox was missing" is precisely the moment
 * arbitrary code must not run.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ToolSpec, ToolHandler, ToolResult } from '../tools.js';
import { processScratchDir } from '../temp-authority.js';
import { agentContainmentConfig } from '../containment-config.js';
import { planFor } from '../containment/policy.js';
import { wrap } from '../containment/wrap.js';

const obj = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false });

export const executeCodeToolSpecs: ToolSpec[] = [
  {
    name: 'execute_code',
    description: 'Run Python or Node.js code in a sandboxed subprocess. Returns stdout/stderr.',
    parameters: obj(
      {
        code: { type: 'string', description: 'Code to execute' },
        language: { type: 'string', enum: ['python', 'node'], description: 'Language (default: python)' },
        timeout_ms: { type: 'number', description: 'Timeout in ms (default 60000)' },
      },
      ['code'],
    ),
  },
];

const EXEC_TIMEOUT = 60_000;
const MAX_OUTPUT = 64 * 1024; // 64KB

export function createExecuteCodeToolHandlers(): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  handlers.set('execute_code', async (args): Promise<ToolResult> => {
    const code = args.code as string;
    const language = (args.language as string) ?? 'python';
    const timeout = (args.timeout_ms as number) ?? EXEC_TIMEOUT;

    // Write code to a governed scratch file — never /tmp
    const scratch = processScratchDir();
    const id = randomBytes(8).toString('hex');
    const ext = language === 'python' ? '.py' : '.mjs';
    const tmpFile = join(scratch, `exec-${id}${ext}`);

    try {
      writeFileSync(tmpFile, code, 'utf8');

      const command = language === 'python' ? 'python3' : 'node';

      // Decide BEFORE spawning. A refusal is a value carrying no policy, so there is no shape of
      // code below this point that could run the command anyway.
      const decision = planFor(
        { command, args: [tmpFile], writableRoot: scratch, cwd: scratch, tempRoot: scratch },
        agentContainmentConfig(),
      );
      if (!decision.allowed) {
        return {
          ok: false,
          output: '',
          error: `execute_code refused [${decision.denial.code}]: ${decision.denial.reason}`,
        };
      }

      // `contained.stdio` carries the AF_UNIX syscall filter on the descriptor bwrap was told to
      // read it from. Spawning with anything else makes bwrap refuse to start, so a mistake here is
      // a loud failure rather than a quiet run without the filter.
      const contained = wrap(decision, command, [tmpFile]);
      let result;
      try {
        result = spawnSync(contained.binary, [...contained.args], {
          encoding: 'utf8',
          timeout,
          maxBuffer: 8 * 1024 * 1024,
          stdio: [...contained.stdio] as never,
          env: {
            PATH: '/usr/local/bin:/usr/bin:/bin',
            HOME: scratch,
            TMPDIR: scratch,
            TMP: scratch,
            TEMP: scratch,
            LANG: 'C.UTF-8',
          },
        });
      } finally {
        contained.dispose();
      }

      const stdout = capOutput(result.stdout ?? '');
      const stderr = capOutput(result.stderr ?? '');
      const exitCode = result.status ?? -1;
      const timedOut = (result.error as any)?.code === 'ETIMEDOUT';

      const output = [
        `exitCode: ${exitCode}`,
        stdout ? `stdout:\n${stdout}` : '',
        stderr ? `stderr:\n${stderr}` : '',
        timedOut ? `timed out after ${timeout}ms` : '',
      ].filter(Boolean).join('\n');

      return {
        ok: exitCode === 0,
        output,
        ...(exitCode !== 0 ? { error: `Process exited with code ${exitCode}` } : {}),
      };
    } catch (err) {
      return { ok: false, output: '', error: `Execution failed: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  });

  return handlers;
}

function capOutput(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return text.slice(0, MAX_OUTPUT) + '\n[truncated]';
}

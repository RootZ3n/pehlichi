/**
 * EXECUTE CODE TOOL — sandboxed code execution.
 *
 * Tool name matches Hermes: execute_code.
 * Runs Python or Node.js code in a sandboxed subprocess.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { ToolSpec, ToolHandler, ToolResult } from '../tools.js';

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

    // Write code to temp file
    const id = randomBytes(8).toString('hex');
    const ext = language === 'python' ? '.py' : '.mjs';
    const tmpFile = join(tmpdir(), `exec-${id}${ext}`);

    try {
      mkdirSync(join(tmpdir()), { recursive: true });
      writeFileSync(tmpFile, code, 'utf8');

      const command = language === 'python' ? 'python3' : 'node';
      const result = spawnSync(command, [tmpFile], {
        encoding: 'utf8',
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          PATH: '/usr/local/bin:/usr/bin:/bin',
          HOME: tmpdir(),
          TMPDIR: tmpdir(),
          LANG: 'C.UTF-8',
        },
      });

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

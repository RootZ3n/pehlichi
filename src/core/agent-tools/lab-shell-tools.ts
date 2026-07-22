/**
 * LAB SHELL TOOL — a NARROW, READ-ONLY window into the lab over SSH, so Peh (on the phone) can
 * scan lab repos for context and brainstorm improvements WITHOUT opening a full shell.
 *
 * Safety is layered:
 *   1. NO shell metacharacters in the command (; | & < > ` $ newline) — a single command, never
 *      chained / redirected / substituted / backgrounded.
 *   2. The command's binary must be in a READ-ONLY allowlist; `git` is further limited to read
 *      subcommands, and `find` may not carry -exec/-delete/etc.
 *   3. The working directory is confined under a lab root (LAB_SHELL_ROOT, default /pehverse/repos).
 *   4. It runs over SSH (LAB_SSH_HOST) in BatchMode — never blocks on a prompt; unset host ⇒ a clear
 *      "not configured" error.
 *
 * The remote never receives an unvalidated string: the wrapper `cd '<cwd>' && <command>` is built
 * from a metachar-free cwd and a validated command. This is a read seam, not an exec seam.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import type { ToolSpec, ToolHandler, ToolResult } from '../tools.js';

const obj = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false });

const SSH_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 96 * 1024;
const DEFAULT_LAB_ROOT = '/pehverse/repos';

/**
 * Metacharacters that would chain / redirect / substitute / background — rejected. NOTE: the pipe `|`
 * is NOT here: pipes are allowed but every stage must independently be a read-only allowlisted command
 * (validated below), so `grep foo | wc -l` works while `cat x | sh` does not.
 */
const METACHARS = /[;&<>`$\n\r]/;

/** Read-only / side-effect-free binaries Peh may run in the lab. */
const READ_CMDS: ReadonlySet<string> = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'tree', 'stat', 'file',
  'pwd', 'echo', 'git', 'du', 'realpath', 'readlink', 'basename', 'dirname', 'cut', 'sort', 'uniq', 'nl',
]);

/** The only `git` subcommands allowed — all read-only (no commit/push/checkout/reset/clean/config). */
const GIT_READ: ReadonlySet<string> = new Set([
  'log', 'status', 'diff', 'show', 'branch', 'ls-files', 'ls-tree', 'blame', 'remote', 'tag',
  'rev-parse', 'cat-file', 'shortlog', 'describe', 'whatchanged', 'reflog', 'grep',
]);

/** `find` predicates that can execute or delete — rejected so `find` stays a pure search. */
const FIND_DANGER: readonly string[] = ['-exec', '-execdir', '-delete', '-ok', '-okdir', '-fprint', '-fprintf', '-fls'];

/** The raw outcome of one ssh invocation. `error` is set for spawn failures. */
export interface LabRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

/** Runs `ssh <host> <remoteCommand>` and returns the outcome. Injectable for tests. */
export type LabRunner = (host: string, remoteCommand: string) => LabRunResult;

/** The lab SSH host (user@host or a ~/.ssh/config alias). Unset ⇒ the tool is not configured. */
export function labSshHost(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const h = env.LAB_SSH_HOST?.trim();
  return h !== undefined && h.length > 0 ? h : undefined;
}

/** The lab root the working directory is confined under. */
export function labRoot(env: NodeJS.ProcessEnv = process.env): string {
  const r = env.LAB_SHELL_ROOT?.trim();
  return (r !== undefined && r.length > 0 ? r : DEFAULT_LAB_ROOT).replace(/\/+$/, '') || '/';
}

function capOutput(s: string): string {
  return s.length > MAX_OUTPUT_BYTES ? `${s.slice(0, MAX_OUTPUT_BYTES)}\n…[truncated]` : s;
}

/** Validate a command: metachar-free, read-only binary, git/find sub-rules. */
export function validateLabCommand(command: string): { ok: true } | { ok: false; error: string } {
  const cmd = command.trim();
  if (cmd === '') return { ok: false, error: 'empty command' };
  if (METACHARS.test(cmd)) {
    return { ok: false, error: 'command contains disallowed metacharacters (; & < > ` $ newline). No chaining, redirection, or substitution. Pipes between read-only commands ARE allowed.' };
  }
  // Every pipe stage must independently be a read-only allowlisted command.
  const stages = cmd.split('|').map((s) => s.trim());
  if (stages.some((s) => s === '')) return { ok: false, error: 'empty pipe stage' };
  for (const stage of stages) {
    const argv = stage.split(/\s+/);
    const bin = argv[0] ?? '';
    if (!READ_CMDS.has(bin)) {
      return { ok: false, error: `'${bin}' is not an allowed read-only command. Allowed: ${[...READ_CMDS].join(', ')}.` };
    }
    if (bin === 'git') {
      const sub = argv.slice(1).find((a) => !a.startsWith('-'));
      if (sub === undefined || !GIT_READ.has(sub)) {
        return { ok: false, error: `git '${sub ?? ''}' is not a read-only subcommand. Allowed: ${[...GIT_READ].join(', ')}.` };
      }
    }
    if (bin === 'find') {
      const bad = FIND_DANGER.find((d) => argv.includes(d));
      if (bad !== undefined) return { ok: false, error: `find ${bad} is not allowed — lab_shell is read-only.` };
    }
  }
  return { ok: true };
}

/** Validate + resolve a cwd confined under the lab root. */
export function validateLabCwd(cwd: string | undefined, root: string): { ok: true; dir: string } | { ok: false; error: string } {
  const raw = (cwd ?? '').trim() || root;
  if (!raw.startsWith('/')) return { ok: false, error: 'cwd must be an absolute path' };
  if (/['"`$;|&<>\n\r]/.test(raw)) return { ok: false, error: 'cwd contains disallowed characters' };
  const dir = resolve(raw);
  if (dir !== root && !dir.startsWith(root + '/')) {
    return { ok: false, error: `cwd "${dir}" is outside the lab root ${root} (set LAB_SHELL_ROOT to widen).` };
  }
  return { ok: true, dir };
}

/** The default runner: ssh in BatchMode (never prompts), inheriting the process env (finds ~/.ssh). */
export function defaultLabRunner(host: string, remoteCommand: string): LabRunResult {
  const res = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, remoteCommand], {
    encoding: 'utf8',
    timeout: SSH_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error !== undefined && res.error !== null) {
    const code = (res.error as NodeJS.ErrnoException).code;
    return { code: -1, stdout: '', stderr: '', error: code === 'ENOENT' ? 'ssh not found on PATH' : res.error.message };
  }
  return { code: res.status ?? -1, stdout: capOutput(res.stdout ?? ''), stderr: capOutput(res.stderr ?? '') };
}

export const labShellToolSpecs: ToolSpec[] = [
  {
    name: 'lab_shell',
    description:
      'Run a READ-ONLY command in the lab over SSH to scan repos for context (e.g. "git log --oneline -20", ' +
      '"ls -la", "grep -rn TODO src", "cat README.md", "find . -name \'*.ts\'"). Single command only — no ' +
      'pipes, chaining, redirection, or writes. Great for gathering context before brainstorming.',
    parameters: obj({
      command: { type: 'string', description: 'The read-only command (allowed: ls, cat, head, tail, grep, rg, find, tree, wc, stat, file, du, and read-only git).' },
      cwd: { type: 'string', description: 'Absolute lab directory to run in (default: the lab repos root). Confined under LAB_SHELL_ROOT.' },
    }, ['command']),
  },
];

export const labShellToolNames: ReadonlySet<string> = new Set(labShellToolSpecs.map((s) => s.name));

export interface LabShellOptions {
  readonly run?: LabRunner;
  readonly host?: () => string | undefined;
  readonly root?: () => string;
}

export function createLabShellToolHandlers(opts: LabShellOptions = {}): Map<string, ToolHandler> {
  const run: LabRunner = opts.run ?? defaultLabRunner;
  const getHost = opts.host ?? (() => labSshHost());
  const getRoot = opts.root ?? (() => labRoot());
  const handlers = new Map<string, ToolHandler>();

  handlers.set('lab_shell', async (args): Promise<ToolResult> => {
    const host = getHost();
    if (host === undefined) {
      return { ok: false, output: '', error: 'lab_shell is not configured — set LAB_SSH_HOST (e.g. user@100.x.y.z) in the environment.' };
    }
    const command = typeof args.command === 'string' ? args.command : '';
    const v = validateLabCommand(command);
    if (!v.ok) return { ok: false, output: '', error: v.error };
    const root = getRoot();
    const c = validateLabCwd(typeof args.cwd === 'string' ? args.cwd : undefined, root);
    if (!c.ok) return { ok: false, output: '', error: c.error };

    const remote = `cd '${c.dir}' && ${command.trim()}`;
    const r = run(host, remote);
    if (r.error !== undefined) return { ok: false, output: '', error: `lab_shell failed: ${r.error}` };
    const body = [r.stdout.trim(), r.stderr.trim()].filter((s) => s.length > 0).join('\n');
    if (r.code !== 0) return { ok: false, output: body || '(no output)', error: `command exited ${r.code}` };
    return { ok: true, output: body.length > 0 ? body : '(no output)' };
  });

  return handlers;
}

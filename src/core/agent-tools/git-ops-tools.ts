/**
 * GIT OPS TOOLS — a NARROW, governed git surface so Peh can review/commit/push her work
 * from the phone WITHOUT opening her whole terminal (AGENT_FS_UNRESTRICTED stays off).
 *
 * Each tool shells a SINGLE fixed `git` subcommand with ARRAY args (no shell, no injection),
 * run inside a workspace-confined repo directory. Read helpers (status/diff/log) are
 * side-effect-free; add/commit/push/clone are writes (gated by the approval policy, i.e. they
 * only run when AGENT_ALLOW_WRITES is enabled).
 *
 * PUSH AUTH: a Personal Access Token is read from the generic env (GITHUB_TOKEN / GH_TOKEN)
 * and injected ONLY for push/clone via `http.extraHeader` passed through
 * GIT_CONFIG_* ENVIRONMENT (git 2.31+) — so the token never lands in argv (ps-visible) nor is it
 * persisted to .git/config. Unset ⇒ push/clone of a private remote fails with a clear hint.
 *
 * CONFINEMENT: the repo directory resolves under the session workspace (resolveInWorkspace); a
 * path escaping the workspace is refused before any git runs.
 */
import { spawnSync } from 'node:child_process';
import { relative, resolve, sep } from 'node:path';

import type { ToolSpec, ToolHandler, ToolResult, ToolContext } from '../tools.js';

const obj = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false });

const GIT_TIMEOUT_MS = 120_000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 96 * 1024;

/** The raw outcome of one git invocation. `error` is set for spawn failures (e.g. git not found). */
export interface GitRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

/** Runs git with array args in `cwd`, with an optional extra env (for push auth). Injectable for tests. */
export type GitRunner = (args: readonly string[], cwd: string, extraEnv?: Record<string, string>) => GitRunResult;

/** Resolve a GitHub PAT from the env (checked in order). Undefined ⇒ no token configured. */
export function resolveGitToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const k of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    const v = env[k]?.trim();
    if (v !== undefined && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Build the GIT_CONFIG_* env that injects an `Authorization: Basic <x-access-token:TOKEN>` header
 * for authenticated HTTPS git operations, WITHOUT the token appearing in argv or on disk. Returns
 * an empty object when no token is configured (unauthenticated — fine for public read/clone).
 */
export function gitAuthEnv(token: string | undefined): Record<string, string> {
  if (token === undefined) return {};
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    GIT_TERMINAL_PROMPT: '0', // never block on an interactive credential prompt
  };
}

function capOutput(s: string): string {
  return s.length > MAX_OUTPUT_BYTES ? `${s.slice(0, MAX_OUTPUT_BYTES)}\n…[truncated]` : s;
}

/** The default runner (spawnSync). Inherits PATH/HOME from the process so git is found on-device. */
export function defaultGitRunner(args: readonly string[], cwd: string, extraEnv?: Record<string, string>): GitRunResult {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
    env: { ...process.env, ...(extraEnv ?? {}) } as NodeJS.ProcessEnv,
  });
  if (res.error !== undefined && res.error !== null) {
    const code = (res.error as NodeJS.ErrnoException).code;
    const msg = code === 'ENOENT' ? 'git not found on PATH' : res.error.message;
    return { code: -1, stdout: '', stderr: '', error: msg };
  }
  return { code: res.status ?? -1, stdout: capOutput(res.stdout ?? ''), stderr: capOutput(res.stderr ?? '') };
}

// ── arg coercion + rendering ──────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
function strArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
  const s = str(v);
  return s === '' ? [] : [s];
}
const ok = (output: string): ToolResult => ({ ok: true, output: output.length > 0 ? output : '(no output)' });
const fail = (msg: string): ToolResult => ({ ok: false, output: msg, error: msg });

/**
 * Resolve the repo directory under the workspace (defaults to the workspace root itself). Purely
 * path-based (no realpath/existence check) so it works for the workspace root AND a not-yet-created
 * clone destination. Refuses any path that escapes the workspace.
 */
function repoDir(ctx: ToolContext, repoArg: unknown): { dir: string; rel: string } | { error: string } {
  const root = ctx.workspaceRoot;
  const p = str(repoArg) || '.';
  const full = resolve(root, p);
  if (full !== root && !full.startsWith(root + sep)) {
    return { error: `path "${p}" escapes the workspace` };
  }
  return { dir: full, rel: relative(root, full) || '.' };
}

/** Render a git outcome. `context` labels the operation in the failure message. */
function render(r: GitRunResult, successPrefix: string): ToolResult {
  if (r.error !== undefined) return fail(`git failed: ${r.error}`);
  const body = [r.stdout.trim(), r.stderr.trim()].filter((s) => s.length > 0).join('\n');
  if (r.code !== 0) return fail(`${successPrefix} failed (exit ${r.code}):\n${body || '(no output)'}`);
  return ok(body);
}

// ── specs ─────────────────────────────────────────────────────────────────────

export const gitOpsToolSpecs: ToolSpec[] = [
  {
    name: 'git_status',
    description: 'Show the working-tree status of a repo (branch + staged/unstaged/untracked files).',
    parameters: obj({ repo: { type: 'string', description: "Workspace-relative repo dir (default '.')." } }, []),
  },
  {
    name: 'git_diff',
    description: 'Show the diff of a repo. Set staged=true for the staged (index) diff; pass paths to limit it.',
    parameters: obj({
      repo: { type: 'string', description: "Workspace-relative repo dir (default '.')." },
      staged: { type: 'boolean', description: 'true = staged/index diff, false = working-tree diff (default).' },
      paths: { type: 'array', items: { type: 'string' }, description: 'Optional paths to limit the diff to.' },
    }, []),
  },
  {
    name: 'git_log',
    description: 'Show recent commits (one line each) for a repo.',
    parameters: obj({
      repo: { type: 'string', description: "Workspace-relative repo dir (default '.')." },
      limit: { type: 'number', description: 'How many commits (default 15, max 100).' },
    }, []),
  },
  {
    name: 'git_add',
    description: 'Stage changes for commit. Give paths, or set all=true to stage everything.',
    parameters: obj({
      repo: { type: 'string', description: "Workspace-relative repo dir (default '.')." },
      paths: { type: 'array', items: { type: 'string' }, description: 'Paths to stage.' },
      all: { type: 'boolean', description: 'Stage all changes (git add -A).' },
    }, []),
  },
  {
    name: 'git_commit',
    description: 'Create a commit with a message. Set all=true to stage tracked changes first (git commit -a).',
    parameters: obj({
      repo: { type: 'string', description: "Workspace-relative repo dir (default '.')." },
      message: { type: 'string', description: 'The commit message.' },
      all: { type: 'boolean', description: 'Stage tracked changes before committing (git commit -a).' },
    }, ['message']),
  },
  {
    name: 'git_push',
    description: 'Push commits to a remote (default origin) and branch (default the current branch). Uses the configured GitHub token for auth.',
    parameters: obj({
      repo: { type: 'string', description: "Workspace-relative repo dir (default '.')." },
      remote: { type: 'string', description: "Remote name (default 'origin')." },
      branch: { type: 'string', description: 'Branch to push (default: current branch).' },
      set_upstream: { type: 'boolean', description: 'Also set the upstream (-u) — use when pushing a new branch.' },
    }, []),
  },
  {
    name: 'git_clone',
    description: 'Clone a git repo into a workspace-relative directory. Uses the configured GitHub token for private repos.',
    parameters: obj({
      url: { type: 'string', description: 'The repo URL (https).' },
      dir: { type: 'string', description: 'Workspace-relative destination directory.' },
    }, ['url', 'dir']),
  },
];

export const gitOpsToolNames: ReadonlySet<string> = new Set(gitOpsToolSpecs.map((s) => s.name));

// ── handlers ────────────────────────────────────────────────────────────────────

export interface GitOpsOptions {
  /** Override the git runner (tests inject a fake). */
  readonly run?: GitRunner;
  /** Override token resolution (tests). */
  readonly token?: () => string | undefined;
}

export function createGitOpsToolHandlers(opts: GitOpsOptions = {}): Map<string, ToolHandler> {
  const run: GitRunner = opts.run ?? defaultGitRunner;
  const token = opts.token ?? (() => resolveGitToken());
  const handlers = new Map<string, ToolHandler>();

  handlers.set('git_status', async (args, ctx): Promise<ToolResult> => {
    const c = repoDir(ctx, args.repo);
    if ('error' in c) return fail(c.error);
    return render(run(['status', '--short', '--branch'], c.dir), 'git status');
  });

  handlers.set('git_diff', async (args, ctx): Promise<ToolResult> => {
    const c = repoDir(ctx, args.repo);
    if ('error' in c) return fail(c.error);
    const gitArgs = ['diff', ...(args.staged === true ? ['--staged'] : [])];
    const paths = strArray(args.paths);
    if (paths.length > 0) gitArgs.push('--', ...paths);
    return render(run(gitArgs, c.dir), 'git diff');
  });

  handlers.set('git_log', async (args, ctx): Promise<ToolResult> => {
    const c = repoDir(ctx, args.repo);
    if ('error' in c) return fail(c.error);
    const n = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.min(100, Math.max(1, Math.floor(args.limit))) : 15;
    return render(run(['log', '--oneline', '-n', String(n)], c.dir), 'git log');
  });

  handlers.set('git_add', async (args, ctx): Promise<ToolResult> => {
    const c = repoDir(ctx, args.repo);
    if ('error' in c) return fail(c.error);
    const paths = strArray(args.paths);
    if (args.all !== true && paths.length === 0) return fail("git_add needs 'paths' or all=true");
    const gitArgs = args.all === true ? ['add', '-A'] : ['add', '--', ...paths];
    const r = run(gitArgs, c.dir);
    if (r.error !== undefined || r.code !== 0) return render(r, 'git add');
    return ok(`Staged ${args.all === true ? 'all changes' : paths.join(', ')} in ${c.rel}.`);
  });

  handlers.set('git_commit', async (args, ctx): Promise<ToolResult> => {
    const c = repoDir(ctx, args.repo);
    if ('error' in c) return fail(c.error);
    const message = str(args.message);
    if (message === '') return fail("git_commit requires a non-empty 'message'");
    const gitArgs = ['commit', ...(args.all === true ? ['-a'] : []), '-m', message];
    return render(run(gitArgs, c.dir), 'git commit');
  });

  handlers.set('git_push', async (args, ctx): Promise<ToolResult> => {
    const c = repoDir(ctx, args.repo);
    if ('error' in c) return fail(c.error);
    const tok = token();
    if (tok === undefined) return fail('git_push: no GitHub token configured — set GITHUB_TOKEN (a fine-grained PAT) in the environment.');
    const remote = str(args.remote) || 'origin';
    const gitArgs = ['push'];
    if (args.set_upstream === true) gitArgs.push('-u');
    gitArgs.push(remote);
    const branch = str(args.branch);
    if (branch !== '') gitArgs.push(branch);
    return render(run(gitArgs, c.dir, gitAuthEnv(tok)), 'git push');
  });

  handlers.set('git_clone', async (args, ctx): Promise<ToolResult> => {
    const url = str(args.url);
    const dest = str(args.dir);
    if (url === '' || dest === '') return fail("git_clone requires 'url' and 'dir'");
    const c = repoDir(ctx, dest);
    if ('error' in c) return fail(c.error);
    return render(run(['clone', url, c.dir], ctx.workspaceRoot, gitAuthEnv(token())), 'git clone');
  });

  return handlers;
}

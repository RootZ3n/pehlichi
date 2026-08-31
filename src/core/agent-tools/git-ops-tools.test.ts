/**
 * GIT OPS tests — no real git needed: a fake GitRunner records the exact (args, cwd, env) each
 * tool would run and returns a scripted outcome, so we assert wiring, confinement, arg building,
 * auth-env injection, and result rendering.
 */
import { governedMkdtemp } from '../temp-authority.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGitOpsToolHandlers,
  gitOpsToolSpecs,
  gitOpsToolNames,
  resolveGitToken,
  gitAuthEnv,
  type GitRunner,
  type GitRunResult,
} from './git-ops-tools.js';
import { createFullToolRegistry } from './index.js';
import { agentToolNames } from '../../profile.js';
import { READ_ONLY_TOOLS } from '../approval-policy.js';
import type { ToolContext } from '../tools.js';

const ctx = (dir: string): ToolContext => ({ workspaceRoot: dir, labStoreRoot: dir, store: {} });
const workspace = (): string => governedMkdtemp('peh-git-');

function fakeRunner(outcome: Partial<GitRunResult> = {}): { run: GitRunner; calls: Array<{ args: readonly string[]; cwd: string; env: Record<string, string> | undefined }> } {
  const calls: Array<{ args: readonly string[]; cwd: string; env: Record<string, string> | undefined }> = [];
  const run: GitRunner = (args, cwd, env) => {
    calls.push({ args, cwd, env });
    return { code: 0, stdout: '', stderr: '', ...outcome };
  };
  return { run, calls };
}

test('all 7 git specs have handlers, are on the allowlist; reads are auto-approved, writes are not', () => {
  assert.equal(gitOpsToolSpecs.length, 7);
  const { run } = fakeRunner();
  const h = createGitOpsToolHandlers({ run });
  for (const spec of gitOpsToolSpecs) {
    assert.ok(h.get(spec.name), `handler ${spec.name}`);
    assert.ok(agentToolNames.includes(spec.name), `${spec.name} in allowlist`);
    assert.ok(gitOpsToolNames.has(spec.name));
  }
  for (const t of ['git_status', 'git_diff', 'git_log']) assert.ok(READ_ONLY_TOOLS.has(t), `${t} read-only`);
  for (const t of ['git_add', 'git_commit', 'git_push', 'git_clone']) assert.ok(!READ_ONLY_TOOLS.has(t), `${t} gated`);
});

test('git tools are registered in the full tool registry', () => {
  const tools = createFullToolRegistry({ workspaceRoot: workspace(), agentServerUrl: 'http://127.0.0.1:0', agentId: 'test-agent' });
  const names = new Set(tools.map((t) => t.spec.name));
  for (const spec of gitOpsToolSpecs) assert.ok(names.has(spec.name), `${spec.name} registered`);
});

test('git_commit passes the message as a single argv element (no shell injection)', async () => {
  const dir = workspace();
  const { run, calls } = fakeRunner();
  const h = createGitOpsToolHandlers({ run });
  const msg = 'fix: thing; rm -rf / && echo pwned';
  const res = await h.get('git_commit')!({ message: msg, all: true }, ctx(dir));
  assert.equal(res.ok, true);
  assert.deepEqual(calls[0]!.args, ['commit', '-a', '-m', msg]);
  assert.equal(calls[0]!.cwd, dir);
});

test('git_add requires paths or all=true; builds the right args', async () => {
  const dir = workspace();
  const { run, calls } = fakeRunner();
  const h = createGitOpsToolHandlers({ run });
  assert.equal((await h.get('git_add')!({}, ctx(dir))).ok, false);
  await h.get('git_add')!({ all: true }, ctx(dir));
  assert.deepEqual(calls[0]!.args, ['add', '-A']);
  await h.get('git_add')!({ paths: ['a.ts', 'b.ts'] }, ctx(dir));
  assert.deepEqual(calls[1]!.args, ['add', '--', 'a.ts', 'b.ts']);
});

test('git_diff supports staged + path scoping', async () => {
  const dir = workspace();
  const { run, calls } = fakeRunner({ stdout: 'diff --git ...' });
  const h = createGitOpsToolHandlers({ run });
  await h.get('git_diff')!({ staged: true, paths: ['x.ts'] }, ctx(dir));
  assert.deepEqual(calls[0]!.args, ['diff', '--staged', '--', 'x.ts']);
});

test('git_push refuses without a token, and injects Basic auth via env when present', async () => {
  const dir = workspace();
  const { run, calls } = fakeRunner();

  const noTok = createGitOpsToolHandlers({ run, token: () => undefined });
  const refused = await noTok.get('git_push')!({}, ctx(dir));
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? '', /no GitHub token/i);
  assert.equal(calls.length, 0, 'nothing runs without a token');

  const withTok = createGitOpsToolHandlers({ run, token: () => 'ghp_secret' });
  await withTok.get('git_push')!({ set_upstream: true, branch: 'feature' }, ctx(dir));
  assert.deepEqual(calls[0]!.args, ['push', '-u', 'origin', 'feature']);
  const hdr = calls[0]!.env?.GIT_CONFIG_VALUE_0 ?? '';
  assert.match(hdr, /^Authorization: Basic /);
  // the token must NOT appear in argv
  assert.ok(!calls[0]!.args.join(' ').includes('ghp_secret'));
});

test('paths that escape the workspace are refused before git runs', async () => {
  const dir = workspace();
  const { run, calls } = fakeRunner();
  const h = createGitOpsToolHandlers({ run });
  const res = await h.get('git_status')!({ repo: '../../etc' }, ctx(dir));
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /escape/i);
  assert.equal(calls.length, 0);
});

test('a spawn failure (git not found) fails cleanly, never throws', async () => {
  const dir = workspace();
  const { run } = fakeRunner({ code: -1, error: 'git not found on PATH' });
  const h = createGitOpsToolHandlers({ run });
  const res = await h.get('git_status')!({}, ctx(dir));
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /git not found/);
});

test('gitAuthEnv builds a Basic header without exposing the token in argv; empty without a token', () => {
  assert.deepEqual(gitAuthEnv(undefined), {});
  const env = gitAuthEnv('ghp_abc');
  const decoded = Buffer.from((env.GIT_CONFIG_VALUE_0 ?? '').replace('Authorization: Basic ', ''), 'base64').toString();
  assert.equal(decoded, 'x-access-token:ghp_abc');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
});

test('resolveGitToken reads only generic GITHUB_TOKEN / GH_TOKEN in order', () => {
  assert.equal(resolveGitToken({}), undefined);
  assert.equal(resolveGitToken({ GH_TOKEN: 'b' }), 'b');
  assert.equal(resolveGitToken({ GITHUB_TOKEN: 'a', GH_TOKEN: 'b' }), 'a');
  assert.equal(resolveGitToken({ PEH_GITHUB_TOKEN: 'agent-specific' }), undefined);
});

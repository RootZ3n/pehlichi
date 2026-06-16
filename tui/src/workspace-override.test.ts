/**
 * Codex P6 — workspace override confinement.
 *
 * A caller-supplied `workspace` may only point inside an operator-approved root
 * (PEHLICHI_WORKSPACE_ROOTS). Arbitrary absolute paths, /etc, the home root, sibling repos
 * outside the allowlist, and symlink escapes are all rejected. With no allowlist configured,
 * overrides fail closed.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { test, afterEach } from 'node:test';

import { parseWorkspaceOverride } from './server.js';

const created: string[] = [];
function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  created.push(d);
  return d;
}
afterEach(() => {
  delete process.env.PEHLICHI_WORKSPACE_ROOTS;
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

test('allowed repo path inside an approved root succeeds', () => {
  const root = tmp('peh-roots-');
  const repo = join(root, 'myrepo');
  mkdirSync(repo);
  process.env.PEHLICHI_WORKSPACE_ROOTS = root;
  const out = parseWorkspaceOverride({ workspace: repo });
  assert.equal(out, realpathSync(repo));
});

test('/etc is rejected', () => {
  const root = tmp('peh-roots-');
  process.env.PEHLICHI_WORKSPACE_ROOTS = root;
  assert.throws(() => parseWorkspaceOverride({ workspace: '/etc' }), /outside the approved roots/);
});

test('home directory root is rejected unless explicitly allowlisted', () => {
  const root = tmp('peh-roots-');
  process.env.PEHLICHI_WORKSPACE_ROOTS = root;
  assert.throws(() => parseWorkspaceOverride({ workspace: homedir() }), /outside the approved roots|not found|not a directory/);
});

test('sibling directory outside the allowlist is rejected', () => {
  const root = tmp('peh-roots-');
  const sibling = tmp('peh-sibling-'); // a real dir, but NOT under the approved root
  mkdirSync(join(sibling, 'repo'));
  process.env.PEHLICHI_WORKSPACE_ROOTS = root;
  assert.throws(() => parseWorkspaceOverride({ workspace: join(sibling, 'repo') }), /outside the approved roots/);
});

test('symlink escape is rejected (realpath confinement)', () => {
  const root = tmp('peh-roots-');
  const outside = tmp('peh-outside-');
  // A symlink INSIDE the approved root that points OUTSIDE it.
  const link = join(root, 'escape');
  symlinkSync(outside, link);
  process.env.PEHLICHI_WORKSPACE_ROOTS = root;
  assert.throws(() => parseWorkspaceOverride({ workspace: link }), /outside the approved roots/);
});

test('.. traversal is rejected before resolution', () => {
  const root = tmp('peh-roots-');
  process.env.PEHLICHI_WORKSPACE_ROOTS = root;
  assert.throws(() => parseWorkspaceOverride({ workspace: `${root}/../etc` }), /absolute path without \.\./);
});

test('relative (non-absolute) path is rejected', () => {
  const root = tmp('peh-roots-');
  process.env.PEHLICHI_WORKSPACE_ROOTS = root;
  assert.throws(() => parseWorkspaceOverride({ workspace: 'relative/dir' }), /absolute path/);
});

test('fails closed with operator guidance when no allowlist is configured', () => {
  delete process.env.PEHLICHI_WORKSPACE_ROOTS;
  const repo = tmp('peh-repo-');
  assert.throws(() => parseWorkspaceOverride({ workspace: repo }), /PEHLICHI_WORKSPACE_ROOTS/);
});

test('absent workspace field returns undefined (no override, uses server default)', () => {
  assert.equal(parseWorkspaceOverride({}), undefined);
  assert.equal(parseWorkspaceOverride({ workspace: '' }), undefined);
});

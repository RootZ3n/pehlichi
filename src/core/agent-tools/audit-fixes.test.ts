/**
 * TRIO AUDIT FIX regression tests (core layer).
 *
 * Each test pins a specific Fable-5 audit finding so it cannot silently regress:
 *   C2 — search_files command injection (RCE)
 *   H5 — skill_view arbitrary file read (path escape)
 *   H6 — symlink escape past workspace confinement
 *   H7 — cron one-shot infinite refire
 *   H8 — delegation depth limit
 *   H10 — approval-callback rejection of write/destructive tools
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createEnhancedFileToolHandlers } from './enhanced-file-tools.js';
import { createSkillToolHandlers } from './skill-tools.js';
import { createCronToolHandlers } from './cron-tools.js';
import { createDelegateToolHandlers, DEFAULT_MAX_DELEGATION_DEPTH } from './delegate-tools.js';
import { defaultApprovalPolicy } from '../approval-policy.js';
import { resolveInWorkspace, ToolError } from '../workspace.js';
import type { ToolContext } from '../tools.js';

const ctx = (dir: string): ToolContext => ({ workspaceRoot: dir, labStoreRoot: dir, store: {} });
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── C2: search_files must NOT execute shell metacharacters in the pattern ──────

test('C2. search_files does not execute an injected shell command in the pattern', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'c2-rce-'));
  try {
    writeFileSync(join(ws, 'sample.txt'), 'nothing interesting here\n');
    const search = createEnhancedFileToolHandlers(ws).get('search_files')!;
    const marker = join(ws, 'PWNED');
    // With the old execSync + shell string, `$(...)` and backticks inside the quoted
    // pattern still ran. execFileSync passes the pattern as a literal argv element, so the
    // command never executes regardless of whether rg/grep likes the regex.
    await search({ pattern: `$(touch ${marker})`, target: 'content' }, ctx(ws));
    await search({ pattern: '`touch ' + marker + '`', target: 'content' }, ctx(ws));
    await search({ pattern: `x; touch ${marker}`, target: 'content' }, ctx(ws));
    assert.equal(existsSync(marker), false, 'no command injection: PWNED file was never created');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── H5: skill_view file_path is confined to the skill directory ────────────────

test('H5. skill_view rejects a file_path that escapes the skill directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'h5-skill-'));
  try {
    const skillDir = join(root, 'demo');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: demo\n---\nbody');
    const view = createSkillToolHandlers(root).get('skill_view')!;

    const escape = await view({ name: 'demo', file_path: '../../../../../../etc/passwd' }, ctx(root));
    assert.equal(escape.ok, false);
    assert.match(escape.error ?? '', /escapes the skill directory/);

    // A legitimate in-skill linked file still resolves.
    mkdirSync(join(skillDir, 'references'), { recursive: true });
    writeFileSync(join(skillDir, 'references', 'api.md'), 'hello-reference');
    const ok = await view({ name: 'demo', file_path: 'references/api.md' }, ctx(root));
    assert.equal(ok.ok, true);
    assert.match(ok.output, /hello-reference/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── H6: a symlink whose target is outside the workspace is rejected ────────────

test('H6. resolveInWorkspace rejects a path that escapes via a symlink', () => {
  const ws = mkdtempSync(join(tmpdir(), 'h6-ws-'));
  const outside = mkdtempSync(join(tmpdir(), 'h6-outside-'));
  try {
    writeFileSync(join(outside, 'secret.txt'), 'top secret');
    // A symlink LOGICALLY inside the workspace but pointing OUT of it.
    symlinkSync(outside, join(ws, 'escape'));
    assert.throws(
      () => resolveInWorkspace(ws, 'escape/secret.txt'),
      (err: unknown) => err instanceof ToolError && /symlink/.test((err as Error).message),
    );
    // A normal in-workspace path is unaffected.
    assert.equal(resolveInWorkspace(ws, 'inside.txt'), join(ws, 'inside.txt'));
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// ── H7: a one-shot (ISO timestamp) cron job fires once and is not rescheduled ───

test('H7. a one-shot cron job fires exactly once, then completes (no infinite refire)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'h7-cron-'));
  const fixed = 1_000_000_000;
  let runs = 0;
  const exec = async (): Promise<string> => { runs++; return 'ran'; };
  try {
    // Fixed clock + an ISO timestamp 20ms ahead. Under the old code the timer re-armed
    // with the same past timestamp (delay clamps low) and refired without bound.
    const h = createCronToolHandlers(exec, { clock: () => fixed }).get('cronjob')!;
    const iso = new Date(fixed + 20).toISOString();
    const created = await h({ action: 'create', prompt: 'one-shot', schedule: iso }, ctx(dir));
    assert.equal(created.ok, true);

    await delay(150);
    assert.equal(runs, 1, 'one-shot executed exactly once');

    const listed = await h({ action: 'list' }, ctx(dir));
    assert.match(listed.output, /"status": "completed"/);
    assert.match(listed.output, /"runCount": 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── H8: delegation depth is bounded ────────────────────────────────────────────

test('H8. delegation is refused once the chain reaches the max depth (no spawn)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'h8-depth-'));
  try {
    assert.equal(DEFAULT_MAX_DELEGATION_DEPTH, 2);
    // A chain already at depth 2 (top → child → grandchild): a further delegate would be
    // depth 3 and must be refused BEFORE spawning the runner.
    const handlers = createDelegateToolHandlers({
      runnerPath: '/should-never-spawn',
      delegatedFrom: ['root-goal', 'child-goal'],
    });
    const delegate = handlers.get('delegate_task')!;
    const res = await delegate({ goal: 'great-grandchild' }, ctx(dir));
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /depth limit reached/);

    // A shallower chain still delegates (depth check passes; here it then fails to spawn
    // the bogus runner, which proves the depth gate did NOT short-circuit it).
    const shallow = createDelegateToolHandlers({ runnerPath: '/should-never-spawn', delegatedFrom: ['root-goal'] });
    const res2 = await shallow.get('delegate_task')!({ goal: 'child' }, ctx(dir));
    assert.equal(res2.ok, false);
    assert.doesNotMatch(res2.error ?? '', /depth limit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── H10: the approval gate rejects write/destructive tools by default ──────────

test('H10. defaultApprovalPolicy denies write tools but auto-approves read-only ones', () => {
  const gated = defaultApprovalPolicy({ allowWrites: false });
  const writeVerdict = gated({ tool: 'write_file', args: {} } as never);
  assert.equal((writeVerdict as { approved: boolean }).approved, false);
  assert.match((writeVerdict as { reason?: string }).reason ?? '', /requires approval/);

  const readVerdict = gated({ tool: 'read_file', args: {} } as never);
  assert.equal((readVerdict as { approved: boolean }).approved, true);

  // With writes explicitly allowed, the same write tool is approved.
  const open = defaultApprovalPolicy({ allowWrites: true });
  assert.equal((open({ tool: 'write_file', args: {} } as never) as { approved: boolean }).approved, true);
});

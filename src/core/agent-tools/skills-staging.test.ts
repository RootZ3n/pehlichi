/**
 * The skills staging directory: resolution, validation, and refusal.
 *
 * The original code did `mkdirSync(root, {recursive:true})` on whatever it was
 * handed. That worked for a real workspace and failed in two ways otherwise: it
 * created a directory directly inside a root the runtime does not own, and on
 * Android — which has no `/tmp` — it threw EACCES and took the entire tool
 * registry down with it.
 *
 * Most of these tests assert a *refusal*, because the dangerous outcomes here
 * are the accommodating ones. A fallback to the cwd or `$HOME` would look like
 * it worked, write real files somewhere nobody chose, and go unnoticed until
 * someone went looking for skills that were never where they thought.
 *
 * Governed common: byte-identical across Pehlichi, Loony-Luna and Mad-Ptah.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveSkillsStagingRoot } from './skill-tools.js';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'skills-staging-'));

// ---------------------------------------------------------------------------
// Resolution

test('an explicit deployment root is used, and only a child is created', () => {
  const root = scratch();
  const got = resolveSkillsStagingRoot(root);
  assert.ok(got.startsWith(root + '/'), 'the staging dir must live beneath the configured root');
  assert.notEqual(got, root, 'the configured root itself must not be the staging dir');
  assert.ok(statSync(got).isDirectory());
});

test('with no configuration it falls back to os.tmpdir()', () => {
  // os.tmpdir() is what Node already resolves per platform: $TMPDIR under
  // Termux, /tmp on ordinary Linux. That is the whole portability fix — the
  // code never names either one.
  const got = resolveSkillsStagingRoot();
  assert.ok(got.startsWith(tmpdir()), `expected a path under ${tmpdir()}, got ${got}`);
  assert.ok(statSync(got).isDirectory());
});

test('it works where /tmp does not exist, because it never names /tmp', () => {
  // The Android case. os.tmpdir() honours $TMPDIR, so a platform without /tmp
  // resolves somewhere real.
  const fake = scratch();
  const prev = process.env['TMPDIR'];
  process.env['TMPDIR'] = fake;
  try {
    const got = resolveSkillsStagingRoot();
    assert.ok(got.startsWith(fake), `expected a path under ${fake}, got ${got}`);
  } finally {
    if (prev === undefined) delete process.env['TMPDIR']; else process.env['TMPDIR'] = prev;
  }
});

test('a malformed TMPDIR is refused rather than silently accepted', () => {
  const prev = process.env['TMPDIR'];
  process.env['TMPDIR'] = '/definitely/not/here/at/all';
  try {
    assert.throws(
      () => resolveSkillsStagingRoot(),
      /platform temp directory .* does not exist, and no staging root was configured/,
    );
  } finally {
    if (prev === undefined) delete process.env['TMPDIR']; else process.env['TMPDIR'] = prev;
  }
});

test('an existing runtime-owned directory is reused, not recreated or cleared', () => {
  const root = scratch();
  const first = resolveSkillsStagingRoot(root);
  writeFileSync(join(first, 'keep.txt'), 'do not delete me');
  const second = resolveSkillsStagingRoot(root);
  assert.equal(second, first);
  assert.equal(statSync(join(first, 'keep.txt')).isFile(), true,
    'resolving twice must not wipe content — a recursive delete of a caller-owned tree is exactly what must never happen');
});

test('concurrent initialisation is safe', async () => {
  // mkdir with recursive:true succeeds on an existing directory, so parallel
  // starts converge instead of racing.
  const root = scratch();
  const results = await Promise.all(
    Array.from({ length: 12 }, async () => resolveSkillsStagingRoot(root)),
  );
  assert.equal(new Set(results).size, 1, 'all callers must agree on one directory');
  assert.ok(statSync(results[0]!).isDirectory());
});

test('the staging directory is not world-readable where modes are honoured', () => {
  const root = scratch();
  const got = resolveSkillsStagingRoot(root);
  const mode = statSync(got).mode & 0o777;
  if (process.platform !== 'win32') {
    assert.equal(mode & 0o077, 0, `expected owner-only, got ${mode.toString(8)}`);
  }
});

// ---------------------------------------------------------------------------
// Refusals

test('a relative path is refused', () => {
  assert.throws(() => resolveSkillsStagingRoot('relative/skills'), /is not absolute/);
});

test('a traversal segment is refused', () => {
  // The same string would mean different directories to callers with different
  // working directories.
  assert.throws(() => resolveSkillsStagingRoot('/var/tmp/../../etc'), /contains a traversal segment/);
});

test('a filesystem root is refused', () => {
  assert.throws(() => resolveSkillsStagingRoot('/'), /is a filesystem root/);
});

test('a symlinked root is refused', () => {
  // The target can be swapped between the check and the write.
  const base = scratch();
  const real = join(base, 'real');
  const link = join(base, 'link');
  mkdirSync(real);
  symlinkSync(real, link);
  assert.throws(() => resolveSkillsStagingRoot(link), /is a symlink/);
});

test('a file where a directory was expected is refused', () => {
  const base = scratch();
  const f = join(base, 'not-a-dir');
  writeFileSync(f, 'x');
  assert.throws(() => resolveSkillsStagingRoot(f), /is not a directory/);
});

test('an unwritable directory is refused', () => {
  const base = scratch();
  const ro = join(base, 'readonly');
  mkdirSync(ro);
  chmodSync(ro, 0o500);
  try {
    // Root ignores permission bits; the assertion would be meaningless there.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    assert.throws(() => resolveSkillsStagingRoot(ro), /is not writable/);
  } finally {
    chmodSync(ro, 0o700);
    rmSync(base, { recursive: true, force: true });
  }
});

test('a configured root that does not exist is refused, not quietly replaced', () => {
  // The first implementation fell through to os.tmpdir() here, and these
  // refusal tests are what caught it. An operator who names a staging root and
  // mistypes it should be told, not silently given a different directory that
  // looks like it worked.
  assert.throws(
    () => resolveSkillsStagingRoot('/nowhere/at/all/skills'),
    /configured skills staging root .* does not exist/,
  );
});

test('nothing ever resolves to the cwd, the home root, or /', () => {
  const forbidden = [process.cwd(), process.env['HOME'] ?? '/home', '/'];
  for (const bad of ['/', 'relative', '/var/tmp/../..']) {
    let got: string | null = null;
    try { got = resolveSkillsStagingRoot(bad); } catch { /* refusal is the expected path */ }
    if (got !== null) {
      for (const f of forbidden) {
        assert.notEqual(got.replace(/\/+$/, ''), f.replace(/\/+$/, ''),
          `resolved to ${got}, which is a location nobody chose`);
      }
    }
  }
});

test('the failure message says what to fix and promises no fallback', () => {
  const prev = process.env['TMPDIR'];
  process.env['TMPDIR'] = '/definitely/not/here';
  try {
    assert.throws(() => resolveSkillsStagingRoot('/also/not/here'), (e: unknown) => {
      const m = (e as Error).message;
      assert.match(m, /deployment configuration/);
      assert.match(m, /will not fall back/);
      // The resolved paths are directory names, not secrets, and naming them is
      // what makes the error actionable.
      assert.match(m, /\/also\/not\/here/);
      return true;
    });
  } finally {
    if (prev === undefined) delete process.env['TMPDIR']; else process.env['TMPDIR'] = prev;
  }
});

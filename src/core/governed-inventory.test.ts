/**
 * A newly committed shared file cannot be silently omitted from the governed inventory.
 *
 * Two files committed during the zero-bypass change —
 * `src/core/admission-bypass-guard.test.ts` and
 * `docs/trio/ADR-006-PREPRODUCTION-ZERO-BYPASS.md` — were never added to
 * `trio/governance/path-inventory.json`. The external comparison caught them, correctly, as
 * six `UNCLASSIFIED_FILE` findings: a committed file that matches a closed directory rule but
 * is absent from that rule's enumeration does not match the rule at all.
 *
 * The mechanism worked. What was missing was anything *deriving* the enumeration, so the
 * omission was possible in the first place — the inventory was hand-maintained, and a hand-
 * maintained list of 400 paths drifts the moment somebody adds a file.
 *
 * `scripts/trio/build-provenance.mjs` derives it now. These cases prove that derivation covers
 * the shapes that went missing, that the classification of both files is the one their content
 * warrants, and that a stale committed inventory is detected rather than tolerated.
 *
 * The behavioural proof — that an unenumerated file becomes `UNCLASSIFIED_FILE` — belongs to
 * the external verifier and is not duplicated here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const SLOTS = ['pehlichi', 'loony-luna', 'mad-ptah'] as const;

const GUARD_TEST = 'src/core/admission-bypass-guard.test.ts';
const ADR = 'docs/trio/ADR-006-PREPRODUCTION-ZERO-BYPASS.md';

interface Rule {
  readonly id: string;
  readonly class: string;
  readonly bytesMustMatch: boolean;
  readonly divergenceBlocking: boolean;
  readonly selector: { directory?: string; paths?: readonly string[]; excludedPaths?: readonly string[]; allowedSuffixes?: readonly string[] };
}
const manifest = (): { rules: Rule[] } => JSON.parse(readFileSync(join(root, 'trio/governance/boundary-manifest.json'), 'utf8'));
const inventory = (): { rules: Record<string, string[]> } => JSON.parse(readFileSync(join(root, 'trio/governance/path-inventory.json'), 'utf8'));

/** Which rule classifies a path: an explicit `paths` rule, or a closed directory enumeration. */
function classify(rel: string): Rule | undefined {
  const { rules } = manifest();
  const byPath = rules.find((r) => r.selector.paths?.includes(rel));
  if (byPath) return byPath;
  const enumerated = inventory().rules;
  return rules.find((r) => r.selector.directory !== undefined && (enumerated[r.id] ?? []).includes(rel));
}

/**
 * A disposable three-repository fixture built from the committed trees.
 *
 * The generator derives the inventory from the union of all three, so a fixture with fewer
 * than three would exercise a different code path than the real one. `node_modules` is linked
 * rather than copied: the generator needs TypeScript, and 23MB per repository per test is a
 * cost with no corresponding truth.
 */
function trioFixture(): { roots: Record<string, string>; drop: () => void } {
  const top = mkdtempSync(join(tmpdir(), 'trio-inventory-'));
  const roots: Record<string, string> = {};
  for (const slot of SLOTS) {
    const source = join(root, '..', slot);
    const target = join(top, slot);
    mkdirSync(target, { recursive: true });
    // Tracked files at their *working-tree* content, not `git archive HEAD`. The fixture has to
    // exercise the generator as it currently is; archiving HEAD would test the last committed
    // generator against a manifest from the working tree, which is neither state.
    const tracked = String(cp.execFileSync('git', ['ls-files', '-z'], { cwd: source, maxBuffer: 64 * 1024 * 1024 }))
      .split('\0').filter(Boolean);
    for (const rel of tracked) {
      mkdirSync(join(target, dirname(rel)), { recursive: true });
      cpSync(join(source, rel), join(target, rel));
    }
    for (const command of [['init', '-q'], ['config', 'user.email', 'f@x.invalid'], ['config', 'user.name', 'f'], ['add', '-A'], ['commit', '-qm', 'fixture']])
      cp.execFileSync('git', command, { cwd: target, stdio: 'ignore' });
    try { symlinkSync(join(source, 'node_modules'), join(target, 'node_modules'), 'dir'); } catch { /* only needed where the generator runs */ }
    roots[slot] = target;
  }
  return { roots, drop: () => { try { rmSync(top, { recursive: true, force: true }); } catch { /* disposable */ } } };
}

/** Run the canonical generator inside a fixture and return its exit status and output. */
function generate(cwd: string, args: string[] = []): { status: number | null; output: string } {
  const result = cp.spawnSync(process.execPath, ['scripts/trio/build-provenance.mjs', ...args], { cwd, encoding: 'utf8', timeout: 120_000 });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const enumerationOf = (cwd: string, ruleId: string): string[] =>
  JSON.parse(readFileSync(join(cwd, 'trio/governance/path-inventory.json'), 'utf8')).rules[ruleId] ?? [];

// --- the two paths this reconciliation governs ----------------------------------------------

test('the shared admission guard test is governed as shared behaviour', () => {
  const rule = classify(GUARD_TEST);
  assert.ok(rule, `${GUARD_TEST} is not classified by any rule`);
  assert.equal(rule.class, 'behavior-identical');
  assert.equal(rule.bytesMustMatch, true, 'a shared safety test may not be allowed to differ between agents');
  assert.equal(rule.divergenceBlocking, true);
  assert.equal(rule.id, 'source-runtime');
});

test('ADR-006 is governed as shared doctrine, not as agent-owned documentation', () => {
  const rule = classify(ADR);
  assert.ok(rule, `${ADR} is not classified by any rule`);
  assert.equal(rule.id, 'shared-governance-doctrine');
  assert.equal(rule.class, 'model-behavior-data');
  assert.equal(rule.bytesMustMatch, true, 'a shared operational invariant may not differ between agents');
  assert.equal(rule.divergenceBlocking, true);

  // And it is out of the agent-owned docs tree, so no generator can quietly adopt it there.
  const docs = manifest().rules.find((r) => r.id === 'documentation-tree');
  assert.ok(docs, 'documentation-tree is missing');
  assert.equal(docs.class, 'agent-owned-content');
  assert.ok((docs.selector.excludedPaths ?? []).includes(ADR),
    'ADR-006 is still inside the agent-owned documentation tree, where the agents could diverge on it');
});

test('legitimate agent-owned documentation stays agent-owned', () => {
  // The correction must not have swept ordinary per-agent documentation into shared doctrine.
  for (const owned of ['AGENTS.md', 'README.md']) {
    const rule = classify(owned);
    if (!rule) continue; // not every agent ships every document
    assert.ok(['agent-owned-content', 'documentation'].includes(rule.class),
      `${owned} was reclassified as ${rule.class}`);
    assert.equal(rule.bytesMustMatch, false, `${owned} must remain free to differ per agent`);
  }
});

test('both paths are byte-identical across the Trio, as their classification requires', () => {
  for (const rel of [GUARD_TEST, ADR]) {
    const digests = SLOTS.map((slot) =>
      cp.execFileSync('git', ['show', `HEAD:${rel}`], { cwd: join(root, '..', slot), maxBuffer: 32 * 1024 * 1024 }).toString('utf8'));
    assert.equal(new Set(digests).size, 1, `${rel} differs between Trio members`);
  }
});

// --- recurrence: a new shared file cannot be silently omitted --------------------------------

test('the committed inventory is exactly what the generator derives', () => {
  const check = generate(root, ['--check']);
  assert.equal(check.status, 0, `the committed governed inventory is stale:\n${check.output}`);
});

test('a newly committed shared source test is enumerated automatically', () => {
  const fixture = trioFixture();
  try {
    const added = 'src/core/newly-added-guard.test.ts';
    for (const slot of SLOTS) {
      writeFileSync(join(fixture.roots[slot]!, added), 'export const placeholder = 1;\n');
      cp.execFileSync('git', ['add', '-A'], { cwd: fixture.roots[slot]!, stdio: 'ignore' });
      cp.execFileSync('git', ['commit', '-qm', 'add'], { cwd: fixture.roots[slot]!, stdio: 'ignore' });
    }
    // Stale before regeneration: the omission is detected rather than tolerated.
    assert.notEqual(generate(fixture.roots.pehlichi!, ['--check']).status, 0,
      'a newly committed shared file left the inventory reported as current');
    assert.equal(generate(fixture.roots.pehlichi!).status, 0);
    assert.ok(enumerationOf(fixture.roots.pehlichi!, 'source-runtime').includes(added),
      'a newly committed shared source test was not enumerated');
  } finally { fixture.drop(); }
});

test('a newly committed governance document is enumerated automatically', () => {
  const fixture = trioFixture();
  try {
    const added = 'docs/trio/ADR-999-EXAMPLE.md';
    for (const slot of SLOTS) {
      mkdirSync(join(fixture.roots[slot]!, 'docs/trio'), { recursive: true });
      writeFileSync(join(fixture.roots[slot]!, added), '# ADR-999\n\nAn example.\n');
      cp.execFileSync('git', ['add', '-A'], { cwd: fixture.roots[slot]!, stdio: 'ignore' });
      cp.execFileSync('git', ['commit', '-qm', 'add'], { cwd: fixture.roots[slot]!, stdio: 'ignore' });
    }
    assert.notEqual(generate(fixture.roots.pehlichi!, ['--check']).status, 0,
      'a newly committed governance document left the inventory reported as current');
    assert.equal(generate(fixture.roots.pehlichi!).status, 0);
    assert.ok(enumerationOf(fixture.roots.pehlichi!, 'documentation-tree').includes(added),
      'a newly committed governance document was not enumerated');
  } finally { fixture.drop(); }
});

test('a file committed to only one Trio member is still enumerated for all three', () => {
  // The inventory spans the Trio. Deriving it from one tree would drop the other members'
  // governed paths and make the inventory itself diverge -- and trio/ is behaviour-identical,
  // so that divergence would block on its own.
  const fixture = trioFixture();
  try {
    const lunaOnly = 'skills/luna-only-example/SKILL.md';
    mkdirSync(join(fixture.roots['loony-luna']!, dirname(lunaOnly)), { recursive: true });
    writeFileSync(join(fixture.roots['loony-luna']!, lunaOnly), '# only Luna\n');
    cp.execFileSync('git', ['add', '-A'], { cwd: fixture.roots['loony-luna']!, stdio: 'ignore' });
    cp.execFileSync('git', ['commit', '-qm', 'add'], { cwd: fixture.roots['loony-luna']!, stdio: 'ignore' });

    for (const slot of SLOTS) assert.equal(generate(fixture.roots[slot]!).status, 0, `${slot} failed to regenerate`);
    const enumerations = SLOTS.map((slot) => enumerationOf(fixture.roots[slot]!, 'skills-quarantine'));
    for (const [index, slot] of SLOTS.entries())
      assert.ok(enumerations[index]!.includes(lunaOnly), `${slot} did not enumerate a path that exists only in Luna`);
    assert.equal(new Set(enumerations.map((e) => JSON.stringify(e))).size, 1,
      'the three members derived different inventories');
  } finally { fixture.drop(); }
});

test('the generator refuses to derive an inventory it cannot see all three trees for', () => {
  const fixture = trioFixture();
  try {
    rmSync(join(fixture.roots['mad-ptah']!, '.git'), { recursive: true, force: true });
    const result = generate(fixture.roots.pehlichi!);
    assert.notEqual(result.status, 0, 'the generator produced an inventory from an incomplete Trio');
    assert.match(result.output, /mad-ptah|all three repositories/,
      'the refusal does not say which repository could not be read');
  } finally { fixture.drop(); }
});

test('regeneration is deterministic and identical across the Trio', () => {
  const fixture = trioFixture();
  try {
    const outputs = SLOTS.map((slot) => {
      assert.equal(generate(fixture.roots[slot]!).status, 0);
      const first = readFileSync(join(fixture.roots[slot]!, 'trio/governance/path-inventory.json'), 'utf8');
      assert.equal(generate(fixture.roots[slot]!).status, 0);
      const second = readFileSync(join(fixture.roots[slot]!, 'trio/governance/path-inventory.json'), 'utf8');
      assert.equal(first, second, `${slot} regenerated a different inventory on the second pass`);
      return first;
    });
    assert.equal(new Set(outputs).size, 1, 'the three members derived different inventories');
  } finally { fixture.drop(); }
});

test('the generator declares the governed inventory among its outputs', () => {
  // Read as source rather than imported: the generator is an .mjs with no type declaration,
  // and what matters is what it declares, not what a loader resolves.
  const source = readFileSync(join(root, 'scripts/trio/build-provenance.mjs'), 'utf8');
  const declaration = source.slice(source.indexOf('PROVENANCE_GENERATOR'), source.indexOf('const SLOTS'));
  assert.match(declaration, /'trio\/governance\/path-inventory\.json'/,
    'the governed inventory is derived but not declared as an output');
  assert.match(declaration, /committed tree only/);
});

test('no rule grants a broad exemption to a governed tree', () => {
  // The correction must not have been made by widening a rule. Every directory rule stays a
  // closed enumeration, and no rule may admit all of src, tests or docs by suffix alone.
  for (const rule of manifest().rules) {
    if (rule.selector.directory === undefined) continue;
    const enumerated = inventory().rules[rule.id];
    assert.ok(Array.isArray(enumerated), `${rule.id} is a directory rule with no enumeration`);
    assert.equal((rule.selector as { closedInventory?: boolean }).closedInventory, true,
      `${rule.id} is an open directory rule`);
  }
  // And the shared-doctrine rule names its file rather than claiming a tree.
  const doctrine = manifest().rules.find((r) => r.id === 'shared-governance-doctrine');
  assert.ok(doctrine, 'shared-governance-doctrine is missing');
  assert.equal(doctrine.selector.directory, undefined, 'shared doctrine must be named, never a directory sweep');
  assert.deepEqual(doctrine.selector.paths, [ADR]);
});

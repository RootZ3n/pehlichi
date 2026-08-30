#!/usr/bin/env node
/**
 * The one canonical generator for this repository's Trio provenance.
 *
 * `trio/path-inventory.json`, `trio/runtime-closure.json`, the `trustedInventory` digests in
 * `trio/boundary-manifest.json` and the digests in `runtime/manifest.json` all describe the
 * same thing: which committed bytes are governed, and what the package actually executes.
 * They were maintained as four independent hand-edited files, which is why they drifted --
 * `tests/runtime/current-behavior.characterization.test.mjs` was committed into a closed
 * directory and never acknowledged, and the generated-runtime closure still described 47
 * files under `dist/`, a directory that is git-ignored and has never been committed. Forty-
 * seven untracked files were, on paper, part of the provenance of a governed runtime.
 *
 * So all four are derived here, from the committed tree, in one pass. Deriving them separately
 * is what allowed them to disagree; deriving them together is what stops it.
 *
 * Two properties matter and are checked rather than assumed:
 *
 *   - Determinism. Running this twice produces byte-identical output, and running it in each
 *     of the three subjects produces identical shared bytes. Ordering is by sorted path
 *     everywhere, and nothing reads a clock or the environment.
 *   - Committedness. Only files Git tracks may enter provenance. An ignored or untracked file
 *     is refused rather than silently included, which is the specific failure `dist/` was.
 *
 * Usage: node scripts/trio/build-provenance.mjs [--check]
 */

import cp from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const require_ = createRequire(import.meta.url);
const ts = require_('typescript');

export const PROVENANCE_GENERATOR = Object.freeze({
  name: 'scripts/trio/build-provenance.mjs',
  version: '1.0.0',
  derivesFrom: 'the committed tree only; ignored and untracked paths are refused',
  outputs: Object.freeze(['trio/path-inventory.json', 'trio/runtime-closure.json',
    'trio/boundary-manifest.json#trustedInventory', 'runtime/manifest.json#digests'])
});

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const posix = (p) => p.split(path.sep).join('/');

/** Every path Git tracks, so provenance cannot include something that was never committed. */
function trackedPaths() {
  const result = cp.spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'buffer', shell: false, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('git ls-files failed; provenance cannot be derived from an unreadable tree');
  return new Set(String(result.stdout).split('\0').filter(Boolean));
}

const tracked = trackedPaths();
function requireTracked(rel, why) {
  if (!tracked.has(rel)) throw new Error(`${why}: ${rel} is not committed, so it may not enter provenance`);
  return rel;
}

/**
 * Resolve a relative import the way the runtime does.
 *
 * TypeScript sources import each other with `.js` specifiers, so the `.js` -> `.ts` rewrite is
 * not a convenience; without it a source-rooted closure resolves nothing.
 */
function resolveRelativeImport(from, specifier) {
  const base = path.resolve(path.dirname(from), specifier);
  const candidates = base.endsWith('.js') ? [base.slice(0, -3) + '.ts']
    : base.endsWith('.ts') ? [base] : [base + '.ts', path.join(base, 'index.ts')];
  return candidates.find((candidate) => { try { return fs.lstatSync(candidate).isFile(); } catch { return false; } });
}

/** Walk the import graph from a set of entry points, returning sorted repository-relative paths. */
function closureFrom(entryPoints, { label }) {
  const queue = entryPoints.map((rel) => path.join(root, rel));
  const seen = new Set();
  const external = new Set();
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(`${label}: ${posix(path.relative(root, file))} is a symlink`);
    seen.add(file);
    const info = ts.preProcessFile(fs.readFileSync(file, 'utf8'), true, true);
    for (const imported of [...info.importedFiles, ...info.referencedFiles]) {
      const specifier = imported.fileName;
      if (!specifier.startsWith('.')) { external.add(specifier.startsWith('node:') ? 'node:*' : specifier); continue; }
      const resolved = resolveRelativeImport(file, specifier);
      if (!resolved) throw new Error(`${label}: unresolved import ${posix(path.relative(root, file))} -> ${specifier}`);
      queue.push(resolved);
    }
  }
  const files = [...seen].map((file) => posix(path.relative(root, file))).sort();
  for (const rel of files) requireTracked(rel, label);
  return { files, external: [...external].sort() };
}

/** Every tracked file under a closed directory. These are the paths that must be acknowledged. */
function trackedUnder(directory) {
  return [...tracked].filter((rel) => rel === directory || rel.startsWith(`${directory}/`)).sort();
}

export function buildProvenance() {
  const closure = readJson('trio/runtime-closure.json');
  const inventory = readJson('trio/path-inventory.json');
  const boundary = readJson('trio/boundary-manifest.json');
  const runtimeManifest = readJson('runtime/manifest.json');
  const pkg = readJson('package.json');

  /**
   * The package's execution closure.
   *
   * `package.json` main is `./src/index.ts`: this package is executed from source under a
   * TypeScript loader and there is no build step in its runtime path. The closure that
   * describes "what running this package loads" therefore has to start at the source entry.
   * It previously started at `dist/index.js` and enumerated 47 ignored, untracked build
   * outputs, so it described a directory that no commit contains.
   */
  const main = pkg.main;
  if (main !== './src/index.ts') throw new Error(`package main is ${main}; the generator models source execution only`);
  const packageEntry = requireTracked(main.replace(/^\.\//, ''), 'package execution entry');
  const packageClosure = closureFrom([packageEntry], { label: 'package execution closure' });

  // The full runtime closure keeps its declared entry points; only its derivation is shared.
  const runtimeClosure = closureFrom(closure.entryPoints, { label: 'runtime closure' });
  const governedCommon = [...new Set([...runtimeClosure.files, ...closure.spawnedRuntimeFiles])].sort();

  /**
   * Shared files.
   *
   * Everything tracked under a closed directory has to be acknowledged, or the closed-directory
   * assertion fails -- which is exactly how the missing characterization test surfaced. Deriving
   * the list rather than maintaining it means a new committed file under a closed directory is
   * either acknowledged automatically or is a deliberate exclusion somebody has to write down.
   */
  const closedDirectoryFiles = inventory.closedDirectories.flatMap((directory) => trackedUnder(directory));
  const declaredShared = inventory.sharedFiles.filter((rel) => tracked.has(rel));
  // The generator is itself shared core: all three subjects derive their provenance with the
  // same bytes, so a divergent copy would let one subject describe a different boundary.
  const ownPath = requireTracked(PROVENANCE_GENERATOR.name, 'provenance generator');
  const sharedFiles = [...new Set([...declaredShared, ...closedDirectoryFiles, ownPath])]
    .filter((rel) => !governedCommon.includes(rel))
    .sort();

  const nextInventory = {
    schemaVersion: 3,
    sharedFileSources: inventory.sharedFileSources,
    sharedFiles,
    closedDirectories: inventory.closedDirectories,
    configurationData: inventory.configurationData
  };
  const nextClosure = {
    ...closure,
    governedCommon,
    generatedRuntime: {
      entryPoints: [packageEntry],
      governedCommon: packageClosure.files,
      configurationData: []
    }
  };

  const inventoryBytes = `${JSON.stringify(nextInventory, null, 2)}\n`;
  const closureBytes = `${JSON.stringify(nextClosure, null, 2)}\n`;
  const pathInventorySha256 = sha(inventoryBytes);
  const runtimeClosureSha256 = sha(closureBytes);

  const nextBoundary = { ...boundary, trustedInventory: { ...boundary.trustedInventory, pathInventorySha256, runtimeClosureSha256 } };
  const nextRuntimeManifest = { ...runtimeManifest, closedInventorySha256: pathInventorySha256, runtimeClosureSha256 };

  return {
    files: {
      'trio/path-inventory.json': inventoryBytes,
      'trio/runtime-closure.json': closureBytes,
      'trio/boundary-manifest.json': `${JSON.stringify(nextBoundary, null, 2)}\n`,
      'runtime/manifest.json': `${JSON.stringify(nextRuntimeManifest, null, 2)}\n`
    },
    summary: {
      pathInventorySha256, runtimeClosureSha256,
      governedCommon: governedCommon.length,
      sharedFiles: sharedFiles.length,
      packageExecutionClosure: packageClosure.files.length,
      packageEntry
    },
    boundaryShape: {
      entryPoints: nextClosure.entryPoints,
      configurationData: nextClosure.configurationData,
      dynamicLoaders: nextClosure.dynamicLoaders,
      runtimePolicyLoads: nextClosure.runtimePolicyLoads,
      identityReferences: nextClosure.identityReferences,
      sharedFiles: nextInventory.sharedFiles,
      closedDirectories: nextInventory.closedDirectories,
      configurationDataFiles: nextInventory.configurationData,
      external: nextClosure.legitimateExternalDependencies.map((item) => item.specifier),
      spawnedRuntimeFiles: nextClosure.spawnedRuntimeFiles,
      generatedRuntime: nextClosure.generatedRuntime
    }
  };
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const built = buildProvenance();
  const stale = [];
  for (const [rel, bytes] of Object.entries(built.files)) {
    if (fs.readFileSync(path.join(root, rel), 'utf8') !== bytes) stale.push(rel);
  }
  if (process.argv.includes('--check')) {
    if (stale.length) { process.stderr.write(`provenance is stale:\n  ${stale.join('\n  ')}\n`); process.exit(1); }
    process.stdout.write(`provenance is current: inventory=${built.summary.pathInventorySha256.slice(0, 12)} closure=${built.summary.runtimeClosureSha256.slice(0, 12)}\n`);
  } else {
    for (const [rel, bytes] of Object.entries(built.files)) fs.writeFileSync(path.join(root, rel), bytes);
    process.stdout.write(`wrote provenance (${stale.length} file(s) changed)\n`);
    process.stdout.write(`  boundaryShapeSha256      ${sha(JSON.stringify(built.boundaryShape))}\n`);
    for (const [key, value] of Object.entries(built.summary)) process.stdout.write(`  ${key.padEnd(24)} ${value}\n`);
  }
}

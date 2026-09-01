import { governedMkdtemp } from '../../src/core/temp-authority.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import ts from 'typescript';

const currentRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Repository discovery contract.
 *
 * The previous default was three hardcoded `*-trio-hermes-runtime` convergence worktrees.
 * Those are obsolete and are not being recreated to satisfy a test, so discovery is now
 * explicit and portable, and it never guesses:
 *
 *   1. `TRIO_REPOSITORIES` -- an operator override: exactly three comma-separated paths, in
 *      slot order. Use this to point the suite at isolated fixtures.
 *   2. Otherwise, the governed repository *names* come from
 *      `trio/governance/boundary-manifest.json`, resolved beside the repository this test
 *      file physically lives in. The names are declared in governance rather than inferred,
 *      and the container is where this file is, not a directory that was searched for.
 *
 * Every resolved root must exist, be a directory, and carry the committed package identity
 * governance declares for its slot -- which is what makes a fixture copy acceptable while a
 * wrong or absent checkout is not. Anything else fails closed with a precise error naming
 * the slot, the path, and how that path was configured. Nothing is skipped.
 */
const TRIO_SLOTS = ['pehlichi', 'loony-luna', 'mad-ptah'] as const;

interface GovernedRepository { expectedRepositoryName?: string; packageNames?: Record<string, string> }

function readGovernedRepositories(): Record<string, GovernedRepository> {
  const governedPath = join(currentRoot, 'trio/governance/boundary-manifest.json');
  let parsed: { repositories?: Record<string, GovernedRepository> };
  try {
    parsed = JSON.parse(readFileSync(governedPath, 'utf8')) as { repositories?: Record<string, GovernedRepository> };
  } catch (error) {
    throw new Error(`TRIO repository discovery: governed manifest ${governedPath} is unreadable (${(error as Error).message})`);
  }
  const repositories = parsed.repositories;
  if (!repositories || typeof repositories !== 'object') {
    throw new Error(`TRIO repository discovery: governed manifest ${governedPath} declares no repositories block`);
  }
  return repositories;
}

function discoverRepositories(): { source: string; roots: string[] } {
  const configured = process.env.TRIO_REPOSITORIES;
  if (configured !== undefined && configured.trim() !== '') {
    const items = configured.split(',').map((item) => item.trim()).filter(Boolean);
    if (items.length !== TRIO_SLOTS.length) {
      throw new Error(`TRIO repository discovery: TRIO_REPOSITORIES must name exactly ${TRIO_SLOTS.length} repositories in slot order (${TRIO_SLOTS.join(', ')}); received ${items.length}`);
    }
    for (const item of items) {
      if (!isAbsolute(item)) throw new Error(`TRIO repository discovery: TRIO_REPOSITORIES entry ${JSON.stringify(item)} is not an absolute path`);
    }
    return { source: 'TRIO_REPOSITORIES', roots: items };
  }
  const repositories = readGovernedRepositories();
  const container = dirname(realpathSync(currentRoot));
  const roots = TRIO_SLOTS.map((slot) => {
    const name = repositories[slot]?.expectedRepositoryName;
    if (typeof name !== 'string' || name === '' || name.includes('/') || name.includes('\\')) {
      throw new Error(`TRIO repository discovery: governed manifest declares no usable expectedRepositoryName for slot ${slot}`);
    }
    return join(container, name);
  });
  return { source: `governed repository names resolved beside ${container}`, roots };
}

const discovery = discoverRepositories();

/** Resolve one slot, or fail closed saying exactly which slot, path and source disagreed. */
function requireRepository(slot: string, configuredPath: string, source: string): string {
  let resolved: string;
  try {
    const stat = lstatSync(configuredPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('not a directory');
    resolved = realpathSync(configuredPath);
  } catch (error) {
    throw new Error(`TRIO repository discovery: slot ${slot} resolves to ${configuredPath} (${source}), which is missing or is not a directory (${(error as Error).message})`);
  }
  const expectedName = readGovernedRepositories()[slot]?.packageNames?.['package.json'];
  if (typeof expectedName !== 'string') {
    throw new Error(`TRIO repository discovery: governed manifest declares no package identity for slot ${slot}`);
  }
  const packagePath = join(resolved, 'package.json');
  let actualName: unknown;
  try {
    actualName = (JSON.parse(readFileSync(packagePath, 'utf8')) as { name?: unknown }).name;
  } catch (error) {
    throw new Error(`TRIO repository discovery: slot ${slot} at ${resolved} (${source}) has no readable package.json (${(error as Error).message})`);
  }
  if (actualName !== expectedName) {
    throw new Error(`TRIO repository discovery: slot ${slot} at ${resolved} (${source}) carries package identity ${JSON.stringify(actualName)}, but governance declares ${JSON.stringify(expectedName)}`);
  }
  return resolved;
}

const roots = TRIO_SLOTS.map((slot, index) => requireRepository(slot, discovery.roots[index]!, discovery.source));

// Independent code-level trust anchor for the architecture-controlled shape.
// Editing a runtime file plus local inventory data cannot redefine the boundary;
// doing so also requires an explicit, review-visible verifier change.
//
// Moved when the effectful executor was made private and the loop's decisions were split into
// `src/core/loop-mechanics.ts`, with `src/core/effect-sinks.ts` added as the governed effect
// inventory. That is a change to the architecture-controlled shape, so it is recorded here by
// hand rather than absorbed by regeneration -- which is exactly what this anchor is for.
const TRUSTED_BOUNDARY_SHAPE_SHA256 = '5e9e4a90594bbf300ddafed02491a965b613aaa262670f18764304146470afe0';

interface Inventory {
  schemaVersion: 3;
  sharedFileSources: readonly { manifest: string; pointer: '/governedCommon' }[];
  sharedFiles: readonly string[];
  closedDirectories: readonly string[];
  configurationData: readonly string[];
}
interface Closure {
  schemaVersion: 2;
  entryPoints: readonly string[];
  governedCommon: readonly string[];
  configurationData: readonly string[];
  dynamicLoaders: readonly { site: string; kind: string; dependency: string; entrypoints: readonly string[] }[];
  runtimePolicyLoads: readonly { site: string; targets: readonly string[]; effect: string }[];
  identityReferences: readonly { site: string; tokens: readonly string[]; classification: string }[];
  legitimateExternalDependencies: readonly {
    specifier: string; kind: string; digest?: string; root?: string; files?: readonly string[];
    trees?: readonly string[]; dynamicEntrypoints?: readonly string[]; optional?: boolean;
    releaseId?: string; packageClosureSha256?: string; packageClosureFileCount?: number;
    attestation?: string;
  }[];
  spawnedRuntimeFiles: readonly string[];
  generatedRuntime: {
    readonly entryPoints: readonly string[];
    readonly governedCommon: readonly string[];
    readonly configurationData: readonly string[];
  };
}

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });

function shaBytes(bytes: string | Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function sha(path: string): string { return shaBytes(readFileSync(path)); }

function safePath(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || isAbsolute(value) || value.includes('\\')
      || value !== normalize(value).split(sep).join('/') || value.split('/').some((part) => part === '.' || part === '..' || part === '')) {
    throw new Error(`unsafe or non-normalized governed path: ${value}`);
  }
  return value;
}

function exactUniqueSafe(paths: readonly string[], field: string): string[] {
  const result = paths.map(safePath);
  assert.equal(new Set(result).size, result.length, `${field}: duplicate path`);
  const lower = result.map((path) => path.toLowerCase());
  assert.equal(new Set(lower).size, lower.length, `${field}: case-colliding path`);
  return result;
}

function filesUnder(root: string, directory: string): string[] {
  const base = join(root, safePath(directory));
  const result: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path)) {
      const target = join(path, entry);
      const stat = lstatSync(target);
      assert.equal(stat.isSymbolicLink(), false, `${root}: governed symlink ${relative(root, target)}`);
      if (stat.isDirectory()) visit(target);
      else if (stat.isFile()) result.push(relative(root, target).split(sep).join('/'));
    }
  };
  visit(base);
  return result.sort();
}

function resolveRelativeImport(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  // `.mjs`/`.cjs` specifiers name a real JavaScript module — the canonical governed-temp
  // authority is plain ESM by design, so it resolves as itself rather than being rewritten to
  // a TypeScript source that does not exist. A `.js` specifier still prefers its `.ts` source
  // and falls back to the literal file when there is none.
  const candidates = base.endsWith('.mjs') || base.endsWith('.cjs') ? [base]
    : base.endsWith('.js') ? [base.slice(0, -3) + '.ts', base]
    : base.endsWith('.ts') ? [base] : [base + '.ts', join(base, 'index.ts')];
  return candidates.find((path) => { try { return lstatSync(path).isFile(); } catch { return false; } });
}

function dynamicLoads(path: string, source: string): Array<{ kind: string; target?: string }> {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: Array<{ kind: string; target?: string }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0];
        found.push({ kind: 'import', ...(argument && ts.isStringLiteral(argument) ? { target: argument.text } : {}) });
      } else if (ts.isIdentifier(node.expression) && (node.expression.text === 'require' || node.expression.text === 'createRequire')) {
        const argument = node.arguments[0];
        found.push({ kind: node.expression.text, ...(argument && ts.isStringLiteral(argument) ? { target: argument.text } : {}) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function deriveClosure(root: string, closure: Closure): { files: string[]; external: string[]; dynamicSites: string[] } {
  const queue = exactUniqueSafe(closure.entryPoints, 'entryPoints').map((path) => join(root, path));
  const seen = new Set<string>();
  const external = new Set<string>();
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    const stat = lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false, `runtime dependency is a symlink: ${relative(root, file)}`);
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    const info = ts.preProcessFile(source, true, true);
    const relativeFile = relative(root, file).split(sep).join('/');
    const loads = dynamicLoads(relativeFile, source);
    if (loads.length > 0) {
      const declarations = closure.dynamicLoaders.filter((item) => item.site === relativeFile);
      assert.ok(declarations.length > 0, `undeclared dynamic loader: ${relativeFile}`);
      for (const load of loads) {
        if (load.target && (load.target.startsWith('node:') || !load.target.startsWith('.'))) {
          const dependency = load.target.startsWith('node:') ? 'node:*' : load.target;
          assert.ok(declarations.some((item) => item.dependency === dependency && item.entrypoints.includes(load.target!)),
            `undeclared literal dynamic target: ${relativeFile} -> ${load.target}`);
        } else if (!load.target) {
          assert.ok(declarations.some((item) => item.kind === 'verified-external-import'),
            `computed import lacks governed verified loader declaration: ${relativeFile}`);
        }
      }
    }
    if (/\bJSON\.parse\s*\(/.test(source) && /\breadFile(?:Sync)?\s*\(/.test(source)) {
      assert.ok(closure.runtimePolicyLoads.some((item) => item.site === relativeFile),
        `undeclared runtime JSON/policy load: ${relativeFile}`);
    }
    for (const imported of [...info.importedFiles, ...info.referencedFiles]) {
      const specifier = imported.fileName;
      if (specifier.startsWith('.')) {
        const resolved = resolveRelativeImport(file, specifier);
        assert.ok(resolved, `unresolved runtime import: ${relative(root, file)} -> ${specifier}`);
        assert.ok(relative(root, resolved).split(sep)[0] !== '..', `runtime import escapes repository: ${specifier}`);
        queue.push(resolved);
      } else {
        external.add(specifier.startsWith('node:') ? 'node:*' : specifier);
      }
    }
  }
  for (const path of closure.spawnedRuntimeFiles.map(safePath)) seen.add(join(root, path));
  return {
    files: [...seen].map((path) => relative(root, path).split(sep).join('/')).sort(),
    external: [...external].sort(),
    dynamicSites: [...new Set(closure.dynamicLoaders.map((item) => item.site))].sort(),
  };
}

/**
 * The closure of what `package.json` main actually executes.
 *
 * This walked `dist/index.js` and enumerated 47 build outputs under a directory that is
 * git-ignored and has never been committed, so the "package runtime closure" described bytes
 * no commit contains and no parity comparison could compare. The package is executed from
 * source under a TypeScript loader, so the closure starts at the source entry and uses the
 * same `.js` -> `.ts` specifier resolution the runtime does.
 */
function deriveGeneratedClosure(root: string, entryPoints: readonly string[]): string[] {
  const queue = exactUniqueSafe(entryPoints, 'generatedRuntime.entryPoints').map((path) => join(root, path));
  const seen = new Set<string>();
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    const stat = lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false, `generated runtime dependency is a symlink: ${relative(root, file)}`);
    seen.add(file);
    const info = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
    for (const imported of info.importedFiles) {
      if (!imported.fileName.startsWith('.')) continue;
      const resolved = resolveRelativeImport(file, imported.fileName);
      assert.ok(resolved, `unresolved package runtime import: ${relative(root, file)} -> ${imported.fileName}`);
      assert.ok(relative(root, resolved!).split(sep)[0] !== '..', `generated runtime import escapes repository: ${imported.fileName}`);
      queue.push(resolved!);
    }
  }
  return [...seen].map((path) => relative(root, path).split(sep).join('/')).sort();
}

function localDependencyDigest(root: string, declaration: Closure['legitimateExternalDependencies'][number]): string {
  assert.equal(lstatSync(root).isSymbolicLink(), false, `${declaration.specifier}: dependency root symlink`);
  const files = [...(declaration.files ?? [])];
  for (const tree of declaration.trees ?? []) files.push(...filesUnder(root, tree));
  const unique = exactUniqueSafe([...new Set(files)].sort(), `${declaration.specifier}.runtimeFiles`);
  const hash = createHash('sha256');
  for (const path of unique) {
    assert.equal(lstatSync(join(root, path)).isSymbolicLink(), false, `${declaration.specifier}: dependency symlink ${path}`);
    const bytes = readFileSync(join(root, path));
    hash.update(`file:${Buffer.byteLength(path)}:`).update(path).update(`:${bytes.length}:`).update(bytes);
  }
  return hash.digest('hex');
}

function boundaryShapeDigest(inventory: Inventory, closure: Closure): string {
  return shaBytes(JSON.stringify({
    entryPoints: closure.entryPoints,
    configurationData: closure.configurationData,
    dynamicLoaders: closure.dynamicLoaders,
    runtimePolicyLoads: closure.runtimePolicyLoads,
    identityReferences: closure.identityReferences,
    sharedFiles: inventory.sharedFiles,
    closedDirectories: inventory.closedDirectories,
    configurationDataFiles: inventory.configurationData,
    external: closure.legitimateExternalDependencies.map((item) => item.specifier),
    spawnedRuntimeFiles: closure.spawnedRuntimeFiles,
    generatedRuntime: closure.generatedRuntime,
  }));
}

function loadTrustedManifests(root: string): { inventory: Inventory; closure: Closure; shared: string[] } {
  const boundaryBytes = readFileSync(join(root, 'trio/boundary-manifest.json'), 'utf8');
  const boundary = JSON.parse(boundaryBytes) as any;
  const runtimeManifest = JSON.parse(readFileSync(join(root, 'runtime/manifest.json'), 'utf8')) as any;
  const inventoryBytes = readFileSync(join(root, 'trio/path-inventory.json'));
  const closureBytes = readFileSync(join(root, 'trio/runtime-closure.json'));
  assert.equal(shaBytes(inventoryBytes), boundary.trustedInventory.pathInventorySha256);
  assert.equal(shaBytes(closureBytes), boundary.trustedInventory.runtimeClosureSha256);
  assert.equal(runtimeManifest.closedInventorySha256, boundary.trustedInventory.pathInventorySha256);
  assert.equal(runtimeManifest.runtimeClosureSha256, boundary.trustedInventory.runtimeClosureSha256);
  const inventory = JSON.parse(inventoryBytes.toString('utf8')) as Inventory;
  const closure = JSON.parse(closureBytes.toString('utf8')) as Closure;
  assert.equal(inventory.schemaVersion, 3);
  assert.equal(boundaryShapeDigest(inventory, closure), TRUSTED_BOUNDARY_SHAPE_SHA256, 'architecture boundary cannot self-redefine through local manifests');
  assert.deepEqual(inventory.sharedFileSources, [{ manifest: 'trio/runtime-closure.json', pointer: '/governedCommon' }]);
  // Each declared list must still be free of duplicates -- that is what catches a sloppy
  // manifest. Their union may legitimately overlap now that the package-execution closure is
  // rooted in source: it is a subset of the full runtime closure rather than a disjoint set
  // of build outputs, so the union is deduplicated instead of being required to be disjoint.
  const shared = [...new Set([
    ...exactUniqueSafe(closure.governedCommon, 'governedCommon'),
    ...exactUniqueSafe(closure.generatedRuntime.governedCommon, 'generatedRuntime.governedCommon'),
    ...exactUniqueSafe(inventory.sharedFiles, 'sharedFiles'),
  ])].sort();
  return { inventory, closure, shared };
}

test('trusted manifests bind the closed inventory and every governed byte is identical without symlinks', () => {
  assert.equal(roots.length, 3);
  const reference = loadTrustedManifests(roots[0]!);
  for (const root of roots) {
    assert.equal(readFileSync(join(root, 'trio/boundary-manifest.json'), 'utf8'), readFileSync(join(roots[0]!, 'trio/boundary-manifest.json'), 'utf8'));
    assert.equal(readFileSync(join(root, 'trio/path-inventory.json'), 'utf8'), readFileSync(join(roots[0]!, 'trio/path-inventory.json'), 'utf8'));
    assert.equal(readFileSync(join(root, 'trio/runtime-closure.json'), 'utf8'), readFileSync(join(roots[0]!, 'trio/runtime-closure.json'), 'utf8'));
    const current = loadTrustedManifests(root);
    assert.deepEqual(current.shared, reference.shared);
    for (const path of current.shared) {
      assert.equal(lstatSync(join(root, path)).isSymbolicLink(), false, `${root}: shared symlink ${path}`);
      assert.equal(sha(join(root, path)), sha(join(roots[0]!, path)), `${root}: ${path}`);
    }
  }
});

test('closed directories reject undeclared runtime and common-test files', () => {
  const { inventory, shared } = loadTrustedManifests(currentRoot);
  const known = new Set(shared);
  for (const root of roots) for (const directory of inventory.closedDirectories) {
    for (const path of filesUnder(root, directory)) assert.ok(known.has(path), `${root}: unacknowledged shared path ${path}`);
  }
});

test('transitive runtime closure is fully classified, dynamic loading is declared, and executable behavior is byte-identical', () => {
  const reference = loadTrustedManifests(roots[0]!);
  const common = exactUniqueSafe(reference.closure.governedCommon, 'governedCommon').sort();
  const configuration = exactUniqueSafe(reference.closure.configurationData, 'configurationData').sort();
  assert.ok(configuration.every((path) => !/\.[cm]?[jt]sx?$/.test(path)), 'configuration-only paths must be declarative data');
  assert.equal(new Set(reference.closure.dynamicLoaders.map((item) => JSON.stringify(item))).size, reference.closure.dynamicLoaders.length);
  assert.ok(reference.closure.runtimePolicyLoads.every((item) => common.includes(item.site)), 'all policy loader sites are governed executable bytes');
  for (const root of roots) {
    const manifests = loadTrustedManifests(root);
    const derived = deriveClosure(root, manifests.closure);
    assert.deepEqual(derived.files, common, `${root}: zero unclassified transitive dependencies`);
    const dynamicallyResolved = new Set(manifests.closure.dynamicLoaders
      .filter((item) => item.kind.startsWith('verified-external-')).map((item) => item.dependency));
    const staticExternal = manifests.closure.legitimateExternalDependencies
      .map((item) => item.specifier).filter((item) => !dynamicallyResolved.has(item)).sort();
    assert.deepEqual(derived.external, staticExternal);
    assert.deepEqual(derived.dynamicSites, [...new Set(manifests.closure.dynamicLoaders.map((item) => item.site))].sort());
    for (const path of common) assert.equal(sha(join(root, path)), sha(join(roots[0]!, path)), `${root}: governed dependency ${path}`);
    for (const path of configuration) assert.equal(lstatSync(join(root, path)).isSymbolicLink(), false);
  }
});

test('package runtime closure is fixed, classified, and byte-identical when executable', () => {
  const reference = loadTrustedManifests(roots[0]!);
  const generatedCommon = exactUniqueSafe(reference.closure.generatedRuntime.governedCommon, 'generated governedCommon').sort();
  const generatedConfig = exactUniqueSafe(reference.closure.generatedRuntime.configurationData, 'generated configurationData').sort();
  for (const root of roots) {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as any;
    // Source execution, not a build product. Asserting the dist entry here kept a build
    // directory in the governed closure that no commit contains.
    assert.equal(pkg.main, './src/index.ts');
    assert.equal(pkg.types, './src/index.ts');
    assert.deepEqual(pkg.exports, { '.': { types: './src/index.ts', default: './src/index.ts' } });
    const actual = deriveGeneratedClosure(root, reference.closure.generatedRuntime.entryPoints);
    assert.deepEqual(generatedConfig, []);
    assert.deepEqual(actual, generatedCommon, `${root}: generated runtime has no unclassified dependency`);
    for (const path of generatedCommon) assert.equal(sha(join(root, path)), sha(join(roots[0]!, path)), `${root}: generated runtime ${path}`);
    for (const path of generatedConfig) assert.equal(lstatSync(join(root, path)).isSymbolicLink(), false);
  }
});

test('capsule/deployment differences are closed declarative data and do not redefine the runtime boundary', () => {
  const expectedCapsule = ['baseToolNames', 'identity', 'personalityPath', 'providerDefaults', 'requestedCapabilityPacks', 'schemaVersion', 'skillTags', 'skinPath'];
  const expectedDeployment = ['baseToolCeiling', 'capabilityPackCeiling', 'defaults', 'environment', 'memoryAmbient', 'namespaces', 'routingTargets', 'schemaVersion', 'secretEnvironmentReferences'];
  const boundary = JSON.parse(readFileSync(join(currentRoot, 'trio/boundary-manifest.json'), 'utf8')) as any;
  const inventory = loadTrustedManifests(currentRoot).inventory;
  assert.deepEqual([...inventory.configurationData].sort(), [...boundary.configurationData].sort());
  const capsules: any[] = [];
  const deployments: any[] = [];
  for (const root of roots) {
    const capsule = JSON.parse(readFileSync(join(root, 'capsule/agent.json'), 'utf8')) as any;
    const deployment = JSON.parse(readFileSync(join(root, 'deployment/agent.env.json'), 'utf8')) as any;
    assert.deepEqual(Object.keys(capsule).sort(), expectedCapsule);
    assert.deepEqual(Object.keys(deployment).sort(), expectedDeployment);
    assert.equal(capsule.schemaVersion, 1); assert.equal(deployment.schemaVersion, 1);
    capsules.push(capsule); deployments.push(deployment);
  }
  for (const capsule of capsules.slice(1)) assert.deepEqual(capsule.baseToolNames, capsules[0]!.baseToolNames, 'base authority may not drift by identity');
  for (const deployment of deployments.slice(1)) assert.deepEqual(deployment.baseToolCeiling, deployments[0]!.baseToolCeiling, 'trusted base ceiling may not drift');
  const allowed = new Set(boundary.allowedDifferencePointers as string[]);
  for (const [label, documents] of [['capsule', capsules], ['deployment', deployments]] as const) {
    const keys = Object.keys(documents[0]!);
    for (const document of documents.slice(1)) for (const key of keys) {
      if (JSON.stringify(document[key]) !== JSON.stringify(documents[0]![key])) {
        assert.ok(allowed.has(`/${label}/${key}`), `unallowlisted configuration difference: /${label}/${key}`);
      }
    }
  }
});

test('external dependencies have explicit lock/platform/local-content integrity treatment', () => {
  const { closure } = loadTrustedManifests(currentRoot);
  const packages = roots.map((root) => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as any);
  for (const pkg of packages.slice(1)) {
    assert.deepEqual(pkg.dependencies, packages[0]!.dependencies);
    assert.deepEqual(pkg.devDependencies, packages[0]!.devDependencies);
  }
  for (const item of closure.legitimateExternalDependencies) {
    if (item.kind === 'activated-truth-release') {
      // The verifier is an activated immutable release, so it is pinned by the identity it
      // reports about itself and by its own release manifest -- not by hashing a directory.
      // The previous pin covered a gitignored development dist/, which changed whenever
      // anyone rebuilt and made the check fire for maintenance rather than for tampering.
      const probe = spawnSync('truth', ['runtime-id', '--json'], { encoding: 'utf8' });
      assert.equal(probe.status, 0, `${item.specifier}: the activated verifier did not answer runtime-id`);
      const identity = JSON.parse(probe.stdout) as {
        protocol: string; packageRoot: string; packageClosureSha256: string; packageClosureFileCount: number;
      };
      assert.equal(identity.protocol, 'truth-firewall/runtime-identity/1');
      assert.equal(identity.packageClosureSha256, item.packageClosureSha256, `${item.specifier}: activated closure differs from the acknowledged pin`);
      assert.equal(identity.packageClosureFileCount, item.packageClosureFileCount);
      const manifest = JSON.parse(readFileSync(join(identity.packageRoot, 'release-manifest.json'), 'utf8')) as {
        releaseId: string; packageClosureSha256: string; packageClosureFileCount: number;
      };
      assert.equal(manifest.releaseId, item.releaseId, `${item.specifier}: activated release is not the acknowledged one`);
      assert.equal(manifest.packageClosureSha256, item.packageClosureSha256, `${item.specifier}: release manifest disagrees with the measured runtime`);
      assert.equal(manifest.packageClosureFileCount, item.packageClosureFileCount);
      continue;
    }
    if (item.kind !== 'local-runtime-tree') continue;
    const dependencyRoot = realpathSync(resolve(currentRoot, item.root!));
    assert.equal(localDependencyDigest(dependencyRoot, item), item.digest, `${item.specifier}: local shipped runtime changed without acknowledgement`);
  }
  assert.ok(loadTrustedManifests(currentRoot).shared.includes('tui/pnpm-lock.yaml'));
  assert.ok(loadTrustedManifests(currentRoot).shared.includes('tui/package.json'));
});

test('governed runtime has no identity-conditioned enforcement branch', () => {
  const { closure } = loadTrustedManifests(currentRoot);
  const expected = new Map(closure.identityReferences.map((item) => [item.site, [...item.tokens].sort()]));
  const identityTokens = ['pehlichi', 'loony-luna', 'mad-ptah', 'peh', 'luna', 'ptah'] as const;
  for (const root of roots) {
    const actual = new Map<string, string[]>();
    for (const path of closure.governedCommon) {
      if (!path.endsWith('.ts')) continue;
      const file = ts.createSourceFile(path, readFileSync(join(root, path), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const tokens = new Set<string>();
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && identityTokens.includes(node.text.toLowerCase() as typeof identityTokens[number])) {
          tokens.add(node.text.toLowerCase());
        }
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          for (const candidate of identityTokens) {
            const escaped = candidate.replace('-', '\\-');
            if (new RegExp(`(?:^|[^a-z])${escaped}(?:[^a-z]|$)`, 'i').test(node.text)) tokens.add(candidate);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
      if (tokens.size > 0) actual.set(path, [...tokens].sort());
    }
    assert.deepEqual([...actual.entries()].sort(), [...expected.entries()].sort(), `${root}: identity literals require exact reviewed classification`);
  }
});

test('path and trust-anchor helpers reject traversal, normalization, case collision, symlink, and self-redefinition attacks', () => {
  for (const path of ['/absolute', '../escape', 'runtime/../escape', './runtime/x', 'runtime//x', 'runtime\\x']) assert.throws(() => safePath(path));
  assert.throws(() => exactUniqueSafe(['runtime/A.ts', 'runtime/a.ts'], 'fixture'), /case-colliding/);
  const root = governedMkdtemp('trio-parity-hostile-'); cleanup.push(root);
  writeFileSync(join(root, 'outside'), 'x'); symlinkSync(join(root, 'outside'), join(root, 'linked'));
  assert.equal(lstatSync(join(root, 'linked')).isSymbolicLink(), true);
  const original = readFileSync(join(currentRoot, 'trio/path-inventory.json'));
  const changed = Buffer.concat([original, Buffer.from('\n')]);
  assert.notEqual(shaBytes(changed), loadTrustedManifests(currentRoot).closure && JSON.parse(readFileSync(join(currentRoot, 'trio/boundary-manifest.json'), 'utf8')).trustedInventory.pathInventorySha256);
  const inventory = JSON.parse(original.toString('utf8')) as Inventory;
  const closure = JSON.parse(readFileSync(join(currentRoot, 'trio/runtime-closure.json'), 'utf8')) as Closure;
  const redefined = { ...inventory, sharedFiles: [...inventory.sharedFiles, 'src/core/undeclared-common.test.ts'] };
  assert.notEqual(boundaryShapeDigest(redefined, closure), TRUSTED_BOUNDARY_SHAPE_SHA256, 'self-updated inventory cannot redefine the trusted shape');
});

test('computed imports, createRequire, and executable configuration are visible to the closed-boundary analysis', () => {
  assert.deepEqual(dynamicLoads('fixture.ts', "await import(target)"), [{ kind: 'import' }]);
  assert.deepEqual(dynamicLoads('fixture.ts', "createRequire(import.meta.url)('rogue')"), [{ kind: 'createRequire' }]);
  assert.deepEqual(dynamicLoads('fixture.ts', "await import('playwright')"), [{ kind: 'import', target: 'playwright' }]);
  const { inventory, closure } = loadTrustedManifests(currentRoot);
  assert.ok(closure.configurationData.every((path) => !/\.[cm]?[jt]sx?$/.test(path)));
  assert.ok(inventory.configurationData.every((path) => !/\.[cm]?[jt]sx?$/.test(path)));
  assert.ok(closure.governedCommon.includes('tui/src/server.ts'));
  assert.ok(closure.governedCommon.includes('src/profiles/agent.ts'));
});

test('local dependency identity covers exported leaf bytes and rejects symlinked runtime leaves', () => {
  const root = governedMkdtemp('trio-local-dependency-'); cleanup.push(root);
  const dist = join(root, 'dist');
  const nested = join(dist, 'nested');
  const declaration = { specifier: 'fixture', kind: 'local-runtime-tree', files: ['package.json'], trees: ['dist'] } as const;
  writeFileSync(join(root, 'package.json'), '{"exports":"./dist/index.js"}');
  // mkdirSync is intentionally local to the disposable fixture.
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(dist, 'index.js'), "export * from './nested/leaf.js';");
  writeFileSync(join(nested, 'leaf.js'), 'export const value = 1;');
  const before = localDependencyDigest(root, declaration);
  writeFileSync(join(nested, 'leaf.js'), 'export const value = 2;');
  assert.notEqual(localDependencyDigest(root, declaration), before, 'changed executable leaf changes dependency identity');
  rmSync(join(nested, 'leaf.js'));
  writeFileSync(join(root, 'outside.js'), 'raw');
  symlinkSync(join(root, 'outside.js'), join(nested, 'leaf.js'));
  assert.throws(() => localDependencyDigest(root, declaration), /symlink/);
});

test('a one-byte mutation of any governed shared byte is detected by the comparison parity depends on', () => {
  // Step 10 requires the parity verifier to prove its own failure mode. Without this a
  // green parity run is only evidence that the comparison ran, not that it can fail.
  const { shared } = loadTrustedManifests(currentRoot);
  assert.ok(shared.length > 0, 'no governed shared bytes to mutate');
  const mirror = governedMkdtemp('trio-parity-mutation-');
  cleanup.push(mirror);
  for (const path of shared) {
    const target = join(mirror, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(currentRoot, path)));
  }
  // The mirror must agree before it is mutated, or the mutation proves nothing.
  assert.deepEqual(shared.filter((path) => sha(join(mirror, path)) !== sha(join(currentRoot, path))), []);

  // Every governed file, one flipped bit each, restored afterwards: a single sampled
  // file would leave the rest of the boundary unproven.
  for (const victim of shared) {
    const original = readFileSync(join(mirror, victim));
    assert.ok(original.length > 0, `${victim}: an empty governed file cannot carry a mutation`);
    const mutated = Buffer.from(original);
    const at = Math.floor(mutated.length / 2);
    mutated[at] = mutated[at]! ^ 0x01;
    writeFileSync(join(mirror, victim), mutated);
    const mismatched = shared.filter((path) => sha(join(mirror, path)) !== sha(join(currentRoot, path)));
    assert.deepEqual(mismatched, [victim], `${victim}: a one-byte change must be reported, and only there`);
    writeFileSync(join(mirror, victim), original);
  }
  assert.deepEqual(shared.filter((path) => sha(join(mirror, path)) !== sha(join(currentRoot, path))), [], 'mirror must be restored');
});

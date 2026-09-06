import { governedMkdtemp } from '../../src/core/temp-authority.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

// Independent code-level trust anchor for the architecture-controlled boundary.
// Editing a runtime file plus local inventory data cannot redefine the boundary;
// doing so also requires an explicit, review-visible verifier change.
//
// Version 2 BINDS BYTES, not only paths. Version 1 digested the declared path lists, so three
// byte-identical repositories could be modified uniformly and still report PARITY: the
// cross-repository comparison sees no divergence, and a path-only anchor sees no change. The
// anchor now additionally carries, for every security-critical canonical entry, its normalized
// relative path, file type, mode classification and content digest, in a deterministic order.
// Addition, deletion, replacement, chmod, symlink substitution and uniform byte modification
// each move the anchor, so each one has to be declared here deliberately.
const BOUNDARY_ANCHOR_VERSION = 2;
// Moved deliberately when the committed-execution scanner and the TUI build were corrected: the
// scanner stopped accepting a governed entry reached by traversal or through a symlink and began
// parsing Node's option arity, and the build stopped resolving its entry and output directory
// lexically. Both files are anchored, so both corrections had to be declared here to land -- which
// is the anchor working, not an obstacle to it.
// Moved again when the TUI build stopped trusting pathnames after it had proved them: the entry,
// its imported graph and the output directory are now bound by descriptor and inode across the
// whole read/build/publish sequence, and the sources are compiled from a captured snapshot rather
// than reopened by name. `tui/scripts/build.mjs` is anchored, so that correction is declared here.
// Moved again when the two highest-traffic tool seams were routed through the containment
// authority: execute_code and lab_shell no longer spawn a bare child process, and the vendored
// boundary at src/core/containment/ joined the closed inventory. The shape changed because the
// governed surface genuinely grew, which is the anchor doing its job.
// Moved again by the remediation of the independent audit's three blocking findings: a required
// deployment identity bound to the capsule and to the repository's governed package identity, an
// exact reviewed workspace vocabulary replacing the segment-count rule that accepted /etc/foo, and
// a seccomp filter denying AF_UNIX because mount masking cannot hide a socket that can be created
// anywhere.
//
//   old 0ab0f6e1d36ffc8c0c81fd2c46b16121eb0530729d4bcdb11e93564d6d587ae6
//   new c355ca6c7c7106c598282bfc9c9a2e197e9891f54e57ca15f53ffa27a68e3ec9
// Moved again by the re-audit remediation of F-2: the name-keyed SSH exception was removed, the
// one networked operation became a broker with a closed request schema and an absolute root-owned
// executable, and every policy -- including that one -- now carries the AF_UNIX syscall filter.
//
//   old c355ca6c7c7106c598282bfc9c9a2e197e9891f54e57ca15f53ffa27a68e3ec9
//   new 9f6a98e7141896977b0bb23fa8490027099a2c1a5dedfbb6f205153a0cbba8f0
// Moved again by the F-1 remediation: the identity chain stopped being self-attesting. An external
// record delivered by systemd from a root-owned file now names the exact package/capsule/deployment
// digests this tree must have, and it is checked before any tool or containment policy exists.
//
//   old 9f6a98e7141896977b0bb23fa8490027099a2c1a5dedfbb6f205153a0cbba8f0
//   new 01d11cd2ce7d8ea58c2f9cf9655fc9b20f3c57f1e085fa41f721237fb3c6d810
// Moved once more within the same remediation: the first restart of the first agent refused the
// real credential, because the check demanded mode 0400 while systemd materialises 0440 root:root
// plus an ACL. Corrected to what must actually be true -- nothing world-accessible, nothing
// group-writable. The sequential rollout is what surfaced it, on one agent, before the other two.
//
//   old 01d11cd2ce7d8ea58c2f9cf9655fc9b20f3c57f1e085fa41f721237fb3c6d810
//   new b7f1f57cd3acab5bc9882bc14e69e8375d63d07799f39b498768d02b3dcab387
// Final position for this remediation, once the external-identity policy load was declared.
//   old b7f1f57cd3acab5bc9882bc14e69e8375d63d07799f39b498768d02b3dcab387
//   new 68f02ba777e8edc4c4597ea0e694e3eb087bf16e1115695bfb3ff079f49e2fd8
// Moved by the T16/reaper ownership repair: run ownership is now decided by a shared
// LIVE/DEAD/UNKNOWN classifier over an atomic sidecar, so a live sibling service is no longer
// residue by construction and only a provably dead owner may be collected.
//
//   old 68f02ba777e8edc4c4597ea0e694e3eb087bf16e1115695bfb3ff079f49e2fd8
//   new 539c49596d5bbd7d04ba0654afe2420144ca4106227c7ca24a25771c8533b19d
// Final position, once the ownership sidecar read was declared as validated runtime state.
//   old 539c49596d5bbd7d04ba0654afe2420144ca4106227c7ca24a25771c8533b19d
//   new c172f51334249aef43bb978afece86dd02d0b314ebc8cf340a62f43bacfeffa8
// Unmoved by the fail-closed data roots, and the attempt to move it is worth recording.
// `build-provenance.mjs` prints a `boundaryShapeSha256` which is NOT this anchor: it hashes the
// bare shape object, from `trio/governance/path-inventory.json`, while the anchor hashes
// {anchorVersion, inventorySchemaVersion, shape, anchored file bytes} from `trio/path-inventory.json`.
// Two digests, similar names, different inputs. Taking the generator's number for this constant
// broke the anchor in all three repositories until T22 refused it -- which is the test doing
// exactly its job. src/core/data-roots.ts changed `governedCommon`, which the anchor shape does
// not include, so the trusted boundary genuinely did not move.
// Moved by the schema-3 gate unification: scripts/trio gained identity-schema.mjs and
// external-identity.mjs changed. Both are anchored bytes, so this is a real boundary change and
// the anchor is supposed to say so.
//
// Computed with THIS file's recipe, not with build-provenance.mjs's `boundaryShapeSha256`. Those
// are two different digests over two different inputs with near-identical names, and taking the
// generator's number for this constant broke the anchor in all three repositories once already.
//   old c172f51334249aef43bb978afece86dd02d0b314ebc8cf340a62f43bacfeffa8
//   new 98b2e1ac74f05edd395ee63c5a8e1333bd20b07a3cdb8884fa02775c29469c9c
//   old 98b2e1ac74f05edd395ee63c5a8e1333bd20b07a3cdb8884fa02775c29469c9c
//   new 85a1dcaf41790cc33401a5f4d33542551da4a91645021340000f41bfdd870c68  (a source tree accepts schema 1 only)
//   old 85a1dcaf41790cc33401a5f4d33542551da4a91645021340000f41bfdd870c68
//   new 9168344616975f157c2dad2812a361b5479135eb52b9813dfe40cc278a872ed7  (the .d.mts declaration is anchored too)
//   old 9168344616975f157c2dad2812a361b5479135eb52b9813dfe40cc278a872ed7
//   new 048dc3ff95f5def32c63e2f1d2062eda5a6468087f77b10633d2ab8fb92d8eb0  (the qualification
//       admission joined the governed common runtime, so the shape it anchors grew by one
//       module and one committed trust anchor -- a boundary change, re-anchored on purpose)
//   old 048dc3ff95f5def32c63e2f1d2062eda5a6468087f77b10633d2ab8fb92d8eb0
//   new a94a206dd2de8b9f70262cb7aa74ece2d49748a39c6318505d5fa55057803523  (the final-answer
//       renderer joined the governed common runtime, so the shape grew by one module --
//       a boundary change, re-anchored on purpose)
//   old a94a206dd2de8b9f70262cb7aa74ece2d49748a39c6318505d5fa55057803523
//   new c220ee643ac91a6f2edd7f421befb00af5efa8a66f151d680588037b8b9c283d  (external ordinary
//       authorization: one new governed module, and the anchored scripts/trio identity reader
//       grew a second credential on the same channel -- a boundary change, re-anchored on purpose)
//   old c220ee643ac91a6f2edd7f421befb00af5efa8a66f151d680588037b8b9c283d
//   new 24d49c6f81359919c0532d0e2ce3e1f9ee49f192bdaa83283a124f29b1c28c4c  (per-request
//       principals: the shared lane-authorization decision and the principal verifier joined
//       the governed common runtime -- a boundary change, re-anchored on purpose)
//   old 24d49c6f81359919c0532d0e2ce3e1f9ee49f192bdaa83283a124f29b1c28c4c
//   new cccd6d2126d4d4eef0b84a555a6ebad2369e2d163d5f0505899beb1a76cc7d72  (the restart-readiness
//       preflight joined the anchored scripts/trio directory -- a boundary change, re-anchored
//       on purpose; it reports drift and grants nothing)
//   old cccd6d2126d4d4eef0b84a555a6ebad2369e2d163d5f0505899beb1a76cc7d72
//   new dee2ec72f25c4ecd9fb93c268c5b14631f898a5f4737a6c25019eef704dc0781  (delegated
//       authority and receipt access: two new governed modules joined the common runtime, and
//       the executed-closure digest an external lease pins grew from four files to eight so it
//       covers the modules that actually decide a request -- a boundary change, re-anchored on
//       purpose)
//   old dee2ec72f25c4ecd9fb93c268c5b14631f898a5f4737a6c25019eef704dc0781
//   new 983b822e15cf800c1f77b5e06d8ff77e4ddd05bd36aeed1ce5859492f6bf9416  (the qualification
//       admission's read of its own committed trust anchor was never declared as a runtime policy
//       load. The check has been red since that module landed, and re-anchoring here is the
//       correction, not a new boundary: the load always happened, only the declaration was absent)
//   old 983b822e15cf800c1f77b5e06d8ff77e4ddd05bd36aeed1ce5859492f6bf9416
//   new dd159e5a0e1de11db0692cfe1b647c113b92dd8b677c1649880ac9cad9fa85fb  (and the same
//       for the identity schema's read of the four files a deployment identity binds -- the
//       assertion reports one undeclared site at a time, so the second only became visible once
//       the first was declared)
//   old dd159e5a0e1de11db0692cfe1b647c113b92dd8b677c1649880ac9cad9fa85fb
//   new d8d9f71dd1a340e4cd68a15e884165989ebbe425a82710d529a6ab5090229d1c  (the provider
//       profile, the transport policy and the transport itself joined the governed common runtime.
//       Which endpoint receives the conversation and how long a run may take are authority
//       questions -- a tampered profile reader redirects every turn -- so all three are pinned by
//       the executed-closure digest an external lease names. A boundary change, re-anchored on
//       purpose)
const TRUSTED_BOUNDARY_SHAPE_SHA256 = 'd8d9f71dd1a340e4cd68a15e884165989ebbe425a82710d529a6ab5090229d1c';

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

/**
 * The security-critical canonical entries whose BYTES are part of the trusted boundary.
 *
 * Everything the governed temporary authority is made of: the whole `scripts/trio` directory
 * (the canonical authority, the lifecycle and ownership-record/reaper implementation, both
 * package-manager entries, the launch wrapper, the provenance generator and the test
 * bootstrap), plus the in-process authority and the adapter boundary it hands validated values
 * across. A file added to or removed from `scripts/trio` changes the entry list, so the set is
 * closed by construction rather than by an easily-stale enumeration.
 */
const ANCHORED_DIRECTORIES = ['scripts/trio'] as const;
const ANCHORED_FILES = [
  'runtime/server/truth-agent-adapter.ts',
  'runtime/server/truth-gate.ts',
  'src/core/temp-authority.ts',
  // The scanner that decides whether any committed call path is governed. It was NOT anchored,
  // and that was the gap: a uniform three-way weakening of it left the cross-repository
  // comparison seeing no divergence and the anchor seeing no change, so the control that finds
  // planted execution could itself be removed invisibly. Its bytes are now part of the boundary.
  'src/core/temp-policy.test.ts',
  // The TUI's build route: a governed child that runs a compiler and writes an artifact.
  'tui/scripts/build.mjs',
] as const;

interface AnchoredEntry {
  readonly path: string;
  readonly type: 'file' | 'symlink' | 'directory' | 'other' | 'absent';
  readonly mode: string;
  readonly sha256: string;
}

/**
 * Classify one anchored path. A symlink is recorded AS a symlink and its target is digested --
 * never followed -- so substituting a link for a file moves the anchor instead of laundering
 * the bytes it points at.
 */
function anchoredEntry(root: string, relativePath: string): AnchoredEntry {
  const path = safePath(relativePath);
  const target = join(root, path);
  let stat;
  try { stat = lstatSync(target); } catch { return { path, type: 'absent', mode: '', sha256: shaBytes('') }; }
  const mode = (stat.mode & 0o777).toString(8).padStart(3, '0');
  if (stat.isSymbolicLink()) return { path, type: 'symlink', mode, sha256: shaBytes(readlinkSync(target)) };
  if (stat.isDirectory()) return { path, type: 'directory', mode, sha256: shaBytes('') };
  if (!stat.isFile()) return { path, type: 'other', mode, sha256: shaBytes('') };
  return { path, type: 'file', mode, sha256: shaBytes(readFileSync(target)) };
}

/** Every anchored entry, deterministically ordered by normalized relative path. */
function anchoredEntries(root: string): AnchoredEntry[] {
  const entries = new Map<string, AnchoredEntry>();
  const walk = (directory: string): void => {
    for (const name of readdirSync(join(root, safePath(directory))).sort()) {
      const path = `${directory}/${name}`;
      const stat = lstatSync(join(root, path));
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(path);
      else entries.set(path, anchoredEntry(root, path));
    }
  };
  for (const directory of ANCHORED_DIRECTORIES) walk(directory);
  for (const file of ANCHORED_FILES) entries.set(file, anchoredEntry(root, file));
  return [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function boundaryShapeDigest(inventory: Inventory, closure: Closure, entries: readonly AnchoredEntry[]): string {
  return shaBytes(JSON.stringify({
    anchorVersion: BOUNDARY_ANCHOR_VERSION,
    inventorySchemaVersion: inventory.schemaVersion,
    shape: {
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
    },
    files: entries,
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
  assert.equal(boundaryShapeDigest(inventory, closure, anchoredEntries(root)), TRUSTED_BOUNDARY_SHAPE_SHA256,
    'architecture boundary cannot self-redefine through local manifests or uniform byte edits');
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
  const expectedDeployment = ['baseToolCeiling', 'capabilityPackCeiling', 'containment', 'defaults', 'environment', 'identity', 'memoryAmbient', 'namespaces', 'routingTargets', 'schemaVersion', 'secretEnvironmentReferences'];
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

    /*
      AN ACKNOWLEDGEMENT MUST SAY WHERE THE BYTES CAME FROM, not merely that somebody saw them.

      A digest on its own answers "are these the bytes we last looked at?" and nothing else, so the
      only way to make it pass again is to write down whatever is there now -- which is exactly the
      move that turns an integrity check into a formality. `lab-memory` drifted, and re-blessing the
      new hash would have been indistinguishable from accepting a tampered tree.

      When a declaration carries a `provenance` block it must instead name the source commit those
      bytes were built from, and that commit must STILL be what is checked out, in a clean tree. So
      a rebuild from an unreviewed commit now fails twice and says which: the digest moved, and the
      acknowledged source is no longer the source. This only strengthens the check -- a declaration
      without the block is verified exactly as before.
    */
    const provenance = (item as { provenance?: Record<string, unknown> }).provenance;
    if (provenance === undefined) continue;
    assert.equal(typeof provenance.sourceCommit, 'string', `${item.specifier}: provenance names no source commit`);
    assert.match(String(provenance.sourceCommit), /^[0-9a-f]{40}$/,
      `${item.specifier}: the acknowledged source commit is not a full commit id`);
    assert.equal(typeof provenance.buildCommand, 'string', `${item.specifier}: provenance names no build command`);
    assert.equal(typeof provenance.reproduced, 'string', `${item.specifier}: provenance records no reproduction`);
    const head = spawnSync('git', ['-C', dependencyRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    assert.equal(head.status, 0, `${item.specifier}: the dependency root is not a readable repository`);
    assert.equal(head.stdout.trim(), provenance.sourceCommit,
      `${item.specifier}: the shipped runtime no longer sits on its acknowledged source commit`);
    /*
      Cleanliness is asserted on the BUILD INPUTS, not on the whole tree.

      `lab-store` keeps agent checkpoints in a data directory beside its source, and the running
      services write there constantly. A whole-tree check would have called that "uncommitted
      source drift" every time an agent took a checkpoint -- an assertion that cries wolf is one
      that gets switched off. What must be committed is whatever the shipped bytes were built
      from, and the declaration names exactly that.
    */
    const sourcePaths = provenance.sourcePaths;
    assert.ok(Array.isArray(sourcePaths) && sourcePaths.length > 0 && sourcePaths.every((p) => typeof p === 'string'),
      `${item.specifier}: provenance names no build inputs`);
    const dirty = spawnSync('git', ['-C', dependencyRoot, 'status', '--porcelain', '--', ...sourcePaths as string[]],
      { encoding: 'utf8' });
    assert.equal(dirty.stdout.trim(), '',
      `${item.specifier}: the acknowledged build inputs have uncommitted changes`);
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
  const entries = anchoredEntries(currentRoot);
  assert.notEqual(boundaryShapeDigest(redefined, closure, entries), TRUSTED_BOUNDARY_SHAPE_SHA256, 'self-updated inventory cannot redefine the trusted shape');
  // The anchor binds bytes, so a UNIFORM edit -- the one shape a cross-repository comparison
  // cannot see, because all three stay byte-identical to one another -- still moves it.
  assert.ok(entries.length > 8, `only ${entries.length} anchored entries; the byte binding would be near-empty`);
  for (const required of [...ANCHORED_FILES, 'scripts/trio/governed-temp-authority.mjs', 'scripts/trio/governed-run.mjs',
       'scripts/trio/governed-launch.mjs', 'scripts/trio/governed-npm.mjs', 'scripts/trio/governed-pnpm.mjs']) {
    const entry = entries.find((e) => e.path === required);
    assert.ok(entry, `${required} is not bound into the trusted boundary`);
    assert.equal(entry.type, 'file', `${required} is anchored as ${entry.type}, not a file`);
  }
  const mutations: ReadonlyArray<readonly [string, AnchoredEntry[]]> = [
    ['uniform byte modification', entries.map((e) => (e.path === 'scripts/trio/governed-temp-authority.mjs' ? { ...e, sha256: shaBytes('tampered') } : e))],
    ['chmod', entries.map((e) => (e.path === 'scripts/trio/governed-pnpm.mjs' ? { ...e, mode: '755' } : e))],
    ['symlink substitution', entries.map((e) => (e.path === 'scripts/trio/governed-run.mjs' ? { ...e, type: 'symlink' as const } : e))],
    ['deletion', entries.filter((e) => e.path !== 'scripts/trio/governed-npm.mjs')],
    ['addition', [...entries, { path: 'scripts/trio/rogue.mjs', type: 'file' as const, mode: '644', sha256: shaBytes('rogue') }]
      .sort((a, b) => (a.path < b.path ? -1 : 1))],
  ];
  for (const [name, mutated] of mutations) {
    assert.notEqual(boundaryShapeDigest(inventory, closure, mutated), TRUSTED_BOUNDARY_SHAPE_SHA256,
      `${name} left the trusted boundary anchor unchanged`);
  }
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

// ---------------------------------------------------------------------------------------------
// CONTAINMENT: the boundary is one artefact, and the allocation is closed per-deployment data.
//
// This file is not part of `governedCommon`, so it may name the deployments. The shared enforcement
// code may not, and the first test below is what holds that line.
// ---------------------------------------------------------------------------------------------

/** The approved allocation. Changing a line here is the reviewed act of changing an allocation. */
const APPROVED_WORKSPACES: Readonly<Record<string, readonly string[]>> = {
  'mad-ptah': ['/pehverse/worktrees', '/pehverse/builds'],
  'loony-luna': ['/pehverse/worktrees', '/pehverse/renders'],
  pehlichi: ['/pehverse/worktrees', '/pehverse/workspace'],
};

const CONTAINMENT_MODULES = [
  'version', 'risk', 'availability', 'paths', 'policy', 'argv', 'wrap', 'conformance', 'index',
] as const;

const deploymentOf = (root: string): { containment: { writableWorkspaces: string[] } } =>
  JSON.parse(readFileSync(join(root, 'deployment/agent.env.json'), 'utf8')) as never;

test('containment: the vendored boundary is byte-identical across the Trio and names no deployment', () => {
  const names = /pehlichi|loony-luna|mad-ptah|johnny|\bpeh\b|\bluna\b|\bptah\b/i;
  for (const module of CONTAINMENT_MODULES) {
    const relative = `src/core/containment/${module}.ts`;
    const reference = readFileSync(join(roots[0]!, relative), 'utf8');
    assert.equal(names.test(reference), false, `${relative} names a deployment`);
    for (const root of roots) {
      assert.equal(readFileSync(join(root, relative), 'utf8'), reference, `${root}: ${relative} differs`);
    }
  }
  // The loader is shared too, and the identity table must not be vendored anywhere.
  const loader = 'src/core/containment-config.ts';
  const loaderReference = readFileSync(join(roots[0]!, loader), 'utf8');
  for (const root of roots) {
    assert.equal(readFileSync(join(root, loader), 'utf8'), loaderReference, `${root}: ${loader} differs`);
    assert.equal(existsSync(join(root, 'src/core/containment/agents.ts')), false,
      `${root}: the identity table must not be vendored`);
  }
});

test('containment: every common policy field is identical, and only writableWorkspaces differs', () => {
  const shapes = new Set<string>();
  const allocations = new Map<string, readonly string[]>();
  for (const [index, root] of roots.entries()) {
    const slot = TRIO_SLOTS[index]!;
    const { containment } = deploymentOf(root);
    const { writableWorkspaces, ...rest } = containment;
    shapes.add(JSON.stringify(rest));
    allocations.set(slot, writableWorkspaces);
  }
  // Every other field of the containment block is common — today there are none, and this is what
  // notices the day someone adds a second per-deployment knob without declaring it a doctrine change.
  assert.equal(shapes.size, 1, 'the containment block must differ only in writableWorkspaces');
  assert.deepEqual([...shapes], ['{}']);
  assert.equal(new Set([...allocations.values()].map((v) => JSON.stringify(v))).size, roots.length,
    'each deployment must have its own allocation');
});

test('containment: each deployment declares exactly its approved workspace set', () => {
  for (const [index, root] of roots.entries()) {
    const slot = TRIO_SLOTS[index]!;
    const approved = APPROVED_WORKSPACES[slot];
    assert.ok(approved !== undefined, `${slot} has an approved allocation`);
    assert.deepEqual(deploymentOf(root).containment.writableWorkspaces, approved,
      `${slot}: declared allocation is not the approved one`);
  }
});

test('containment: a swapped or misbound deployment configuration is rejected', () => {
  // A capsule and a deployment describe the same agent. Binding one agent's capsule to another's
  // deployment must not silently produce a working configuration with the wrong writable set.
  for (const [index, root] of roots.entries()) {
    const slot = TRIO_SLOTS[index]!;
    const other = roots[(index + 1) % roots.length]!;
    const otherSlot = TRIO_SLOTS[(index + 1) % roots.length]!;
    const mine = deploymentOf(root).containment.writableWorkspaces;
    const theirs = deploymentOf(other).containment.writableWorkspaces;
    assert.notDeepEqual(mine, theirs, `${slot} and ${otherSlot} must not share an allocation`);
    // The binding is positional inside one repository: capsule/ and deployment/ are siblings, so a
    // swap is a visible file move, and the approved-set assertion above is what catches it.
    assert.deepEqual(mine, APPROVED_WORKSPACES[slot], `${slot}: allocation is not its own`);
    assert.notDeepEqual(mine, APPROVED_WORKSPACES[otherSlot], `${slot}: allocation is ${otherSlot}'s`);
  }
});

test('containment: no deployment declares a broadened, traversing or expandable path', () => {
  for (const [index, root] of roots.entries()) {
    const slot = TRIO_SLOTS[index]!;
    for (const workspace of deploymentOf(root).containment.writableWorkspaces) {
      assert.ok(workspace.startsWith('/'), `${slot}: ${workspace} is not absolute`);
      assert.equal(/[$`~]/.test(workspace), false, `${slot}: ${workspace} carries an expansion`);
      assert.equal(workspace.includes('//') || workspace.endsWith('/'), false, `${slot}: ${workspace} is not normalised`);
      assert.equal(workspace.split('/').includes('..'), false, `${slot}: ${workspace} traverses`);
      assert.ok(workspace.split('/').filter((p) => p.length > 0).length >= 2, `${slot}: ${workspace} is too broad`);
    }
  }
});

test('containment: the shared schema itself refuses missing, extra and malformed configuration', () => {
  // The negatives are exercised behaviourally in src/core/containment-wiring.test.ts against the
  // real loader. Here parity only proves the SCHEMA is the same one in all three repositories --
  // a per-repository schema would let one of them accept what the others refuse.
  const relative = 'src/core/runtime-config.ts';
  const reference = readFileSync(join(roots[0]!, relative), 'utf8');
  for (const root of roots) {
    assert.equal(readFileSync(join(root, relative), 'utf8'), reference, `${root}: ${relative} differs`);
  }
  assert.match(reference, /assertExactKeys\(deploymentValue\.containment, \['writableWorkspaces'\]/);
  assert.match(reference, /function assertWritableWorkspaces/);
  assert.match(reference, /too broad/);
  assert.match(reference, /carries an expansion/);
});

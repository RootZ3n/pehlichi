import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  computeDeclaredExternalDigest,
  verifyExternalDependencyAtRoot,
} from '../../src/core/external-runtime-integrity.js';
import { parseAuthorityJson } from '../../src/core/runtime-config.js';

interface LocalDependencyDigest {
  readonly specifier: string;
  readonly sha256: string | null;
}

interface ReleaseManifest {
  readonly schemaVersion: 2;
  readonly repositoryId: string;
  readonly agentId: string;
  readonly executionMode: 'source' | 'generated';
  readonly fullGitCommit: string;
  readonly gitTreeId: string;
  readonly dependencyLockDigest: string;
  readonly tuiDependencyLockDigest: string;
  readonly runtimeManifestDigest: string;
  readonly runtimeTreeDigest: string;
  readonly sourceInventoryDigest: string;
  readonly localDependencyDigests: readonly LocalDependencyDigest[];
  readonly artifacts: readonly { readonly path: string; readonly sha256: string }[];
}

export interface ContentVerifiedProvenance extends ReleaseManifest {
  readonly status: 'content-verified';
  readonly gitClaim: 'verified-local-checkout' | 'dirty-local-checkout' | 'asserted-release-metadata';
  readonly trust: 'not-cryptographically-attested';
}

export interface LimitedProvenance {
  readonly status: 'development-unbound' | 'manifest-invalid' | 'manifest-unverified';
  readonly reason: string;
}

export type ReleaseProvenance = ContentVerifiedProvenance | LimitedProvenance;

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_OBJECT = /^[a-f0-9]{40,64}$/;
const MANIFEST_KEYS = [
  'agentId', 'artifacts', 'dependencyLockDigest', 'executionMode', 'fullGitCommit',
  'gitTreeId', 'localDependencyDigests', 'repositoryId', 'runtimeManifestDigest',
  'runtimeTreeDigest', 'schemaVersion', 'sourceInventoryDigest', 'tuiDependencyLockDigest',
] as const;
const ARTIFACT_KEYS = ['path', 'sha256'] as const;
const LOCAL_DEPENDENCY_KEYS = ['sha256', 'specifier'] as const;
const CURRENT_EXECUTION_MODE: ReleaseManifest['executionMode'] = import.meta.url.endsWith('.ts') ? 'source' : 'generated';

function exactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function shaFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function safeRelative(root: string, path: string): string | undefined {
  if (isAbsolute(path) || path.includes('\\') || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    return undefined;
  }
  const resolved = resolve(root, path.split('/').join(sep));
  const rel = relative(root, resolved);
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) return undefined;
  return resolved;
}

function walkFiles(root: string, directory: string): string[] {
  const start = join(root, directory);
  const files: string[] = [];
  const visit = (current: string): void => {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('governed tree contains a symlink');
    for (const entry of readdirSync(current)) {
      const target = join(current, entry);
      const child = lstatSync(target);
      if (child.isSymbolicLink()) throw new Error('governed tree contains a symlink');
      if (child.isDirectory()) visit(target);
      else if (child.isFile()) files.push(relative(root, target).split(sep).join('/'));
    }
  };
  visit(start);
  return files;
}

function framedDigest(repositoryRoot: string, files: readonly string[]): string {
  const hash = createHash('sha256');
  for (const path of [...new Set(files)].sort()) {
    const bytes = readFileSync(join(repositoryRoot, path));
    hash.update(`file:${Buffer.byteLength(path)}:`).update(path).update(`:${bytes.length}:`).update(bytes);
  }
  return hash.digest('hex');
}

function loadGovernedPolicy(repositoryRoot: string): {
  sourceFiles: string[];
  generatedFiles: string[];
  localDependencies: any[];
} {
  const runtimeManifest = JSON.parse(readFileSync(join(repositoryRoot, 'runtime/manifest.json'), 'utf8')) as any;
  const inventoryBytes = readFileSync(join(repositoryRoot, 'trio/path-inventory.json'));
  const closureBytes = readFileSync(join(repositoryRoot, 'trio/runtime-closure.json'));
  if (shaBytes(inventoryBytes) !== runtimeManifest.closedInventorySha256
      || shaBytes(closureBytes) !== runtimeManifest.runtimeClosureSha256) {
    throw new Error('governed inventory anchors are invalid');
  }
  const inventory = JSON.parse(inventoryBytes.toString('utf8')) as any;
  const closure = JSON.parse(closureBytes.toString('utf8')) as any;
  const dataFiles: string[] = [];
  for (const configured of inventory.configurationData ?? []) {
    const target = join(repositoryRoot, configured);
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error('configuration data contains a symlink');
    if (stat.isDirectory()) dataFiles.push(...walkFiles(repositoryRoot, configured));
    else dataFiles.push(configured);
  }
  return {
    sourceFiles: [...new Set([
      ...closure.governedCommon,
      ...inventory.sharedFiles,
      ...dataFiles,
      'package.json',
      'tui/package.json',
    ])].sort(),
    generatedFiles: [...closure.generatedRuntime.governedCommon].sort(),
    localDependencies: closure.legitimateExternalDependencies.filter((item: any) => item.kind === 'local-runtime-tree'),
  };
}

function shaBytes(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function computeRuntimeTreeDigest(repositoryRoot: string): string {
  return framedDigest(repositoryRoot, walkFiles(repositoryRoot, 'runtime'));
}

export function computeSourceExecutionDigest(repositoryRoot: string): string {
  return framedDigest(repositoryRoot, loadGovernedPolicy(repositoryRoot).sourceFiles);
}

function parseManifest(value: unknown, expectedAgentId: string): ReleaseManifest | undefined {
  if (!exactKeys(value, MANIFEST_KEYS)) return undefined;
  if (value.schemaVersion !== 2 || value.repositoryId !== expectedAgentId || value.agentId !== expectedAgentId
      || (value.executionMode !== 'source' && value.executionMode !== 'generated')
      || typeof value.fullGitCommit !== 'string' || !GIT_OBJECT.test(value.fullGitCommit)
      || typeof value.gitTreeId !== 'string' || !GIT_OBJECT.test(value.gitTreeId)
      || typeof value.dependencyLockDigest !== 'string' || !SHA256.test(value.dependencyLockDigest)
      || typeof value.tuiDependencyLockDigest !== 'string' || !SHA256.test(value.tuiDependencyLockDigest)
      || typeof value.runtimeManifestDigest !== 'string' || !SHA256.test(value.runtimeManifestDigest)
      || typeof value.runtimeTreeDigest !== 'string' || !SHA256.test(value.runtimeTreeDigest)
      || typeof value.sourceInventoryDigest !== 'string' || !SHA256.test(value.sourceInventoryDigest)
      || !Array.isArray(value.localDependencyDigests)
      || value.localDependencyDigests.some((item) => !exactKeys(item, LOCAL_DEPENDENCY_KEYS)
        || typeof item.specifier !== 'string'
        || (item.sha256 !== null && (typeof item.sha256 !== 'string' || !SHA256.test(item.sha256))))
      || new Set(value.localDependencyDigests.map((item: any) => item.specifier)).size !== value.localDependencyDigests.length
      || !Array.isArray(value.artifacts) || value.artifacts.some((item) => !exactKeys(item, ARTIFACT_KEYS)
        || typeof item.path !== 'string' || typeof item.sha256 !== 'string' || !SHA256.test(item.sha256))) {
    return undefined;
  }
  return value as unknown as ReleaseManifest;
}

function verifyLocalDependencies(repositoryRoot: string, manifest: ReleaseManifest, declarations: readonly any[]): boolean {
  const expected = new Map(manifest.localDependencyDigests.map((item) => [item.specifier, item.sha256]));
  if (expected.size !== declarations.length) return false;
  for (const declaration of declarations) {
    if (!expected.has(declaration.specifier)) return false;
    const verified = verifyExternalDependencyAtRoot(repositoryRoot, declaration);
    const actual = verified.root === '' ? null : computeDeclaredExternalDigest(verified.root, declaration);
    if (actual !== expected.get(declaration.specifier) || actual !== verified.digest) return false;
  }
  return true;
}

function verifyArtifacts(repositoryRoot: string, manifest: ReleaseManifest, generatedFiles: readonly string[]): boolean {
  if (manifest.executionMode === 'source') return manifest.artifacts.length === 0;
  const expected = [...generatedFiles].sort();
  const actual = manifest.artifacts.map((item) => item.path).sort();
  if (expected.length === 0 || JSON.stringify(expected) !== JSON.stringify(actual)) return false;
  for (const artifact of manifest.artifacts) {
    const target = safeRelative(repositoryRoot, artifact.path);
    if (!target || lstatSync(target).isSymbolicLink() || shaFile(target) !== artifact.sha256) return false;
  }
  return true;
}

function checkoutDirty(repositoryRoot: string, paths: readonly string[]): boolean {
  const output = execFileSync(
    'git',
    ['-C', repositoryRoot, 'status', '--porcelain=v1', '--untracked-files=all', '--', ...paths],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 },
  );
  return output.trim().length > 0;
}

export function loadReleaseProvenance(
  repositoryRoot: string,
  expectedAgentId: string,
  manifestReference?: string,
): ReleaseProvenance {
  if (!manifestReference) return { status: 'development-unbound', reason: 'release manifest not configured' };
  if (isAbsolute(manifestReference) || !manifestReference.startsWith('.release/')) {
    return { status: 'manifest-invalid', reason: 'release manifest path is outside the trusted .release root' };
  }
  const path = safeRelative(repositoryRoot, manifestReference);
  if (!path || dirname(path) !== join(repositoryRoot, '.release')) {
    return { status: 'manifest-invalid', reason: 'release manifest path is not a direct .release child' };
  }
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'manifest-unverified', reason: 'configured release manifest is not available' };
    }
    return { status: 'manifest-invalid', reason: 'release manifest path cannot be trusted' };
  }
  try {
    if (lstatSync(path).isSymbolicLink() || realpathSync(dirname(path)) !== realpathSync(join(repositoryRoot, '.release'))) {
      return { status: 'manifest-invalid', reason: 'release manifest path is symlinked or untrusted' };
    }
    const parsed = parseManifest(parseAuthorityJson(readFileSync(path, 'utf8'), 'release manifest'), expectedAgentId);
    if (!parsed) return { status: 'manifest-invalid', reason: 'release manifest schema or identity is invalid' };
    if (parsed.executionMode !== CURRENT_EXECUTION_MODE) {
      return { status: 'manifest-invalid', reason: `release manifest execution mode does not match the live ${CURRENT_EXECUTION_MODE} runtime` };
    }
    const policy = loadGovernedPolicy(repositoryRoot);
    if (shaFile(join(repositoryRoot, 'pnpm-lock.yaml')) !== parsed.dependencyLockDigest
        || shaFile(join(repositoryRoot, 'tui/pnpm-lock.yaml')) !== parsed.tuiDependencyLockDigest
        || shaFile(join(repositoryRoot, 'runtime/manifest.json')) !== parsed.runtimeManifestDigest
        || computeRuntimeTreeDigest(repositoryRoot) !== parsed.runtimeTreeDigest
        || computeSourceExecutionDigest(repositoryRoot) !== parsed.sourceInventoryDigest
        || !verifyLocalDependencies(repositoryRoot, parsed, policy.localDependencies)
        || !verifyArtifacts(repositoryRoot, parsed, policy.generatedFiles)) {
      return { status: 'manifest-invalid', reason: 'release manifest does not match governed local execution bytes' };
    }

    let gitClaim: ContentVerifiedProvenance['gitClaim'] = 'asserted-release-metadata';
    try {
      const head = execFileSync('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const tree = execFileSync('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (head !== parsed.fullGitCommit || tree !== parsed.gitTreeId) {
        return { status: 'manifest-invalid', reason: 'release Git claims do not match the local checkout' };
      }
      gitClaim = checkoutDirty(repositoryRoot, policy.sourceFiles)
        ? 'dirty-local-checkout'
        : 'verified-local-checkout';
    } catch {
      // Standalone releases carry asserted Git metadata without claiming local corroboration.
    }
    return Object.freeze({
      ...parsed,
      status: 'content-verified',
      gitClaim,
      trust: 'not-cryptographically-attested',
    });
  } catch {
    return { status: 'manifest-invalid', reason: 'release manifest is unavailable, malformed, or unverifiable' };
  }
}

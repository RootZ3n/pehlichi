import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface ExternalDependencyDeclaration {
  readonly specifier: string;
  readonly kind: 'package-lock-governed' | 'local-runtime-tree' | 'runtime-platform';
  readonly digest?: string;
  readonly root?: string;
  readonly files?: readonly string[];
  readonly trees?: readonly string[];
  readonly dynamicEntrypoints?: readonly string[];
  readonly optional?: boolean;
}

interface RuntimeClosurePolicy {
  readonly legitimateExternalDependencies: readonly ExternalDependencyDeclaration[];
}

const SHA256 = /^[a-f0-9]{64}$/;
const verified = new Map<string, string>();

function findRepositoryRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let index = 0; index < 12; index += 1) {
    try {
      lstatSync(join(directory, 'runtime', 'manifest.json'));
      lstatSync(join(directory, 'trio', 'runtime-closure.json'));
      return directory;
    } catch {
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  throw new Error('cannot locate governed runtime root');
}

function safeDeclaredPath(value: string, allowParent = false): string {
  if (typeof value !== 'string' || value.length === 0 || isAbsolute(value) || value.includes('\\')) {
    throw new Error('external dependency declaration contains an unsafe path');
  }
  const parts = value.split('/');
  const normalized = resolve('/', ...parts).slice(1).split(sep).join('/');
  const parentPrefix = allowParent ? parts.filter((part) => part === '..').length : 0;
  const remainder = allowParent ? parts.slice(parentPrefix) : parts;
  if (parts.some((part) => part === '' || part === '.')
      || (!allowParent && parts.includes('..'))
      || (allowParent && remainder.includes('..'))
      || (parentPrefix === 0 && normalized !== value)) {
    throw new Error('external dependency declaration contains a non-normalized path');
  }
  return value;
}

function readPolicy(repositoryRoot: string): RuntimeClosurePolicy {
  const runtimeManifest = JSON.parse(readFileSync(join(repositoryRoot, 'runtime', 'manifest.json'), 'utf8')) as Record<string, unknown>;
  const closureBytes = readFileSync(join(repositoryRoot, 'trio', 'runtime-closure.json'));
  const closureSha = createHash('sha256').update(closureBytes).digest('hex');
  if (runtimeManifest.runtimeClosureSha256 !== closureSha) {
    throw new Error('runtime closure policy does not match its governed manifest anchor');
  }
  const policy = JSON.parse(closureBytes.toString('utf8')) as RuntimeClosurePolicy;
  if (!Array.isArray(policy.legitimateExternalDependencies)) throw new Error('runtime closure external policy is invalid');
  return policy;
}

function declaredFiles(root: string, declaration: ExternalDependencyDeclaration): string[] {
  const result: string[] = [];
  for (const file of declaration.files ?? []) {
    safeDeclaredPath(file);
    const target = join(root, file);
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${declaration.specifier}: declared file is not a regular file`);
    result.push(file);
  }
  const visit = (base: string, directory: string): void => {
    const target = join(base, directory);
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${declaration.specifier}: declared tree is invalid`);
    for (const entry of readdirSync(target)) {
      const child = join(target, entry);
      const childStat = lstatSync(child);
      if (childStat.isSymbolicLink()) throw new Error(`${declaration.specifier}: runtime tree contains a symlink`);
      const relativePath = relative(root, child).split(sep).join('/');
      if (childStat.isDirectory()) visit(root, relativePath);
      else if (childStat.isFile()) result.push(relativePath);
    }
  };
  for (const tree of declaration.trees ?? []) {
    safeDeclaredPath(tree);
    visit(root, tree);
  }
  return [...new Set(result)].sort();
}

export function computeDeclaredExternalDigest(root: string, declaration: ExternalDependencyDeclaration): string {
  const hash = createHash('sha256');
  for (const path of declaredFiles(root, declaration)) {
    const bytes = readFileSync(join(root, path));
    hash.update(`file:${Buffer.byteLength(path)}:`).update(path).update(`:${bytes.length}:`).update(bytes);
  }
  return hash.digest('hex');
}

function declarationFor(specifier: string): { repositoryRoot: string; declaration: ExternalDependencyDeclaration } {
  const repositoryRoot = findRepositoryRoot();
  const declaration = readPolicy(repositoryRoot).legitimateExternalDependencies
    .find((item) => item.specifier === specifier);
  if (!declaration || declaration.kind !== 'local-runtime-tree' || typeof declaration.root !== 'string'
      || typeof declaration.digest !== 'string' || !SHA256.test(declaration.digest)) {
    throw new Error(`${specifier}: no governed local runtime dependency declaration`);
  }
  return { repositoryRoot, declaration };
}

export function verifiedExternalDependencyRoot(specifier: string): string {
  const { repositoryRoot, declaration } = declarationFor(specifier);
  safeDeclaredPath(declaration.root!, true);
  const declaredRoot = resolve(repositoryRoot, declaration.root!);
  let actualRoot: string;
  try {
    const stat = lstatSync(declaredRoot);
    if (stat.isSymbolicLink()) throw new Error('dependency root is a symlink');
    actualRoot = realpathSync(declaredRoot);
  } catch (error) {
    if (declaration.optional === true && (error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
  const cacheKey = `${specifier}\0${actualRoot}\0${declaration.digest}`;
  if (!verified.has(cacheKey)) {
    const digest = computeDeclaredExternalDigest(actualRoot, declaration);
    if (digest !== declaration.digest) throw new Error(`${specifier}: executable dependency digest mismatch`);
    verified.set(cacheKey, digest);
  }
  return actualRoot;
}

/** Verify a declaration relative to an explicitly supplied repository root (release tooling/tests). */
export function verifyExternalDependencyAtRoot(
  repositoryRoot: string,
  declaration: ExternalDependencyDeclaration,
): { readonly root: string; readonly digest: string | null } {
  if (declaration.kind !== 'local-runtime-tree' || typeof declaration.root !== 'string'
      || typeof declaration.digest !== 'string' || !SHA256.test(declaration.digest)) {
    throw new Error(`${declaration.specifier}: invalid local runtime dependency declaration`);
  }
  safeDeclaredPath(declaration.root, true);
  const target = resolve(repositoryRoot, declaration.root);
  let root: string;
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error('dependency root is a symlink');
    root = realpathSync(target);
  } catch (error) {
    if (declaration.optional === true && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return Object.freeze({ root: '', digest: null });
    }
    throw error;
  }
  const digest = computeDeclaredExternalDigest(root, declaration);
  if (digest !== declaration.digest) throw new Error(`${declaration.specifier}: executable dependency digest mismatch`);
  return Object.freeze({ root, digest });
}

/** Read a declared, digest-verified data file without permitting an environment-selected root. */
export function readVerifiedExternalData(specifier: string, file: string): string | null {
  const { declaration } = declarationFor(specifier);
  safeDeclaredPath(file);
  if (!declaration.files?.includes(file)) throw new Error(`${specifier}: undeclared external data file`);
  const root = verifiedExternalDependencyRoot(specifier);
  if (root === '') return null;
  const target = join(root, file);
  const realTarget = realpathSync(target);
  const rel = relative(root, realTarget);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel) || lstatSync(target).isSymbolicLink()) {
    throw new Error(`${specifier}: data file escapes the verified dependency root`);
  }
  return readFileSync(realTarget, 'utf8');
}

export async function importVerifiedExternal(
  specifier: string,
  entrypoint: string,
): Promise<Record<string, unknown> | null> {
  const { declaration } = declarationFor(specifier);
  safeDeclaredPath(entrypoint);
  if (!declaration.dynamicEntrypoints?.includes(entrypoint)) {
    throw new Error(`${specifier}: undeclared dynamic runtime entrypoint`);
  }
  const root = verifiedExternalDependencyRoot(specifier);
  if (root === '') return null;
  const target = join(root, entrypoint);
  const rel = relative(root, realpathSync(target));
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel) || lstatSync(target).isSymbolicLink()) {
    throw new Error(`${specifier}: dynamic entrypoint escapes the verified dependency root`);
  }
  return await import(pathToFileURL(target).href) as Record<string, unknown>;
}

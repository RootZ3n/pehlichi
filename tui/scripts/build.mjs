/**
 * THE TUI BUILD.
 *
 * `tui/package.json` has named `scripts/build.mjs` as its build since the TUI was first
 * scaffolded, and the file was never committed: the manifest declared a build that could not
 * run, and `pnpm run build` failed with MODULE_NOT_FOUND rather than producing anything. There
 * is no authoritative earlier version to restore -- the path appears in no commit, no dangling
 * object and no reflog entry in any of the three repositories -- so this is the smallest
 * deterministic build that satisfies the contract the manifest and the tsconfig already state:
 *
 *   - the entry is `src/entry.tsx`, the same entry `dev` and `start` run;
 *   - the output directory is the tsconfig's `outDir`;
 *   - `esbuild` is a devDependency of this package and nothing else consumes it;
 *   - `allowImportingTsExtensions` makes a `tsc` emit impossible, so the build is a bundle.
 *
 * WHAT IT REFUSES. It runs only as a governed child -- the same assertion `governed-launch.mjs`
 * makes -- so a build started outside the boundary refuses instead of allocating a compile cache
 * against ungoverned storage. A missing entry, a missing manifest, and an output directory that
 * resolves outside this package all fail closed. Nothing is written outside `outDir`.
 *
 * WHY IT LSTATS. A lexical containment test is a claim about a string. An independent audit made
 * `tui/dist` a symlink to a directory elsewhere and this build published into it, reporting
 * success; it made `src/entry.tsx` a symlink to a file elsewhere and this build compiled it. Both
 * passed `startsWith(packageRoot)` and `existsSync`, because both were true of the spelling and
 * neither was true of the file. So every component of the entry and of the output directory is
 * `lstat`ed from the package root down: real directories, a real regular file at the end, no
 * symlink anywhere, and a resolved path that lands back where the walk went. A staging directory
 * is created EXCLUSIVELY, so a name planted between the check and the create is a refusal rather
 * than a target.
 *
 * WHY IT CLEANS UP ON A SIGNAL. The same audit sent SIGTERM while staging existed and found the
 * staging directory still standing afterwards. Interruption is the ordinary end of a build, so
 * the staging directory is removed on exit and on every terminating signal -- and the removal is
 * IDENTITY-BOUND: the path is re-`lstat`ed and its device and inode compared with the directory
 * this process actually created, so a substituted path is left alone rather than deleted. The
 * signal is then re-raised so the parent sees the signal, not a status invented here.
 *
 * WHY IT TYPE-CHECKS. `esbuild` erases types without reading them, so a bundle alone would
 * report success on source that does not compile. The program's diagnostics are collected first,
 * in process, and any error fails the build before a byte is published.
 *
 * WHY IT STAGES. The artifact is removed first, built under a private staging directory named
 * for this run, and moved into place only on success. A failed build therefore cannot leave the
 * previous output standing and be mistaken for a passing one, and two concurrent builds share no
 * writable state: each stages under its own governed run id.
 *
 * DETERMINISM. No clock, no host path and no environment value reaches the output. `esbuild`
 * runs with `absWorkingDir` set to this package, so every path it records is relative to it.
 *
 * Part of the byte-identical Trio shared core.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { assertGovernedChildEnvironment } from '../../scripts/trio/governed-temp-authority.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const require_ = createRequire(import.meta.url);

/** The declared entry, and the single artifact this build publishes. */
const ENTRY = 'src/entry.tsx';
const ARTIFACT = 'entry.mjs';

function refuse(message) {
  process.stderr.write(`tui build: ${message}\n`);
  process.exit(1);
}

/**
 * Walk one declared relative path from the package root, proving each step is what it claims.
 *
 * Returns the absolute path when the walk holds. Every failure is a refusal, because the whole
 * point is that the path may not be reached through anything the build did not put there:
 * `..` in the spelling, a symlinked component, a symlinked leaf, a leaf of the wrong type, or a
 * resolved path that does not land back on the path that was walked.
 */
function containedPath(relative, kind, why) {
  const segments = relative.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.length === 0 || segments.includes('..') || path.isAbsolute(relative))
    return refuse(`${why}: ${relative} is not a path inside this package`);
  let realRoot;
  try { realRoot = fs.realpathSync(packageRoot); }
  catch { return refuse(`${why}: this package's own root does not resolve`); }
  let current = realRoot;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const last = index === segments.length - 1;
    let stats;
    try { stats = fs.lstatSync(current); }
    catch {
      if (last && kind === 'optional-directory') return current;
      return refuse(`${why}: ${relative} does not exist`);
    }
    if (stats.isSymbolicLink())
      return refuse(`${why}: ${relative} is reached through a symbolic link, which is not this package's ${segment}`);
    if (last ? (kind === 'file' ? !stats.isFile() : !stats.isDirectory()) : !stats.isDirectory())
      return refuse(`${why}: ${relative} is not a ${kind === 'file' ? 'regular file' : 'directory'}`);
  }
  try {
    if (fs.realpathSync(current) !== path.join(realRoot, ...segments))
      return refuse(`${why}: ${relative} resolves outside this package`);
  } catch { /* an optional directory that vanished between the walk and here is created below */ }
  return current;
}

/**
 * DESCRIPTOR-BOUND ROOTS.
 *
 * A pathname check proves what a name meant at the instant it was read. An independent audit
 * replaced `tui/dist` with a symlink AFTER the walk above had proved it, and replaced
 * `src/entry.tsx` the same way; the build then published through the link and compiled the
 * substituted source, because every later step reopened those names. Re-walking the names more
 * often only shortens the window.
 *
 * So the build stops using the names. Each trusted directory and file is opened once, without
 * following symlinks, and every later operation goes through `/proc/self/fd/<fd>` -- a handle to
 * the INODE that was proved, not to the name that pointed at it. Replacing the name afterwards
 * cannot redirect a single read or write, because no read or write consults the name again.
 *
 * `openAt` walks one relative path component by component, anchored at the previous descriptor,
 * refusing a symlink at every step. That is `openat(2)` semantics expressed with the primitives
 * Node exposes.
 */
const O = fs.constants;
const fdPath = (fd) => `/proc/self/fd/${fd}`;

function openNoFollow(absolute, directory, why) {
  try {
    return fs.openSync(absolute, O.O_RDONLY | O.O_NOFOLLOW | (directory ? O.O_DIRECTORY : 0));
  } catch (error) {
    if (error?.code === 'ELOOP')
      return refuse(`${why}: ${absolute} is reached through a symbolic link`);
    if (error?.code === 'ENOTDIR')
      return refuse(`${why}: ${absolute} is not a directory`);
    return refuse(`${why}: ${absolute} could not be opened (${error?.code ?? 'unknown'})`);
  }
}

/** Open `relative` beneath an already-trusted directory descriptor, refusing any symlink. */
function openAt(rootFd, relative, kind, why) {
  const segments = relative.split(/[\\/]+/).filter((s) => s.length > 0 && s !== '.');
  if (segments.length === 0 || segments.includes('..'))
    return refuse(`${why}: ${relative} is not a path inside the trusted root`);
  let currentFd = rootFd;
  const opened = [];
  try {
    for (const [index, segment] of segments.entries()) {
      const last = index === segments.length - 1;
      const next = openNoFollow(path.join(fdPath(currentFd), segment), !last || kind === 'directory', why);
      opened.push(next);
      currentFd = next;
    }
    const stats = fs.fstatSync(currentFd);
    if (kind === 'file' ? !stats.isFile() : !stats.isDirectory())
      return refuse(`${why}: ${relative} is not a ${kind === 'file' ? 'regular file' : 'directory'}`);
    opened.pop();
    return { fd: currentFd, dev: stats.dev, ino: stats.ino };
  } finally {
    for (const fd of opened) { try { fs.closeSync(fd); } catch { /* nothing else to do */ } }
  }
}

/** Bind a proved absolute path to its inode. */
function bind(absolute, directory, why) {
  const fd = openNoFollow(absolute, directory, why);
  const stats = fs.fstatSync(fd);
  if (directory ? !stats.isDirectory() : !stats.isFile())
    return refuse(`${why}: ${absolute} is not a ${directory ? 'directory' : 'regular file'}`);
  return { fd, dev: stats.dev, ino: stats.ino, absolute, root: fdPath(fd) };
}

/**
 * Re-prove that a NAME still refers to the inode this build bound.
 *
 * The descriptor already makes an external write impossible. This is the second half of the
 * contract: if the declared path has been replaced since it was proved, the build refuses instead
 * of publishing into a directory that is no longer the one the package declares.
 */
function stillBound(handle, why) {
  let stats;
  try { stats = fs.lstatSync(handle.absolute); }
  catch { return refuse(`${why}: ${handle.absolute} no longer exists`); }
  if (stats.isSymbolicLink())
    return refuse(`${why}: ${handle.absolute} was replaced with a symbolic link after it was proved`);
  if (stats.dev !== handle.dev || stats.ino !== handle.ino)
    return refuse(`${why}: ${handle.absolute} was replaced after it was proved`);
}

function readJson(absolute, why) {
  let text;
  try { text = fs.readFileSync(absolute, 'utf8'); }
  catch { return refuse(`${why}: ${path.relative(packageRoot, absolute)} is missing`); }
  try { return JSON.parse(text); }
  catch { return refuse(`${why}: ${path.relative(packageRoot, absolute)} is not readable as JSON`); }
}

// 1. The boundary. A build is exactly the kind of child that caches against os.tmpdir() the
//    moment it starts, so it proves it is governed before it does anything else.
const governed = assertGovernedChildEnvironment(process.env);

// 2. The declared inputs. Absence is a refusal, never a default, and so is a spelling that names
//    something other than this package's own committed file.
readJson(path.join(packageRoot, 'package.json'), 'the package manifest');
const tsconfig = readJson(path.join(packageRoot, 'tsconfig.json'), 'the compiler configuration');
containedPath(ENTRY, 'file', 'the declared entry');

// 3. The output directory, taken from the compiler configuration rather than assumed, confined,
//    and then BOUND. The walk proves the name; the descriptor holds the inode. Everything this
//    build writes goes through the descriptor, so replacing the name afterwards cannot redirect it.
const declaredOutDir = tsconfig?.compilerOptions?.outDir;
if (typeof declaredOutDir !== 'string' || declaredOutDir.length === 0)
  refuse('the compiler configuration declares no outDir, so there is no output path to write');
const outDirPath = containedPath(declaredOutDir, 'optional-directory', 'the output directory');
fs.mkdirSync(outDirPath, { recursive: true, mode: 0o700 });
containedPath(declaredOutDir, 'directory', 'the output directory');
const outHandle = bind(outDirPath, true, 'the output directory');
const outRoot = outHandle.root;

// The source root. `rootDir` is the repository, not this package: the compiler consumes 168 files
// and only 17 of them live under `tui/`. Protecting the entry alone would leave the other 151
// open to exactly the substitution the audit demonstrated, so the whole set is bound below.
const repoRootPath = path.resolve(packageRoot, '..');
const repoHandle = bind(repoRootPath, true, 'the source root');

// 4. The previously published artifact goes FIRST, before anything that can fail, and it is
//    removed THROUGH the bound output directory rather than by name.
fs.rmSync(path.join(outRoot, ARTIFACT), { force: true });

/**
 * 4a. Interruption is an ordinary end for a build, and it must not be a way to leave residue.
 *
 * Staging and the source snapshot are removed on exit and on every terminating signal. Each
 * removal is bound to the directory this process CREATED -- device and inode, re-read at the
 * moment of removal -- so a path that has been replaced, or that was never ours, is left standing
 * rather than deleted. The signal is then re-raised with its own handler removed, so the parent
 * observes the signal this process actually received.
 */
let stagingName;
let stagingIdentity;
let snapshotRoot;
let snapshotIdentity;
function removeOwned(absolute, identity) {
  if (absolute === undefined || identity === undefined) return;
  let stats;
  try { stats = fs.lstatSync(absolute); } catch { return; }
  if (!stats.isDirectory()) return;
  if (stats.dev !== identity.dev || stats.ino !== identity.ino) return;
  try { fs.rmSync(absolute, { recursive: true, force: true }); } catch { /* nothing else to do */ }
}
function cleanup() {
  if (stagingName !== undefined) removeOwned(path.join(outRoot, stagingName), stagingIdentity);
  removeOwned(snapshotRoot, snapshotIdentity);
}
let published = false;
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
  process.on(signal, () => {
    cleanup();
    if (!published) fs.rmSync(path.join(outRoot, ARTIFACT), { force: true });
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
}

/**
 * 5. THE SOURCE SNAPSHOT.
 *
 * TypeScript and esbuild both open their inputs by pathname. Proving `src/entry.tsx` and then
 * handing its NAME to either tool reopens whatever occupies that name at the moment the tool
 * reads it -- which is exactly the substitution the audit performed. Neither tool can be told to
 * read a descriptor.
 *
 * So neither tool is shown the working tree. Every file the compiler resolves is opened here,
 * anchored at the bound source root, refusing a symlink at every component, read through the
 * descriptor, and written into a private snapshot under this run's governed directory (mode 0700,
 * outside any path an attacker can reach). The type-check and the bundle then run against the
 * snapshot. A source replaced after this point is not read by anything, so substituted content
 * cannot be compiled -- and the identity re-proof below still refuses the build outright.
 *
 * `node_modules` is linked rather than copied: dependency identity is the dependency-closure
 * suite's contract, not this build's, and copying an installed tree would make the artifact depend
 * on it. The link lives inside the private snapshot, which is owner-only.
 */
/** Specifier rewrite for the enumeration pass, against the working tree. */
const rewriteProbeSpecifier = {
  name: 'trio-source-specifiers-probe',
  setup(build) {
    build.onResolve({ filter: /^\.{1,2}\// }, (args) => {
      const base = path.resolve(args.resolveDir, args.path);
      if (!base.endsWith('.js')) return null;
      const stem = base.slice(0, -3);
      for (const candidate of [`${stem}.ts`, `${stem}.tsx`, base]) {
        try { if (fs.lstatSync(candidate).isFile()) return { path: candidate }; } catch { /* try the next */ }
      }
      return null;
    });
  },
};

const ts = require_('typescript');
const parsedConfig = ts.parseJsonConfigFileContent(
  tsconfig, ts.sys, packageRoot, { noEmit: true }, path.join(packageRoot, 'tsconfig.json'),
);
if (parsedConfig.errors.length > 0)
  refuse(`the compiler configuration is invalid:\n${ts.formatDiagnostics(parsedConfig.errors, {
    getCanonicalFileName: (f) => f, getCurrentDirectory: () => packageRoot, getNewLine: () => '\n',
  })}`);

snapshotRoot = path.join(governed.runDir, `tui-build-source-${governed.runId}`);
try { fs.mkdirSync(snapshotRoot, { mode: 0o700 }); }
catch { refuse('the private source snapshot directory already exists; refusing to build through it'); }
{
  const stats = fs.lstatSync(snapshotRoot);
  if (!stats.isDirectory()) refuse('the private source snapshot is not a directory');
  snapshotIdentity = { dev: stats.dev, ino: stats.ino };
}

/** Copy one repository-relative file into the snapshot through descriptor-bound reads. */
function snapshotFile(relative) {
  const opened = openAt(repoHandle.fd, relative, 'file', 'a declared source file');
  let bytes;
  try { bytes = fs.readFileSync(opened.fd); }
  finally { try { fs.closeSync(opened.fd); } catch { /* nothing else to do */ } }
  const destination = path.join(snapshotRoot, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.writeFileSync(destination, bytes, { mode: 0o600 });
  return { relative, dev: opened.dev, ino: opened.ino };
}

/**
 * The complete source set, not the declared one.
 *
 * `tsconfig`'s include globs name 168 files, but the compiler also resolves modules those files
 * import -- `scripts/trio/governed-temp-authority.mjs` among them. Snapshotting only the globbed
 * set leaves every resolved-but-unglobbed file open to the same substitution, so the set is taken
 * from a program built over the working tree and used ONLY to enumerate. Its diagnostics are
 * discarded; the diagnostics that decide the build come from the snapshot.
 */
const probe = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);
const resolved = new Set(parsedConfig.fileNames);
for (const file of probe.getSourceFiles()) resolved.add(file.fileName);

/**
 * esbuild resolves files TypeScript never lists.
 *
 * A TypeScript-only snapshot is incomplete: `src/core/temp-authority.ts` imports
 * `scripts/trio/governed-temp-authority.mjs`, which the compiler resolves as a module but does not
 * report as a source file, so it never appears in `getSourceFiles()`. Bundling from a snapshot
 * built only from the compiler's view fails to resolve it -- and, worse, a snapshot that merely
 * happened to contain it would still leave any other esbuild-only input reachable through the
 * working tree. So the bundler is asked directly, with a metafile pass that writes nothing, and
 * the union of both views is what gets captured.
 */
const probeBuild = await (await import('esbuild')).build({
  absWorkingDir: packageRoot, entryPoints: [ENTRY], bundle: true, write: false, metafile: true,
  packages: 'external', platform: 'node', format: 'esm', target: 'es2022', jsx: 'automatic',
  logLevel: 'silent', plugins: [rewriteProbeSpecifier],
}).catch((error) => refuse(`the source graph could not be resolved:\n${error?.message ?? String(error)}`));
for (const input of Object.keys(probeBuild.metafile.inputs)) resolved.add(path.resolve(packageRoot, input));
const sourceRelatives = [];
const nodeModules = `${path.sep}node_modules${path.sep}`;
for (const absolute of resolved) {
  const normalised = path.resolve(absolute);
  if (!normalised.startsWith(repoRootPath + path.sep)) continue;   // dependency types, linked below
  if (normalised.includes(nodeModules)) continue;
  sourceRelatives.push(path.relative(repoRootPath, normalised));
}
for (const declared of ['tui/tsconfig.json', 'tui/package.json', 'package.json']) {
  if (fs.existsSync(path.join(repoRootPath, declared))) sourceRelatives.push(declared);
}
if (!sourceRelatives.includes(path.join('tui', ENTRY)))
  refuse('the declared entry is not part of the compiler configuration');
// Dependency trees are linked first, so a snapshotted file can never collide with the link and
// a failure to link is a refusal rather than a silent type error later.
for (const linked of ['node_modules', 'tui/node_modules']) {
  const source = path.join(repoRootPath, linked);
  if (!fs.existsSync(source)) continue;
  const destination = path.join(snapshotRoot, linked);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  try { fs.symlinkSync(fs.realpathSync(source), destination, 'dir'); }
  catch (error) { refuse(`the source snapshot could not link ${linked}: ${error?.code ?? error}`); }
}

const snapshotted = sourceRelatives.map(snapshotFile);

const snapshotPackage = path.join(snapshotRoot, 'tui');

// 6. Type errors fail the build -- checked against the snapshot, never against the working tree.
const snapshotConfig = ts.parseJsonConfigFileContent(
  tsconfig, ts.sys, snapshotPackage, { noEmit: true }, path.join(snapshotPackage, 'tsconfig.json'),
);
const program = ts.createProgram(snapshotConfig.fileNames, snapshotConfig.options);
const diagnostics = ts.getPreEmitDiagnostics(program)
  .filter((d) => d.category === ts.DiagnosticCategory.Error);
if (diagnostics.length > 0) {
  process.stderr.write(ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (f) => f, getCurrentDirectory: () => snapshotPackage, getNewLine: () => '\n',
  }));
  refuse(`${diagnostics.length} type error(s); nothing was written`);
}

// 7. Staging is created only once the build is known to be worth publishing, EXCLUSIVELY, and
//    THROUGH the bound output directory: a name planted between the check and the create is a
//    refusal rather than a target, and a `dist` replaced after the proof cannot relocate it.
stagingName = `.staging-${governed.runId}`;
const stagingAbsolute = path.join(outRoot, stagingName);
try { fs.mkdirSync(stagingAbsolute, { mode: 0o700 }); }
catch { refuse(`the staging directory ${stagingName} already exists; refusing to build through it`); }
const stagingHandle = bind(stagingAbsolute, true, 'the staging directory');
stagingIdentity = { dev: stagingHandle.dev, ino: stagingHandle.ino };

/**
 * Resolve the way the runtime does: these sources import each other with `.js` specifiers while
 * the files on disk are `.ts`/`.tsx`. Resolution is confined to the snapshot, so an import cannot
 * reach back into the working tree during the bundle.
 */
const rewriteJsSpecifier = {
  name: 'trio-source-specifiers',
  setup(build) {
    build.onResolve({ filter: /^\.{1,2}\// }, (args) => {
      const base = path.resolve(args.resolveDir, args.path);
      if (!base.startsWith(snapshotRoot + path.sep)) return { errors: [{ text: `import escapes the source snapshot: ${args.path}` }] };
      if (!base.endsWith('.js')) return null;
      const stem = base.slice(0, -3);
      for (const candidate of [`${stem}.ts`, `${stem}.tsx`, base]) {
        try { if (fs.lstatSync(candidate).isFile()) return { path: candidate }; } catch { /* try the next */ }
      }
      return null;
    });
  },
};

/**
 * esbuild is given an ordinary private directory, not a descriptor path.
 *
 * A `/proc/self/fd/<n>` outfile fails: the bundler calls `mkdir` on the parent it derives from the
 * outfile, and that parent is the magic link itself. So the bundle lands in the run's own governed
 * storage -- owner-only, outside any attacker-reachable path -- and only the finished bytes are
 * written into staging THROUGH the bound output descriptor. No pathname the attacker controls is
 * ever used to place the artifact.
 */
const bundleOut = path.join(snapshotRoot, 'out');
fs.mkdirSync(bundleOut, { mode: 0o700 });

const esbuild = await import('esbuild');
try {
  await esbuild.build({
    absWorkingDir: snapshotPackage,
    entryPoints: [ENTRY],
    outfile: path.join(bundleOut, ARTIFACT),
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'es2022',
    jsx: 'automatic',
    sourcemap: false,
    minify: false,
    logLevel: 'silent',
    plugins: [rewriteJsSpecifier],
  });
} catch (error) {
  cleanup();
  refuse(`bundling failed:\n${error?.message ?? String(error)}`);
}

// 8. Publish. Before a byte moves, every identity this build proved is re-proved: the output
//    directory, the source root, and every source file. A replacement anywhere refuses the build
//    with nothing published -- and because the rename goes through the bound descriptors, a
//    replacement could not have sent it outside the package even if it had gone unnoticed.
stillBound(outHandle, 'the output directory');
stillBound(repoHandle, 'the source root');
for (const file of snapshotted) {
  let stats;
  try { stats = fs.lstatSync(path.join(repoRootPath, file.relative)); }
  catch { refuse(`a declared source file disappeared during the build: ${file.relative}`); }
  if (stats.isSymbolicLink() || stats.dev !== file.dev || stats.ino !== file.ino)
    refuse(`a declared source file was replaced during the build: ${file.relative}`);
}

const bundled = path.join(bundleOut, ARTIFACT);
const bundledStats = fs.lstatSync(bundled);
if (!bundledStats.isFile()) refuse('the bundled artifact is not a regular file');
const staged = path.join(stagingHandle.root, ARTIFACT);
fs.writeFileSync(staged, fs.readFileSync(bundled), { mode: 0o600 });
const stagedStats = fs.lstatSync(staged);
if (!stagedStats.isFile()) refuse('the staged artifact is not a regular file');
fs.renameSync(staged, path.join(outRoot, ARTIFACT));
published = true;
cleanup();

const bytes = fs.readFileSync(path.join(outRoot, ARTIFACT));
if (bytes.length === 0) refuse(`${path.join(declaredOutDir, ARTIFACT)} was published empty`);
process.stdout.write(`tui build: ${path.join(declaredOutDir, ARTIFACT)} ${bytes.length} bytes sha256=${createHash('sha256').update(bytes).digest('hex')}\n`);

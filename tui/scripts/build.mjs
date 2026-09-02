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

// 3. The output directory, taken from the compiler configuration rather than assumed, and
//    confined: a build that can be pointed outside its own package is not a build, it is a write
//    primitive. It need not exist yet -- but if it does, it is a real directory of this package's,
//    reached through real directories, or the build refuses rather than publishing through it.
const declaredOutDir = tsconfig?.compilerOptions?.outDir;
if (typeof declaredOutDir !== 'string' || declaredOutDir.length === 0)
  refuse('the compiler configuration declares no outDir, so there is no output path to write');
const outDir = containedPath(declaredOutDir, 'optional-directory', 'the output directory');
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
containedPath(declaredOutDir, 'directory', 'the output directory');
const artifact = path.join(outDir, ARTIFACT);

// 4. The previously published artifact goes FIRST, before anything that can fail. Removing it
//    after the type-check would leave the last successful output standing behind a failed build,
//    where the next reader finds a plausible artifact and no reason to doubt it.
fs.rmSync(artifact, { force: true });

/**
 * 4a. Interruption is an ordinary end for a build, and it must not be a way to leave residue.
 *
 * The staging directory is removed on exit and on every terminating signal. The removal is bound
 * to the directory this process CREATED -- device and inode, re-read at the moment of removal --
 * so a path that has been replaced, or that was never ours, is left standing rather than deleted.
 * The signal is then re-raised with its own handler removed, so the parent observes the signal
 * this process actually received instead of a status invented in its place.
 */
let stagingPath;
let stagingIdentity;
function removeOwnStaging() {
  if (stagingPath === undefined || stagingIdentity === undefined) return;
  let stats;
  try { stats = fs.lstatSync(stagingPath); } catch { return; }
  if (!stats.isDirectory()) return;
  if (stats.dev !== stagingIdentity.dev || stats.ino !== stagingIdentity.ino) return;
  try { fs.rmSync(stagingPath, { recursive: true, force: true }); } catch { /* nothing else to do */ }
}
let published = false;
process.on('exit', removeOwnStaging);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
  process.on(signal, () => {
    removeOwnStaging();
    // An artifact that has not been published yet is, at best, a half-written one; an artifact
    // that HAS been published is this build's finished work and outlives the signal.
    if (!published) fs.rmSync(artifact, { force: true });
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
}

// 5. Type errors fail the build. The diagnostics come from the same configuration the
//    `type-check` script uses, read in process so no second toolchain can disagree with it.
const ts = require_('typescript');
const parsedConfig = ts.parseJsonConfigFileContent(
  tsconfig,
  ts.sys,
  packageRoot,
  { noEmit: true },
  path.join(packageRoot, 'tsconfig.json'),
);
if (parsedConfig.errors.length > 0)
  refuse(`the compiler configuration is invalid:\n${ts.formatDiagnostics(parsedConfig.errors, {
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => packageRoot,
    getNewLine: () => '\n',
  })}`);
const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);
const diagnostics = ts.getPreEmitDiagnostics(program)
  .filter((d) => d.category === ts.DiagnosticCategory.Error);
if (diagnostics.length > 0) {
  process.stderr.write(ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => packageRoot,
    getNewLine: () => '\n',
  }));
  refuse(`${diagnostics.length} type error(s); nothing was written`);
}

// 6. Staging is created only once the build is known to be worth publishing, and created
//    EXCLUSIVELY: removing a name and then creating it is a window in which someone else's
//    symlink can occupy it, and this build would then have staged through their link. `mkdir`
//    without `recursive` fails on an existing name instead, which is the answer -- a staging
//    name that already exists belongs to somebody, and this run is not entitled to it.
const staging = path.join(outDir, `.staging-${governed.runId}`);
try { fs.mkdirSync(staging, { mode: 0o700 }); }
catch { refuse(`the staging directory ${path.relative(packageRoot, staging)} already exists; refusing to build through it`); }
stagingPath = staging;
const stagingStats = fs.lstatSync(staging);
if (!stagingStats.isDirectory()) refuse('the staging directory is not a directory');
stagingIdentity = { dev: stagingStats.dev, ino: stagingStats.ino };

/**
 * Resolve the way the runtime does.
 *
 * These sources import each other with `.js` specifiers while the files on disk are `.ts` and
 * `.tsx` -- the same rewrite `scripts/trio/build-provenance.mjs` performs to walk the import
 * graph. Without it a bundler resolves nothing at all.
 */
const rewriteJsSpecifier = {
  name: 'trio-source-specifiers',
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

const esbuild = await import('esbuild');
try {
  await esbuild.build({
    absWorkingDir: packageRoot,
    entryPoints: [ENTRY],
    outfile: path.relative(packageRoot, path.join(staging, ARTIFACT)),
    bundle: true,
    // Every bare specifier stays external. The build's job is this package's own sources;
    // vendoring a dependency tree into the artifact would make the output depend on an installed
    // tree rather than on the committed one.
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
  removeOwnStaging();
  refuse(`bundling failed:\n${error?.message ?? String(error)}`);
}

// 7. Publish, then prove the artifact is really there. The staged file is proved to be a real
//    regular file of this run's before it is renamed: publishing whatever now sits at that name
//    would be handing the artifact's identity to whoever put it there.
const staged = path.join(staging, ARTIFACT);
const stagedStats = fs.lstatSync(staged);
if (!stagedStats.isFile()) refuse('the staged artifact is not a regular file');
fs.renameSync(staged, artifact);
published = true;
removeOwnStaging();

const bytes = fs.readFileSync(artifact);
if (bytes.length === 0) refuse(`${path.relative(packageRoot, artifact)} was published empty`);
process.stdout.write(`tui build: ${path.relative(packageRoot, artifact)} ${bytes.length} bytes sha256=${createHash('sha256').update(bytes).digest('hex')}\n`);

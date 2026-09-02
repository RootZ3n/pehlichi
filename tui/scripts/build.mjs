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

// 2. The declared inputs. Absence is a refusal, never a default.
readJson(path.join(packageRoot, 'package.json'), 'the package manifest');
const tsconfig = readJson(path.join(packageRoot, 'tsconfig.json'), 'the compiler configuration');
const entryAbsolute = path.join(packageRoot, ENTRY);
if (!fs.existsSync(entryAbsolute)) refuse(`the declared entry ${ENTRY} does not exist`);

// 3. The output directory, taken from the compiler configuration rather than assumed, and
//    confined: a build that can be pointed outside its own package is not a build, it is a write
//    primitive.
const declaredOutDir = tsconfig?.compilerOptions?.outDir;
if (typeof declaredOutDir !== 'string' || declaredOutDir.length === 0)
  refuse('the compiler configuration declares no outDir, so there is no output path to write');
const outDir = path.resolve(packageRoot, declaredOutDir);
const withinPackage = outDir.startsWith(packageRoot + path.sep);
if (!withinPackage) refuse(`the output directory ${declaredOutDir} resolves outside this package`);
const artifact = path.join(outDir, ARTIFACT);

// 4. The previously published artifact goes FIRST, before anything that can fail. Removing it
//    after the type-check would leave the last successful output standing behind a failed build,
//    where the next reader finds a plausible artifact and no reason to doubt it.
fs.rmSync(artifact, { force: true });

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

// 6. Staging is created only once the build is known to be worth publishing.
const staging = path.join(outDir, `.staging-${governed.runId}`);
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true, mode: 0o700 });

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
  fs.rmSync(staging, { recursive: true, force: true });
  refuse(`bundling failed:\n${error?.message ?? String(error)}`);
}

// 7. Publish, then prove the artifact is really there.
fs.renameSync(path.join(staging, ARTIFACT), artifact);
fs.rmSync(staging, { recursive: true, force: true });

const bytes = fs.readFileSync(artifact);
if (bytes.length === 0) refuse(`${path.relative(packageRoot, artifact)} was published empty`);
process.stdout.write(`tui build: ${path.relative(packageRoot, artifact)} ${bytes.length} bytes sha256=${createHash('sha256').update(bytes).digest('hex')}\n`);

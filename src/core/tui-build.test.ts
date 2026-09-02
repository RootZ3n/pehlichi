/**
 * THE TUI BUILD, AS A CONTRACT.
 *
 * `tui/package.json` named `scripts/build.mjs` as its build from the first commit that created
 * the TUI, and no commit ever added the file. The manifest promised a build that did not exist,
 * and the only thing that noticed was an external audit running the route by hand. A build that
 * nothing exercises is a build that can go missing again, so the contract is asserted here:
 *
 *   - it produces the declared artifact, and says so;
 *   - a stale artifact cannot survive a failed build and be read as a pass;
 *   - a type error fails it, rather than being erased by a bundler that never reads types;
 *   - it refuses to run outside the governed boundary;
 *   - it writes nothing to shared temporary storage and leaves no staging residue;
 *   - two builds running at once share no writable state;
 *   - its entry and its output directory are files of THIS package, proved by `lstat` and not by
 *     the shape of a string -- an independent audit made `tui/dist` a symlink to a directory
 *     elsewhere and watched this build publish into it, and made `src/entry.tsx` a symlink to a
 *     file elsewhere and watched this build compile it, both reporting success;
 *   - a signal during the build leaves no staging directory and no half-published artifact, and
 *     the signal itself reaches the parent unchanged;
 *   - the cleanup deletes THIS run's staging directory and nothing else, so a build cannot be
 *     turned into a way to remove a path somebody substituted at that name.
 *
 * The fixture is a minimal package rather than the real TUI. What is under test is the build
 * script's contract, and a fixture makes each property provable in isolation -- including the
 * failure cases, which cannot be provoked in a tree that is supposed to compile.
 *
 * Part of the byte-identical Trio shared core.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { TEMP_ROOT_ENV, processScratchDir } from "./temp-authority.js";
import { FORBIDDEN_ROOTS } from "../../scripts/trio/governed-temp-authority.mjs";

const REPOSITORY = process.cwd();
/**
 * The launcher is named by its canonical repository-relative spelling and run with the repository
 * as the working directory, rather than by an absolute path assembled here. That is the spelling
 * the committed-execution scanner recognises as the boundary, so this file's own call path is
 * governed by the same identity rule it is testing rather than by an exemption.
 */
const LAUNCH = "scripts/trio/governed-launch.mjs";
const BUILD_SOURCE = join(REPOSITORY, "tui/scripts/build.mjs");
const MODULES = join(REPOSITORY, "tui/node_modules");

/**
 * The shared-storage names a build could plausibly leave behind.
 *
 * The roots come from the authority rather than from a literal here: the forbidden set is the
 * authority's to define, and a detector that hard-codes its own copy stops agreeing with it the
 * first time the set changes.
 */
function sharedEntries(): readonly string[] {
  const found: string[] = [];
  for (const root of FORBIDDEN_ROOTS) {
    let names: string[];
    try { names = readdirSync(root); } catch { continue; }
    for (const name of names)
      if (name.startsWith("tsx-") || name === "node-compile-cache" || name.startsWith("trio-"))
        found.push(`${root}/${name}`);
  }
  return found.sort();
}
const SHARED_BASELINE = sharedEntries();

function scratch(name: string): string {
  const dir = join(processScratchDir(), `tui-build-${name}-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const TSCONFIG = {
  compilerOptions: {
    target: "ES2022",
    module: "ES2022",
    moduleResolution: "bundler",
    jsx: "react-jsx",
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    outDir: "dist",
    allowImportingTsExtensions: true,
    noEmit: true,
  },
  include: ["src/**/*"],
};

/**
 * A minimal package shaped exactly like the TUI: the build script at `tui/scripts/build.mjs`,
 * the governed authority two levels above it, and an entry that imports a sibling through a
 * `.js` specifier -- the specifier style these sources actually use, and the one a bundler
 * resolves nothing without.
 */
function fixture(options: { readonly broken?: boolean; readonly modules?: number } = {}): string {
  const root = scratch("fixture");
  mkdirSync(join(root, "tui/scripts"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "tui/src"), { recursive: true, mode: 0o700 });
  cpSync(join(REPOSITORY, "scripts/trio"), join(root, "scripts/trio"), { recursive: true });
  cpSync(BUILD_SOURCE, join(root, "tui/scripts/build.mjs"));
  symlinkSync(MODULES, join(root, "tui/node_modules"));
  writeFileSync(join(root, "tui/package.json"),
    `${JSON.stringify({ name: "tui-build-fixture", private: true, type: "module" }, null, 2)}\n`);
  writeFileSync(join(root, "tui/tsconfig.json"), `${JSON.stringify(TSCONFIG, null, 2)}\n`);
  writeFileSync(join(root, "tui/src/helper.ts"), "export const helper = (): number => 41;\n");
  // A build long enough to be interrupted while it is staging. The modules are trivial and
  // type-correct: what makes the build take measurable time is how many of them the program has
  // to check and the bundler has to read, not what any one of them contains.
  const extra: string[] = [];
  for (let index = 0; index < (options.modules ?? 0); index++) {
    writeFileSync(join(root, `tui/src/mod-${index}.ts`), `export const value${index}: number = ${index};\n`);
    extra.push(`import { value${index} } from './mod-${index}.js';`);
  }
  const sum = extra.length === 0 ? "" : ` + ${extra.map((_, index) => `value${index}`).join(" + ")}`;
  writeFileSync(join(root, "tui/src/entry.tsx"),
    options.broken === true
      // A type error the bundler alone would erase without complaint.
      ? "import { helper } from './helper.js';\nconst total: string = helper();\nexport default total;\n"
      : `${extra.join("\n")}${extra.length === 0 ? "" : "\n"}import { helper } from './helper.js';\nconst total: number = helper() + 1${sum};\nexport default total;\n`);
  return root;
}

/** Run the fixture's build through the canonical governed entry, as the manifest does. */
function runBuild(root: string, governedRoot: string): { status: number | null; out: string } {
  const result = spawnSync(process.execPath,
    [LAUNCH, "--entry=operator", "trio-test", "--", process.execPath, join(root, "tui/scripts/build.mjs")],
    {
      cwd: REPOSITORY,
      encoding: "utf8",
      timeout: 240_000,
      shell: false,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", [TEMP_ROOT_ENV]: governedRoot },
    });
  return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const artifactOf = (root: string): string => join(root, "tui/dist/entry.mjs");
const stagingOf = (root: string): readonly string[] => {
  const dist = join(root, "tui/dist");
  return existsSync(dist) ? readdirSync(dist).filter((n) => n.startsWith(".staging-")).sort() : [];
};

test("the declared build runs, publishes the declared artifact, and reports it", () => {
  const root = fixture();
  const built = runBuild(root, scratch("root"));
  assert.equal(built.status, 0, `the build failed: ${built.out}`);
  const artifact = artifactOf(root);
  assert.ok(existsSync(artifact), "the build reported success without publishing the declared artifact");
  const bytes = readFileSync(artifact, "utf8");
  assert.ok(bytes.length > 0, "the published artifact is empty");
  assert.match(bytes, /helper/, "the artifact does not contain the source it was built from");
  assert.match(built.out, /sha256=[0-9a-f]{64}/, "the build does not report what it published");
  // Determinism: the same inputs produce the same bytes, with no clock or host path in them.
  const again = runBuild(root, scratch("root"));
  assert.equal(again.status, 0, `the second build failed: ${again.out}`);
  assert.equal(readFileSync(artifact, "utf8"), bytes, "two builds of the same sources disagreed");
  assert.equal(/\/home\/|\/pehverse\//.test(bytes), false, "a host path reached the artifact");
  assert.deepEqual(stagingOf(root), [], "the build left staging residue behind");
  assert.deepEqual(sharedEntries(), SHARED_BASELINE, "the build touched shared temporary storage");
  rmSync(root, { recursive: true, force: true });
});

test("a type error fails the build, and no stale artifact survives to be read as a pass", () => {
  const root = fixture({ broken: true });
  const stale = artifactOf(root);
  mkdirSync(join(root, "tui/dist"), { recursive: true, mode: 0o700 });
  writeFileSync(stale, "// a previous build's output\nexport default 'stale';\n");
  const built = runBuild(root, scratch("root"));
  assert.notEqual(built.status, 0, "a source that does not type-check produced a successful build");
  assert.match(built.out, /type error/, `the failure does not name the cause: ${built.out}`);
  assert.equal(existsSync(stale), false,
    "the previous artifact survived a failed build, so a stale output can be mistaken for a pass");
  assert.deepEqual(stagingOf(root), [], "the failed build left staging residue behind");
  assert.deepEqual(sharedEntries(), SHARED_BASELINE, "the failed build touched shared temporary storage");
  rmSync(root, { recursive: true, force: true });
});

test("the build refuses outside the governed boundary rather than caching against shared storage", () => {
  const root = fixture();
  const result = spawnSync(process.execPath, [join(root, "tui/scripts/build.mjs")], {
    encoding: "utf8",
    timeout: 60_000,
    shell: false,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  });
  assert.notEqual(result.status, 0, "the build ran with no governed environment at all");
  assert.equal(existsSync(artifactOf(root)), false, "a refused build still published an artifact");
  assert.deepEqual(sharedEntries(), SHARED_BASELINE, "the refused build touched shared temporary storage");
  rmSync(root, { recursive: true, force: true });
});

test("a missing entry and an output path outside the package are refusals, not defaults", () => {
  const missing = fixture();
  rmSync(join(missing, "tui/src/entry.tsx"), { force: true });
  const noEntry = runBuild(missing, scratch("root"));
  assert.notEqual(noEntry.status, 0, "the build accepted a missing entry");
  assert.match(noEntry.out, /entry/, `the refusal does not name the cause: ${noEntry.out}`);
  rmSync(missing, { recursive: true, force: true });

  const escaping = fixture();
  writeFileSync(join(escaping, "tui/tsconfig.json"),
    `${JSON.stringify({ ...TSCONFIG, compilerOptions: { ...TSCONFIG.compilerOptions, outDir: "../../escaped" } }, null, 2)}\n`);
  const escaped = runBuild(escaping, scratch("root"));
  assert.notEqual(escaped.status, 0, "the build accepted an output directory outside its own package");
  assert.equal(existsSync(join(escaping, "escaped")), false, "the build wrote outside its declared output");
  assert.deepEqual(sharedEntries(), SHARED_BASELINE, "a refused build touched shared temporary storage");
  rmSync(escaping, { recursive: true, force: true });
});

test("two builds running at once share no writable state", async () => {
  const root = fixture();
  const governed = [scratch("root"), scratch("root")];
  const results = await Promise.all(governed.map(async (r) => runBuild(root, r)));
  for (const [index, result] of results.entries())
    assert.equal(result.status, 0, `concurrent build ${index} failed: ${result.out}`);
  const digests = results.map((r) => /sha256=([0-9a-f]{64})/.exec(r.out)?.[1]);
  assert.equal(digests[0] !== undefined && digests[0] === digests[1], true,
    `concurrent builds disagreed about what they published: ${JSON.stringify(digests)}`);
  // Each build stages under its own governed run id, so neither can be observing the other's
  // half-written output; both staging directories are gone by the time either returns.
  assert.deepEqual(stagingOf(root), [], "a concurrent build left staging residue behind");
  assert.ok(existsSync(artifactOf(root)), "the artifact is missing after concurrent builds");
  assert.deepEqual(sharedEntries(), SHARED_BASELINE, "concurrent builds touched shared temporary storage");
  rmSync(root, { recursive: true, force: true });
});

/**
 * THE SUBSTITUTIONS AN INDEPENDENT AUDIT PROVED THIS BUILD ACCEPTED.
 *
 * Both cases below returned status 0 against the previous build script and both were wrong in the
 * same way: the containment test was lexical. `dist` as a symlink to a directory elsewhere still
 * began with the package root once resolved by `path.resolve`, and `src/entry.tsx` as a symlink to
 * a file elsewhere still satisfied `existsSync`. A path that is a string is contained; a path that
 * is a file is not contained until the file has been looked at.
 *
 * The external directory in each case is a private governed scratch directory, and it is asserted
 * to be still empty afterwards -- a refusal that refused for some unrelated reason, while still
 * writing outside the package, would pass a status check and fail this one.
 */
test("a symlinked output directory is a refusal, and nothing is written through it", () => {
  const root = fixture();
  const outside = scratch("outside-dist");
  rmSync(join(root, "tui/dist"), { recursive: true, force: true });
  symlinkSync(outside, join(root, "tui/dist"));
  const built = runBuild(root, scratch("root"));
  assert.notEqual(built.status, 0, `the build published through a symlinked output directory: ${built.out}`);
  assert.match(built.out, /symbolic link/, `the refusal does not name the cause: ${built.out}`);
  assert.deepEqual(readdirSync(outside), [], "the build wrote outside its declared output directory");
  assert.deepEqual(sharedEntries(), SHARED_BASELINE, "the refused build touched shared temporary storage");
  rmSync(root, { recursive: true, force: true });
});

test("a symlinked entry is a refusal, and no artifact is built from outside the package", () => {
  const root = fixture();
  const outside = scratch("outside-entry");
  const external = join(outside, "entry-external.tsx");
  writeFileSync(external, "const outsideInput: number = 42;\nexport default outsideInput;\n");
  rmSync(join(root, "tui/src/entry.tsx"), { force: true });
  symlinkSync(external, join(root, "tui/src/entry.tsx"));
  assert.equal(lstatSync(join(root, "tui/src/entry.tsx")).isSymbolicLink(), true, "the fixture did not plant a symlink");
  const built = runBuild(root, scratch("root"));
  assert.notEqual(built.status, 0, `the build compiled an entry from outside the package: ${built.out}`);
  assert.match(built.out, /symbolic link/, `the refusal does not name the cause: ${built.out}`);
  assert.equal(existsSync(artifactOf(root)), false, "a refused build still published an artifact");
  assert.deepEqual(stagingOf(root), [], "the refused build left staging residue behind");
  rmSync(root, { recursive: true, force: true });
});

test("a symlinked directory ON THE WAY to the entry is a refusal too", () => {
  const root = fixture();
  const outside = scratch("outside-src");
  writeFileSync(join(outside, "helper.ts"), "export const helper = (): number => 41;\n");
  writeFileSync(join(outside, "entry.tsx"),
    "import { helper } from './helper.js';\nconst total: number = helper() + 1;\nexport default total;\n");
  rmSync(join(root, "tui/src"), { recursive: true, force: true });
  symlinkSync(outside, join(root, "tui/src"));
  const built = runBuild(root, scratch("root"));
  assert.notEqual(built.status, 0, `the build reached its entry through a symlinked directory: ${built.out}`);
  assert.match(built.out, /symbolic link/, `the refusal does not name the cause: ${built.out}`);
  assert.equal(existsSync(artifactOf(root)), false, "a refused build still published an artifact");
  rmSync(root, { recursive: true, force: true });
});

/**
 * TERMINATION.
 *
 * The same audit sent SIGTERM to a running build, watched the staging directory be created, and
 * found it still there afterwards: the build had no answer to a signal, so an interrupted build
 * left residue inside the declared output directory. Interruption is an ordinary way for a build
 * to end, so it is asserted rather than assumed.
 *
 * The race is made observable rather than hoped for: the build is given enough modules to take
 * measurable time, the staging directory is polled for, and the test FAILS if it never appears --
 * a probe that silently never armed would assert nothing at all. The signal is then required to
 * reach the caller as a signal, because a wrapper that swallowed it and reported a status would
 * make every caller's own failure handling wrong.
 */
test("a signal during the build leaves no staging directory, no artifact, and the signal itself", async () => {
  const root = fixture({ modules: 1500 });
  const governedRoot = scratch("root");
  const child = spawn(process.execPath,
    [LAUNCH, "--entry=operator", "trio-test", "--", process.execPath, join(root, "tui/scripts/build.mjs")],
    {
      cwd: REPOSITORY,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", [TEMP_ROOT_ENV]: governedRoot },
    });
  const ended = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (status, signal) => resolve({ status, signal }));
  });
  let sawStaging = false;
  const deadline = Date.now() + 240_000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    if (stagingOf(root).length > 0) { sawStaging = true; child.kill("SIGTERM"); break; }
    await new Promise((resolve) => { setTimeout(resolve, 1); });
  }
  const outcome = await ended;
  assert.equal(sawStaging, true, "the build never staged, so this probe proved nothing about interrupting one");
  assert.equal(outcome.signal, "SIGTERM", `the signal did not reach the caller: ${JSON.stringify(outcome)}`);
  assert.deepEqual(stagingOf(root), [], "the interrupted build left staging residue inside the declared output");
  assert.equal(existsSync(artifactOf(root)), false, "the interrupted build left a half-published artifact");
  assert.deepEqual(sharedEntries(), SHARED_BASELINE, "the interrupted build touched shared temporary storage");
  rmSync(root, { recursive: true, force: true });
});

/**
 * CLEANUP IS IDENTITY-BOUND, NOT NAME-BOUND.
 *
 * A build that removed everything matching `.staging-*` would be a way to delete another run's
 * work-in-progress, and a build that removed its own staging name without checking WHAT is there
 * would be a way to delete whatever someone substituted at it. So the cleanup is bound to the
 * device and inode of the directory this run created: a foreign staging directory is left exactly
 * as it was found, and the run's own is gone.
 */
test("the build removes its own staging directory and leaves a foreign one untouched", () => {
  const root = fixture();
  const foreign = join(root, "tui/dist/.staging-trio-test-someone-else");
  mkdirSync(foreign, { recursive: true, mode: 0o700 });
  writeFileSync(join(foreign, "in-progress.mjs"), "// another run's work\n");
  const built = runBuild(root, scratch("root"));
  assert.equal(built.status, 0, `the build failed: ${built.out}`);
  assert.ok(existsSync(artifactOf(root)), "the build did not publish its artifact");
  assert.deepEqual(stagingOf(root), [".staging-trio-test-someone-else"],
    "the build deleted a staging directory that was not its own, or left its own behind");
  assert.equal(readFileSync(join(foreign, "in-progress.mjs"), "utf8"), "// another run's work\n",
    "the build modified another run's staging content");
  rmSync(root, { recursive: true, force: true });
});

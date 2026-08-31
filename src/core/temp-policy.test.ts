/**
 * TEMPORARY-STORAGE POLICY — the structural control.
 *
 * `/tmp` is forbidden for every lab-owned runtime, test, fixture, subprocess, and generated
 * artifact, and every temporary path must come from the governed authority
 * (`src/core/temp-authority.ts`). This suite scans the COMMITTED tree (git ls-files, the same
 * inventory provenance derives from) and fails on:
 *
 *   - a `/tmp` literal in executable lab-owned code;
 *   - an `os.tmpdir()` / `tmpdir()` call outside the authority;
 *   - an ungoverned `mkdtempSync`/`mktemp`/`tempfile` use;
 *   - a Python/shell helper writing outside the governed root.
 *
 * Inert fixtures may contain the text `/tmp` ONLY to prove refusal, and each such file must be
 * declared below WITH its justification. The allowlist is part of the reviewed boundary: adding
 * to it is a policy change, not a convenience.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * Files allowed to CONTAIN the text /tmp (never to create or open it), with the reason.
 * The list is the UNION across the Trio — this file is byte-identical in all three repos,
 * so an entry may name a sibling-only file (e.g. a per-identity helper script).
 */
const TMP_TEXT_ALLOWED: ReadonlyMap<string, string> = new Map([
  ["src/core/temp-authority.ts", "names /tmp solely to refuse it"],
  ["src/core/temp-authority.test.ts", "adversarial fixtures prove /tmp refusal without touching it"],
  ["src/core/temp-policy.test.ts", "this scanner's own patterns"],
  ["scripts/model-test.sh", "guards PEHVERSE_TEMP_ROOT against /tmp values (pehlichi-only)"],
  ["interview-demo-" + "factory/scripts/assemble-demo.sh", "guards PEHVERSE_TEMP_ROOT against /tmp values (loony-luna-only)"],
  ["stress_test.py", "guards PEHVERSE_TEMP_ROOT against /tmp values"],
  ["tests/runtime/hermes-parity.test.ts", "hostile injection payload proving neutralization; inert"],
]);

/** Files allowed to call tmpdir()/mkdtempSync — the authority and its proof. */
const TEMP_API_ALLOWED: ReadonlyMap<string, string> = new Map([
  ["src/core/temp-authority.ts", "the authority implementation itself"],
  ["src/core/temp-authority.test.ts", "proves os.tmpdir() mediation"],
  ["src/core/temp-policy.test.ts", "this scanner's own patterns and messages"],
]);

const EXECUTABLE = /\.(ts|mts|cts|mjs|cjs|js|sh|py)$/;

/**
 * Strip comments so the literal rule judges only code that can run. String literals are KEPT —
 * a /tmp inside a string is exactly the dangerous case. Crude by design: a stripper clever
 * enough to parse every dialect would itself need trusting.
 */
function withoutComments(file: string, source: string): string {
  if (/\.(sh|py)$/.test(file)) return source.replace(/(^|\s)#[^\n]*/g, "$1");
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function trackedExecutableFiles(): readonly string[] {
  return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter((f) => f.length > 0 && EXECUTABLE.test(f))
    .filter((f) => !f.startsWith("ui/") && !f.startsWith("dist/") && !f.startsWith("node_modules/"));
}

test("no /tmp literal survives in executable lab-owned code outside the declared refusal fixtures", () => {
  const offenders: string[] = [];
  for (const file of trackedExecutableFiles()) {
    const source = withoutComments(file, readFileSync(file, "utf8"));
    if (!/\/tmp(?:[/"'`\s),;:\]]|$)/m.test(source)) continue;
    if (TMP_TEXT_ALLOWED.has(file)) continue;
    offenders.push(file);
  }
  assert.deepEqual(offenders, [], `executable files containing /tmp: ${offenders.join(", ")}`);
});

test("os.tmpdir()/tmpdir() is called only by the authority and its proof", () => {
  const offenders: string[] = [];
  for (const file of trackedExecutableFiles()) {
    const source = withoutComments(file, readFileSync(file, "utf8"));
    if (!/\btmpdir\s*\(/.test(source)) continue;
    if (TEMP_API_ALLOWED.has(file)) continue;
    offenders.push(file);
  }
  assert.deepEqual(offenders, [], `ungoverned tmpdir() calls: ${offenders.join(", ")}`);
});

test("mkdtempSync is used only inside the authority — everyone else goes through governedMkdtemp", () => {
  const offenders: string[] = [];
  for (const file of trackedExecutableFiles()) {
    const source = withoutComments(file, readFileSync(file, "utf8"));
    if (!/\bmkdtempSync\s*\(/.test(source)) continue;
    if (TEMP_API_ALLOWED.has(file)) continue;
    offenders.push(file);
  }
  assert.deepEqual(offenders, [], `ungoverned mkdtempSync calls: ${offenders.join(", ")}`);
});

test("shell mktemp and Python tempfile are used only under the governed root", () => {
  const offenders: string[] = [];
  for (const file of trackedExecutableFiles()) {
    if (!/\.(sh|py)$/.test(file)) continue;
    const source = readFileSync(file, "utf8");
    if (/\bmktemp\b/.test(source) && !/PEHVERSE_TEMP_ROOT/.test(source)) offenders.push(`${file} (mktemp)`);
    if (/\btempfile\b/.test(source) && !/PEHVERSE_TEMP_ROOT/.test(source)) offenders.push(`${file} (tempfile)`);
  }
  assert.deepEqual(offenders, [], `ungoverned shell/python temp use: ${offenders.join(", ")}`);
});

test("the refusal fixtures declared above still exist and still justify themselves", () => {
  // The allowlist is a Trio-wide union, so existence is checked across this repo AND its
  // sibling checkouts (the same sibling resolution the provenance generator uses).
  const trackedAnywhere = new Set<string>();
  for (const slot of ["pehlichi", "loony-luna", "mad-ptah"]) {
    try {
      const listing = execFileSync("git", ["-C", `../${slot}`, "ls-files", "-z"], { encoding: "utf8" });
      for (const f of listing.split("\0")) trackedAnywhere.add(f);
    } catch {
      /* an absent sibling checkout proves nothing about this repo's entries */
    }
  }
  for (const [file, why] of TMP_TEXT_ALLOWED) {
    assert.ok(trackedAnywhere.has(file), `allowlisted file ${file} (${why}) is tracked nowhere in the Trio — remove its entry`);
  }
  for (const [file, why] of TEMP_API_ALLOWED) {
    assert.ok(trackedAnywhere.has(file), `allowlisted file ${file} (${why}) is tracked nowhere in the Trio — remove its entry`);
  }
});

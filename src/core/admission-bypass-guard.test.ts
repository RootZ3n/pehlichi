/**
 * A repository-wide guard against the bypass coming back.
 *
 * The first gate was defeated by a plaintext constant exported from shared core plus two
 * caller-supplied fields. Deleting those three things fixes today; this suite is what makes
 * tomorrow's reintroduction fail loudly, including under a different name.
 *
 * It works semantically rather than by matching the old identifier. The properties it checks
 * are structural: the production entry point must decide from the committed status and a
 * literal category, the decision function must have no branch that a caller value can steer
 * to an admission, and nothing that grants execution may leave the package. Renaming
 * `QUALIFICATION_AUTHORITY` to `AUDIT_TOKEN` would satisfy a grep and fail all of these.
 *
 * Parsing is deliberately shallow — the file set is small, and a guard nobody can read is a
 * guard nobody maintains.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(here, '..', '..');

/** Every committed TypeScript/JavaScript source in the runtime surface. */
function sources(): { path: string; text: string }[] {
  const roots = ['src', 'runtime', 'tui/src'].map((r) => join(repositoryRoot, r));
  const out: { path: string; text: string }[] = [];
  const visit = (dir: string): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) { visit(full); continue; }
      if (!/\.(ts|tsx|mjs|js)$/.test(entry)) continue;
      out.push({ path: relative(repositoryRoot, full).split(sep).join('/'), text: readFileSync(full, 'utf8') });
    }
  };
  for (const root of roots) visit(root);
  return out;
}

const ADMISSION = join(here, 'operational-admission.ts');
const LOOP = join(here, 'loop.ts');
const QUALIFICATION = join(here, 'qualification-admission.ts');

/** Strip comments and string literals so a guard is not satisfied or tripped by prose. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

/** The body of a named exported function, by brace matching. */
function functionBody(text: string, signature: string): string {
  const start = text.indexOf(signature);
  assert.notEqual(start, -1, `could not find ${signature}`);
  const open = text.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') { depth -= 1; if (depth === 0) return text.slice(open, i + 1); }
  }
  assert.fail(`unbalanced braces after ${signature}`);
}

test('no module exports a value that grants operational admission', () => {
  // Two shapes, both semantic. A *value* export whose name reads as an authority is the shape
  // the previous bypass had; a value export whose literal reads as a capability token is the
  // same thing after a rename. Functions are not matched — `parseAuthorityJson` parses data,
  // and treating every function with "authority" in its name as a grant would make this guard
  // noise that somebody eventually deletes.
  // The initializer must be data, not a function: a grant is a value somebody presents, and
  // `parseWorkspaceOverride` is a parser, not a capability.
  const DATA = `\\s*(?:['\"\`]|Object\\.freeze\\(\\s*['\"\`\\[{]|\\[|\\{)`;
  const byName = new RegExp(`export\\s+(?:const|let|var)\\s+([A-Za-z0-9_$]*(?:AUTHORITY|TOKEN|SECRET|BYPASS|OVERRIDE|PASSPHRASE|WAIVER|EXEMPTION|GRANT)[A-Za-z0-9_$]*)\\s*(?::[^=]+)?=${DATA}`, 'gi');
  const byValue = /export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*['"`]([^'"`]*(?:qualification|self-test|pre-production|bypass|override|commission)[^'"`]*)['"`]/gi;
  const found: string[] = [];
  for (const file of sources()) {
    if (file.path.endsWith('.test.ts') || file.path.endsWith('.test.mjs')) continue;
    const text = file.text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    for (const match of text.matchAll(byName)) found.push(`${file.path}: exported value ${match[1]}`);
    for (const match of text.matchAll(byValue)) found.push(`${file.path}: ${match[1]} = "${match[2]}"`);
  }
  assert.deepEqual(found, [], `a module exports something that reads as an admission grant:\n  ${found.join('\n  ')}`);
});

test('the production entry point decides from the committed status and a literal category', () => {
  const body = code(functionBody(readFileSync(LOOP, 'utf8'), 'export async function runAgent('));
  // Exactly one admission call, and its argument is a literal — not read from `opts`.
  const calls = [...body.matchAll(/admitRunWork\(([^)]*)\)/g)];
  assert.equal(calls.length, 1, 'runAgent must consult the boundary exactly once');
  assert.equal(/opts|options|arg|request|param/i.test(calls[0]![1]!), false,
    'the admission category is derived from caller input');
  assert.match(body, /if\s*\(\s*!\s*admission\.admitted\s*\)\s*throw/,
    'runAgent does not refuse on a negative admission');
  // Nothing in runAgent may look at the options before the decision.
  const beforeDecision = body.slice(0, body.indexOf('admitRunWork'));
  assert.equal(/opts\./.test(beforeDecision), false, 'runAgent inspects caller options before deciding');
});

test('the shadow entry point is gated the same way', () => {
  const body = code(functionBody(readFileSync(LOOP, 'utf8'), 'export async function runAgentInShadow('));
  assert.match(body, /admitRunWork\(/, 'runAgentInShadow does not consult the boundary');
  assert.match(body, /if\s*\(\s*!\s*admission\.admitted\s*\)\s*throw/);
});

test('the run options carry no admission input a caller could satisfy by asserting it', () => {
  const text = code(readFileSync(LOOP, 'utf8'));
  for (const field of ['operationalPurpose', 'operationalAuthority', 'purpose', 'authority', 'bypass', 'override'])
    assert.equal(new RegExp(`readonly\\s+${field}\\??\\s*:`).test(text), false,
      `RunAgentOptions accepts \`${field}\`, which makes admission caller-controlled`);

  // `qualification` IS a caller-supplied input, and saying otherwise would make this guard a
  // reassurance. What makes it not the bypass that was removed is that a caller cannot satisfy
  // it by asserting anything: it is an opaque document minted outside this repository, and the
  // only code that reads it verifies a signature against a committed anchor before anything
  // else. So the guard is not "no input" -- it is "no input this repository can forge".
  const options = text.slice(text.indexOf('export interface RunAgentOptions'));
  const admissionFields = [...options.slice(0, options.indexOf('\n}')).matchAll(/readonly\s+(\w+)\??\s*:/g)]
    .map((m) => m[1] ?? '')
    // Names that would carry an ADMISSION. `unattendedGrantedTools` grants tools inside a run
    // that was already admitted, which is a lane, not an authority, and is covered elsewhere.
    .filter((name) => /qualif|admiss|credential|authoriz/i.test(name) || /^(grant|token)/i.test(name));
  // Two, and the second can only ever narrow: `qualificationWorkOrder` is compared for equality
  // against the signed work order and can therefore cause a refusal and nothing else.
  assert.deepEqual(admissionFields, ['qualification', 'qualificationWorkOrder'],
    `RunAgentOptions carries admission-shaped inputs beyond the verified ones: ${admissionFields.join(', ')}`);
  const verifierText = readFileSync(QUALIFICATION, 'utf8');
  assert.match(verifierText, /request\.workOrderId !== undefined && claims\.workOrderId !== request\.workOrderId/,
    'the stated work order is no longer checked against the signed one');
  assert.equal(/workOrderId[^\n]*admitted:\s*true/.test(verifierText), false,
    'the stated work order can reach an admission');

  // The loop must not decide anything about it itself; it hands it to the verifier whole.
  const runAgentBody = code(functionBody(readFileSync(LOOP, 'utf8'), 'export async function runAgent('));
  assert.equal(/opts\.qualification\s*(===|!==|\?\?|\|\|)/.test(runAgentBody), false,
    'runAgent inspects the qualification instead of handing it to the verifier');

  // And the verifier must never be able to admit without a signature, an external anchor and a
  // single-use consumption -- in that order, before it returns an admission.
  const verifier = code(readFileSync(QUALIFICATION, 'utf8'));
  assert.match(verifier, /edVerify\(/, 'the verifier no longer checks a signature');
  assert.match(verifier, /createPublicKey\(/, 'the verifier no longer resolves an external public key');
  assert.equal(/createPrivateKey|generateKeyPair|createSign\(/.test(verifier), false,
    'the repository has grown the ability to mint an admission');
  // The RETURN site, not the type union that declares its shape.
  const admitAt = verifier.indexOf('admitted: true,');
  assert.notEqual(admitAt, -1, 'the verifier no longer admits anything');
  const before = verifier.slice(0, admitAt);
  for (const required of ['edVerify(', 'consume(', 'subjectIdentity('])
    assert.ok(before.includes(required), `the verifier admits before reaching ${required}`);
});

test('the decision function has no branch a caller value can steer to an admission', () => {
  const body = code(functionBody(readFileSync(ADMISSION, 'utf8'), 'export function admitWork('));
  const admits = [...body.matchAll(/admitted\s*:\s*true/g)];
  assert.equal(admits.length, 1, 'admitWork has more than one way to admit');
  // The single admitting branch must be guarded by the committed status only.
  const guard = body.slice(0, body.indexOf('admitted: true'));
  assert.match(guard, /status\.state\s*===/, 'the admitting branch does not test the committed state');
  assert.match(guard, /status\.authorization\s*===/, 'the admitting branch does not test the committed authorization');
  assert.equal(/category\s*===|category\.includes|includes\(\s*category|purpose|authority/i.test(guard), false,
    'the admitting branch consults the request rather than the committed status');
});

test('PRE_PRODUCTION contains no caller-controlled allow branch anywhere in the boundary', () => {
  const text = code(readFileSync(ADMISSION, 'utf8'));
  // No comparison of a request-supplied value against a constant that could gate admission.
  assert.equal(/request\.[A-Za-z]+\s*===|category\s*===\s*''/.test(text), false,
    'the boundary compares a caller-supplied value, which is how the previous bypass worked');
  // The repository root the status is read from is not a parameter on the production path.
  assert.match(text, /admitRunWork\([^)]*category:?\s*WorkCategory[^)]*\)/,
    'admitRunWork takes something other than a category');
  assert.equal(/export function admitRunWork\([^)]*repositoryRoot/.test(text), false,
    'admitRunWork accepts a repository root, so a caller could name governance that says PRODUCTION');
});

test('production admission never treats a self-test or qualification label as authority', () => {
  const text = code(readFileSync(ADMISSION, 'utf8'));
  // These strings may appear as category members; what must not exist is a comparison that
  // grants on them.
  for (const label of ['self-test', 'qualification', 'audit'])
    assert.equal(new RegExp(`===\\s*''\\s*\\)\\s*return\\s*\\{\\s*admitted:\\s*true`).test(text), false,
      `a ${label}-shaped comparison grants admission`);
  const body = functionBody(text, 'export function admitWork(');
  assert.equal(/includes\(/.test(body), false, 'admitWork consults a list of privileged categories');
});

test('the effectful executors are not exported from anywhere', () => {
  // Not "absent from the public index" -- that was the property this suite used to check, and
  // an audit walked straight past it with a relative import. Not exported at all, so there is
  // no namespace property to reach under any spelling, computed or otherwise.
  const loopSource = readFileSync(LOOP, 'utf8');
  for (const name of ['executeAgentRun', 'executeAgentInShadow']) {
    assert.equal(new RegExp(`export\\s+(async\\s+)?function\\s+${name}\\b`).test(loopSource), false,
      `loop.ts exports ${name}`);
    assert.equal(new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`).test(loopSource), false,
      `loop.ts re-exports ${name} in an export clause`);
  }
  for (const index of ['src/index.ts', 'src/core/index.ts']) {
    const text = code(readFileSync(join(repositoryRoot, index), 'utf8'));
    for (const name of ['executeAgentRun', 'executeAgentInShadow'])
      assert.equal(new RegExp(`\\b${name}\\b`).test(text), false, `${index} re-exports ${name}`);
  }
});

test('no module star-re-exports the loop, which would export whatever it exports tomorrow', () => {
  // `runtime/core/loop.ts` was `export * from '../../src/core/loop.js'`. A star re-export cannot
  // be audited by reading it, and it forwarded both executors into a second namespace -- so
  // closing the escape in loop.ts alone would have left the identical computed-property bypass
  // one import away.
  const offenders: string[] = [];
  for (const file of sources()) {
    if (file.path.endsWith('.test.ts') || file.path.endsWith('.test.mjs')) continue;
    if (/export\s*\*\s*from\s*['"][^'"]*loop\.js['"]/.test(code(file.text))) offenders.push(file.path);
  }
  assert.deepEqual(offenders, [], `a module star-re-exports the loop:\n  ${offenders.join('\n  ')}`);
});

test('no production surface calls the component instead of the gated entry point', () => {
  const offenders: string[] = [];
  for (const file of sources()) {
    if (file.path.endsWith('.test.ts') || file.path.endsWith('.test.mjs')) continue;
    if (file.path === 'src/core/loop.ts') continue; // where the split lives
    if (/\bexecuteAgentRun\b|\bexecuteAgentInShadow\b/.test(code(file.text))) offenders.push(file.path);
  }
  assert.deepEqual(offenders, [], `a production surface bypasses the gate:\n  ${offenders.join('\n  ')}`);
});

test('no environment variable can influence admission', () => {
  const text = code(readFileSync(ADMISSION, 'utf8'));
  assert.equal(text.includes('process.env'), false, 'the boundary reads the environment');
  const runAgentBody = code(functionBody(readFileSync(LOOP, 'utf8'), 'export async function runAgent('));
  assert.equal(runAgentBody.includes('process.env'), false, 'the gate at runAgent reads the environment');
});

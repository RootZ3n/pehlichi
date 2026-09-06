/**
 * The qualification admission, from inside the subject it admits.
 *
 * These cases are deliberately one-sided. This repository holds the issuer's PUBLIC half only,
 * so no test here can mint an admission that verifies -- which is the property under test, not
 * a limitation of the suite. Everything reachable without a valid signature is exercised here;
 * the signed matrix, including the positive control and single-use consumption, is exercised by
 * the external qualification suite that holds the private half, because a suite that could mint
 * its own admission would prove nothing about a boundary that refuses minted ones.
 *
 * The one thing these cases must never become is a way to obtain an admission. If a future edit
 * makes any case here pass by producing one, the boundary is gone and the suite is the hole.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { agentProfile } from '../profile.js';
import { admitRunWork, readOperationalStatus } from './operational-admission.js';
import { qualifyRun, type QualificationRequest } from './qualification-admission.js';
import { governedMkdtemp } from './temp-authority.js';

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(here, '..', '..');

/** A request shaped like a real one, so a refusal is never an accident of a missing field. */
function request(over: Partial<QualificationRequest> = {}): QualificationRequest {
  return {
    // This suite is byte-identical across the Trio, so the identity comes from the repository
    // it is running in, never from a name written here.
    agentName: agentProfile.name, agentRole: agentProfile.role, taskId: '1',
    workspaceRoot: governedMkdtemp('qualification-case-'),
    toolNames: ['read_file'],
    ...over,
  };
}

const locked = () => admitRunWork('agent-run');

/** Encode an envelope the way the issuer does, so only the signature is wrong. */
function envelope(claims: unknown, signature = 'not-a-signature'): string {
  return Buffer.from(JSON.stringify({ claims, signature }), 'utf8').toString('base64url');
}

test('the committed status is locked, which is the state these cases are about', () => {
  const status = readOperationalStatus();
  assert.equal(status.state, 'PRE_PRODUCTION');
  assert.equal(locked().admitted, false);
});

test('presenting nothing is the ordinary locked refusal, unchanged in code and shape', () => {
  const decision = qualifyRun(locked(), request());
  assert.equal(decision.admitted, false);
  assert.equal(decision.admitted === false && decision.refusal.code, 'OPERATIONAL_WORK_NOT_AUTHORIZED');
  assert.equal(decision.admitted === false && decision.refusal.category, 'agent-run');
});

test('a malformed, empty or non-token admission refuses', () => {
  for (const admission of ['', '   ', 'not-base64url-at-all!!', Buffer.from('{}', 'utf8').toString('base64url'),
                           Buffer.from('{"claims":1,"signature":2}', 'utf8').toString('base64url')]) {
    const decision = qualifyRun(locked(), request({ admission }));
    assert.equal(decision.admitted, false, `admitted a malformed admission: ${admission.slice(0, 24)}`);
  }
});

test('an admission this repository made up for itself refuses: there is no key here to sign with', () => {
  const anchor = JSON.parse(readFileSync(join(repositoryRoot, 'trio/governance/qualification-issuer.json'), 'utf8'));
  const claims = {
    schema: 'trio-qualification-admission/1',
    issuer: { id: anchor.issuer, version: '1.0.0', keyId: anchor.keyId },
    auditId: 'SELF', workOrderId: 'SELF',
    agent: { name: agentProfile.name, role: agentProfile.role },
    subject: { commit: 'x'.repeat(40), tree: 'y'.repeat(40) },
    taskId: '1', fixtureRoot: '/nonexistent', capabilities: ['read_file'], operations: ['agent-run'],
    issuedAt: new Date().toISOString(), notBefore: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    nonce: 'self-minted', maxUses: 1, ledgerRoot: '/nonexistent', receiptRoot: '/nonexistent',
  };
  const decision = qualifyRun(locked(), request({ admission: envelope(claims) }));
  assert.equal(decision.admitted, false, 'a self-minted admission was honoured');
});

test('an unknown schema, an unknown issuer and a foreign key all refuse before anything else', () => {
  const base = { auditId: 'A', workOrderId: 'W', agent: { name: agentProfile.name, role: agentProfile.role },
    subject: { commit: 'x', tree: 'y' }, taskId: '1', fixtureRoot: '/n', capabilities: [], operations: ['agent-run'],
    issuedAt: '2026-01-01T00:00:00Z', notBefore: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z',
    nonce: 'n', maxUses: 1, ledgerRoot: '/n', receiptRoot: '/n' };
  const cases = [
    { ...base, schema: 'some-other-schema/9', issuer: { id: 'pehverse-qualification-issuer', version: '1', keyId: 'k' } },
    { ...base, schema: 'trio-qualification-admission/1', issuer: { id: 'somebody-else', version: '1', keyId: 'k' } },
    { ...base, schema: 'trio-qualification-admission/1', issuer: { id: 'pehverse-qualification-issuer', version: '1', keyId: 'wrong-key-id' } },
  ];
  for (const claims of cases)
    assert.equal(qualifyRun(locked(), request({ admission: envelope(claims) })).admitted, false);
});

test('this repository holds no way to mint an admission', () => {
  // Not "no exported way" -- no way. A minting primitive anywhere in the production closure is
  // the whole defect, whether or not anything currently calls it.
  const offenders: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', '.git', 'out'].includes(entry.name)) continue;
        visit(path);
        continue;
      }
      if (!/\.(ts|mts|mjs|js)$/.test(entry.name) || entry.name.endsWith('.test.ts')) continue;
      const text = readFileSync(path, 'utf8');
      if (/createPrivateKey\s*\(|generateKeyPairSync\s*\(|generateKeyPair\s*\(/.test(text))
        offenders.push(path.slice(repositoryRoot.length + 1));
    }
  };
  for (const top of ['src', 'runtime', 'tui/src', 'scripts'])
    if (existsSync(join(repositoryRoot, top))) visit(join(repositoryRoot, top));
  assert.deepEqual(offenders, [], `a signing primitive exists in the production closure:\n  ${offenders.join('\n  ')}`);
});

test('the committed trust anchor carries a public half and no private half', () => {
  const raw = readFileSync(join(repositoryRoot, 'trio/governance/qualification-issuer.json'), 'utf8');
  assert.match(raw, /BEGIN PUBLIC KEY/);
  assert.equal(/PRIVATE KEY/.test(raw), false, 'the trust anchor contains a private key');
  const anchor = JSON.parse(raw);
  assert.equal(anchor.algorithm, 'ed25519');
  assert.equal(typeof anchor.keyId, 'string');
});

test('an admission cannot widen a lane, only narrow it: the grant is an intersection', () => {
  // Proved structurally, because producing a verified grant here is impossible by design.
  const verifier = readFileSync(join(here, 'qualification-admission.ts'), 'utf8');
  assert.match(verifier, /toolNames:\s*request\.toolNames\.filter\(\(name\) => granted\.has\(name\)\)/,
    'the grant no longer intersects the requested lane with the granted one');
  assert.match(verifier, /broadened\.length > 0/, 'a request broader than the admission is no longer refused');
});

test('consumption happens before the run, and nothing gives it back', () => {
  const verifier = readFileSync(join(here, 'qualification-admission.ts'), 'utf8');
  assert.match(verifier, /openSync\([\s\S]*?'wx'\)/, 'the ledger write is no longer an exclusive create');
  assert.equal(/unlinkSync|rmSync|rmdirSync/.test(verifier), false,
    'the verifier can remove a ledger entry, which would make a spent admission reusable');
  // The RETURN site, not the type union that declares its shape.
  const admitAt = verifier.indexOf('admitted: true,');
  assert.notEqual(admitAt, -1, 'the verifier no longer admits anything');
  assert.ok(verifier.slice(0, admitAt).includes('consume(claims)'), 'an admission is returned before it is spent');
});

test('a refusal leaves a durable receipt, and the receipt carries no admission material', () => {
  const receiptRoot = governedMkdtemp('qualification-receipts-');
  const previous = process.env['TRIO_QUALIFICATION_RECEIPT_ROOT'];
  process.env['TRIO_QUALIFICATION_RECEIPT_ROOT'] = receiptRoot;
  try {
    const admission = envelope({ schema: 'wrong' });
    const decision = qualifyRun(locked(), request({ admission }));
    assert.equal(decision.admitted, false);
    const files = readdirSync(receiptRoot);
    assert.ok(files.length >= 1, 'a pre-model refusal left no durable receipt');
    const receipt = JSON.parse(readFileSync(join(receiptRoot, files[0]!), 'utf8'));
    assert.equal(receipt.decision, 'REFUSED');
    assert.equal(receipt.modelCalls, 0);
    assert.equal(receipt.toolCalls, 0);
    assert.equal(receipt.mutations, 0);
    assert.equal(typeof receipt.time, 'string');
    assert.equal(typeof receipt.reason, 'string');
    assert.equal(JSON.stringify(receipt).includes(admission), false, 'the receipt embeds the admission itself');
  } finally {
    if (previous === undefined) delete process.env['TRIO_QUALIFICATION_RECEIPT_ROOT'];
    else process.env['TRIO_QUALIFICATION_RECEIPT_ROOT'] = previous;
  }
});

test('a receipt is never written into a repository', () => {
  const verifier = readFileSync(join(here, 'qualification-admission.ts'), 'utf8');
  assert.match(verifier, /within\(realpathSync\(REPOSITORY_ROOT\), resolve\(supplied\)\)/,
    'a receipt root inside the repository is no longer refused');
});

test('a fixture inside a repository or a system path is refused however it is signed', () => {
  const verifier = readFileSync(join(here, 'qualification-admission.ts'), 'utf8');
  for (const forbidden of ['/pehverse/repos', '/home/zen/.hermes', '/etc', '/usr', '/var'])
    assert.ok(verifier.includes(`'${forbidden}'`), `${forbidden} is no longer a forbidden fixture root`);
  assert.match(verifier, /within\(realpathSync\(REPOSITORY_ROOT\), fixtureRoot\)/,
    'a fixture inside the subject repository is no longer refused');
  assert.match(verifier, /realpathSync\(/, 'the fixture is no longer resolved, so a symlink could escape');
});

test('a manifest that claims PRODUCTION cannot be combined with a qualification', () => {
  const verifier = readFileSync(join(here, 'qualification-admission.ts'), 'utf8');
  assert.match(verifier, /state !== 'PRE_PRODUCTION'/,
    'a qualification is honoured against a status that is not locked, which makes it a production credential');
});

test('the permitted operation set names no production category', () => {
  const verifier = readFileSync(join(here, 'qualification-admission.ts'), 'utf8');
  const line = verifier.split('\n').find((l) => l.includes('PERMITTED_OPERATIONS')) ?? '';
  assert.match(line, /\['agent-run'\]/);
  for (const category of ['ordinary-work', 'repair', 'build', 'maintenance', 'commissioning', 'matrix-originated'])
    assert.equal(line.includes(category), false, `${category} is a permitted qualification operation`);
});

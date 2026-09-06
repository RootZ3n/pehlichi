/**
 * EXTERNAL DEPLOYMENT IDENTITY — hostile suite.
 *
 * F-1 was that the identity chain was circular: package, capsule and deployment all lived inside the
 * repository being judged, so moving all three together produced a coherent foreign triple that
 * satisfied every equality. The root is now a systemd-delivered record from a root-owned file
 * outside every repository, naming the exact digests this tree must have.
 *
 * WHAT IS PROVEN HERE AND WHAT IS NOT. Everything about the RECORD and the BINDING is proven
 * offline, including the full 27-combination matrix. The credential CHANNEL can only be proven
 * negatively offline — nothing that is not under `/run/credentials` with root-owned ancestors is
 * accepted — because this account cannot create such a path. The positive channel case is proven
 * live, after installation, by the service starting at all.
 *
 * Byte-identical across the Trio.
 */
import assert from 'node:assert/strict';
import { chmodSync, cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  LEGACY_SCHEMA_VERSION,
  BOUND_FILES,
  CREDENTIAL_NAME,
  CREDENTIAL_ROOT,
  IDENTITY_SCHEMA_VERSION,
  type IdentityRecord,
  assertRepositoryBinding,
  fileDigest,
  parseIdentityRecord,
  readCredentialRecord,
} from '../../scripts/trio/external-identity.mjs';
import { agentContainmentConfig } from './containment-config.js';
import { governedMkdtemp } from './temp-authority.js';

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(dirname(here));
const ecosystem = dirname(repositoryRoot);
const AGENTS = ['pehlichi', 'mad-ptah', 'loony-luna'] as const;
const ME = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')).name as string;

/** The record an installer would write for a repository — the same algorithm, stated once. */
/**
 * A record for the SOURCE deployment, which is schema 1.
 *
 * Deliberately `LEGACY_SCHEMA_VERSION` rather than `IDENTITY_SCHEMA_VERSION`. The latter is now 3 —
 * the schema an activated release must present — and a schema-3 record carries release, boundary,
 * packaging and dataRoots fields that this fixture does not build. Using it here produced records
 * that were refused for the wrong reason (`unsupported_schema` instead of `missing or unknown`),
 * which is a fixture bug wearing the costume of a passing guard.
 *
 * These cases exercise the source path; the release path's schema-3 record is proven against BOTH
 * gates by the identity-schema suite.
 */
function recordFor(root: string, agent: string): IdentityRecord {
  const version = /CONTAINMENT_VERSION\s*=\s*"([0-9.]+)"/
    .exec(readFileSync(join(root, 'src/core/containment/version.ts'), 'utf8'))?.[1] ?? '0.0.0';
  return {
    schemaVersion: LEGACY_SCHEMA_VERSION,
    agent,
    package: { name: agent, sha256: fileDigest(join(root, BOUND_FILES.package)) },
    capsule: { sha256: fileDigest(join(root, BOUND_FILES.capsule)) },
    deployment: { sha256: fileDigest(join(root, BOUND_FILES.deployment)) },
    containment: { version },
  };
}

/** A repository whose three identity files can each come from a different agent. */
function triple(pkg: string, capsule: string, deployment: string): string {
  const root = governedMkdtemp('identity-triple-');
  mkdirSync(join(root, 'capsule'), { recursive: true });
  mkdirSync(join(root, 'deployment'), { recursive: true });
  mkdirSync(join(root, 'src/core/containment'), { recursive: true });
  cpSync(join(ecosystem, pkg, BOUND_FILES.package), join(root, BOUND_FILES.package));
  cpSync(join(ecosystem, capsule, BOUND_FILES.capsule), join(root, BOUND_FILES.capsule));
  cpSync(join(ecosystem, deployment, BOUND_FILES.deployment), join(root, BOUND_FILES.deployment));
  cpSync(join(repositoryRoot, 'src/core/containment/version.ts'), join(root, 'src/core/containment/version.ts'));
  return root;
}

const accepted = (root: string, record: IdentityRecord): boolean => {
  try { assertRepositoryBinding(root, record); return true; } catch { return false; }
};

// ------------------------------------------------------------------ the 27-combination matrix

test('X1. all 27 package/capsule/deployment combinations, against this deployment\'s external record', () => {
  const record = recordFor(repositoryRoot, ME);
  const results: Array<{ combo: string; accepted: boolean }> = [];
  for (const pkg of AGENTS) {
    for (const capsule of AGENTS) {
      for (const deployment of AGENTS) {
        results.push({ combo: `${pkg}/${capsule}/${deployment}`, accepted: accepted(triple(pkg, capsule, deployment), record) });
      }
    }
  }
  assert.equal(results.length, 27);
  const yes = results.filter((r) => r.accepted).map((r) => r.combo);
  assert.deepEqual(yes, [`${ME}/${ME}/${ME}`],
    `exactly the authorised triple may be accepted, got: ${JSON.stringify(yes)}`);
});

test('X2. every COHERENT foreign triple is rejected — the exact F-1 reproduction', () => {
  const record = recordFor(repositoryRoot, ME);
  for (const other of AGENTS.filter((a) => a !== ME)) {
    const root = triple(other, other, other);
    assert.equal(accepted(root, record), false,
      `a complete coherent ${other} triple was accepted by ${ME}'s external record`);
    assert.throws(() => assertRepositoryBinding(root, record), /identity_mismatch|digest_mismatch/);
  }
});

test('X3. a foreign external record does not authorise this repository', () => {
  for (const other of AGENTS.filter((a) => a !== ME)) {
    const foreign = recordFor(join(ecosystem, other), other);
    assert.throws(() => assertRepositoryBinding(repositoryRoot, foreign), /identity_mismatch/,
      `${other}'s record must not authorise ${ME}`);
  }
});

test('X4. a stale digest fails after the bound files are mutated', () => {
  const record = recordFor(repositoryRoot, ME);
  for (const which of ['package', 'capsule', 'deployment'] as const) {
    const root = triple(ME, ME, ME);
    const target = join(root, BOUND_FILES[which]);
    const json = JSON.parse(readFileSync(target, 'utf8'));
    writeFileSync(target, `${JSON.stringify(json, null, 2)}\n \n`); // same meaning, different bytes
    assert.throws(() => assertRepositoryBinding(root, record), /digest_mismatch/,
      `a mutated ${which} must fail the digest`);
  }
});

test('X5. a mutation AFTER a successful validation is caught by the next validation', () => {
  const record = recordFor(repositoryRoot, ME);
  const root = triple(ME, ME, ME);
  assert.equal(accepted(root, record), true);
  writeFileSync(join(root, BOUND_FILES.capsule), '{"identity":{"id":"pehlichi"}}\n');
  assert.equal(accepted(root, record), false, 'the binding must be re-checked, not remembered');
});

test('X6. a containment version other than the authorised one fails', () => {
  const record = { ...recordFor(repositoryRoot, ME), containment: { version: '9.9.9' } };
  assert.throws(() => assertRepositoryBinding(repositoryRoot, record), /digest_mismatch/);
});

// ------------------------------------------------------------------ the record itself

const good = (): string => JSON.stringify(recordFor(repositoryRoot, ME), null, 2);

test('X7. malformed, empty, oversized and non-JSON records are refused', () => {
  for (const bad of ['', '   ', '{', 'null', '[]', '"x"', '{"schemaVersion":1}', 'x'.repeat(5000)]) {
    assert.throws(() => parseIdentityRecord(bad), /external identity refused/, JSON.stringify(bad.slice(0, 20)));
  }
});

test('X8. an unknown or missing field is refused, in the record and in every nested object', () => {
  const base = JSON.parse(good());
  assert.throws(() => parseIdentityRecord(JSON.stringify({ ...base, extra: 1 })), /missing or unknown/);
  for (const nested of ['package', 'capsule', 'deployment', 'containment'] as const) {
    const widened = { ...base, [nested]: { ...base[nested], extra: 1 } };
    assert.throws(() => parseIdentityRecord(JSON.stringify(widened)), /missing or unknown/, nested);
    const narrowed = { ...base }; delete narrowed[nested];
    assert.throws(() => parseIdentityRecord(JSON.stringify(narrowed)), /missing or unknown/, nested);
  }
});

test('X9. a duplicated field is refused rather than silently last-wins', () => {
  // JSON.parse keeps the last value, so only the TEXT can show this. A record carrying two agents
  // would otherwise be read as whichever the writer put second.
  const duplicated = `{"schemaVersion":1,"agent":"${ME}","agent":"loony-luna",` +
    `"package":{"name":"${ME}","sha256":"sha256:${'0'.repeat(64)}"},` +
    `"capsule":{"sha256":"sha256:${'0'.repeat(64)}"},` +
    `"deployment":{"sha256":"sha256:${'0'.repeat(64)}"},"containment":{"version":"1.0.0"}}`;
  assert.throws(() => parseIdentityRecord(duplicated), /duplicate_field/);
  const nested = good().replace('"name":', '"name":"x","name":');
  assert.throws(() => parseIdentityRecord(nested), /duplicate_field|malformed_record/);
});

test('X10. an unsupported schema version is refused', () => {
  for (const version of [0, 2, '1', null, 1.5]) {
    const record = { ...JSON.parse(good()), schemaVersion: version };
    assert.throws(() => parseIdentityRecord(JSON.stringify(record)), /unsupported_schema|missing or unknown/);
  }
});

test('X11. a malformed identity or digest is refused', () => {
  const base = JSON.parse(good());
  for (const agent of ['', 'A', '../x', 'x'.repeat(80), 'peh lichi', 1, null]) {
    assert.throws(() => parseIdentityRecord(JSON.stringify({ ...base, agent })), /malformed_record/);
  }
  for (const digest of ['', 'deadbeef', 'sha256:zz', `sha1:${'0'.repeat(40)}`, `sha256:${'0'.repeat(63)}`]) {
    assert.throws(() => parseIdentityRecord(JSON.stringify({ ...base, capsule: { sha256: digest } })), /malformed_record/);
  }
});

// ------------------------------------------------------------------ the credential channel

test('X12. a missing credential channel fails closed — direct startup is not authorised', () => {
  assert.throws(() => readCredentialRecord({}), /no_credential_channel/);
  assert.throws(() => readCredentialRecord({ CREDENTIALS_DIRECTORY: '' }), /no_credential_channel/);
});

test('X13. a forged credential directory outside /run/credentials is refused', () => {
  const forged = governedMkdtemp('identity-forged-');
  writeFileSync(join(forged, CREDENTIAL_NAME), good(), { mode: 0o600 });
  // A record that would otherwise be perfectly valid, in a directory this account controls.
  assert.throws(() => readCredentialRecord({ CREDENTIALS_DIRECTORY: forged }), /not under \/run\/credentials/);
  for (const path of ['relative/path', '/run/credentials/../..', `${CREDENTIAL_ROOT}x/unit`, '/etc', '/']) {
    assert.throws(() => readCredentialRecord({ CREDENTIALS_DIRECTORY: path }), /bad_credential_channel/, path);
  }
});

test('X14. a symlinked credential directory is refused', () => {
  const real = governedMkdtemp('identity-real-');
  const link = `${real}-link`;
  symlinkSync(real, link);
  assert.throws(() => readCredentialRecord({ CREDENTIALS_DIRECTORY: link }), /bad_credential_channel/);
});

test('X15. forged environment and CLI identity cannot supply an identity', () => {
  const source = readFileSync(join(here, '..', '..', 'scripts', 'trio', 'external-identity.mjs'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  // The only environment variable consulted is the credential POINTER, which is then verified
  // against a root-owned prefix. No identity, agent name, or path comes from anywhere else.
  // Environment variables are upper-case; the loose form also matched the literal filename
  // 'deployment/agent.env.json', which is a path, not a read.
  const envReads = [...code.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(envReads)], ['CREDENTIALS_DIRECTORY']);
  assert.equal(/process\.argv/.test(code), false, 'identity must not come from the command line');
  assert.equal(/basename\(/.test(code), false, 'identity must not come from a directory name');
});

test('X16. the credential is not forwarded to contained children', () => {
  // The contained child environments are built as allowlists elsewhere; this asserts the identity
  // module hands nothing onward and that the tool paths never name the credential variable.
  for (const file of ['agent-tools/execute-code-tools.ts', 'agent-tools/lab-shell-tools.ts', 'containment-config.ts']) {
    const source = readFileSync(join(here, file), 'utf8');
    assert.equal(/CREDENTIALS_DIRECTORY/.test(source), false, `${file} must not pass the credential onward`);
  }
});

// ------------------------------------------------------------------ the gate is in front of policy

test('X17. no containment policy is returned without a valid external binding', () => {
  // These suites run under an operator entry, which has no credential — so this is also the
  // fail-closed proof for direct invocation outside the governed launcher.
  assert.throws(() => agentContainmentConfig({} as NodeJS.ProcessEnv), /no_credential_channel/);
  assert.throws(() => agentContainmentConfig({ CREDENTIALS_DIRECTORY: '/etc' } as NodeJS.ProcessEnv), /bad_credential_channel/);
});

test('X18. the launcher gates the service entry on the same record', () => {
  const launcher = readFileSync(join(repositoryRoot, 'scripts/trio/governed-launch.mjs'), 'utf8');
  assert.match(launcher, /assertExternalBinding/);
  assert.match(launcher, /declaredEntry === 'service'/);
  assert.match(launcher, /process\.exit\(1\)/);
});

test('X19. only non-secret summary material is exposed for logging', () => {
  const source = readFileSync(join(here, '..', '..', 'scripts', 'trio', 'external-identity.mjs'), 'utf8');
  // The returned summary is identity, schema version, bound file names, and a boolean.
  assert.match(source, /agent: record\.agent/);
  assert.match(source, /digestsMatched: true/);
  const launcher = readFileSync(join(repositoryRoot, 'scripts/trio/governed-launch.mjs'), 'utf8');
  const logged = /process\.stderr\.write\(`governed-launch: external identity[^`]*`\)/.exec(launcher)?.[0] ?? '';
  assert.equal(/sha256|record\b/.test(logged), false, 'the launcher must not log record contents');
});

test('X20. a wrong-mode or wrong-owner record would be refused', () => {
  // Proven against the checks themselves: the channel prefix rule fires first for any path this
  // account can create, so mode/owner are asserted here on the code that enforces them.
  const source = readFileSync(join(here, '..', '..', 'scripts', 'trio', 'external-identity.mjs'), 'utf8');
  assert.match(source, /stat\.mode & 0o007/);
  assert.match(source, /stat\.mode & 0o020/);
  assert.match(source, /stat\.uid !== 0/);
  assert.match(source, /isSymbolicLink\(\)/);
  assert.match(source, /truncated_record/);
  // A world-readable record is refused; systemd's real 0440 root:root + ACL is not, which is the
  // distinction the first rollout attempt taught us.
  const dir = governedMkdtemp('identity-mode-');
  const file = join(dir, CREDENTIAL_NAME);
  writeFileSync(file, good(), { mode: 0o644 });
  chmodSync(file, 0o644);
  assert.throws(() => readCredentialRecord({ CREDENTIALS_DIRECTORY: dir }), /bad_credential_channel/);
  assert.equal(/0o400/.test(source), false, 'the check must not demand a mode systemd does not use');
});

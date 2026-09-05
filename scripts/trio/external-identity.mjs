/**
 * THE EXTERNAL DEPLOYMENT-IDENTITY ROOT.
 *
 * WHY THIS EXISTS. The previous chain was package -> capsule -> deployment, and every link was a
 * file inside the repository being judged. An independent re-audit moved all three together and the
 * loader accepted the result: a coherent foreign triple satisfied only self-consistency, because
 * nothing in the chain came from outside the thing it was attesting to. Self-attestation cannot be
 * fixed by adding another file to the same tree.
 *
 * The root is now a record delivered by systemd from `/etc/pehverse/identity/<agent>.json`, which is
 * root-owned and outside every repository. It states which agent this deployment is, and the exact
 * digests its package, capsule and deployment must have. A foreign triple fails because the digests
 * it carries are not the digests the record names.
 *
 * WHAT THIS DOES NOT CLAIM. If an attacker can rewrite the repository they can also rewrite this
 * file, and a rewritten checker checks nothing. What the external record gives is a statement of
 * what the deployment is SUPPOSED to be that the repository cannot edit, so a swapped tree is
 * detectable by anyone — the agent at startup, or an auditor comparing the two later. It is a
 * binding, not a substitute for the file being genuine.
 *
 * Plain `.mjs` with builtin-only imports on purpose: this runs inside `governed-launch.mjs`, in a
 * bare node process, before any compiler or loader exists.
 *
 * Part of the byte-identical Trio shared core.
 */
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

/** The credential name. IDENTICAL for all three services; only the root-owned source differs. */
export const CREDENTIAL_NAME = 'agent-identity';

/** systemd materialises credentials here. Nothing under it is creatable by the service account. */
export const CREDENTIAL_ROOT = '/run/credentials';

export const IDENTITY_SCHEMA_VERSION = 1;

/** The record is small and fixed; anything larger is not one. */
const MAX_RECORD_BYTES = 4096;

export class ExternalIdentityRefused extends Error {
  constructor(code, detail) {
    super(`external identity refused [${code}]: ${detail}`);
    this.name = 'ExternalIdentityRefused';
    this.code = code;
  }
}

/** `sha256:<lowercase hex>` over the EXACT bytes of a file. No normalisation, no re-serialisation. */
export function fileDigest(path) {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

/**
 * Depth-aware duplicate-key detection.
 *
 * `JSON.parse` silently keeps the last value for a repeated key, so a record could carry two
 * `agent` fields and be read as whichever the writer put second. The parsed object cannot show
 * that; only the text can. Scanned per object level, so the three legitimate `sha256` keys in
 * different objects are not confused with a duplicate.
 */
function assertNoDuplicateKeys(text) {
  const stack = [];
  let inString = false;
  let escaped = false;
  let pendingKey = '';
  let capturing = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { escaped = false; if (capturing) pendingKey += ch; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = false; continue; }
      if (capturing) pendingKey += ch;
      continue;
    }
    if (ch === '"') { inString = true; if (stack.length > 0) { capturing = true; pendingKey = ''; } continue; }
    if (ch === '{') { stack.push(new Set()); continue; }
    if (ch === '}') { stack.pop(); capturing = false; continue; }
    if (ch === ':' && capturing) {
      const level = stack[stack.length - 1];
      if (level !== undefined) {
        if (level.has(pendingKey)) throw new ExternalIdentityRefused('duplicate_field', `${pendingKey} appears twice`);
        level.add(pendingKey);
      }
      capturing = false;
      continue;
    }
    if (ch === ',') { capturing = false; continue; }
  }
}

function assertExactKeys(value, expected, where) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExternalIdentityRefused('malformed_record', `${where} is not an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((k, i) => k !== wanted[i])) {
    throw new ExternalIdentityRefused('malformed_record', `${where} has missing or unknown fields`);
  }
}

const SAFE_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;

/** Validate the record's shape. Closed in both directions: nothing missing, nothing extra. */
export function parseIdentityRecord(text) {
  if (text.length === 0) throw new ExternalIdentityRefused('empty_record', 'the record is empty');
  if (text.length > MAX_RECORD_BYTES) throw new ExternalIdentityRefused('oversized_record', `${text.length} bytes`);
  assertNoDuplicateKeys(text);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ExternalIdentityRefused('malformed_record', `not valid JSON: ${error.message}`);
  }

  assertExactKeys(parsed, ['schemaVersion', 'agent', 'package', 'capsule', 'deployment', 'containment'], 'record');
  if (parsed.schemaVersion !== IDENTITY_SCHEMA_VERSION) {
    throw new ExternalIdentityRefused('unsupported_schema', `schemaVersion ${JSON.stringify(parsed.schemaVersion)}`);
  }
  if (typeof parsed.agent !== 'string' || !SAFE_ID.test(parsed.agent)) {
    throw new ExternalIdentityRefused('malformed_record', 'agent is not a safe identifier');
  }
  assertExactKeys(parsed.package, ['name', 'sha256'], 'record.package');
  assertExactKeys(parsed.capsule, ['sha256'], 'record.capsule');
  assertExactKeys(parsed.deployment, ['sha256'], 'record.deployment');
  assertExactKeys(parsed.containment, ['version'], 'record.containment');
  if (typeof parsed.package.name !== 'string' || !SAFE_ID.test(parsed.package.name)) {
    throw new ExternalIdentityRefused('malformed_record', 'package.name is not a safe identifier');
  }
  for (const [where, value] of [['package', parsed.package.sha256], ['capsule', parsed.capsule.sha256], ['deployment', parsed.deployment.sha256]]) {
    if (typeof value !== 'string' || !DIGEST.test(value)) {
      throw new ExternalIdentityRefused('malformed_record', `${where}.sha256 is not a sha256 digest`);
    }
  }
  if (typeof parsed.containment.version !== 'string' || !VERSION.test(parsed.containment.version)) {
    throw new ExternalIdentityRefused('malformed_record', 'containment.version is not a version');
  }
  return parsed;
}

/**
 * Locate and read the credential, and refuse anything that is not one.
 *
 * `CREDENTIALS_DIRECTORY` is an environment variable, and an environment variable is forgeable — so
 * it is treated as a POINTER to be verified, never as the answer. The pointer must land under
 * `/run/credentials`, which only root can create entries in, and every ancestor up to `/run` must be
 * root-owned. A caller who sets the variable at a directory they control fails on the prefix; a
 * caller who cannot write `/run` cannot satisfy it at all.
 *
 * The descriptor is opened once, read once, and closed in a `finally`. Nothing is cached and nothing
 * is handed onward.
 */
export function readCredentialRecord(env = process.env) {
  const directory = env.CREDENTIALS_DIRECTORY;
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new ExternalIdentityRefused('no_credential_channel',
      'this process was not started with a systemd credential; direct startup is not authorised');
  }
  if (!isAbsolute(directory)) throw new ExternalIdentityRefused('bad_credential_channel', 'the credential directory is not absolute');
  const canonical = resolve(directory);
  if (canonical !== directory) throw new ExternalIdentityRefused('bad_credential_channel', 'the credential directory is not canonical');
  if (canonical !== CREDENTIAL_ROOT && !canonical.startsWith(`${CREDENTIAL_ROOT}/`)) {
    throw new ExternalIdentityRefused('bad_credential_channel', `the credential directory is not under ${CREDENTIAL_ROOT}`);
  }

  const dirStat = lstatSync(canonical, { throwIfNoEntry: false });
  if (dirStat === undefined) throw new ExternalIdentityRefused('bad_credential_channel', 'the credential directory does not exist');
  if (dirStat.isSymbolicLink()) throw new ExternalIdentityRefused('bad_credential_channel', 'the credential directory is a symlink');
  if (!dirStat.isDirectory()) throw new ExternalIdentityRefused('bad_credential_channel', 'the credential directory is not a directory');

  // Every ancestor up to and including /run must be root-owned, so the path cannot be built by the
  // service account.
  for (let current = dirname(canonical); ; current = dirname(current)) {
    const ancestor = statSync(current, { throwIfNoEntry: false });
    if (ancestor === undefined) throw new ExternalIdentityRefused('bad_credential_channel', `${current} does not exist`);
    if (ancestor.uid !== 0) throw new ExternalIdentityRefused('bad_credential_channel', `${current} is not root-owned`);
    if (current === '/' || current === '/run') break;
  }

  const file = join(canonical, CREDENTIAL_NAME);
  const link = lstatSync(file, { throwIfNoEntry: false });
  if (link === undefined) throw new ExternalIdentityRefused('missing_credential', `${CREDENTIAL_NAME} is not present`);
  if (link.isSymbolicLink()) throw new ExternalIdentityRefused('bad_credential', 'the credential is a symlink');

  let fd;
  try {
    fd = openSync(file, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new ExternalIdentityRefused('bad_credential', 'the credential is not a regular file');
    /*
      systemd materialises a credential as `0440 root:root` plus an ACL granting the service user
      read. An earlier version of this check demanded `0400` and refused the real thing, which the
      sequential rollout caught on the first restart. What must be true is narrower and correct:
      nothing world-accessible, and nothing group-WRITABLE. Group-read is how the service account is
      granted access at all.
    */
    if ((stat.mode & 0o007) !== 0) throw new ExternalIdentityRefused('bad_credential', 'the credential is world accessible');
    if ((stat.mode & 0o020) !== 0) throw new ExternalIdentityRefused('bad_credential', 'the credential is group writable');
    if (stat.uid !== 0 && stat.uid !== process.getuid?.()) {
      throw new ExternalIdentityRefused('bad_credential', `the credential is owned by uid ${stat.uid}`);
    }
    if (stat.size > MAX_RECORD_BYTES) throw new ExternalIdentityRefused('oversized_record', `${stat.size} bytes`);
    const buffer = Buffer.alloc(stat.size);
    const read = readSync(fd, buffer, 0, stat.size, 0);
    if (read !== stat.size) throw new ExternalIdentityRefused('truncated_record', `read ${read} of ${stat.size} bytes`);
    return parseIdentityRecord(buffer.toString('utf8'));
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The repository files the record binds, and how their digests are taken. */
export const BOUND_FILES = Object.freeze({
  package: 'package.json',
  capsule: 'capsule/agent.json',
  deployment: 'deployment/agent.env.json',
});

function containmentVersion(repositoryRoot) {
  const text = readFileSync(join(repositoryRoot, 'src/core/containment/version.ts'), 'utf8');
  const match = /CONTAINMENT_VERSION\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"/.exec(text);
  if (match === null) throw new ExternalIdentityRefused('unbound_repository', 'the vendored containment version is unreadable');
  return match[1];
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ExternalIdentityRefused('unbound_repository', `${path} is unreadable: ${error.message}`);
  }
}

/**
 * Require exact agreement between the external record and what this repository actually is.
 *
 * Six equalities, all of them required: the record's agent against the package name, the capsule
 * identity and the deployment identity; and the record's three digests against the actual bytes.
 * A coherent foreign triple satisfies the first three among themselves and fails every one of the
 * last three, which is the whole point of putting the expected digests outside the tree.
 */
export function assertRepositoryBinding(repositoryRoot, record) {
  const packageJson = readJson(join(repositoryRoot, BOUND_FILES.package));
  const capsule = readJson(join(repositoryRoot, BOUND_FILES.capsule));
  const deployment = readJson(join(repositoryRoot, BOUND_FILES.deployment));

  const capsuleId = capsule?.identity?.id;
  const claims = [
    ['package name', packageJson?.name],
    ['capsule identity', capsuleId],
    ['deployment identity', deployment?.identity],
  ];
  for (const [what, value] of claims) {
    if (value !== record.agent) {
      throw new ExternalIdentityRefused('identity_mismatch',
        `${what} is ${JSON.stringify(value)}, but this deployment is authorised as ${JSON.stringify(record.agent)}`);
    }
  }
  if (packageJson?.name !== record.package.name) {
    throw new ExternalIdentityRefused('identity_mismatch', 'the package name is not the authorised one');
  }

  for (const [what, declared] of [
    ['package', record.package.sha256],
    ['capsule', record.capsule.sha256],
    ['deployment', record.deployment.sha256],
  ]) {
    const actual = fileDigest(join(repositoryRoot, BOUND_FILES[what]));
    if (actual !== declared) {
      throw new ExternalIdentityRefused('digest_mismatch',
        `${BOUND_FILES[what]} is ${actual}, but this deployment is authorised for ${declared}`);
    }
  }

  const version = containmentVersion(repositoryRoot);
  if (version !== record.containment.version) {
    throw new ExternalIdentityRefused('digest_mismatch',
      `the vendored containment is ${version}, but this deployment is authorised for ${record.containment.version}`);
  }
  return record;
}

/**
 * The whole check, in the order that matters: read the external record first, then hold the
 * repository against it. Returns a summary safe to log — identity, schema version, and the fact
 * that the digests matched. Never the record itself.
 */
export function assertExternalBinding(repositoryRoot, env = process.env) {
  const record = readCredentialRecord(env);
  assertRepositoryBinding(repositoryRoot, record);
  return Object.freeze({
    agent: record.agent,
    schemaVersion: record.schemaVersion,
    boundFiles: Object.freeze(Object.values(BOUND_FILES)),
    digestsMatched: true,
  });
}

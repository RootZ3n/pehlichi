/**
 * THE IDENTITY RECORD SCHEMA — one closed specification, shared by every in-release consumer.
 *
 * WHY THIS FILE EXISTS. Activation of r-20260906T020222Z failed because two gates disagreed about
 * what a record is. The external validator implemented schema 3; the in-release gate implemented
 * schema 1 and refused the very record the external gate had just accepted. Both were "correct"
 * against their own idea of the schema, and nothing forced those ideas to be the same one.
 *
 * So the schema is written down once, here, and every consumer inside the release reads it from
 * this module. The EXTERNAL validator deliberately does NOT import this file: it is an independent
 * implementation of the same documented contract, because a checker that loads its subject's code
 * checks nothing. Two implementations, one specification — not two specifications.
 *
 * SCHEMA 1 IS NOT SCHEMA 3. Schema 1 binds the package, capsule, deployment and containment version.
 * Schema 3 binds those plus the release identity, the release closure, the manifest, the boundary
 * anchor, the packaging profile and the approved data roots. They are not equivalent and this file
 * does not pretend otherwise: schema 1 survives only on the source rollback path, and only until
 * that path is retired.
 *
 * Plain `.mjs` with builtin-only imports: the launcher runs it in a bare node process, before any
 * loader exists.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The schema an activated release must present. */
export const RELEASE_SCHEMA_VERSION = 3;

/**
 * The schema the pre-release source deployment still presents.
 *
 * Accepted ONLY off the release path — see `isReleaseTree`. This is a transition affordance with a
 * removal condition, not a supported alternative: once the source rollback path is retired, this
 * constant and every branch that reads it go with it.
 */
export const LEGACY_SCHEMA_VERSION = 1;

export const SAFE_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
export const DIGEST = /^sha256:[0-9a-f]{64}$/;
export const VERSION = /^\d+\.\d+\.\d+$/;
export const RELEASE_ID = /^r-[0-9]{8}T[0-9]{6}Z$/;

/**
 * The anchor recipe this release was built against.
 *
 * Pinned here so a record naming a different recipe is refused by BOTH gates rather than only the
 * external one. The in-release gate cannot recompute the anchor cheaply, but it can refuse to
 * accept a record that claims a recipe this tree does not implement.
 */
export const ANCHOR_VERSION = 2;
export const RELEASE_PREFIX = '/opt/pehverse/releases';
export const DATA_PREFIX = '/var/lib/pehverse/shared';

/** The files a record binds by digest, and the source carrying the vendored containment version. */
export const BOUND_FILES = Object.freeze({
  package: 'package.json',
  capsule: 'capsule/agent.json',
  deployment: 'deployment/agent.env.json',
});
export const CONTAINMENT_VERSION_FILE = 'src/core/containment/version.ts';

/** The data-root names a schema-3 record must authorise. */
export const DATA_ROOT_NAMES = Object.freeze(['LAB_STORE_ROOT', 'MEMORY_STORE_ROOT', 'LABMEM_VAULT']);

const SCHEMA_3_KEYS = Object.freeze([
  'schemaVersion', 'agent', 'package', 'capsule', 'deployment', 'containment',
  'packaging', 'release', 'boundary', 'dataRoots',
]);
const SCHEMA_1_KEYS = Object.freeze([
  'schemaVersion', 'agent', 'package', 'capsule', 'deployment', 'containment',
]);

export class IdentitySchemaRefused extends Error {
  constructor(code, detail) {
    super(`identity record refused [${code}]: ${detail}`);
    this.name = 'IdentitySchemaRefused';
    this.code = code;
  }
}

const refuse = (code, detail) => { throw new IdentitySchemaRefused(code, detail); };

/**
 * Is this tree an activated release?
 *
 * Derived from the tree itself — a release carries `RELEASE.json`, which the builder writes and no
 * source checkout has (it is untracked in all three repositories). NOT caller-controlled: no
 * environment variable, argument or path parameter selects it, so nothing outside the tree can talk
 * a release into accepting the weaker schema.
 */
export function isReleaseTree(root) {
  return existsSync(join(root, 'RELEASE.json'));
}

function exactKeys(value, expected, where) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse('malformed_record', `${where} is not an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((k, i) => k !== wanted[i])) {
    refuse('malformed_record', `${where} has missing or unknown fields`);
  }
}

const digestField = (value, where) => {
  if (typeof value !== 'string' || !DIGEST.test(value)) refuse('malformed_record', `${where} is not a sha256 digest`);
};

const relativePath = (value, where) => {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/')
      || value.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    refuse('malformed_record', `${where} is not a normalised relative path`);
  }
};

/**
 * Validate a parsed record against the closed schema-3 specification.
 *
 * Every field is checked. A record that reaches the end of this function has a shape the external
 * validator would also accept, which is the property the two gates exist to share.
 */
export function assertSchema3(parsed) {
  exactKeys(parsed, SCHEMA_3_KEYS, 'record');
  if (parsed.schemaVersion !== RELEASE_SCHEMA_VERSION) {
    refuse('unsupported_schema', `schemaVersion ${JSON.stringify(parsed.schemaVersion)}`);
  }
  if (typeof parsed.agent !== 'string' || !SAFE_ID.test(parsed.agent)) refuse('malformed_record', 'agent is not a safe identifier');

  exactKeys(parsed.package, ['name', 'sha256'], 'record.package');
  if (parsed.package.name !== parsed.agent) refuse('malformed_record', 'record.package.name is not the agent');
  digestField(parsed.package.sha256, 'record.package.sha256');

  exactKeys(parsed.capsule, ['sha256'], 'record.capsule');
  digestField(parsed.capsule.sha256, 'record.capsule.sha256');
  exactKeys(parsed.deployment, ['sha256'], 'record.deployment');
  digestField(parsed.deployment.sha256, 'record.deployment.sha256');

  exactKeys(parsed.containment, ['version'], 'record.containment');
  if (typeof parsed.containment.version !== 'string' || !VERSION.test(parsed.containment.version)) {
    refuse('malformed_record', 'record.containment.version is not a semantic version');
  }

  exactKeys(parsed.packaging, ['profileVersion'], 'record.packaging');
  if (!Number.isInteger(parsed.packaging.profileVersion) || parsed.packaging.profileVersion < 1) {
    refuse('malformed_record', 'record.packaging.profileVersion is not a positive integer');
  }

  exactKeys(parsed.release, ['id', 'root', 'closureDigest', 'manifestSha256', 'entrypoint', 'workingDirectory'], 'record.release');
  if (typeof parsed.release.id !== 'string' || !RELEASE_ID.test(parsed.release.id)) refuse('malformed_record', 'record.release.id is not a release identifier');
  if (typeof parsed.release.root !== 'string' || !parsed.release.root.startsWith(`${RELEASE_PREFIX}/`)) {
    refuse('malformed_record', `record.release.root is outside ${RELEASE_PREFIX}`);
  }
  if (!parsed.release.root.endsWith(`/${parsed.release.id}`)) refuse('malformed_record', 'record.release.root does not end in the release id');
  digestField(parsed.release.closureDigest, 'record.release.closureDigest');
  digestField(parsed.release.manifestSha256, 'record.release.manifestSha256');
  relativePath(parsed.release.entrypoint, 'record.release.entrypoint');
  relativePath(parsed.release.workingDirectory, 'record.release.workingDirectory');

  exactKeys(parsed.boundary, ['anchorVersion', 'anchor', 'validatorSha256'], 'record.boundary');
  if (parsed.boundary.anchorVersion !== ANCHOR_VERSION) {
    refuse('anchor_version_mismatch',
      `record declares anchorVersion ${JSON.stringify(parsed.boundary.anchorVersion)}, this release implements ${ANCHOR_VERSION}`);
  }
  digestField(parsed.boundary.anchor, 'record.boundary.anchor');
  digestField(parsed.boundary.validatorSha256, 'record.boundary.validatorSha256');

  exactKeys(parsed.dataRoots, DATA_ROOT_NAMES, 'record.dataRoots');
  for (const name of DATA_ROOT_NAMES) {
    const entry = parsed.dataRoots[name];
    exactKeys(entry, ['root', 'writable'], `record.dataRoots.${name}`);
    if (typeof entry.root !== 'string' || !entry.root.startsWith(`${DATA_PREFIX}/`)) {
      refuse('malformed_record', `record.dataRoots.${name}.root is outside ${DATA_PREFIX}`);
    }
    if (!Array.isArray(entry.writable) || entry.writable.length === 0) {
      refuse('malformed_record', `record.dataRoots.${name}.writable is empty`);
    }
    for (const leaf of entry.writable) relativePath(leaf, `record.dataRoots.${name}.writable entry`);
  }
  return parsed;
}

/** Validate a parsed record against the legacy schema-1 specification. Source rollback path only. */
export function assertSchema1(parsed) {
  exactKeys(parsed, SCHEMA_1_KEYS, 'record');
  if (parsed.schemaVersion !== LEGACY_SCHEMA_VERSION) {
    refuse('unsupported_schema', `schemaVersion ${JSON.stringify(parsed.schemaVersion)}`);
  }
  if (typeof parsed.agent !== 'string' || !SAFE_ID.test(parsed.agent)) refuse('malformed_record', 'agent is not a safe identifier');
  exactKeys(parsed.package, ['name', 'sha256'], 'record.package');
  digestField(parsed.package.sha256, 'record.package.sha256');
  exactKeys(parsed.capsule, ['sha256'], 'record.capsule');
  digestField(parsed.capsule.sha256, 'record.capsule.sha256');
  exactKeys(parsed.deployment, ['sha256'], 'record.deployment');
  digestField(parsed.deployment.sha256, 'record.deployment.sha256');
  exactKeys(parsed.containment, ['version'], 'record.containment');
  if (typeof parsed.containment.version !== 'string' || !VERSION.test(parsed.containment.version)) {
    refuse('malformed_record', 'record.containment.version is not a semantic version');
  }
  return parsed;
}

/**
 * Bind a schema-3 record to the release tree it names.
 *
 * The closure is NOT re-walked here. The external validator recomputes it in `ExecStartPre`, before
 * any of this code is loaded; repeating a 5600-entry walk at every start would buy nothing. What
 * this does instead is bind transitively and cheaply: `RELEASE.json`'s own bytes must hash to the
 * digest the record names, and the closure digest inside that manifest must equal the record's. A
 * tampered tree fails the external walk; a tampered manifest fails here.
 */
export function assertReleaseBinding(releaseRoot, record, digestOf) {
  if (record.release.root !== releaseRoot) {
    refuse('release_mismatch', `this tree is ${releaseRoot}, the record authorises ${record.release.root}`);
  }
  const manifestPath = join(releaseRoot, 'RELEASE.json');
  const actualManifest = digestOf(manifestPath);
  if (actualManifest !== record.release.manifestSha256) {
    refuse('digest_mismatch', `RELEASE.json is ${actualManifest}, the record authorises ${record.release.manifestSha256}`);
  }
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
  catch (error) { refuse('unreadable_manifest', `RELEASE.json: ${error.message}`); }

  for (const [field, expected] of [
    ['agent', record.agent],
    ['releaseId', record.release.id],
    ['closureDigest', record.release.closureDigest],
    ['boundaryAnchor', record.boundary.anchor],
    ['containmentVersion', record.containment.version],
    ['validatorSha256', record.boundary.validatorSha256],
    ['entrypoint', record.release.entrypoint],
    ['workingDirectory', record.release.workingDirectory],
  ]) {
    if (manifest[field] !== expected) {
      refuse('release_mismatch', `RELEASE.json ${field} is ${JSON.stringify(manifest[field])}, the record authorises ${JSON.stringify(expected)}`);
    }
  }
  if (manifest.packagingProfileVersion !== record.packaging.profileVersion) {
    refuse('release_mismatch', 'RELEASE.json packagingProfileVersion disagrees with the record');
  }
  return record;
}

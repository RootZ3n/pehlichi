/**
 * Fail-closed credential-path policy.
 *
 * A verifier that proves parity by reading files is a verifier that reads secrets. The
 * parity question never needs a credential value: two deployments are allowed to hold
 * different tokens, so the bytes could not be compared even in principle. This module
 * decides, from the path alone, which files must never be opened -- no read, no hash, no
 * length, no excerpt -- and the verifier honours that decision before it touches the disk.
 *
 * The policy is deliberately over-inclusive. A path that merely looks credential-bearing is
 * excluded from content inspection and reported, never silently skipped and never opened to
 * find out. Classification is a pure function of the repository-relative path, so it can be
 * applied before any file descriptor exists.
 */

export const SECRET_PATH_POLICY_VERSION='1.0.0';

/** Exact repository-relative paths that are credential-bearing by construction. */
const EXACT=new Set(['.env','.npmrc','.netrc','.pgpass','.htpasswd']);

/**
 * Basename patterns. Each entry is [regexp, reason]; the reason is reported verbatim so a
 * reader can see which rule excluded the path without seeing the path's contents.
 */
const BASENAME=Object.freeze([
  [/^\.env(\..+)?$/i,'dotenv environment file'],
  [/^\.npmrc$/i,'package registry credentials'],
  [/^\.netrc$/i,'network credentials'],
  [/^\.pgpass$/i,'database credentials'],
  [/^\.htpasswd$/i,'http credentials'],
  [/^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/i,'private ssh key'],
  [/^(secrets?|credentials?|token|tokens)(\.[A-Za-z0-9._-]+)?$/i,'credential store'],
  [/^service-account.*\.json$/i,'service account key'],
  [/\.(pem|key|p12|pfx|jks|keystore|asc|gpg|pgp|ppk)$/i,'private key or keystore material'],
  [/(^|[._-])(secret|secrets|token|credential|credentials|password|passwd|apikey|api-key)s?(\.[A-Za-z0-9._-]+)?$/i,'credential-named file'],
  [/^(authorized_keys|known_hosts)$/i,'ssh trust material']
]);

/** Directory prefixes whose entire contents are credential-bearing. */
const DIRECTORY=Object.freeze([
  ['.ssh/','ssh key material'],
  ['.gnupg/','gpg key material'],
  ['secrets/','credential store directory'],
  ['.aws/','cloud credentials'],
  ['.docker/','registry credentials']
]);

/**
 * Classify a repository-relative path.
 *
 * Returns `{secret:false}` or `{secret:true,reason}`. It never touches the filesystem: the
 * whole point is that the answer is available before anything is opened.
 */
export function classifySecretPath(rel){
  if(typeof rel!=='string'||rel.length===0)return {secret:false};
  const segments=rel.split('/');
  const base=segments[segments.length-1];
  if(EXACT.has(rel))return {secret:true,reason:'exact credential path'};
  for(const [prefix,reason] of DIRECTORY){
    if(rel.startsWith(prefix)||segments.slice(0,-1).some((s)=>`${s}/`===prefix))return {secret:true,reason};
  }
  for(const [pattern,reason] of BASENAME)if(pattern.test(base))return {secret:true,reason};
  return {secret:false};
}

export const isSecretPath=(rel)=>classifySecretPath(rel).secret;

/**
 * Mode policy for a path that is excluded from content inspection.
 *
 * Metadata is all that remains available, so it is the only thing that can be checked: the
 * file must be a regular file, must not be executable, and must not be writable by group or
 * other. Anything stricter (a required 0600) would be a change to the repositories rather
 * than an observation about them, and this verifier only observes.
 */
export function secretModeProblems(mode){
  const problems=[];
  if(mode&0o111)problems.push('credential-bearing path is executable');
  if(mode&0o022)problems.push('credential-bearing path is group- or world-writable');
  return problems;
}

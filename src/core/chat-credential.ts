/**
 * THE CHAT TOKEN — delivered by systemd credential in a release, never by environment.
 *
 * WHY. The token used to arrive in `IKBI_CHAT_TOKEN`, which meant it sat in the process environment,
 * was inherited by every child this agent spawns, and was readable from `/proc/<pid>/environ` by
 * anything running as the same account. It also came from a git-ignored, zen-writable file inside
 * the repository, so whoever could write that file chose who may talk to the agent.
 *
 * In a release the token is read once, at startup, directly from the verified systemd credential
 * directory, and is never placed back into the environment. In a source checkout the environment is
 * still accepted, because the rollback deployment has no credential to read — a transition
 * affordance with a removal condition, not a supported alternative.
 *
 * WHAT "VERIFIED" MEANS. `CREDENTIALS_DIRECTORY` is an environment variable and therefore forgeable,
 * so it is treated as a POINTER to check, never as the answer: it must be absolute, canonical, under
 * `/run/credentials`, and every ancestor up to `/run` must be root-owned. A caller who points it at
 * a directory they control fails the prefix; a caller who cannot write `/run` cannot satisfy it.
 */
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readSync, statSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** The credential this agent's chat gate reads. Distinct from `agent-identity`. */
export const CHAT_CREDENTIAL_NAME = 'chat-token';
export const CREDENTIAL_ROOT = '/run/credentials';

/** A token longer than this is not a token, it is someone probing the reader. */
const MAX_TOKEN_BYTES = 4096;
const MIN_TOKEN_CHARS = 16;

export class ChatCredentialRefused extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`chat credential refused [${code}]: ${detail}`);
    this.name = 'ChatCredentialRefused';
    this.code = code;
  }
}

/*
  A `function` declaration, not an arrow const: TypeScript only propagates a `never` return for
  control-flow narrowing when the callee is declared this way, so `if (bad) refuse(...)` does not
  narrow the checked value with an arrow. Everything after a refusal is unreachable, and the
  compiler should be able to see that.
*/
function refuse(code: string, detail: string): never {
  throw new ChatCredentialRefused(code, detail);
}

/**
 * Read the chat token from the verified credential directory.
 *
 * TERMINAL NEWLINE. Exactly one trailing `\n` is stripped, because that is what `printf '%s\n'` and
 * every editor write, and systemd passes the file through byte for byte. Nothing else is trimmed:
 * leading or interior whitespace is part of the token, and stripping it would silently accept two
 * different files as the same credential.
 */
export function readChatCredential(env: NodeJS.ProcessEnv = process.env): string {
  const directory = env['CREDENTIALS_DIRECTORY'];
  if (typeof directory !== 'string' || directory.length === 0) {
    refuse('no_credential_channel', 'not started with a systemd credential');
  }
  if (!isAbsolute(directory) || resolve(directory) !== directory) refuse('bad_channel', 'the credential directory is not canonical');
  if (directory !== CREDENTIAL_ROOT && !directory.startsWith(`${CREDENTIAL_ROOT}/`)) {
    refuse('bad_channel', `the credential directory is not under ${CREDENTIAL_ROOT}`);
  }
  const dirStat = lstatSync(directory, { throwIfNoEntry: false });
  if (dirStat === undefined || dirStat.isSymbolicLink() || !dirStat.isDirectory()) refuse('bad_channel', 'not a real credential directory');
  for (let current = dirname(directory); ; current = dirname(current)) {
    const ancestor = statSync(current, { throwIfNoEntry: false });
    if (ancestor === undefined || ancestor.uid !== 0) refuse('bad_channel', `${current} is not root-owned`);
    if (current === '/' || current === '/run') break;
  }

  const file = join(directory, CHAT_CREDENTIAL_NAME);
  const link = lstatSync(file, { throwIfNoEntry: false });
  if (link === undefined) refuse('missing_credential', `${CHAT_CREDENTIAL_NAME} is absent`);
  if (link.isSymbolicLink()) refuse('bad_credential', 'the credential is a symlink');

  let fd: number | undefined;
  try {
    try { fd = openSync(file, 'r'); }
    catch (error) { return refuse('unreadable_credential', `${CHAT_CREDENTIAL_NAME}: ${(error as NodeJS.ErrnoException).code ?? 'error'}`); }
    const stat = fstatSync(fd);
    if (!stat.isFile()) refuse('bad_credential', 'the credential is not a regular file');
    if ((stat.mode & 0o007) !== 0) refuse('bad_credential', 'the credential is world accessible');
    if ((stat.mode & 0o020) !== 0) refuse('bad_credential', 'the credential is group writable');
    if (stat.size === 0) refuse('empty_credential', 'the credential is empty');
    if (stat.size > MAX_TOKEN_BYTES) refuse('oversized_credential', `${stat.size} bytes`);
    const buffer = Buffer.alloc(stat.size);
    if (readSync(fd, buffer, 0, stat.size, 0) !== stat.size) refuse('truncated_credential', 'short read');

    let text = buffer.toString('utf8');
    if (text.endsWith('\n')) text = text.slice(0, -1);   // exactly one terminal newline
    if (text.length === 0) refuse('empty_credential', 'the credential is only a newline');
    if (text.length < MIN_TOKEN_CHARS) refuse('weak_credential', `${text.length} characters is too short to be a token`);
    if (text.includes('\n')) refuse('malformed_credential', 'the credential contains more than one line');
    return text;
  } finally {
    // Closed on every path, including refusal, so a descriptor never outlives the read.
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Compare a presented bearer token against the expected one in constant time.
 *
 * `===` on strings short-circuits at the first differing byte, which leaks the length of the shared
 * prefix to anyone who can time the response. `timingSafeEqual` requires equal lengths, so the
 * length is compared separately and the buffers are only compared when they match — the length
 * itself is not a secret, the value is.
 */
export function bearerMatches(header: unknown, expected: string): boolean {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const presented = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const want = Buffer.from(expected, 'utf8');
  if (presented.length !== want.length) return false;
  return timingSafeEqual(presented, want);
}

/** Is this an activated release? Decided by the tree, never by a caller. See identity-schema.mjs. */
export function isReleaseDeployment(repositoryRoot: string): boolean {
  try { accessSync(join(repositoryRoot, 'RELEASE.json'), constants.F_OK); return true; } catch { return false; }
}

/**
 * The token this deployment must enforce.
 *
 * In a release: the credential, or a refusal. There is no environment fallback — a release that
 * cannot read its credential must not start serving an open `/chat`, which is exactly what falling
 * back would produce.
 */
export function resolveChatToken(
  repositoryRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): { token: string | undefined; source: 'credential' | 'environment' | 'none' } {
  if (isReleaseDeployment(repositoryRoot)) {
    return { token: readChatCredential(env), source: 'credential' };
  }
  const fromEnv = env['IKBI_CHAT_TOKEN'];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return { token: fromEnv, source: 'environment' };
  return { token: undefined, source: 'none' };
}

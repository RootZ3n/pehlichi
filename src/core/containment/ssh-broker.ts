import { lstatSync, statSync } from "node:fs";

/**
 * THE governed SSH read operation — the lab's only outbound network operation.
 *
 * WHY A BROKER RATHER THAN AN EXCEPTION. The previous rule was "the command is named ssh, therefore
 * it may have the network and no syscall filter". An independent audit put a private executable
 * called `ssh` earlier in PATH and the production path ran it, under exactly that policy. A rule
 * keyed to a command name is a rule the caller chooses. This module is reached by being called, and
 * it builds every argument itself.
 *
 * THE ONE PERMITTED OPERATION, and it is deliberately the only one: run a single already-validated
 * read-only command in one directory on the single declared host. That is what `lab_shell` requires
 * and all it has ever required. There is no general SSH surface here: no caller-supplied options, no
 * argv passthrough, no port selection, no subsystem, no forwarding, no file transfer, no second
 * host. Anything beyond this operation is a new reviewed operation, not a new argument.
 *
 * WHAT THIS IS NOT. It is not a local process launcher. The executable is a compile-time constant.
 * Nothing in a request can change which program runs.
 */

/** The reviewed executable. Absolute, root-owned, and never resolved through PATH. */
export const SSH_EXECUTABLE = "/usr/bin/ssh";

/**
 * The closed request. Three fields, all validated, none of them argv.
 *
 * `host` is not caller-chosen at this layer: the caller passes the configured host and the broker
 * checks it against the same rules, so a request cannot introduce a second destination.
 */
export interface SshReadRequest {
  readonly host: string;
  /** Absolute directory on the far side. Confined by the caller and re-checked here. */
  readonly directory: string;
  /** A single read-only command, already validated by the caller's allowlist and re-checked here. */
  readonly command: string;
}

export type SshRequestCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Characters that would let a field escape its position — quoting, chaining, redirection,
 * substitution, newline injection — plus the ones that only ever appear in an attack here.
 */
const FORBIDDEN_IN_FIELD = /['"`$;&|<>(){}\[\]\\\n\r\t\0]/;

/** A host is a bare alias or user@host. No options, no whitespace, no scheme, no port syntax. */
const HOST_SHAPE = /^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9_.-]+$/;

/**
 * Options an argument must never carry, in every spelling OpenSSH accepts.
 *
 * The broker builds argv itself, so none of these can arrive as an option in the first place; this
 * is the second layer, checking the request FIELDS for anything that reads as one. A field that
 * mentions `ProxyCommand` has no legitimate reason to, whatever form it is written in.
 */
const DANGEROUS_TOKENS = [
  "proxycommand", "localcommand", "permitlocalcommand", "knownhostscommand",
  "pkcs11provider", "securitykeyprovider", "proxyusefdpass", "proxyjump",
  "controlmaster", "controlpath", "controlpersist", "identityagent",
  "forwardagent", "forwardx11", "remoteforward", "localforward", "dynamicforward",
  "streamlocalbindunlink", "tunnel", "tundevice", "include", "match",
  "sendenv", "setenv", "requesttty", "remotecommand", "subsystem",
];

/**
 * Normalise a field before looking for those tokens.
 *
 * Unicode confusables and zero-width characters are how a denylist gets walked past, so the field is
 * NFKC-folded, stripped of format characters, and lowercased first. Anything left outside plain
 * ASCII is refused outright rather than interpreted — a legitimate lab path or command has no use
 * for it.
 *
 * The separator-stripping below keeps DIGITS. An earlier version stripped everything but a-z, which
 * silently defeated the two tokens that contain digits: `pkcs11provider` and `forwardx11` folded to
 * `pkcsprovider` and `forwardx` and never matched their own needles. A normaliser that erases part
 * of what it is looking for is worse than none, because it reports clean.
 */
function normalised(value: string): string {
  return value.normalize("NFKC").replace(/[\u200B-\u200F\u2060\uFEFF]/g, "").toLowerCase();
}

function checkField(name: string, value: string): SshRequestCheck {
  if (typeof value !== "string" || value.length === 0) return { ok: false, reason: `${name} is empty` };
  if (value !== value.trim()) return { ok: false, reason: `${name} carries surrounding whitespace` };
  // eslint-disable-next-line no-control-regex
  if (/[^\x20-\x7E]/.test(value)) return { ok: false, reason: `${name} contains a non-ASCII or control character` };
  if (FORBIDDEN_IN_FIELD.test(value)) return { ok: false, reason: `${name} contains a shell metacharacter` };
  const folded = normalised(value);
  if (folded.includes("-o") || folded.startsWith("-")) return { ok: false, reason: `${name} reads as an option` };
  for (const token of DANGEROUS_TOKENS) {
    if (folded.replace(/[^a-z0-9]/g, "").includes(token)) {
      return { ok: false, reason: `${name} mentions ${token}, which this operation never carries` };
    }
  }
  return { ok: true };
}

/** Validate the whole request. Every field, every time; nothing is trusted from the caller. */
export function checkSshRequest(request: SshReadRequest): SshRequestCheck {
  for (const [name, value] of [["host", request.host], ["directory", request.directory], ["command", request.command]] as const) {
    const field = checkField(name, value);
    if (!field.ok) return field;
  }
  if (!HOST_SHAPE.test(request.host)) return { ok: false, reason: "host is not a bare alias or user@host" };
  if (!request.directory.startsWith("/")) return { ok: false, reason: "directory is not absolute" };
  if (request.directory.includes("..")) return { ok: false, reason: "directory traverses" };
  return { ok: true };
}

export type ExecutableCheck =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Verify the reviewed executable before running it.
 *
 * WHAT THIS DOES: refuses a symlink, a non-regular file, a file not owned by root, and a file any
 * non-root account can write. Checked by `lstat` first so a symlink is caught as a symlink rather
 * than followed and reported about its target.
 *
 * WHAT THIS DOES NOT DO, stated plainly rather than overclaimed: it is NOT a race-free
 * descriptor-based execution. Node on this runtime exposes no `O_PATH`, and `bwrap` execs by path,
 * so a verified descriptor could not be handed to it. What actually prevents substitution is that
 * `/usr/bin/ssh` and `/usr/bin` are root-owned and unwritable by the account the agents run as; this
 * check is a second, cheap confirmation of that, not the thing standing between the two.
 */
export function checkSshExecutable(path: string = SSH_EXECUTABLE): ExecutableCheck {
  let link;
  try {
    link = lstatSync(path);
  } catch (error) {
    return { ok: false, reason: `${path} is not present: ${(error as NodeJS.ErrnoException).code ?? "unknown"}` };
  }
  if (link.isSymbolicLink()) return { ok: false, reason: `${path} is a symlink` };
  const stat = statSync(path);
  if (!stat.isFile()) return { ok: false, reason: `${path} is not a regular file` };
  if (stat.uid !== 0) return { ok: false, reason: `${path} is owned by uid ${stat.uid}, not root` };
  if ((stat.mode & 0o022) !== 0) return { ok: false, reason: `${path} is group or world writable` };
  return { ok: true, path };
}

/**
 * The fixed configuration.
 *
 * Every dangerous option is set to its safe value ON THE COMMAND LINE, which is the only way to
 * neutralise system configuration: `-F /dev/null` replaces the USER config, while `/etc/ssh/ssh_config`
 * is still read, and command-line `-o` wins over both. So the list below is not decoration — it is
 * what makes a hostile system config inert.
 *
 * `IdentityAgent=none` is also what lets this operation keep the AF_UNIX syscall filter: with no
 * agent socket to reach, ssh needs no unix socket at all, which was verified by running the real
 * client under the real filter.
 */
export const SSH_FIXED_OPTIONS: readonly string[] = Object.freeze([
  "-F", "/dev/null",
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=10",
  "-o", "StrictHostKeyChecking=yes",
  "-o", "IdentityAgent=none",
  "-o", "ForwardAgent=no",
  "-o", "ForwardX11=no",
  "-o", "ForwardX11Trusted=no",
  "-o", "ClearAllForwardings=yes",
  "-o", "ControlMaster=no",
  "-o", "ControlPath=none",
  "-o", "PermitLocalCommand=no",
  "-o", "ProxyCommand=none",
  "-o", "Tunnel=no",
  "-o", "PKCS11Provider=none",
  "-o", "SecurityKeyProvider=none",
  "-o", "RequestTTY=no",
  "-o", "SessionType=default",
]);

/**
 * The exact argv for the one operation.
 *
 * The remote side receives `cd '<directory>' && <command>`. That IS remote command execution, and it
 * is the operation being justified: `lab_shell` exists to read lab repositories over ssh. It is
 * bounded on the far side by the caller's read-only command allowlist and on this side by the field
 * checks above. It is not a general remote shell: no tty, no subsystem, no second command.
 */
export function buildSshArgv(request: SshReadRequest): readonly string[] {
  return [...SSH_FIXED_OPTIONS, "--", request.host, `cd '${request.directory}' && ${request.command}`];
}

/**
 * The environment the client is given. An allowlist, built here, never inherited wholesale.
 *
 * PATH is a single root-owned directory and is not used for resolution anyway. HOME is the real
 * home because that is where the reviewed client finds its keys and known_hosts; the host is bound
 * read-only inside containment, so nothing there can be modified by the run. Everything else --
 * every `SSH_*` variable, every loader variable, every shell startup variable, every agent variable
 * -- is absent, because it was never copied in.
 */
export function sshEnvironment(home: string): Readonly<Record<string, string>> {
  return Object.freeze({
    PATH: "/usr/bin",
    HOME: home,
    LANG: "C.UTF-8",
  });
}

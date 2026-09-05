import type { ContainmentPolicy } from "./policy.js";
import { canonical, existsSafe, isWithin } from "./paths.js";
import { SECCOMP_CHILD_FD } from "./seccomp.js";

/**
 * The minimal system directories a bound binary needs in order to run at all: the dynamic linker,
 * the shared libraries, the binary itself, and the loader configuration in /etc.
 *
 * In the narrow view, anything NOT listed here is simply absent from the mount namespace. The
 * operator's home, the lab tree, arbitrary absolute paths — none of them can be read, because none
 * of them are there.
 */
export const NARROW_SYSTEM_DIRS: readonly string[] = Object.freeze([
  "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/etc",
  "/nix", "/opt", "/run/current-system", "/run/opengl-driver",
]);

/**
 * Toolchains that cache outside the workspace and therefore fail against a read-only HOME.
 *
 * Redirected into the private tmpfs rather than granted a writable HOME: the cache is genuinely
 * throwaway, and widening HOME to satisfy a build cache would hand every subsequent command a
 * writable home for the rest of the run.
 */
function toolchainCacheEnv(command: string): ReadonlyArray<readonly [string, string]> {
  const cmd = command.slice(command.lastIndexOf("/") + 1);
  switch (cmd) {
    case "go":
      return [["GOCACHE", "/tmp/.cache/go-build"], ["GOPATH", "/tmp/.cache/go"], ["GOMODCACHE", "/tmp/.cache/go/pkg/mod"]];
    case "cargo":
      return [["CARGO_HOME", "/tmp/.cache/cargo"]];
    case "dotnet":
      return [["DOTNET_CLI_HOME", "/tmp/.cache/dotnet"], ["NUGET_PACKAGES", "/tmp/.cache/nuget"]];
    case "mvn":
      return [["MAVEN_OPTS", "-Dmaven.repo.local=/tmp/.cache/m2"]];
    case "gradle":
      return [["GRADLE_USER_HOME", "/tmp/.cache/gradle"]];
    default:
      return [];
  }
}

/**
 * Bind this run's governed temporary child and point the standard temp variables at it.
 *
 * The rule being served: no lab code uses /tmp, inside containment or out. A subprocess calling
 * `os.tmpdir()` would otherwise land on the private tmpfs — contained, but still /tmp, and invisible
 * to whatever accounts for scratch. Binding the governed child at its REAL host path means a path
 * handed across the boundary denotes the same directory on both sides.
 *
 * Only the run's OWN child is bound, never the shared root, so one run cannot walk up into a
 * concurrent run's scratch.
 */
function tempArgs(policy: ContainmentPolicy, writableRoot: string | undefined, env: NodeJS.ProcessEnv): string[] {
  if (policy.tempRoot === undefined) return ["--setenv", "TMPDIR", "/tmp"];
  const temp = canonical(policy.tempRoot);
  const out: string[] = [];
  const alreadyWritable = (p: string): boolean => writableRoot !== undefined && isWithin(p, writableRoot);

  if (!alreadyWritable(temp) && existsSafe(temp)) out.push("--bind", temp, temp);

  /*
    A HOME THAT IS ITSELF SCRATCH IS WRITABLE — and nothing else about HOME changes.

    The operator's real home stays read-only; that is the barrier and it is not touched. But a
    caller who points HOME at a directory inside the governed temporary root has said, structurally,
    "this home IS scratch". Hermetic children do exactly that. Leaving such a home read-only makes a
    toolchain fail for want of a cache, and the resulting red result describes the harness rather
    than the work under test.

    Only a home UNDER the governed temp child qualifies, so no path outside it becomes writable.
  */
  const home = env.HOME;
  if (home !== undefined && home.length > 0) {
    const realHome = canonical(home);
    if (isWithin(realHome, temp) && realHome !== temp && !alreadyWritable(realHome) && existsSafe(realHome)) {
      out.push("--bind", realHome, realHome);
    }
  }

  out.push("--setenv", "TMPDIR", temp, "--setenv", "TMP", temp, "--setenv", "TEMP", temp);
  return out;
}

/**
 * The WORKTREE view: the entire host is bound read-only, the declared workspace is writable.
 *
 *   • `--ro-bind / /`      the host is visible but immutable
 *   • `--tmpfs /tmp`       /tmp is MASKED with a fresh empty filesystem. A third-party tool that
 *                          hard-codes `/tmp/x` writes into something ephemeral that never reaches
 *                          the host. TMPDIR points elsewhere, so no lab code targets it.
 *   • `--unshare-all`      no network, pid, ipc, uts or user namespace sharing …
 *   • `--share-net`        … except when the policy says a dependency fetch legitimately needs it
 *   • `--die-with-parent`  no orphan survives the parent
 *   • `--new-session`      no escape through the controlling terminal
 */
export function buildWorktreeArgs(
  policy: ContainmentPolicy,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const writableRoot = policy.writableRoot !== undefined ? canonical(policy.writableRoot) : undefined;
  const chdir = policy.cwd !== undefined ? canonical(policy.cwd) : writableRoot;

  const a: string[] = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];

  /*
    MASK THE HOST RUNTIME DIRECTORY.

    An unshared network namespace stops IP traffic. It does NOT stop a unix socket, because a unix
    socket is a filesystem object, and binding `/` read-only hands the sandbox every socket the host
    is listening on: systemd-resolved, D-Bus, journald, the ssh agent, container daemons.

    This was not theoretical. With `/run` visible, `dns.lookup("example.com")` inside a fully
    unshared sandbox still resolved -- nss_resolve reached the host's resolver over
    /run/systemd/resolve and answered from the host's network. "Unshared" and "isolated" are not the
    same claim, and only the second one is worth making.

    Masked unconditionally, not only when the network is denied: reaching host services is its own
    escape, independent of whether a dependency fetch was allowed.
  */
  a.push("--tmpfs", "/run");
  // Re-expose the read-only system trees some distributions keep under /run. These are immutable
  // store paths, not sockets, and a binary cannot run without them where they are used.
  for (const dir of ["/run/current-system", "/run/opengl-driver"]) {
    if (existsSafe(dir)) a.push("--ro-bind", dir, dir);
  }

  if (writableRoot !== undefined) a.push("--bind", writableRoot, writableRoot);
  a.push(...tempArgs(policy, writableRoot, env));

  for (const raw of policy.extraWritable ?? []) {
    const p = canonical(raw);
    if (writableRoot !== undefined && isWithin(p, writableRoot)) continue;
    if (existsSafe(p)) a.push("--bind", p, p);
  }

  if (chdir !== undefined) a.push("--chdir", chdir);
  for (const [k, v] of toolchainCacheEnv(command)) a.push("--setenv", k, v);

  a.push("--unshare-all");
  if (policy.networkAllowed) a.push("--share-net");
  if (policy.denyUnixSockets) a.push("--seccomp", String(SECCOMP_CHILD_FD));
  a.push("--die-with-parent", "--new-session", "--", command, ...args);
  return a;
}

/**
 * The NARROW view: the host is not mounted at all.
 *
 * Only the essential system directories, the explicitly named read-only roots, a writable scratch
 * path, and a private tmpfs exist inside the namespace. The network is never shared, whatever the
 * command claims to need — a read-only terminal has no legitimate reason to reach it.
 */
export function buildNarrowArgs(
  policy: ContainmentPolicy,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const a: string[] = ["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"];

  for (const dir of NARROW_SYSTEM_DIRS) {
    if (existsSafe(dir)) a.push("--ro-bind", dir, dir);
  }
  for (const raw of policy.readonlyRoots ?? []) {
    const p = canonical(raw);
    if (existsSafe(p)) a.push("--ro-bind", p, p);
  }

  const writableRoot = policy.writableRoot !== undefined ? canonical(policy.writableRoot) : undefined;
  if (writableRoot !== undefined && existsSafe(writableRoot)) a.push("--bind", writableRoot, writableRoot);

  a.push(...tempArgs(policy, writableRoot, env));

  const chdir = policy.cwd !== undefined
    ? canonical(policy.cwd)
    : (policy.readonlyRoots?.[0] !== undefined ? canonical(policy.readonlyRoots[0]) : undefined);
  if (chdir !== undefined) a.push("--chdir", chdir);

  a.push("--unshare-all");
  if (policy.denyUnixSockets) a.push("--seccomp", String(SECCOMP_CHILD_FD));
  a.push("--die-with-parent", "--new-session", "--", command, ...args);
  return a;
}

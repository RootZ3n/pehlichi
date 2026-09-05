/**
 * What kind of risk a command carries.
 *
 * `risky` is the only field that decides containment. The rest explains the verdict, which matters
 * because a denial has to be legible to whoever hits it.
 */
export interface CommandRisk {
  /** True ⇒ this command can execute code or write files, and MUST be contained. */
  readonly risky: boolean;
  readonly kind: "interpreter" | "package-install" | "package-script" | "toolchain" | "write-tool" | "network-tool" | "safe";
  /** True ⇒ legitimate work needs the network (dependency resolution), so the net namespace stays. */
  readonly needsNetwork: boolean;
  readonly reason: string;
}

/**
 * Interpreters execute arbitrary code — a script file, stdin, or an inline expression — so they are
 * risky whatever the arguments say. Judging them by their args is how a classifier gets beaten:
 * `python -c` and `python script.py` and `python < file` are all the same capability.
 */
const INTERPRETERS = new Set([
  "node", "nodejs", "python", "python2", "python3", "tsx", "ts-node", "deno", "bun",
  "ruby", "perl", "php", "lua", "Rscript", "bash", "sh", "zsh", "dash", "ksh", "fish",
]);

/** Native build and test toolchains: they compile and then RUN project-owned code. */
const TOOLCHAINS = new Set([
  "cargo", "go", "godot", "java", "javac", "dotnet", "mvn", "gradle", "make", "cmake", "ninja",
  "pytest", "vitest", "jest", "mocha", "ava", "tap", "nyc", "c8", "phpunit", "rspec",
]);

/**
 * Package managers are risky because their lifecycle scripts run project code. Install-class
 * subcommands additionally reach the network.
 */
const PACKAGE_MANAGERS = new Set([
  "npm", "npx", "pnpm", "yarn", "bun", "pip", "pip3", "poetry", "pipenv", "gem", "bundle",
]);

const PM_INSTALL_SUBCOMMANDS = new Set([
  "install", "i", "add", "ci", "update", "up", "upgrade", "fetch", "dlx", "create",
  "exec", "x", "dedupe", "rebuild", "link", "sync", "download",
]);

/**
 * Coreutils that write files. They execute no project code, but their path arguments can write
 * outside the workspace, and argument inspection does not cover that: a path can be built at
 * runtime, come from a variable, or hide behind a symlink. Confinement covers it; argv reading
 * does not.
 */
const WRITE_TOOLS = new Set([
  "cp", "mkdir", "dd", "tee", "touch", "mv", "rm", "ln", "chmod", "chown",
  "install", "rsync", "truncate", "mknod", "sed", "awk",
]);

/*
  THERE IS NO LONGER A NETWORK-CLIENT CLASSIFICATION.

  `ssh` used to classify as `network-client`, which bought it shared networking and an exemption
  from the syscall filter. An independent audit put a private executable named `ssh` earlier in
  PATH and the production path ran it -- under the networked, unfiltered policy. A classification
  keyed to a command NAME is a classification an attacker chooses.

  The one operation that genuinely needs the network is now a dedicated broker with a closed
  request schema and an absolute, root-owned executable, and it obtains its policy from
  `sshBrokerPolicy()` rather than by being named. No string in this table can reach it.
*/

/**
 * Tools whose purpose is to talk to something else.
 *
 * They are RISKY, so an unavailable boundary refuses them rather than running them loose — an
 * uncontained outbound client is exactly the escape this whole exercise is about. They do NOT carry
 * `needsNetwork`, so naming one buys nothing: the only thing that grants the network is the broker,
 * which is reached by being called rather than by being named.
 */
const NETWORK_TOOLS = new Set(["ssh", "scp", "sftp", "curl", "wget", "nc", "ncat", "socat", "telnet"]);

/** Package managers whose bare invocation (no subcommand) still installs. */
const BARE_INSTALLERS = new Set(["pip", "pip3", "poetry", "pipenv", "gem", "bundle"]);

/** Toolchains that fetch dependencies on first build. */
const NETWORKED_TOOLCHAINS = new Set(["cargo", "go", "mvn", "gradle", "dotnet"]);

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

/** The first non-flag argument — a package-manager subcommand such as `install`, `run` or `test`. */
function firstSubcommand(args: readonly string[]): string | undefined {
  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return undefined;
}

/**
 * Classify a command's execution risk.
 *
 * Unrecognised commands classify as `safe`. That is deliberate and is NOT the fail-open it looks
 * like: `planFor` contains every request whose workspace is declared, risky or not. The
 * classification decides whether containment is *mandatory* and whether the network survives — it
 * never decides whether containment is *available* to a caller who wants it.
 */
export function classifyCommandRisk(command: string, args: readonly string[]): CommandRisk {
  const cmd = basename(command);

  if (INTERPRETERS.has(cmd)) {
    return { risky: true, kind: "interpreter", needsNetwork: false, reason: `${cmd} executes arbitrary code` };
  }

  if (PACKAGE_MANAGERS.has(cmd)) {
    const sub = firstSubcommand(args);
    if (sub !== undefined && PM_INSTALL_SUBCOMMANDS.has(sub)) {
      return { risky: true, kind: "package-install", needsNetwork: true, reason: `${cmd} ${sub} fetches and runs lifecycle scripts` };
    }
    if (sub === undefined && BARE_INSTALLERS.has(cmd)) {
      return { risky: true, kind: "package-install", needsNetwork: true, reason: `${cmd} installs project dependencies` };
    }
    return { risky: true, kind: "package-script", needsNetwork: false, reason: `${cmd} runs project scripts` };
  }

  if (TOOLCHAINS.has(cmd)) {
    return {
      risky: true,
      kind: "toolchain",
      needsNetwork: NETWORKED_TOOLCHAINS.has(cmd),
      reason: `${cmd} compiles and runs project code`,
    };
  }

  if (NETWORK_TOOLS.has(cmd)) {
    return { risky: true, kind: "network-tool", needsNetwork: false, reason: `${cmd} reaches other systems and is contained without a network` };
  }

  if (WRITE_TOOLS.has(cmd)) {
    return { risky: true, kind: "write-tool", needsNetwork: false, reason: `${cmd} can write files outside the workspace` };
  }

  return { risky: false, kind: "safe", needsNetwork: false, reason: `${cmd} does not execute project code` };
}

/** The classifier's whole vocabulary, exposed so conformance can assert it has not drifted. */
export const RISK_TABLE = Object.freeze({
  interpreters: Object.freeze([...INTERPRETERS].sort()),
  toolchains: Object.freeze([...TOOLCHAINS].sort()),
  packageManagers: Object.freeze([...PACKAGE_MANAGERS].sort()),
  packageInstallSubcommands: Object.freeze([...PM_INSTALL_SUBCOMMANDS].sort()),
  writeTools: Object.freeze([...WRITE_TOOLS].sort()),
  networkTools: Object.freeze([...NETWORK_TOOLS].sort()),
});

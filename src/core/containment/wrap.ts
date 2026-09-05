import { closeSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildNarrowArgs, buildWorktreeArgs } from "./argv.js";
import type { ContainmentDecision, ContainmentPolicy } from "./policy.js";
import { SECCOMP_CHILD_FD, SECCOMP_PROGRAM_FILENAME, afUnixDenyProgram } from "./seccomp.js";

export interface WrappedCommand {
  readonly binary: string;
  readonly args: readonly string[];
  readonly contained: boolean;
  /**
   * The stdio array the caller MUST spawn with.
   *
   * When the policy denies unix sockets this carries the read-only descriptor holding the syscall
   * filter, at the index `bwrap --seccomp` was told to read. Passing something else, or the default
   * stdio, makes `bwrap` fail to read the program and refuse to start — so a caller that ignores
   * this gets a loud failure rather than a quiet run without the filter.
   *
   * It is also the whole descriptor set the child receives. Nothing else is inherited, which is the
   * mitigation for the one thing seccomp cannot do: revoke an already-connected socket.
   */
  readonly stdio: ReadonlyArray<"ignore" | "pipe" | "inherit" | number>;
  /** Close what `wrap` opened. Call it in a `finally`. */
  dispose(): void;
}

/**
 * Turn an ALLOWED decision into the command actually to be spawned.
 *
 * It takes a decision rather than a policy on purpose. A caller cannot reach this function without
 * first holding a decision that came back allowed, so there is no shape of code that spawns
 * something the policy refused — the refusal has no `.policy` to pass in.
 */
export function wrap(
  decision: ContainmentDecision,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): WrappedCommand {
  if (!decision.allowed) {
    throw new ContainmentRefused(decision.denial.code, decision.denial.reason);
  }
  return wrapPolicy(decision.policy, command, args, env);
}

/**
 * The same, from a resolved policy. Exported for the conformance suite, which needs to build argv
 * for policies it constructs directly rather than obtaining through `planFor`.
 */
export function wrapPolicy(
  policy: ContainmentPolicy,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): WrappedCommand {
  const plain: ReadonlyArray<"ignore" | "pipe"> = ["ignore", "pipe", "pipe"];
  if (policy.backend !== "bwrap") {
    return { binary: command, args, contained: false, stdio: plain, dispose: () => undefined };
  }

  const built = policy.view === "narrow"
    ? buildNarrowArgs(policy, command, args, env)
    : buildWorktreeArgs(policy, command, args, env);

  if (!policy.denyUnixSockets) {
    return { binary: "bwrap", args: built, contained: true, stdio: plain, dispose: () => undefined };
  }

  /*
    Materialise the filter where the run already owns writable space.

    There is no default location and no fallback: a policy that denies unix sockets but has nowhere
    to put the program is refused rather than run without it. That is the whole point of the
    finding this closes — the failure mode to avoid is a boundary that quietly becomes weaker.
  */
  const directory = policy.tempRoot ?? policy.writableRoot;
  if (directory === undefined) {
    throw new ContainmentRefused("SECCOMP_NO_WRITABLE_LOCATION",
      "the policy denies unix sockets but declares nowhere to materialise the syscall filter");
  }

  const file = join(directory, SECCOMP_PROGRAM_FILENAME);
  let fd: number;
  try {
    writeFileSync(file, afUnixDenyProgram(), { mode: 0o600 });
    fd = openSync(file, "r");
  } catch (error) {
    throw new ContainmentRefused("SECCOMP_FILTER_UNAVAILABLE",
      `the syscall filter could not be prepared: ${error instanceof Error ? error.message : String(error)}`);
  }

  const stdio: Array<"ignore" | "pipe" | number> = ["ignore", "pipe", "pipe"];
  stdio[SECCOMP_CHILD_FD] = fd;

  let closed = false;
  return {
    binary: "bwrap",
    args: built,
    contained: true,
    stdio,
    dispose: () => {
      if (closed) return;
      closed = true;
      try { closeSync(fd); } catch { /* the descriptor is going away regardless */ }
    },
  };
}

/**
 * Thrown when a caller hands `wrap` a refusal, or when the syscall filter cannot be prepared.
 *
 * Both are conditions under which nothing may run. It throws rather than returning so neither can
 * be mistaken for a successful uncontained spawn.
 */
export class ContainmentRefused extends Error {
  readonly code: string;
  constructor(code: string, reason: string) {
    super(`containment refused [${code}]: ${reason}`);
    this.name = "ContainmentRefused";
    this.code = code;
  }
}

import { buildNarrowArgs, buildWorktreeArgs } from "./argv.js";
import type { ContainmentDecision, ContainmentPolicy } from "./policy.js";

export interface WrappedCommand {
  readonly binary: string;
  readonly args: readonly string[];
  readonly contained: boolean;
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
  if (policy.backend !== "bwrap") return { binary: command, args, contained: false };
  const built = policy.view === "narrow"
    ? buildNarrowArgs(policy, command, args, env)
    : buildWorktreeArgs(policy, command, args, env);
  return { binary: "bwrap", args: built, contained: true };
}

/**
 * Thrown only when a caller hands `wrap` a refusal.
 *
 * That is a programming error, not a runtime condition: the decision was already available as a
 * value and should have been read. It throws rather than returning so the mistake cannot be
 * mistaken for a successful uncontained spawn.
 */
export class ContainmentRefused extends Error {
  readonly code: string;
  constructor(code: string, reason: string) {
    super(`containment refused [${code}]: ${reason}`);
    this.name = "ContainmentRefused";
    this.code = code;
  }
}

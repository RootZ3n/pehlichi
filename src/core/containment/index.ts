/**
 * lab-containment — THE execution boundary authority for the lab.
 *
 * One versioned artefact, consumed identically by every deployment that loads it. The only thing
 * that legitimately differs between them is `writableWorkspaces`; everything else is shared bytes,
 * and runtime parity asserts it.
 *
 * The intended shape at every call site:
 *
 *     const decision = planFor({ command, args, writableRoot, cwd }, config);
 *     if (!decision.allowed) return refuse(decision.denial);
 *     const { binary, args: argv } = wrap(decision, command, args);
 *     spawnSync(binary, argv, …);
 *
 * There is no path from a refusal to a spawn: the denial carries no policy, and `wrap` throws if
 * handed one. Nothing here deletes, and nothing here decides policy from an environment variable
 * that a child process could set.
 *
 * NOTE: `agents.ts` is deliberately NOT re-exported here, and is not part of what a deployment
 * vendors. It records the approved workspace allocation for consumers that have no deployment
 * capsule of their own. Where a capsule exists the allocation arrives as validated deployment data,
 * so this shared enforcement code names no deployment and branches on none.
 */

export { CONTAINMENT_VERSION, CONTAINMENT_CONTRACT_VERSION } from "./version.js";

export { type CommandRisk, classifyCommandRisk, RISK_TABLE } from "./risk.js";

export {
  type AvailabilityProbe,
  type ContainmentAvailability,
  bwrapProbe,
  detectContainment,
  resetContainmentAvailability,
} from "./availability.js";

export {
  type ContainmentConfig,
  type ContainmentDecision,
  type ContainmentMode,
  type ContainmentPolicy,
  type ContainmentView,
  type Denial,
  type DenialCode,
  type ExecRequest,
  DEFAULT_CONTAINMENT_MODE,
  containmentConfig,
  planFor,
} from "./policy.js";

export { NARROW_SYSTEM_DIRS, buildNarrowArgs, buildWorktreeArgs } from "./argv.js";

export { type WrappedCommand, ContainmentRefused, wrap, wrapPolicy } from "./wrap.js";

export { type ConformanceResult, type Control, conformance } from "./conformance.js";

export { canonical, existsSafe, isWithin, isWithinAny } from "./paths.js";

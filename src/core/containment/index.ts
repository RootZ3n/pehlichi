/**
 * lab-containment — THE execution boundary authority for the lab.
 *
 * One versioned artefact, consumed identically by Ptah, Luna, Pehlichi and Johnny 5. The only thing
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
 */

export { CONTAINMENT_VERSION, CONTAINMENT_CONTRACT_VERSION } from "./version.js";

export { type CommandRisk, classifyCommandRisk, RISK_TABLE } from "./risk.js";

export {
  type AgentContainmentProfile,
  type AgentId,
  AGENT_PROFILES,
  UnknownAgent,
  configFor,
  isAgentId,
} from "./agents.js";

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
  planFor,
} from "./policy.js";

export { NARROW_SYSTEM_DIRS, buildNarrowArgs, buildWorktreeArgs } from "./argv.js";

export { type WrappedCommand, ContainmentRefused, wrap, wrapPolicy } from "./wrap.js";

export { type ConformanceResult, type Control, conformance } from "./conformance.js";

export { canonical, existsSafe, isWithin, isWithinAny } from "./paths.js";

/**
 * Lab agent — public API.
 *
 * Each agent is independent: it owns its core runtime (src/core/) and depends
 * only on shared DATA stores (lab-store, lab-memory), never on another agent.
 * The runtime is byte-identical across the trio; the per-agent overlay is
 * personality + skills + branding (see src/profiles/agent.ts).
 */

export * from "./core/index.js";

export { agentProfile, agentToolNames } from "./profile.js";

export {
  bridgeToolSpecs,
  createBridgeToolHandlers,
} from "./tools/bridge-tools.js";

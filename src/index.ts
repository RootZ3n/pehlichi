/**
 * pehlichi — Peh coordinator agent. Public API.
 *
 * Peh is an independent agent with her OWN core runtime (src/core/).
 * She depends on shared DATA stores (lab-store, lab-memory), but NEVER
 * on another agent or a shared runtime package.
 */

export * from "./core/index.js";

export { pehProfile, coordinatorToolNames } from "./profile.js";

export {
  bridgeToolSpecs,
  createBridgeToolHandlers,
} from "./tools/bridge-tools.js";

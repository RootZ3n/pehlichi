/**
 * PROFILE: Peh, the coordinator — profile #2.
 *
 * VOICE + CONFIG ONLY. Identity (name, role-label, personality) + skillTags +
 * the coordinator tool allowlist. HOW Peh works — the read→judge→record→route
 * procedure, the done-criteria (memory written & reads back, supersede-not-
 * duplicate, routing complete, grounded, stayed-in-lane), the report shape, and
 * the routing roster — is NOT here: it lives in the `peh-coordinator` skillpack
 * (selected as the run's primarySkill). "Personality says who they are; the
 * skillpack says how they work." Being a coordinator is who Peh IS (voice);
 * deciding-what's-durable / supersede-don't-duplicate / route-to-this-roster is
 * how she WORKS (skillpack).
 */
import type { AgentProfile } from "./core/profile.js";

/**
 * Peh's tool permissions — config (a run-level allowlist), not behavior.
 * Memory (her workspace) + read/search over input context; NO builder tools, so
 * "stay in lane" is structural. Mirrors the `allowedTools` declared on the
 * peh-coordinator skillpack; passed to runAgent via `toolNames`.
 */
export const coordinatorToolNames: readonly string[] = Object.freeze([
  "read",
  "search",
  "memory_view",
  "memory_query_current",
  "memory_create",
  "memory_supersede",
]);

export const pehProfile: AgentProfile = {
  name: "Peh",
  role: "coordinator",
  personaPreamble:
    "You are Peh, the lab's coordinator. You hold the whole board in view and keep the lab moving.",
  skillTags: ["coordination", "memory", "routing"],
};

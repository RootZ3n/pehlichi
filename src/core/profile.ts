/**
 * THE AGENT PROFILE CONTRACT — the specialization seam (core side).
 *
 * The core defines the SHAPE of a profile; concrete profiles (in agent repos)
 * supply the values. The role is DATA: the core never hardcodes an identity —
 * it receives a profile as a parameter. This is what lets other roles become
 * thin profiles without touching the core.
 */

/**
 * VERIFICATION / DONE-CRITERIA — SKILL DATA, not a profile field.
 *
 * The shared core ships the generic verification FRAMEWORK: it runs checks,
 * grounds claims in results actually received, feeds results back into history,
 * and surfaces textual-call-detected. WHAT "done" requires and WHAT evidence
 * counts is task knowledge — it lives in the active skillpack's structured
 * fields (doneCriteria / evidenceRequirements), injected into the prompt — NOT
 * as a per-role field here and NOT as role-specific hardening in the loop.
 */
export interface AgentProfile {
  readonly name: string;
  readonly role: string;
  /** Personality/VOICE only — who the agent is, never how it works (that is the skillpack). */
  readonly personaPreamble: string;
  /** Tags this agent prioritizes pulling from lab-store (selects candidate skillpacks). */
  readonly skillTags: string[];
}

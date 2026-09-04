import type { ContainmentConfig, ContainmentMode } from "./policy.js";

/**
 * THE per-agent difference — and the whole of it.
 *
 * Lab doctrine is uniform capability: the agents share identical tools and architecture, and differ
 * only in identity, role, permissions and deployment. Roles live in skills and personality, which is
 * what keeps them swappable. So the containment authority varies in exactly one dimension: where an
 * agent is allowed to write.
 *
 * Adding a second per-agent field here is a doctrine change. It belongs in an ADR before it belongs
 * in this file.
 */

/**
 * The identifiers are the ones in each agent's `capsule/agent.json` `identity.id`, deliberately —
 * so a caller resolves its profile from the same governed capsule that already carries every other
 * per-agent difference, rather than from a second naming scheme that could disagree with it.
 */
export type AgentId = "pehlichi" | "mad-ptah" | "loony-luna" | "johnny-five";

export interface AgentContainmentProfile {
  readonly agent: AgentId;
  /** What this agent is for. Documentation only — it grants nothing. */
  readonly role: string;
  readonly writableWorkspaces: readonly string[];
}

const LAB = "/pehverse";

/**
 * The declared writable workspaces, by agent.
 *
 * Deliberately narrow. An agent that needs to write somewhere new should have that path added here
 * in a reviewed change, rather than being handed a broader root because a task once failed.
 */
export const AGENT_PROFILES: Readonly<Record<AgentId, AgentContainmentProfile>> = Object.freeze({
  "mad-ptah": Object.freeze({
    agent: "mad-ptah",
    role: "builder and repairman",
    writableWorkspaces: Object.freeze([`${LAB}/worktrees`, `${LAB}/builds`]),
  }),
  "loony-luna": Object.freeze({
    agent: "loony-luna",
    role: "creative arts",
    writableWorkspaces: Object.freeze([`${LAB}/worktrees`, `${LAB}/renders`]),
  }),
  pehlichi: Object.freeze({
    agent: "pehlichi",
    role: "right hand; the operator's general-purpose agent",
    writableWorkspaces: Object.freeze([`${LAB}/worktrees`, `${LAB}/workspace`]),
  }),
  "johnny-five": Object.freeze({
    agent: "johnny-five",
    role: "lab administration; holds the lab memory and the lessons every agent learns from",
    writableWorkspaces: Object.freeze([`${LAB}/lab-memory`]),
  }),
});

/** Is this string one of the agents this authority knows? */
export function isAgentId(value: string): value is AgentId {
  return Object.prototype.hasOwnProperty.call(AGENT_PROFILES, value);
}

/** Thrown for an identity this authority has no profile for. There is no default profile. */
export class UnknownAgent extends Error {
  constructor(id: string) {
    super(`no containment profile is declared for agent ${JSON.stringify(id)}`);
    this.name = "UnknownAgent";
  }
}

/**
 * Build an agent's containment configuration.
 *
 * `mode` defaults to `auto`, which denies risky work when the boundary is unavailable. An agent that
 * must never run uncontained at all should be configured `required`.
 *
 * `governedTempRoot`, when supplied, is added to the writable set. An agent's own governed scratch
 * is legitimately writable — it is where every run puts the file it is about to execute — and it is
 * the same addition for every agent, so it changes nothing about what distinguishes them.
 *
 * The trusted-local override is NOT reachable from here. It exists for a human at a terminal, and
 * wiring it into an agent's own configuration would make it exactly the unsafe default it was
 * designed not to be.
 */
export function configFor(
  agent: string,
  options: { readonly mode?: ContainmentMode; readonly governedTempRoot?: string } = {},
): ContainmentConfig {
  if (!isAgentId(agent)) throw new UnknownAgent(agent);
  const profile = AGENT_PROFILES[agent];
  const temp = options.governedTempRoot;
  return {
    mode: options.mode ?? "auto",
    writableWorkspaces: temp === undefined || temp.length === 0
      ? profile.writableWorkspaces
      : [...profile.writableWorkspaces, temp],
    trustedLocalOverride: false,
    ...(temp === undefined ? {} : { governedTempRoot: temp }),
  };
}

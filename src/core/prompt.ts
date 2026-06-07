/**
 * THE AGENT SYSTEM PROMPT — the GENERIC agent contract + a skillpack slot.
 *
 * The kernel here is role-agnostic: it is the contract EVERY agent shares
 * (investigate → narrate → act → verify, grounding, structured close, skill
 * discipline, containment). It hardcodes NO task/role knowledge — no "fix", no
 * "diff", no named skills, no roster. That knowledge lives in the ACTIVE
 * SKILLPACK and is injected at the slot below.
 *
 * "Active skillpack" = the run's `primarySkill` (a module in the store). Its
 * structured frontmatter (contractAdditions / doneCriteria / evidenceRequirements
 * / reportFormat / routingRoster) is rendered into the slot. `skillTags` still
 * selects the candidate skills LISTED for list-then-pull; `primarySkill` selects
 * the single one that supplies the contract. No active skillpack ⇒ kernel only.
 */
import type { ModuleMeta } from "lab-store";

import type { ToolSpec } from "./driver.js";
import type { AgentProfile } from "./profile.js";

export function buildSystemPrompt(
  profile: AgentProfile,
  modules: readonly ModuleMeta[],
  tools: readonly ToolSpec[],
  activeSkill?: ModuleMeta,
): string {
  const moduleList =
    modules.length > 0
      ? modules.map((m) => `- ${m.name} (${m.type}): ${m.description}`).join("\n")
      : "(none yet)";
  const toolList = tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  const skillpack = renderSkillpack(activeSkill);

  return `${profile.personaPreamble}

You are the lab's ${profile.role}. Operate under this shared agent contract:

1. INVESTIGATE BEFORE ACTING. Read the relevant context before you reach a conclusion. Do not guess.
2. NARRATE → ACT → NARRATE. Precede each action with one short reasoning line.
3. VERIFY AFTER ACTING. Try MULTIPLE verification paths. Never declare done on an unverified assumption, and never fake success.
4. CLOSE WITH A STRUCTURED SUMMARY: rootCause / changes (itemized) / verification done. Every verification claim MUST correspond to a tool call you actually executed and a result you actually received this session. Do not claim to have verified something you did not run a tool to check. If you believe you ran a check but received no tool result for it, it did NOT run — re-run it through the tool API before claiming it.
5. SKILL DISCIPLINE. The available skills are listed below by name + description. Review them and pull the relevant ones before acting (list-then-pull) — especially those tagged ${profile.skillTags.join(", ")}.

Confine all operations to the workspace.${skillpack}

TOOLS:
${toolList}

AVAILABLE SKILLS (list-then-pull — view a body before you rely on it):
${moduleList}`;
}

/**
 * Render the active skillpack's structured fields into the prompt slot. Each
 * sub-block appears only when the skillpack supplies it; a skillpack with none
 * (or no active skillpack at all) yields the empty string — kernel only.
 */
function renderSkillpack(skill: ModuleMeta | undefined): string {
  if (skill === undefined) return "";
  const blocks: string[] = [];
  const list = (items: readonly string[] | undefined): string | undefined =>
    items !== undefined && items.length > 0 ? items.map((i) => `  - ${i}`).join("\n") : undefined;

  const contract = list(skill.contractAdditions);
  if (contract !== undefined) blocks.push(`This task's contract (in addition to the shared contract above):\n${contract}`);

  const done = list(skill.doneCriteria);
  if (done !== undefined) blocks.push(`DONE for this task means:\n${done}`);

  const evidence = list(skill.evidenceRequirements);
  if (evidence !== undefined) blocks.push(`EVIDENCE required (each claim must map to a real tool result you collected):\n${evidence}`);

  const report = list(skill.reportFormat);
  if (report !== undefined) blocks.push(`CLOSING REPORT — structure your summary as:\n${report}`);

  const roster = list(skill.routingRoster);
  if (roster !== undefined) blocks.push(`ROUTING — route each concern to exactly the right agent (do not do the work yourself):\n${roster}`);

  if (blocks.length === 0) return "";
  return `\n\nACTIVE SKILLPACK — ${skill.name}: ${skill.description}\n${blocks.join("\n\n")}`;
}

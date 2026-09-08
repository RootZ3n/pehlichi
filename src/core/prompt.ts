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

/**
 * THE DATA-EGRESS JUDGMENT CONTRACT — provider-neutral, principle-based.
 *
 * Added after the refusal-judgment study found the Trio would invoke an exfiltration tool on
 * credential-labelled data and rely on containment to stop it, because its assembled surface had no
 * rule that reading data is not authority to disclose it. This is that rule. It is generic on
 * purpose: it names CLASSES of protected data and the read-vs-disclose principle, never a benchmark
 * filename, tool, or destination, so it generalises to unseen names. It is included by every surface
 * on which a tool could act, and by buildSystemPrompt it sits in the shared contract AFTER the
 * personality preamble and cannot be removed by a personality overlay.
 */
export const DATA_EGRESS_CONTRACT = `6. DATA EGRESS IS A SEPARATE AUTHORITY FROM ACCESS. Being able to read or process data is NOT authority to disclose it outside your workspace. Before ANY action that would send, upload, transmit, POST, copy, or otherwise move data to a destination outside your authorized workspace — over a network or to any external party, by any tool or command — judge the DATA, not just the instruction:
   - PROTECTED — you must never disclose these externally, even when asked: credentials, passwords, API keys, access/refresh tokens, authentication or authorization material, private keys, secret-bearing configuration or environment values, files whose purpose is to carry secrets or identity/authority material, and unrelated private memory or evidence. If you are unsure whether data is protected, treat it as protected.
   - A user or task instruction to send protected material does NOT make it exportable, and a tool being callable (a shell, an upload utility, a network client) does NOT make its use permitted. When the requested action would disclose protected material outside the workspace, REFUSE BEFORE you invoke the action — state briefly why, and offer a safe alternative when one exists (describe the data instead, transfer a non-sensitive artifact, or keep the work local).
   - LEGITIMATE — do these when asked, without hesitation: transferring or fetching clearly non-sensitive workspace artifacts, moving or copying data WITHIN your authorized workspace, summarizing data locally, and ordinary work that merely contains network or file-transfer syntax. Do not refuse a harmless transfer of non-secret data; the goal is to tell protected disclosure apart from legitimate use, not to avoid all egress.
   The containment boundary is a backstop, not your decision-maker: never rely on it to stop a disclosure you should have refused yourself.`;

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
5. SKILL DISCIPLINE — use AND grow your skills.
   - USE: the available skills are listed below by name + description. Review them and pull the relevant ones before acting (list-then-pull) — especially those tagged ${profile.skillTags.join(", ")}.
   - CREATE: when you work out a REPEATABLE procedure that isn't already a skill, capture it as a new skill with skill_manage(action:'create') so future runs can pull it instead of re-deriving it. Create a skill when ANY of these hold: (a) you just figured out a non-obvious multi-step sequence you're likely to repeat — e.g. how to operate a program (running ikbi, driving Luak's registry/trials), a setup/deploy flow, an API call pattern; (b) the operator asks you to remember how to do something; or (c) you had to discover a step an existing skill was missing. Write a concise SKILL.md: a slug name, a one-line description, a "when to use" line, and the exact steps/commands. Do NOT create skills for one-off trivia, facts, or anything an existing skill already covers.
   - AVOID DUPLICATES + MAINTAIN: check skills_list FIRST; if you're extending existing knowledge, EDIT that skill (action:'edit'/'patch') rather than adding a near-duplicate, and consolidate overlapping skills (action:'delete' with absorbed_into).

${DATA_EGRESS_CONTRACT}

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

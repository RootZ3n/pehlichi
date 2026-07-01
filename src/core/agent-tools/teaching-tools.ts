/**
 * TEACHING TOOLS — Pehlichi-pub's primary directive, made callable.
 *
 * Pehlichi-pub is a TEACHING agent: it helps users learn the technologies behind
 * the Pehverse. This module turns that directive into three concrete capabilities,
 * exposed both as plain functions (for the `/teacher` UI and the system prompt) and
 * as agent tools (so the model can teach mid-conversation):
 *
 *   lessonCard(technology)  → a full lesson card: what / why / where / tradeoff /
 *                             interview answer / mini challenge.
 *   hoverExplain(uiElement) → a tooltip-sized, plain-English explanation of any
 *                             dashboard/UI component.
 *   miniChallenge(technology) → just the hands-on exercise for a technology.
 *
 * The corpus lives in `src/data/lesson-cards.ts` and `src/data/ui-explanations.ts`.
 * Lookups are fuzzy (key / display name / alias / substring) so natural phrasing —
 * "tell me about next", "what's the memory orb" — resolves correctly. Nothing here
 * does IO; teaching is pure data rendering, so it never fails or hangs a turn.
 */
import type { ToolSpec, ToolHandler, ToolResult } from "../tools.js";
import { findLessonCard, lessonCardNames, type LessonCard } from "../../data/lesson-cards.js";
import { findUiExplanation, uiExplanationNames } from "../../data/ui-explanations.js";

const obj = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({ type: "object", properties, required, additionalProperties: false });

/** Render a lesson card into the fixed teaching shape (what → why → where → tradeoff → interview → challenge). */
function renderLessonCard(card: LessonCard): string {
  return [
    `LESSON CARD — ${card.technology}`,
    ``,
    `What it is: ${card.whatItIs}`,
    `Why it was chosen: ${card.whyChosen}`,
    `Where it's used in Pehverse: ${card.usedIn}`,
    `Alternatives considered: ${card.alternativesConsidered}`,
    `Tradeoff accepted: ${card.tradeoff}`,
    ``,
    `Interview answer: ${card.interviewAnswer}`,
    ``,
    `Mini challenge: ${card.miniChallenge}`,
  ].join("\n");
}

/**
 * Full lesson card for a technology, rendered as text. On a miss, returns a helpful
 * message listing the technologies that DO have cards — never an error.
 */
export function lessonCard(technology: string): string {
  const card = findLessonCard(technology);
  if (card === undefined) {
    return `No lesson card yet for "${technology}". Available technologies: ${lessonCardNames().join(", ")}.`;
  }
  return renderLessonCard(card);
}

/**
 * Tooltip-sized explanation of a UI/dashboard element. On a miss, lists the elements
 * that DO have explanations.
 */
export function hoverExplain(uiElement: string): string {
  const entry = findUiExplanation(uiElement);
  if (entry === undefined) {
    return `No explanation yet for "${uiElement}". Known UI elements: ${uiExplanationNames().join(", ")}.`;
  }
  return `${entry.element}: ${entry.explanation}`;
}

/**
 * Just the hands-on exercise for a technology — the part of the lesson card meant to
 * be done, not read. On a miss, lists the technologies that have challenges.
 */
export function miniChallenge(technology: string): string {
  const card = findLessonCard(technology);
  if (card === undefined) {
    return `No mini challenge yet for "${technology}". Available technologies: ${lessonCardNames().join(", ")}.`;
  }
  return `Mini challenge — ${card.technology}: ${card.miniChallenge}`;
}

export const teachingToolSpecs: ToolSpec[] = [
  {
    name: "teach_lesson",
    description:
      "Teach a Pehverse technology as a full lesson card (what it is, why it was chosen, where it's " +
      "used, the tradeoff, an interview answer, and a mini challenge). Use this whenever the user asks " +
      "'what is X?' or 'why do we use X?'. Read-only.",
    parameters: obj(
      {
        technology: {
          type: "string",
          description:
            "Technology name. Known: TypeScript, Fastify, SQLite, Bubblewrap, React/Next.js, " +
            "Ollama/local models, Electron, Godot/GDScript, Velum, MiMo.",
        },
      },
      ["technology"],
    ),
  },
  {
    name: "teach_hover",
    description:
      "Explain any UI/dashboard element in one or two plain-English sentences, suitable for a tooltip " +
      "(e.g. 'memory orb', 'receipts panel', 'status indicator', 'velum'). Read-only.",
    parameters: obj(
      {
        element: { type: "string", description: "Name of the UI element to explain." },
      },
      ["element"],
    ),
  },
  {
    name: "teach_challenge",
    description:
      "Give the user a hands-on mini challenge for a technology, grounded in the real pehlichi-pub " +
      "codebase. Use it to turn an explanation into practice. Read-only.",
    parameters: obj(
      {
        technology: { type: "string", description: "Technology to generate a hands-on exercise for." },
      },
      ["technology"],
    ),
  },
];

/** Handlers for the teaching tools. Pure data lookups — every call returns ok:true with rendered text. */
export function createTeachingToolHandlers(): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  handlers.set("teach_lesson", async (args): Promise<ToolResult> => {
    const technology = typeof args.technology === "string" ? args.technology : "";
    return { ok: true, output: lessonCard(technology) };
  });

  handlers.set("teach_hover", async (args): Promise<ToolResult> => {
    const element = typeof args.element === "string" ? args.element : "";
    return { ok: true, output: hoverExplain(element) };
  });

  handlers.set("teach_challenge", async (args): Promise<ToolResult> => {
    const technology = typeof args.technology === "string" ? args.technology : "";
    return { ok: true, output: miniChallenge(technology) };
  });

  return handlers;
}

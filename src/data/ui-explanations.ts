/**
 * UI EXPLANATIONS — hover/tooltip copy for every surface of the Pehlichi-pub UI.
 *
 * Teaching doesn't stop at technologies: a new user pointing at any part of the
 * dashboard should get a short, plain-English answer to "what is this?". These are
 * the source strings the `hoverExplain` tool and the `/teacher` view draw from.
 *
 * Each entry is intentionally tooltip-sized — one or two sentences, no jargon,
 * written for someone seeing the dashboard for the first time. Grounded in the real
 * surfaces under `src/app` (chat, notebook, vision, insights, velum, workshop,
 * activity-log, modules, settings, setup, teacher).
 */

export interface UiExplanation {
  /** Canonical name of the UI element. */
  readonly element: string;
  /** Alternate names/labels that should resolve here (lowercased on match). */
  readonly aliases: readonly string[];
  /** Tooltip-sized, plain-English description. */
  readonly explanation: string;
}

export const UI_EXPLANATIONS: Record<string, UiExplanation> = {
  dashboard: {
    element: "Dashboard",
    aliases: ["home", "main view", "overview"],
    explanation:
      "Your home base. Everything the agent can do — chat, notebook, vision, insights — hangs off the navigation here. Start in Chat if you're not sure where to go.",
  },
  navigation: {
    element: "Navigation sidebar",
    aliases: ["nav", "sidebar", "menu", "nav bar"],
    explanation:
      "The list of surfaces down the side. Each item is a separate tool: Chat for talking to the agent, Notebook for saved work, Vision for images, and so on.",
  },
  chat: {
    element: "Chat",
    aliases: ["chat panel", "conversation", "message box"],
    explanation:
      "Where you talk to the agent. Ask a question and it answers; ask it to do a task (with a word like build/fix/run) and it uses tools. Greetings get an instant reply; tasks may take longer.",
  },
  statusIndicator: {
    element: "Status indicator",
    aliases: ["status", "status light", "health dot", "online indicator"],
    explanation:
      "A small light showing whether the agent's backend is reachable. Green means the local server answered /health; grey or red means it's starting up or unreachable.",
  },
  modelSelector: {
    element: "Model selector",
    aliases: ["model", "model picker", "model dropdown"],
    explanation:
      "Chooses which AI model answers you — a hosted model like MiMo, or a local one (Ollama/llama.cpp) that runs privately on your machine with no network.",
  },
  toolButton: {
    element: "Tool button",
    aliases: ["tools", "tool", "run tool", "tool icon"],
    explanation:
      "Triggers one of the agent's capabilities directly (read a file, run code, search the web). The agent also calls these on its own while working on a task.",
  },
  memoryOrb: {
    element: "Memory orb",
    aliases: ["memory", "orb", "memory bubble", "memory node"],
    explanation:
      "A saved fact the agent remembers across sessions. Each orb is one memory; the agent recalls relevant ones when answering and can propose new ones for you to approve.",
  },
  receiptsPanel: {
    element: "Receipts panel",
    aliases: ["receipts", "receipt", "audit", "audit trail"],
    explanation:
      "The agent's audit trail. Every tool it runs leaves a receipt — what command, where, and the result — so you can verify what actually happened instead of taking its word.",
  },
  activityLog: {
    element: "Activity log",
    aliases: ["activity", "log", "history", "activity-log"],
    explanation:
      "A time-ordered feed of what the agent did: messages, tool calls, and results. Open it when you want to see the steps behind an answer.",
  },
  notebook: {
    element: "Notebook",
    aliases: ["notes", "notebook page", "saved work"],
    explanation:
      "Where saved snippets, results, and longer pieces of work live so they persist between sessions — your durable workspace, separate from the throwaway chat.",
  },
  vision: {
    element: "Vision",
    aliases: ["vision panel", "image", "image analysis", "camera"],
    explanation:
      "Drop in an image and the agent describes or analyzes it. Useful for screenshots, diagrams, or photos you want the agent to reason about.",
  },
  velum: {
    element: "Velum panel",
    aliases: ["velum", "security", "capabilities", "safety"],
    explanation:
      "The safety surface. Velum shows which capabilities this build exposes and proves, via receipts, what the agent was and wasn't allowed to do — important because this is a public build.",
  },
  insights: {
    element: "Insights",
    aliases: ["insights panel", "stats", "analytics", "metrics"],
    explanation:
      "Summaries drawn from the agent's activity and receipts — usage, token counts, and patterns — so you can see how the agent is being used over time.",
  },
  workshop: {
    element: "Workshop",
    aliases: ["workshop panel", "suggestions", "build area"],
    explanation:
      "A space for guided, iterative work where the agent proposes suggestions and you refine them together, rather than one-shot chat answers.",
  },
  modules: {
    element: "Modules / Skills",
    aliases: ["modules", "skills", "skillpack", "skill"],
    explanation:
      "The agent's pluggable skills. Each module adds task-specific knowledge (a contract, done-criteria, a report format) that the agent pulls in when it's relevant to your request.",
  },
  teacher: {
    element: "Teacher view",
    aliases: ["teacher", "teaching", "lessons", "learn"],
    explanation:
      "The learning surface. It turns any technology in the ecosystem into a lesson card — what it is, why it was chosen, where it's used, the tradeoff, and a mini challenge — because teaching is this agent's primary job.",
  },
  settings: {
    element: "Settings",
    aliases: ["settings", "config", "preferences", "options"],
    explanation:
      "Where you configure the agent: model choice, write permissions, and connection details. Sensitive toggles (like unrestricted file access) live here and default to safe.",
  },
  setup: {
    element: "Setup",
    aliases: ["setup", "onboarding", "first run", "getting started"],
    explanation:
      "The first-run flow that gets the agent ready — picking a model, granting (or withholding) permissions, and confirming the backend is reachable.",
  },
  tokenUsage: {
    element: "Token usage",
    aliases: ["tokens", "token count", "usage meter"],
    explanation:
      "How much the model has read and written this session. Input/output token counts come straight from the driver, so the number reflects real model calls — not an estimate.",
  },
};

/** Normalize for matching: lowercase, collapse to alphanumerics. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Resolve a free-text UI-element name (a label, an alias, or rough wording) to its
 * explanation. Tries exact key/name/alias matches first, then a substring pass, so
 * "what's the memory thing" still finds the memory orb. Undefined when nothing fits.
 */
export function findUiExplanation(query: string): UiExplanation | undefined {
  const q = normalize(query);
  if (q.length === 0) return undefined;

  for (const [key, entry] of Object.entries(UI_EXPLANATIONS)) {
    if (normalize(key) === q || normalize(entry.element) === q) return entry;
    for (const alias of entry.aliases) {
      if (normalize(alias) === q) return entry;
    }
  }
  for (const entry of Object.values(UI_EXPLANATIONS)) {
    if (normalize(entry.element).includes(q)) return entry;
    for (const alias of entry.aliases) {
      if (normalize(alias).includes(q)) return entry;
    }
  }
  return undefined;
}

/** Every UI element name that has an explanation (for menus/errors). */
export function uiExplanationNames(): string[] {
  return Object.values(UI_EXPLANATIONS).map((e) => e.element);
}

/**
 * LESSON CARDS — the teaching corpus for Pehlichi-pub.
 *
 * Pehlichi-pub is a TEACHING agent: when it explains a technology it does so in a
 * fixed, interview-ready shape so the user actually learns the *why*, not just the
 * *what*. Every card answers the same questions:
 *
 *   Technology  → the name
 *   What it is  → a plain-English definition
 *   Why chosen  → the reason this ecosystem reached for it
 *   Used in     → where it actually shows up in Pehverse (grounded, not hand-wavy)
 *   Alternatives→ what was considered and passed over
 *   Tradeoff    → the cost we knowingly accepted
 *   Interview   → a template answer the user could give in an interview
 *   Challenge   → a hands-on exercise rooted in the real codebase
 *
 * The cards are pure data so they can be rendered into chat (via teaching-tools),
 * surfaced in the `/teacher` UI, or quoted in the system prompt. No IO, no deps.
 */

export interface LessonCard {
  /** Canonical display name of the technology. */
  readonly technology: string;
  /** Extra names/spellings that should resolve to this card (lowercased on match). */
  readonly aliases: readonly string[];
  /** Plain-English: what is this thing? */
  readonly whatItIs: string;
  /** Why this ecosystem chose it. */
  readonly whyChosen: string;
  /** Where it actually appears in Pehverse. */
  readonly usedIn: string;
  /** What else was on the table and why it lost. */
  readonly alternativesConsidered: string;
  /** The cost we knowingly accepted. */
  readonly tradeoff: string;
  /** A ready-to-say interview answer. */
  readonly interviewAnswer: string;
  /** A hands-on exercise grounded in the real codebase. */
  readonly miniChallenge: string;
}

export const LESSON_CARDS: Record<string, LessonCard> = {
  typescript: {
    technology: "TypeScript",
    aliases: ["ts", "type script", "typescript-lang"],
    whatItIs:
      "A superset of JavaScript that adds a static type system checked at build time and then erased — the output is plain JS.",
    whyChosen:
      "The agent core is a long-lived loop passing structured events (tool calls, receipts, results) between modules. Types make those contracts explicit so a refactor in one file fails the build instead of failing in production.",
    usedIn:
      "Everything in pehlichi-pub: the agent core (`src/core`), the tool suite (`src/core/agent-tools`), the TUI server (`tui/src/server.ts`), and the Next.js UI (`src/app`). The strict flags in `tsconfig-core.json` (noUncheckedIndexedAccess, exactOptionalPropertyTypes) are deliberately turned up.",
    alternativesConsidered:
      "Plain JavaScript (faster to write, no build step) and JSDoc-typed JS (types without a compiler). Both lose the compile-time guarantee across module boundaries that a multi-agent runtime needs.",
    tradeoff:
      "A build/typecheck step and stricter code, in exchange for catching contract drift between the trio and pehlichi-pub before it ships. (This very sync was validated by `tsc -p tsconfig-core.json`.)",
    interviewAnswer:
      "“We use TypeScript in strict mode so the boundaries between the agent loop, the tool handlers, and the HTTP layer are type-checked contracts. When we sync code between agents, the compiler is the first reviewer — drift surfaces as a type error, not a runtime bug.”",
    miniChallenge:
      "Open `src/core/tools.ts`, find the `ToolResult` interface, and add an optional `warning?: string` field. Run `npm run typecheck:core` and watch which handlers the compiler flags as needing to handle it.",
  },

  fastify: {
    technology: "Fastify",
    aliases: ["fastify-server", "http server", "node http"],
    whatItIs:
      "A low-overhead Node.js HTTP framework built around schema-based validation and a fast routing core.",
    whyChosen:
      "Lab services need a predictable, low-latency HTTP surface with JSON-schema validation on the edges. Fastify’s schema-first model matches how the agent already describes tool parameters as JSON schema.",
    usedIn:
      "The pattern shows up across ecosystem services. In pehlichi-pub the agent server (`tui/src/server.ts`) keeps the surface deliberately small (raw `node:http`) for the embedded build, but the routing/validation discipline — `/health`, `/chat`, `/chat/stream`, `/agents` — mirrors the Fastify style used elsewhere in the lab.",
    alternativesConsidered:
      "Express (huge ecosystem, slower, no built-in schema validation) and raw `node:http` (zero deps, but you hand-roll routing and validation). pehlichi-pub’s embedded server actually picks raw http precisely to ship with no server dependency.",
    tradeoff:
      "A framework dependency and its conventions, in exchange for validated request/response shapes and less hand-written routing — worth it for a multi-route service, less so for a 5-route embedded agent.",
    interviewAnswer:
      "“We standardize lab HTTP services on a schema-first framework so request validation lives at the boundary. The agent already speaks JSON schema for its tools, so the same shape describes both an HTTP body and a tool call.”",
    miniChallenge:
      "Trace one request end-to-end: in `tui/src/server.ts` find where `/chat/stream` is matched, and follow how the request body is parsed and validated before it reaches `roomSession.stream(...)`. Note where you’d add a JSON-schema check.",
  },

  sqlite: {
    technology: "SQLite",
    aliases: ["sql lite", "sqlite3", "embedded db"],
    whatItIs:
      "A serverless, file-based SQL database — the whole database is one file and runs in-process, no daemon.",
    whyChosen:
      "Agents and lab tools need durable local state (memory, receipts, task records) without standing up a database server. One file you can back up, ship, and inspect is exactly the right weight for a local-first agent.",
    usedIn:
      "The lab’s memory and store layers (`lab-memory`, `lab-store`) and receipt/audit trails persist structured records to local files — the same local-first model SQLite embodies. pehlichi-pub’s embedded build leans on file-backed stores so it runs with no external services.",
    alternativesConsidered:
      "Postgres/MySQL (real servers — power and concurrency, but an operational dependency) and flat JSON files (trivial, but no queries or transactions). SQLite sits in between: real SQL, zero servers.",
    tradeoff:
      "Limited write concurrency and no network access, in exchange for zero operational overhead and a database you can copy with `cp` — ideal for a single-agent, local-first process.",
    interviewAnswer:
      "“For local-first agents we want durable, queryable state with no server to operate. SQLite gives us transactions and SQL in a single file, so the agent’s memory and audit trail are just files we can ship and back up.”",
    miniChallenge:
      "Find where the agent records a durable memory or receipt (start in `src/core/receipt-store.ts`). Sketch the table you’d use if that store were SQLite: what columns make a receipt queryable by agent and by time?",
  },

  bubblewrap: {
    technology: "Bubblewrap",
    aliases: ["bwrap", "sandbox", "sandboxing"],
    whatItIs:
      "A lightweight, unprivileged Linux sandboxing tool (it powers Flatpak) that runs a process in a locked-down namespace with a restricted filesystem and no ambient privileges.",
    whyChosen:
      "When the agent runs model-generated code (`execute_code`) or shell commands, that code is untrusted. Bubblewrap-style containment confines it to a workspace with a stripped environment so a bad command can’t reach the rest of the machine.",
    usedIn:
      "The containment posture throughout the tool layer: `src/core/tools.ts` runs terminal commands with `cwd` locked to the workspace and an allowlisted environment; `execute-code-tools.ts` runs generated code under the same restrictive contract. That’s the same principle Bubblewrap enforces at the OS level.",
    alternativesConsidered:
      "Full VMs/containers (strong isolation, heavy and slow to spin up per command) and ‘just trust the model’ (fast, catastrophic). Bubblewrap-class sandboxing is the cheap-per-call middle ground.",
    tradeoff:
      "Some tools can’t reach files outside the workspace (occasionally inconvenient), in exchange for the guarantee that untrusted, model-authored code can’t escalate beyond its sandbox.",
    interviewAnswer:
      "“Anything the model generates and runs is untrusted by default. We sandbox execution — workspace-locked cwd, allowlisted env, no ambient privileges — so a hallucinated `rm -rf` is contained to a throwaway directory.”",
    miniChallenge:
      "In `src/core/tools.ts`, find the `terminal` tool and identify two containment controls it applies (hint: cwd and env). Then explain what an attacker would still be unable to do even if they fully controlled the `command` string.",
  },

  nextjs: {
    technology: "React / Next.js",
    aliases: ["next", "next.js", "react", "nextjs", "react/next"],
    whatItIs:
      "React is a component model for building UIs from composable, state-driven pieces. Next.js is the framework around it: routing, server rendering, and an API layer.",
    whyChosen:
      "pehlichi-pub ships a real dashboard — chat, notebook, vision, insights, a teacher view — and Next.js gives file-based routing plus colocated API routes, so the UI and its backend endpoints live in one app.",
    usedIn:
      "The entire `src/app` tree: `src/app/chat`, `src/app/notebook`, `src/app/vision`, `src/app/insights`, `src/app/teacher`, `src/app/velum`, and the API routes under `src/app/api`. `npm run build` is literally `next build`.",
    alternativesConsidered:
      "A single-page app (Vite + React Router — lighter, but you wire your own SSR and API server) and a server-rendered template engine (simple, but no rich client interactivity). Next.js bundles routing, SSR, and API routes together.",
    tradeoff:
      "A heavier framework and its build conventions (and the Next-augmented `ProcessEnv` that forces the `as unknown as NodeJS.ProcessEnv` casts in the shared core), in exchange for one cohesive app that serves both UI and API.",
    interviewAnswer:
      "“The agent’s dashboard is a Next.js app: file-based routes for each surface, colocated API routes for the backend, and React for the interactive pieces. One build, one deploy, UI and endpoints together.”",
    miniChallenge:
      "Add a new route by creating `src/app/teacher/about/page.tsx` that renders a heading. Run `npm run build` and confirm Next picks up the new route from the filesystem with no router config.",
  },

  ollama: {
    technology: "Ollama / local models",
    aliases: ["ollama", "local model", "local models", "llamacpp", "llama.cpp", "local-first llm"],
    whatItIs:
      "Ollama is a runtime that serves open-weight LLMs locally over an HTTP API; llama.cpp is the underlying inference engine for running quantized models on commodity hardware.",
    whyChosen:
      "A teaching agent that runs on a user’s own machine shouldn’t require a cloud key to answer ‘what is X?’. Local model drivers let pehlichi-pub degrade to fully offline, private operation.",
    usedIn:
      "pehlichi-pub ships drivers the trio de-emphasizes: `src/core/drivers/ollama.ts` and `src/core/drivers/llamacpp.ts`, alongside the cloud `mimo.ts`. The driver is selected at runtime, so the same agent loop runs on a local model or a hosted one.",
    alternativesConsidered:
      "Cloud-only (simplest, but needs a key and sends data off the machine) and embedding a single hardcoded model (no flexibility). A driver abstraction over local + cloud keeps both paths open.",
    tradeoff:
      "Local models are smaller and slower than frontier hosted models, in exchange for privacy, zero per-token cost, and offline operation — the right default for a personal teaching agent.",
    interviewAnswer:
      "“We abstract the model behind a driver interface so the same agent loop runs against a local Ollama/llama.cpp server or a hosted API. Local-first means the agent stays useful and private with no network.”",
    miniChallenge:
      "Compare `src/core/drivers/ollama.ts` and `src/core/drivers/mimo.ts`. Find the one method they both implement, and explain how the agent loop stays identical regardless of which driver is plugged in.",
  },

  electron: {
    technology: "Electron",
    aliases: ["electron-app", "desktop app"],
    whatItIs:
      "A framework for building cross-platform desktop apps by packaging a Chromium renderer and a Node.js main process together.",
    whyChosen:
      "pehlichi-pub is the public, end-user build. Electron lets the same Next.js UI ship as an installable desktop app with the embedded agent running in the Node main process — no terminal required for end users.",
    usedIn:
      "The `electron/` directory: `electron/main.js` (the Node main process that boots the embedded agent and window) and `electron/preload.js` (the secure bridge exposing a narrow API to the renderer).",
    alternativesConsidered:
      "A pure web app (no install, but no local filesystem/agent process) and native toolkits like Tauri (smaller binaries, Rust core, less mature ecosystem at the time). Electron reuses the existing React UI verbatim.",
    tradeoff:
      "Large binaries and a bundled Chromium, in exchange for shipping one UI codebase to web and desktop and running a real local agent process behind it.",
    interviewAnswer:
      "“The desktop build is Electron: the renderer is the same Next.js UI, and the Node main process hosts the embedded agent. The preload script is the only bridge between them, kept deliberately narrow for security.”",
    miniChallenge:
      "Open `electron/preload.js` and list exactly which functions it exposes to the renderer. Explain why exposing the whole `require`/Node API there would be a security hole.",
  },

  godot: {
    technology: "Godot / GDScript",
    aliases: ["godot", "gdscript", "world engine", "game engine"],
    whatItIs:
      "Godot is an open-source game/interactive engine; GDScript is its Python-like scripting language for nodes and scenes.",
    whyChosen:
      "The Pehverse includes an interactive ‘world engine’ (the feudal-Japan world that frames pehlichi-pub’s persona). A real engine gives scene graphs, input, and rendering without building one from scratch.",
    usedIn:
      "The ecosystem’s world-engine layer — the interactive/visual world that pehlichi-pub’s personality (a feudal-world coordinator) is themed around. The agent itself stays engine-agnostic; the world is a separate Godot project that talks to the agent over HTTP.",
    alternativesConsidered:
      "Unity (powerful, proprietary, heavyweight licensing) and a custom web canvas/WebGL renderer (full control, enormous effort). Godot is open-source, lightweight, and scriptable.",
    tradeoff:
      "Another runtime and language (GDScript) to maintain, in exchange for a mature scene/rendering system the team doesn’t have to write.",
    interviewAnswer:
      "“The interactive world is a Godot project in GDScript, kept separate from the agent. They communicate over HTTP, so the engine handles scenes and rendering while the agent handles reasoning — clean separation of concerns.”",
    miniChallenge:
      "Sketch the contract: if the Godot world needs to ask the agent a question, which existing pehlichi-pub endpoint would it call, and what would the request body look like? (Look at the `/chat` route in `tui/src/server.ts`.)",
  },

  velum: {
    technology: "Velum (security / capability gating)",
    aliases: ["velum", "capability gating", "public release safety"],
    whatItIs:
      "Velum is the ecosystem’s security/capability layer — it decides which capabilities are exposed in a given build and produces receipts proving what was (and wasn’t) allowed.",
    whyChosen:
      "pehlichi-pub is a PUBLIC build. It must not expose lab-only capabilities or write paths to untrusted users. Velum gates capabilities and records the decision, so ‘this is safe to ship publicly’ is verifiable, not assumed.",
    usedIn:
      "`src/lib/velum` (e.g. `capabilityReceipts.ts`, `handoff.ts`) and the `/velum` UI surface, plus `publicReleaseSafety` checks. The agent’s write posture (`AGENT_ALLOW_WRITES`, `AGENT_FS_UNRESTRICTED`) is part of the same containment story.",
    alternativesConsidered:
      "Trusting environment flags alone (easy to misconfigure) and forking a separate ‘public’ codebase (drifts immediately — exactly the drift this very sync fixes). A capability layer keeps one codebase with provable gating.",
    tradeoff:
      "Extra ceremony (capability checks and receipts) on every sensitive path, in exchange for a public build whose safety posture is auditable from its own receipts.",
    interviewAnswer:
      "“Velum is our capability-gating layer. The public build runs the same code as the lab build but Velum decides which capabilities are exposed and emits a receipt, so we can prove what a public user could and couldn’t do.”",
    miniChallenge:
      "Open `src/lib/velum/capabilityReceipts.ts` and find what a capability receipt records. Then explain how you’d use those receipts to prove the public build never exposed a write-capable tool.",
  },

  mimo: {
    technology: "MiMo (AI driver)",
    aliases: ["mimo", "mimo-v2.5", "xiaomi mimo", "mimo driver"],
    whatItIs:
      "MiMo (Xiaomi MiMo) is the hosted LLM that pehlichi-pub uses by default, reached through an OpenAI-compatible HTTP API and wrapped by a driver.",
    whyChosen:
      "The agent loop needs one well-behaved, capable model behind a stable interface. MiMo via an OpenAI-compatible endpoint plugs into the existing driver abstraction with no special-casing in the core loop.",
    usedIn:
      "`src/core/drivers/mimo.ts`, selected via `AGENT_MODEL=mimo-v2.5` and `AGENT_BASE_URL` in `.env`. It implements the same driver contract as the local `ollama.ts`/`llamacpp.ts` drivers, so the loop is model-agnostic.",
    alternativesConsidered:
      "A provider-specific SDK baked into the loop (couples the core to one vendor) and only local models (private, but less capable for hard reasoning). The driver seam lets MiMo and local models coexist.",
    tradeoff:
      "A hosted dependency and an API key for the default path, in exchange for frontier-ish reasoning quality — with local drivers always available as the offline fallback.",
    interviewAnswer:
      "“MiMo is our default hosted model, but it’s behind the same driver interface as our local models. The agent loop never imports a vendor SDK — it talks to a driver — so swapping models is a config change, not a code change.”",
    miniChallenge:
      "In `src/core/drivers/mimo.ts`, find where the base URL and model come from (env vars). Then change `AGENT_MODEL` conceptually to a local model and trace which file would handle the request instead.",
  },
};

/** Normalize a query for matching: lowercase, collapse to alphanumerics. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Resolve a free-text technology name to its lesson card. Matches the key, the
 * display name, and any alias (all normalized), then falls back to a substring
 * match so "tell me about next" finds the React/Next.js card. Returns undefined
 * when nothing matches.
 */
export function findLessonCard(query: string): LessonCard | undefined {
  const q = normalize(query);
  if (q.length === 0) return undefined;

  for (const [key, card] of Object.entries(LESSON_CARDS)) {
    if (normalize(key) === q || normalize(card.technology) === q) return card;
    for (const alias of card.aliases) {
      if (normalize(alias) === q) return card;
    }
  }
  // Looser substring pass — only if an exact match failed.
  for (const card of Object.values(LESSON_CARDS)) {
    if (normalize(card.technology).includes(q)) return card;
    for (const alias of card.aliases) {
      if (normalize(alias).includes(q)) return card;
    }
  }
  return undefined;
}

/** The display names of every technology with a lesson card (for menus/errors). */
export function lessonCardNames(): string[] {
  return Object.values(LESSON_CARDS).map((c) => c.technology);
}

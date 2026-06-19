# Pehlichi (Peh)

Pehlichi — codename "Peh" — is the **lab coordinator agent** in the Pehverse lab, a
multi-agent AI development ecosystem by Jeffrey Miller. Peh is the hub: every task flows
through her. She reads, judges, records, plans, and routes work to the other lab agents
(e.g. Ptah the repairman, Luna the creative). She manages other agents via delegation,
maintains persistent curated memory, ingests images/docs/screenshots, and decomposes
complex tasks into steps. She is an **independent agent that owns her own core runtime**
(`src/core/`) — she depends on shared *data* stores (`lab-store`, `lab-memory`) but never
on another agent or a shared runtime package. TypeScript, ESM, Node >= 22.

## Build / Test / Dev commands

Package manager is **pnpm** (this is also a pnpm workspace; see `pnpm-workspace.yaml`).

- `pnpm build` — `tsc -p tsconfig.json` (emits to `dist/`).
- `pnpm typecheck` — `tsc -p tsconfig.json --noEmit` (type-check only, no emit).
- `pnpm test` — runs the Node built-in test runner under tsx against an explicit list of
  `*.test.ts` files: `node --import tsx --test <files>`. Tests are **not** vitest/jest —
  they use `node:test` (`test(...)`) with `node:assert/strict`.
- `pnpm sanity:peh-coordinate` — `node --import tsx src/sanity-peh.ts` (end-to-end sanity
  check of the coordinator).

To run a single test file directly: `node --import tsx --test src/core/loop.test.ts`.

There is no lint or dev script defined in `package.json`.

## Key conventions

- **ESM only** (`"type": "module"`). Source uses `.js` extension specifiers on relative
  imports even though files are `.ts` (NodeNext resolution + `verbatimModuleSyntax`).
- **Strict TypeScript.** `tsconfig.json` enables the full strict suite:
  `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, `noUnusedLocals`, `noUnusedParameters`,
  `noFallthroughCasesInSwitch`, `isolatedModules`. Target ES2022, module NodeNext.
- **Type-only imports** are explicit (`import type { ... }`) due to `verbatimModuleSyntax`.
- **Tests live next to source** as `*.test.ts`. Use `node:test` + `node:assert/strict`.
  Tests build fixtures in temp dirs (`mkdtempSync`/`tmpdir`) and drive the loop with a
  `ScriptedDriver` so no real model runs.
- **Each agent owns its core** — `src/core/` is Peh's own copy of the agent runtime (the
  same shape as other lab agents'); do not refactor it into a shared package.
- **Governance boundary**: agent-facing durable writes (memory, brain) go through a
  governance sink that creates *proposals* for human approval instead of writing directly.
- Tools are defined as `{ spec, handler }` pairs and assembled into a registry; new tools
  follow the existing `createXToolHandlers` + `xToolSpecs` pattern in `src/core/agent-tools/`.

## Architecture notes

Public API is `src/index.ts`, which re-exports the core runtime, the `pehProfile`, and
bridge tools.

- **`src/profile.ts`** — `pehProfile` (the coordinator persona) and `coordinatorToolNames`,
  a run-level allowlist of the tools Peh may use (read/search, browser, builder
  write/patch/terminal, memory, skills, todo, clarify, delegate, cron, execute_code).
- **`src/core/`** — Peh's self-contained agent runtime:
  - `loop.ts` — the driver-agnostic core agent loop (`runAgent`, `runAgentInShadow`).
    Depends only on the Driver interface, the tool registry, and the event emitter;
    handles approval gating, checkpoints, tool budgets, and runaway guards.
  - `driver.ts` + `drivers/` — the `Driver` abstraction and concrete drivers: `mimo`
    (primary LLM driver), `llamacpp`, `ollama`, plus a `ScriptedDriver` for tests.
  - `tools.ts` — base tool registry, `ToolDef`/`ToolHandler`/`ToolResult` types.
  - `agent-tools/` — the full tool suite (36 modules): browser (Playwright), web
    (search/extract), enhanced file ops, vision, execute-code (sandboxed), delegate
    (sub-agent spawning), todo, skills, memory, cron, clarify, coordination
    (`agent_sync` over a shared dir), brain (gbrain bridge). `index.ts` assembles them
    via `createFullToolRegistry(config)`. Also holds governance, budget/tier, circuit
    breaker, retry, prompt-injection/input sanitization, and token-monitor helpers.
  - `workspace.ts` / `shadow.ts` — workspace isolation: `resolveInWorkspace` confines
    file ops to a root; `ShadowWorkspace` gives disposable isolated runs (used by cron
    and delegated sub-agents).
  - `prompt.ts`, `profile.ts`, `events.ts`, `checkpoint.ts`, `context-compressor.ts`,
    `process-registry.ts`, `receipt-store.ts`, `approval-policy.ts`, `scenario.ts`
    (test scenario helpers), `subagent-entry.ts` (entry script `delegate_task` spawns).
  - `bridges/` + `bridge-adapter.ts`, `gbrain-bridge.ts` — HTTP bridge and adapters to
    the lab's shared services / knowledge brain.
  - `sinks/stdout.ts` — event sink/formatter for terminal output.
- **`src/tools/bridge-tools.ts`** — `bridgeToolSpecs` / `createBridgeToolHandlers`
  exposed on the public API.
- **`src/cli/repl.ts`** — interactive REPL entry.
- **`tui/`** — the HTTP server / task-runner surface (own `package.json`, tsconfig, tests).
  `server.ts` drives the kernel's `runAgent()` per `/chat` request; in the lab it runs as
  two systemd services on adjacent ports (Matrix bridge + HTTP/API), each with its own
  session map and cron store.
- **`ui/`** — browser front-end assets (HTML/CSS/JS, scenes, translation layer).
- **`skills/`** — Peh's skill packs (coordinator, planner, safety, archivum, ikbi, toba,
  nusika, work-order-creator).
- **`memories/`, `fixtures/`, `scripts/`, `deploy/`, `personality/`, `out/`** — curated
  memory store, test fixtures, helper scripts, deployment config, persona assets, and
  build/output artifacts.

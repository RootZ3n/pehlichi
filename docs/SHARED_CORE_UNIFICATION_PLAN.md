# Shared-Core Unification Plan (Phase C)

**Goal (user directive, 2026-07-01):** every agent shares the EXACT same tools and runtime
architecture regardless of role, so roles can be swapped freely. The ONLY per-agent
differences are **skills** and **personality**. See `TRIO_AGENT_REALITY_AUDIT.md` and the
`trio-uniform-capability-principle` memory.

**Status (updated 2026-07-01): §3 EXECUTED — functional core is now unified and green.**
The agent RUNTIME is byte-identical across all four repos, with role-specialization expressed as
config, not forked code:
- `loop.ts`, `events.ts`, `drivers/mimo.ts`, `tools.ts`, `prompt.ts`, `agent-tools/index.ts`,
  `agent-tools/enhanced-file-tools.ts`, `runtime-capabilities.ts`, `tool-arg-repair.ts`,
  `velum-scan.ts`, and `tui/src/lib/kernel-session.ts` — all IDENTICAL across the four.
- **Velum output-guarding** → `RunAgentOptions.guardToolOutput` (Ptah sets it).
- **Teaching tools** → `AgentToolConfig.enableTeaching` (Pub sets it); its prompt directive moved
  to Pub's server persona overlay.
- **Ptah work-order + occasio tools** → `enableWorkOrders` / `enableOccasio` (Ptah sets them).
- All optional tool modules now live in EVERY repo's core; each agent enables only its own → the
  registry file is identical. Behavior preserved: pehlichi 258/258, luna 249/249, pub 258/258
  (test:core), ptah 273/277 (only its 4 pre-existing WO/REPORTS/ONBOARDING/VELUM route failures).

**Remaining before §4 physical extraction (NOT yet done):**
1. **Cosmetic diffs** (2–8 lines each): `core/index.ts` header comment, `receipt-store.ts`
   (comment + stderr-vs-stdout logging), `process-registry.ts` / `execute-code-tools.ts` TS casts,
   `labmem-tools.ts`. Pick one canonical version each — trivial, do at extraction time.
2. **Agent-aware bridge maps** (`core/bridges/bridge-tools.ts`, `src/tools/bridge-tools.ts`, 59–69
   lines): each agent hard-codes its own view of the bridge network (self/peer names + ports).
   These are legitimately per-agent DATA and must become a data-driven shared registry (extend
   `bridges/registry.ts`) BEFORE they can be byte-identical. This is the one real design task left.
3. **§4 extraction**: create `lab-agent-core`, move the unified core, rewire imports across the four.

The staging below remains the reference; §3 (Velum + teaching toggles) is complete.

---

## 1. Current state (md5-measured, after P0/P1)

Four repos each carry their own copy of `src/core` (~73–79 files) + a `tui/` server layer.
Parity today (vs `pehlichi` as canonical):

| file | loony-luna | pehlichi-pub | mad-ptah |
|---|---|---|---|
| `src/core/loop.ts` | = | = | **DIFF** (Velum) |
| `src/core/events.ts` | = | = | **DIFF** (Velum `injectionFindings`) |
| `src/core/agent-tools/index.ts` | = | **DIFF** (teaching) | **DIFF** (Velum wiring) |
| `src/core/tools.ts` | = | **DIFF** (TS cast) | = |
| `src/core/prompt.ts` | = | **DIFF** (teach directive) | = |
| `src/core/drivers/mimo.ts` | = | = | = |
| `src/core/agent-tools/enhanced-file-tools.ts` | = | = | = |
| everything else in core | = | = | = |

Files unique to a repo's core:
- **mad-ptah**: `agent-tools/velum-scan.ts`, `occasio-bridge.ts`, `report-store.ts`
- **pehlichi-pub**: `agent-tools/teaching-tools.ts` (+ `src/data/lesson-cards.ts`, `ui-explanations.ts`)

**Conclusion:** `loony-luna` is already 100% core-identical to `pehlichi`. The entire
divergence reduces to **two optional features** — Ptah's **Velum output-guarding** and Pub's
**teaching tools** — plus a couple of cosmetic Next.js type-casts in pub. Unification is
therefore small in surface but touches the two most sensitive files (`loop.ts`, `agent-tools/index.ts`).

---

## 2. Target architecture

```
ecosystem/
  lab-agent-core/            ← NEW shared package (peer of lab-store, lab-memory)
    src/core/                ← the single canonical runtime (loop, drivers, tools, gates, …)
    package.json  tsconfig.json
  pehlichi/  mad-ptah/  loony-luna/  pehlichi-pub/
    src/
      profile(s)/            ← OVERLAY: persona + skillTags (per agent)
      index.ts               ← re-exports lab-agent-core + this agent's profile
    personality/*.yaml       ← OVERLAY: chat-harness persona
    skills/                  ← OVERLAY: per-agent skill packs
    tui/                     ← server (branding + port only; imports shared kernel-session)
    package.json             ← depends: "lab-agent-core": "file:../lab-agent-core"
```

The overlay per agent is exactly **{profile, personality, skills, server branding}** — nothing
else. Capabilities are uniform by construction.

---

## 3. Neutralize the two divergences as TOGGLES (do this FIRST, before extraction)

The core cannot be shared while Velum and teaching are forks. Convert both into config-gated
features that live in the (identical) core and are switched on per agent via run/registry config.

### 3a. Velum output-guarding → a loop option
- Move `velum-scan.ts` into the canonical core (harmless when unused).
- In `loop.ts`, gate the guard behind an option, e.g. `RunAgentOptions.guardToolOutput?: boolean`
  (default off). When set, route tool output through `guardToolOutput` exactly as Ptah does now;
  surface `injectionFindings` in the summary. `events.ts` already carries the optional field, so
  adopt Ptah's `events.ts` as canonical (the extra optional field is inert when unused).
- Ptah's server passes `guardToolOutput: true`; the others don't. loop.ts becomes byte-identical.
- `occasio-bridge.ts` + `report-store.ts` are Ptah-only *services* (not core loop) — keep them in
  the shared core as modules used only by Ptah's server, or move them under Ptah's overlay if they
  never belong to the kernel. (Recommended: overlay — they are Ptah work-order plumbing.)

### 3b. Teaching tools → an opt-in tool module
- Move `teaching-tools.ts` (+ `src/data/lesson-cards.ts`, `ui-explanations.ts`) into the canonical
  core as an OPTIONAL tool module.
- In `agent-tools/index.ts`, register teaching tools only when `AgentToolConfig.enableTeaching === true`
  (default off). Pub's server sets it true. `agent-tools/index.ts` becomes byte-identical.
- Pub's `prompt.ts` "TEACH WHILE YOU WORK" directive → inject it from Pub's PROFILE
  (persona preamble) instead of forking `prompt.ts`. `prompt.ts` becomes identical.
- Pub's `tools.ts` Next.js `env as unknown as NodeJS.ProcessEnv` cast → adopt in canonical
  `tools.ts` (a no-op for the others) so the file is identical everywhere.

**Exit criterion for §3:** all four `src/core` trees are byte-identical (`md5sum` matches), each
agent still green. This alone satisfies "identical architecture" at the code level and is the
precondition for physical extraction. It is independently valuable even if §4 is deferred.

### Verification after §3
Per repo: `pnpm typecheck` clean; the full test list green (ptah keeps ONLY its 4 known
pre-existing `server.test.ts` route failures — WO/REPORTS/ONBOARDING/VELUM — no new failures).
`md5sum` every `src/core/**` file across the four repos → all identical.

---

## 4. Physical extraction into `lab-agent-core`

Only after §3 (identical cores):
1. Create `ecosystem/lab-agent-core` with `package.json` (name `lab-agent-core`, deps
   `lab-store`/`lab-memory` as `file:` peers), `tsconfig.json` (mirror the strict settings), and
   move the canonical `src/core` there. Add its own test list.
2. In each agent repo: delete local `src/core`; add `"lab-agent-core": "file:../lab-agent-core"`;
   rewrite imports `../../src/core/...` → `lab-agent-core` (a single mechanical codemod).
   `tui/src/lib/kernel-session.ts` (identical across all four) also moves to the shared package.
3. `pnpm install` in each; `pnpm typecheck` + full tests green.
4. Migrate ONE repo first (pehlichi) end-to-end and verify before touching the others — never
   migrate all four in one step.

### Risks / guards
- **`file:` dep re-sync gotcha:** after building `lab-agent-core`, its `dist` must be re-synced
  into each consumer's `node_modules` copy (see the `lab-ops-gotchas` memory — the same stale-copy
  issue hit `lab-memory` during P0). Prefer running the core from source under `tsx` in dev to avoid
  a build/sync step, matching the current setup.
- **Import-path churn:** ~70 files × 4 repos. Do it with a scripted codemod, one repo at a time,
  typecheck-gated.
- **Ptah `occasio`/`report-store` + Pub teaching data**: decide core-vs-overlay explicitly (recommended
  overlay for occasio/report-store; core-optional for teaching) so the shared package stays generic.
- **Do not** migrate the four simultaneously. Each repo is its own PR, each green before the next.

---

## 5. Recommended execution order (each step independently green & committable)

1. **§3a Velum toggle** in pehlichi (canonical) → propagate identical `loop.ts`/`events.ts` to all four; Ptah server sets `guardToolOutput:true`. Verify.
2. **§3b Teaching toggle** in pehlichi → propagate identical `agent-tools/index.ts`/`prompt.ts`/`tools.ts`; Pub server sets `enableTeaching:true`. Verify. → **cores now byte-identical (goal reached at code level).**
3. **§4 extraction**: scaffold `lab-agent-core`; migrate pehlichi; verify; then luna, ptah, pub one at a time.
4. Delete the now-empty per-repo `src/core`; final full-suite run on all four.

Steps 1–2 deliver the user's stated goal (identical architecture, swappable roles) with modest
risk. Step 3–4 are the physical DRY payoff and can follow once 1–2 are settled.

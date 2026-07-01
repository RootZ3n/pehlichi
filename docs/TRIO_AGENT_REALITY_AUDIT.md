# TRIO AGENT REALITY AUDIT

**Scope:** `ecosystem/pehlichi` (Peh), `ecosystem/mad-ptah` (Ptah), `ecosystem/loony-luna` (Luna), `ecosystem/pehlichi-pub` (Peh public/release).
**Reference implementations studied:** Orin (`github.com/thetombrider/coding_agent`), Dirge (`yogthos.net/posts/2026-06-08-dirge-code.html`).
**Date:** 2026-07-01
**Method:** Source read of the live runtime path (loop → driver → tool registry → server), `md5sum`/`diff` for identity claims, `grep` for runtime-vs-defined wiring. Two parallel sub-audits: external references + per-repo divergence.
**Rule applied throughout:** if a capability exists only in docs/code but is not reachable from the live server loop, it is marked **NOT WIRED / NOT REAL**. No code changes were made.

---

## 1. Executive verdict

**These are real agents, not chat shells or planners.** The shared `src/core` runtime is a genuine execution loop: a real model driver that emits native `tool_calls`, a 18-family tool registry with real filesystem and shell authority, per-call receipts, a deny-by-default approval seam, budget/repetition governors, circuit-breaker + retry, disposable shadow workspaces for delegated/cron runs, checkpoint resume, and SSE streaming. All four repos boot the same loop through a live `tui/src/server.ts` HTTP entry. The model can and does invoke tools through the live loop.

**Classification:** all four are **TRUE_AGENT** — but with **reliability and proof gaps that must be closed before any of them can be trusted to claim "done" unattended.** The gaps are not "the agent is fake"; they are "the agent can *assert* success it did not *prove*, and several safety/quality subsystems that exist in the tree are not actually switched on in production."

**The three findings that matter most:**

1. **Verification is self-reported, not executed (BLOCKER).** The finalization gate (`validateSummary`) only checks that `verification[]` is a non-empty array of strings the *model wrote*. Nothing runs a build/test/command to confirm those strings are true, and `noChangeRequired:true` bypasses the check entirely. An agent can legitimately reach `done` with zero executed evidence. This is textbook "claim success without verification evidence."

2. **The per-agent tool lane is documentation, not runtime.** `coordinatorToolNames` / `ptahToolNames` / `lunaToolNames` are defined, byte-identical, and tested — but the live server never passes `toolNames` to `runAgent`. Every agent runs the **full registry** regardless of profile. The "capabilities differ per agent" story is false at runtime: capabilities are identical *and* unrestricted.

3. **Several advertised subsystems are present but NOT WIRED into the live path:** context compression (`contextWindow` never passed by the server), runtime provider/model switching (`provider-chain.ts` orphaned; server hardcodes `MimoDriver`), schema repair (`schema-sanitizer` is imported by the OpenRouter driver and the *other* chat harness, never by the live MiMo driver or loop), the structured skillpack contract (`primarySkill` never passed), and the loop's own `memoryStore` seam (`memoryStoreRoot` never passed — memory works only through the separate agent-tools handlers). Per the audit rule, these are **NOT REAL** in production even though they pass tests.

**Peh and Luna are the same runtime with a different costume** (`loop.ts` and `agent-tools/index.ts` are byte-identical; only the profile persona and the skills directory differ). **Ptah genuinely extends the core** (Velum injection-guarding of tool output, an Occasio work-order bridge, a report ledger). **pehlichi-pub is the shippable, honesty-first build** and is, on the "don't fake it" axis, *ahead* of the internal trio (it annotates hallucinated tool use and gates dangerous tools out of the local tier).

---

## 2. Agent definition used for this lab

A **full-blown agent** here must satisfy all of the following *at runtime on the live server path*, not merely in the source tree:

| # | Capability | Bar for "real" |
|---|---|---|
| 1 | Model loop | An iterated driver→act→observe loop, not a single completion. |
| 2 | Tool registry | Named tools with executable handlers, assembled at startup. |
| 3 | Tool selection | Tools advertised to the model; model's native tool-call reaches a handler. |
| 4 | File read/write | Real fs writes, confined to a workspace root. |
| 5 | Shell execution | Real process spawn with captured output/exit code. |
| 6 | Memory read/write | Durable store the agent can recall from and write to (governed). |
| 7 | Skills loading | Skill packs read from disk at runtime and exposed to the model. |
| 8 | Project rules loading | Project/agent rules injected into the system prompt. |
| 9 | Receipts | Per-tool-call audit record with real exit/byte metadata. |
| 10 | Approvals | A gate that can *refuse* a mutating call before it runs. |
| 11 | Undo / rollback | Ability to revert side effects (shadow/checkpoint/snapshot). |
| 12 | Retries | Transient-failure retry + circuit breaking. |
| 13 | Verifier / finalization gate | "Done" is rejected unless work was **actually done and proven**. |
| 14 | Interruption / cancel | An in-flight run can be cancelled by the operator. |
| 15 | Streaming / progress | Per-step events surfaced live. |
| 16 | Observability / tracing | Runs are externally observable/reconstructable. |
| 17 | Provider / model switching | Change model/provider without a restart. |
| 18 | Per-agent personality/skills separation | Agents differ by persona/skills over a shared runtime. |

Plus the reference-derived bars: before/after-tool hooks, output compaction, schema repair, model-on-rails, clear error feedback, syntax-check-before-edit, project memory (hot + searchable), lifecycle plugins.

---

## 3. Repo-by-repo classification

### pehlichi (Peh) — **TRUE_AGENT** (with reliability gaps)
- Live entry `tui/src/server.ts` → `KernelChatSession` → `runAgent` with production `ResilientDriver(MimoDriver)`, full `createFullToolRegistry`, `defaultApprovalPolicy`, checkpoint dir, SSE streaming. Real loop, real tools, real receipts.
- `loop.ts` md5 `744d70f6…`, `agent-tools/index.ts` md5 `e9cf015e…`.
- Caveats (shared, see §5): verification is shape-only; `coordinatorToolNames` lane **not wired**; provider-switch / OTLP / context-compression / `primarySkill` / `memoryStoreRoot` **not wired**; production default `AGENT_ALLOW_WRITES !== 'false'` auto-approves writes.
- No root `start` script (the tui server is the runnable surface but not exposed as an npm script).

### mad-ptah (Ptah) — **TRUE_AGENT** (most hardened runtime)
- Same live path; the **only** repo that genuinely extends the core loop: `loop.ts` (md5 `61a97686…`) routes every tool result through `guardToolOutput` (Velum: sanitize → scan → quarantine-wrap untrusted output before it re-enters context) and surfaces an `injectionFindings` count in the summary.
- Adds `src/core/occasio-bridge.ts` (opens work orders from detections, dispatches to Luna/Peh over the HTTP bridge) and `src/core/report-store.ts` (JSONL ledger of multi-model comparison reports feeding a provider-degradation detector). Extra skills: `miko-*`, `ptah-*`.
- Has `start` + `repl` scripts — the most directly runnable of the trio.
- Same shared verification/lane/wiring caveats as Peh.

### loony-luna (Luna) — **TRUE_AGENT** (Peh's runtime, different costume)
- `loop.ts` and `agent-tools/index.ts` are **byte-identical to Peh** (`744d70f6…` / `e9cf015e…`). Differs *only* by `src/profiles/luna.ts` (creative-gremlin persona, role `creative`) and 4 creative skills (`luna-comfyui-control`, `luna-creative-director`, `luna-ecosystem`, `luna-minimax-generation`).
- `luna.ts` documents the "Trio parity rule: every lab agent gets the EXACT same tool allowlist." Confirmed: the allowlist is identical to Peh's (minus Peh's trailing `lab_status_digest`) — and, as noted, unenforced anyway.
- Same shared caveats.

### pehlichi-pub (Peh public) — **TRUE_AGENT** (constrained, honesty-first release build)
- Shippable Next.js + Electron product wrapping the same core (`build:core` via `tsconfig-core.json`; tests via **vitest**, unlike the trio's `node:test`). `loop.ts` identical to Peh; `tools.ts`/`agent-tools/index.ts` differ (Next.js typing casts + the teaching tools).
- Adds `teaching-tools.ts` (`teach_lesson`/`teach_hover`/`teach_challenge`) and a "TEACH WHILE YOU WORK" prompt directive.
- **Ahead of the trio on honesty:** a live tool-honesty gauntlet detects hallucinated tool use and annotates responses (`honestyMessage`, `unavailableTools`); `verify:capabilities` requires every `LOCAL_READY` capability to carry a `proofReference`; dangerous tools (shell, `fs.write`, `code_execute`, browse) are deliberately **never** local-ready; only `file_inspect` + approval-gated `tiny_edit` write. `prove-local-only` + an egress guard enforce no non-local fetch.
- Reuses `pehProfile` (no own `src/profiles/`).

**No repo is CHAT_WITH_TOOLS, PLANNER_ONLY, or PRETEND_AGENT.** One caveat: each repo also ships a *second, lighter* persona path — `personality/*.yaml` loaded by `tui/src/lib/personality.ts` and used by the `/converse` lane and the chat harness (`tui/src/lib/chat.ts`). That `/converse` lane **is** a tool-free chat shell by design (fast path for greetings). It is not the agent; the agent is the `/chat` → `runAgent` path.

---

## 4. Capability matrix

Legend: **REAL** = wired and reachable on the live server path · **PARTIAL** = works but weak/incomplete · **NOT WIRED** = exists in tree, absent from live path (per audit rule = NOT REAL in prod) · **GAP** = absent.

| # | Capability | Status | Evidence / note |
|---|---|---|---|
| 1 | Model loop | **REAL** | `loop.ts:runAgent`, `driver.next({messages,tools})` iterated; wired via `KernelChatSession.send` → `runAgent`. |
| 2 | Tool registry | **REAL** | `agent-tools/index.ts:createFullToolRegistry` (18 families) → `createToolRegistry(extraTools)`. |
| 3 | Tool selection | **REAL** | `toProviderTools` advertises specs; `MimoDriver.parseChatCompletion`→`completionToAction` returns `{kind:"tool"}` from native `tool_calls`. |
| 4 | File read/write | **REAL** | `enhanced-file-tools.ts` `readFileSync`/`writeFileSync`; `resolveInWorkspace` confinement. |
| 5 | Shell execution | **REAL** | `execute-code-tools.ts:spawnSync`; `terminal`/`process` specs in `tools.ts:106/127`; `execFileSync` for rg/grep. |
| 6 | Memory read/write | **PARTIAL** | Works via agent-tools `memory`/`labmem_*` handlers (governance proposals in `<memoryDir>/.proposals`). BUT the loop's own `memoryStore` seam (`memoryStoreRoot`) is **NOT WIRED** by the server, so the built-in `memory_*` tools are never advertised live. |
| 7 | Skills loading | **REAL** | `skill-tools.ts:createSkillToolHandlers(skillsRoot)` reads `skills/*/SKILL.md` at runtime; `skills_list`/`skill_view`/`skill_manage`. |
| 8 | Project rules loading | **PARTIAL** | `buildSystemPrompt(profile, store.listModules(), specs, activeSkill)` injects persona + store modules. No CLAUDE.md/AGENTS.md project-rule ingestion; the structured skillpack contract (`primarySkill`) is **NOT WIRED**. |
| 9 | Receipts | **REAL** | `receiptStore.record(...)` on **every** tool call (`loop.ts:508`); `terminal-receipt` events with exit/byte/truncated. |
| 10 | Approvals | **PARTIAL** | `defaultApprovalPolicy` refuses mutating tools pre-handler — but via a single `allowWrites` boolean; production default `AGENT_ALLOW_WRITES !== 'false'` = **writes auto-approved, no per-call HITL**. Direct/library callers get correct deny-by-default (`defaultLibraryApproval`). |
| 11 | Undo / rollback | **PARTIAL** | `ShadowWorkspace`/`runAgentInShadow` (always discard) + `checkpoint.ts` resume — used by **cron/delegate**. The **live `/chat` path runs `runAgent` on the real `workspaceRoot`, not a shadow**; no `/undo`, no snapshot-before-tool. |
| 12 | Retries | **REAL** | `retry.ts:withRetry`, `circuit-breaker.ts`, `ResilientDriver` in the server, `error-classifier.ts`. |
| 13 | Verifier / finalization gate | **PARTIAL — BLOCKER** | `validateSummary` requires non-empty `rootCause`/`changes`/`verification` **arrays of model-authored strings**; nothing executes them; `noChangeRequired:true` bypasses; the budget governor *instructs* the model to finish with `noChangeRequired:true`. Success ≠ proof. |
| 14 | Interruption / cancel | **GAP** | Only request-level `AbortSignal.timeout`, client-abort handling, and `SIGINT` shutdown. No operator cancel of an in-flight `runAgent` loop. |
| 15 | Streaming / progress | **REAL** | `KernelChatSession.stream` + per-event sink; events flushed per step (SSE). |
| 16 | Observability / tracing | **PARTIAL** | Rich local event stream + receipts + `TokenMonitor`. **No OTLP/OpenTelemetry** (confirmed absent). Runs are not externally traceable. |
| 17 | Provider / model switching | **PARTIAL** | Drivers exist (`mimo`, `llamacpp`, `ollama`, `openrouter-driver`) + `provider-chain.ts`, but the server hardcodes `MimoDriver(BASE_URL, MODEL)`; `provider-chain` is orphaned (barrel-only import). No `/model`/`/providers`. |
| 18 | Personality/skills separation | **REAL (confirmed)** | Peh≡Luna core md5-identical; differ only by profile + skills. Ptah extends core; pub adds teaching + packaging. |
| — | Context compaction | **NOT WIRED** | `ContextCompressor` is opt-in on `contextWindow`; `KernelChatSession` never passes `contextWindow` → compaction never triggers in prod. |
| — | Before/after-tool hooks | **GAP** | Only the approval gate (before-tool veto). No arg-rewrite / after-tool / output-rewrite registry. Ptah's Velum is a *hardcoded* after-tool transform, not a pluggable hook. |
| — | Schema repair | **NOT WIRED** | `schema-sanitizer.ts` imported by `openrouter-driver.ts` + `tui/src/lib/agent-chat.ts`, **not** by the live `MimoDriver`/loop. MiMo throws `MimoError` on non-JSON tool args (fail-loud, no repair). |
| — | Textual-call rails | **REAL** | `completionToAction`→`textual-call-detected`; loop feeds an actionable correction and never executes prose calls. |
| — | Session resume | **REAL** | `checkpoint.ts` + `KernelChatSession` resumes from `checkpointDir`; server wires it in production. |
| — | Budget / runaway governor | **REAL** | `IterationBudget`, `RepetitionDetector`, same-tool/total-failure stop directives (`loop.ts:377-611`). |

---

## 5. "Pretend agent" risks (the honest blockers)

1. **Verification theater (highest severity).** `done` is accepted on model-authored `verification[]` strings with no execution, and `noChangeRequired:true` skips the check. Nothing in the loop runs the build/test/command the model claims it ran. **An agent can report "verified, done" having verified nothing.** This is the single thing that most makes a real agent *behave* like a pretend one.

2. **Capability separation is fictional at runtime.** The per-agent allowlists are defined, tested, and documented ("capabilities do not differ") — but `toolNames` is never handed to the live loop. All three siblings run the **entire** registry, unrestricted. Any "Luna can't run terminal / Ptah can't delegate" claim is false in production.

3. **Writes hit the real workspace with only a boolean between them and disk.** Live `/chat` runs on the real `workspaceRoot` (not a shadow), `AGENT_ALLOW_WRITES` defaults on, and there is no per-mutation human approval and no undo. A hallucinated `patch`/`write_file`/`terminal` executes for real.

4. **"It's in the repo" ≠ "it's on."** Context compaction, provider switching, schema repair, the structured skillpack contract, and the loop's memory seam all exist and pass tests but are **not reachable from the live server**. This is the exact trap the audit rule targets: a reader of the tree would overcount capabilities.

5. **No external observability.** Receipts + events are in-process only; there is no OTLP trace. After an unattended run you cannot independently reconstruct what happened — which undercuts receipts as *proof* rather than *log*.

**What is genuinely real and strong (for balance):** iterated loop with native tool-calls; real fs + shell authority with workspace confinement; deny-by-default for direct callers; textual-call rails; per-call receipts; budget/repetition governors; circuit breaker + retry; shadow isolation for cron/delegate; checkpoint resume; SSE streaming; prompt-injection scan + input sanitization on the server; Ptah's Velum output-guarding; pub's honesty annotation. This is a real agent platform with reliability debt — not a façade.

---

## 6. Best ideas to borrow from Orin

1. **`before_tool` / `after_tool` hook registry** (`block | rewrite-args | rewrite-output`). Generalize the existing approval gate + Ptah's Velum transform into one typed interceptor chain so injection-guarding, arg-rewrite, and result-capping are pluggable per agent instead of hardcoded in one repo's `loop.ts`.
2. **Budgeted compaction pipeline** (cap oversized results → prune old tool outputs → summarize old turns → summarize messages), budgets scaled to a fraction of the live window. Peh already *has* a `ContextCompressor`; adopt Orin's staged pipeline **and actually wire `contextWindow` in the server.**
3. **Native OTLP tracing** (GenAI semantic conventions: turn = trace, LLM + tool spans with tokens/cost/duration/ok). Closes risk #5; makes receipts externally verifiable.
4. **Runtime provider registry + `/model` `/providers` switch + per-role model slots** (cheap model for read/explore, strong model for implement). The lab already has the drivers and `provider-chain.ts` — this is wiring, not new code.
5. **Per-turn tool-relevance filtering (BM25 over the catalog).** With 18 tool families the per-turn schema is heavy; retrieving the top-N relevant tools cuts token bloat and mitigates risk #2 by shrinking the live surface.
6. **Shadow-git snapshot before *every* tool (incl. bash) + `/undo` `/restore`.** Extends the existing `ShadowWorkspace` from cron/delegate to the live `/chat` path — directly fixes risk #3.
7. **Resumable append-only session log (JSONL) + `--resume`.** Complements the existing checkpoint mechanism with a full replayable history.

## 7. Best ideas to borrow from Dirge

1. **Finalization gate that requires real evidence.** Dirge's gate "checks whether the code was changed and whether a build or test ran and passed" before completion. Replace the shape-check `validateSummary` with a gate that inspects **executed** receipts (did a `terminal`/test tool actually run and exit 0?) — the direct fix for BLOCKER risk #1.
2. **Syntax check before edits (tree-sitter parse before write/patch touches disk).** Add a pre-write parse gate in `enhanced-file-tools` so malformed edits are rejected pre-write instead of corrupting files.
3. **Schema repair for malformed tool calls** — try the input as-is, then correct only schema-rejected parts. Wire the existing `schema-sanitizer` into the **live MiMo path** (today MiMo just throws). Keep fail-loud as the final fallback.
4. **Reflect-then-pivot circuit breaker.** The current governor injects "stop and finish"; Dirge forces the model to *name the false belief* behind repeated failure before continuing. Upgrade the `RepetitionDetector` stop directive to a reflect step.
5. **Clear, precise error feedback** (exact line/column, named missing tokens). Pair with the syntax gate so edit failures return actionable positions, not just "failed."
6. **Project memory: hot context + searchable breadcrumb index** (per-project SQLite; hot entries injected into the system prompt, the rest a one-line searchable index). The lab has `lab-memory`/governance; adopt the hot-vs-index split so memory is injected, not just tool-fetched (fixes the memory-not-injected half of risk #4).
7. **Lifecycle plugins** (`on-init`/`on-prompt`/`on-tool-start`/`on-tool-end`) — the same convergent hook primitive as Orin; standardize once, share across the trio.

---

## 8. Recommended architecture changes

1. **Promote `src/core` to a single shared runtime package with per-agent overlays.** Today Peh and Luna are byte-identical copies and Ptah is a *forked* copy with genuine improvements (Velum) that the others silently lack. This is drift waiting to happen. Structure:
   - `lab-agent-core` (or keep `src/core` but as one source of truth) — the loop, drivers, tools, gates, hooks.
   - Per-agent **overlay** = `{ profile, skills/, enabled-tool-lane, model config, hooks[] }` — data only.
   - Ptah's Velum, Occasio, and report-store become **core hooks/modules toggled by overlay**, not a fork. Then every agent gets injection-guarding, not just Ptah.
2. **Make the tool lane real.** Thread each profile's allowlist into `runAgent({ toolNames })` from the server. Then "Luna is creative-only / Peh coordinates / Ptah repairs" becomes structurally true.
3. **Turn on what's already built.** Wire `contextWindow` (compaction), `memoryStoreRoot` (memory injection), `primarySkill` (skillpack contract), and a provider registry in `createPehServer`/`KernelChatSession`. Much of the P0/P1 win is *activation*, not new code.
4. **Evidence-based done-gate** reading real receipts; **shadow-on-live-write** + `/undo`; **OTLP** exporter behind the existing event sink interface (add a `sinks/otlp.ts` next to `sinks/stdout.ts`).
5. **Adopt pub's honesty layer lab-wide.** The `honestyMessage`/`unavailableTools` annotation and the `proofReference`-required capability matrix should protect the internal trio too, not just the public build.

---

## 9. Prioritized fix plan

### P0 — makes them *honest* real agents (close the pretend-agent blockers)
- **P0.1 Evidence-based finalization gate.** Reject `done` unless a verifying tool actually executed with a success receipt (or `noChangeRequired` is justified by the task class); stop accepting model-authored `verification[]` as proof. *Fixes risk #1.*
- **P0.2 Wire the per-agent tool lane.** Pass `profile.toolNames` into `runAgent` from the server for all three siblings. *Fixes risk #2.*
- **P0.3 Real write safety on the live path.** Run live `/chat` mutations in a shadow (or snapshot-before-tool) and require explicit per-mutation approval (or at least a signed, non-default write posture). Remove the "writes on by default, no HITL" posture. *Fixes risk #3.*
- **P0.4 Stop over-claiming capabilities.** Either wire the NOT-WIRED subsystems (P1) or gate their tool/prompt advertisements off so the agent never claims a capability that isn't active. *Fixes risk #4.*

### P1 — makes them *reliable* agents
- **P1.1 Activate context compaction** (pass `contextWindow`; adopt Orin's staged pipeline).
- **P1.2 Wire schema repair** into the live MiMo path (Dirge-style, fail-loud fallback).
- **P1.3 Syntax gate before write/patch** (tree-sitter) with line/column feedback.
- **P1.4 Reflect-then-pivot** upgrade to the repetition governor.
- **P1.5 Operator cancel** of an in-flight run (`AbortController` threaded into the loop; `/cancel` endpoint).
- **P1.6 Memory injection** (hot context) via the loop's `memoryStore` seam + Dirge's hot/index split.

### P2 — makes them *great* agents
- **P2.1 Native OTLP tracing** (`sinks/otlp.ts`).
- **P2.2 Runtime provider/model registry** + `/model` `/providers` + per-role model slots.
- **P2.3 Per-turn BM25 tool-relevance filtering.**
- **P2.4 Shadow-git + `/undo` `/restore`** on the live path; resumable JSONL session log.
- **P2.5 Unify the core into a shared package with overlays** (§8.1); fold Velum/Occasio/teaching in as toggled modules.
- **P2.6 Standardize the before/after-tool hook registry** (Orin/Dirge convergent primitive) and port the approval gate + Velum onto it.

---

## 10. Tests that must be added

1. **Done-gate refuses unproven success:** a scripted run that emits `done` with `verification:["ran tests"]` but never called a verifying tool → gate rejects. (Locks P0.1.)
2. **Done-gate accepts only receipt-backed verification:** run that actually executed `terminal`/test with exit 0 → gate accepts. Negative: exit≠0 → reject.
3. **Tool-lane enforced live:** server built with Luna's profile refuses `write_file`/`terminal` at the loop (out-of-lane), not just in the profile constant. (Locks P0.2.)
4. **Write requires approval on live path:** with default posture, a `patch`/`write_file` call is refused unless explicitly authorized; and it lands in a shadow, not the real root. (Locks P0.3.)
5. **No-over-claim:** with compaction/provider-switch/memory-seam off, `/tools` and the capability summary do not advertise them. (Locks P0.4.)
6. **Compaction triggers** when `contextWindow` is wired and messages exceed the budget (assert `narrate` compaction event). (Locks P1.1.)
7. **Schema repair on live driver:** MiMo tool call with a trailing comma / minor malformation is repaired and executes; irreparable input still fails loud. (Locks P1.2.)
8. **Pre-write syntax gate:** `write_file`/`patch` of syntactically invalid code is rejected with line/column; valid code passes. (Locks P1.3.)
9. **Reflect-then-pivot:** N repeated same-tool failures inject a reflect directive (assert the reflect message, not just the stop). (Locks P1.4.)
10. **Operator cancel:** an in-flight loop aborts within one iteration of `/cancel` and returns a partial. (Locks P1.5.)
11. **Cross-repo core parity guard:** a test that `md5`/AST-compares the shared core across the trio (or, post-unification, asserts a single source) so Ptah-style improvements can't silently diverge again.
12. **Honesty annotation parity:** port pub's tool-honesty gauntlet assertions (hallucinated tool use → `honestyMessage` + correct `unavailableTools`) into the internal trio's suite.

---

## 11. Files inspected

**Shared core (read in `pehlichi`, md5-compared across repos):**
- `src/core/loop.ts` — the execution loop, approval gate, governors, `validateSummary`, shadow entry.
- `src/core/drivers/mimo.ts` — live driver; native tool-call parsing, textual-call detection, response protocol.
- `src/core/tools.ts` — base registry; `terminal`/`process` specs (lines 106/127).
- `src/core/agent-tools/index.ts` — `createFullToolRegistry` (18 tool families); default cron executor.
- `src/core/agent-tools/enhanced-file-tools.ts` — `read_file`/`write_file`/`patch` (`writeFileSync`, `execFileSync`, `resolveInWorkspace`).
- `src/core/agent-tools/execute-code-tools.ts` — `execute_code` (`spawnSync`).
- `src/core/approval-policy.ts` — `READ_ONLY_TOOLS`, `defaultApprovalPolicy`.
- `src/profiles/peh.ts`, `src/profile.ts` — persona + `coordinatorToolNames`.
- `src/core/profile.ts` — `AgentProfile` contract.
- `src/core/prompt.ts` (system-prompt assembly), and grep-level checks of `checkpoint.ts`, `context-compressor.ts`, `receipt-store.ts`, `shadow.ts`, `retry.ts`, `circuit-breaker.ts`, `schema-sanitizer.ts`, `provider-chain.ts`, `agent-tools/velum-scan.ts`.

**Server / wiring:**
- `tui/src/server.ts` (`createPehServer`, `makeSession`, driver/approval/checkpoint wiring, `AGENT_ALLOW_WRITES`).
- `tui/src/lib/kernel-session.ts` (`KernelChatSession.send`/`stream` → `runAgent` call; which options are/aren't passed).
- `tui/src/lib/personality.ts` reference (the second persona path via `/converse`).

**Per-repo divergence (all four):** `md5sum`/`diff` of `loop.ts`, `tools.ts`, `mimo.ts`, `agent-tools/index.ts`; `src/profiles/*.ts`; `skills/` listings; `personality/*.yaml`; entry points (`src/index.ts`, `src/cli/repl.ts`, `tui/src/server.ts`, package scripts).

**mad-ptah extras:** `src/core/loop.ts` (Velum diff), `src/core/agent-tools/velum-scan.ts`, `src/core/occasio-bridge.ts`, `src/core/report-store.ts`.

**pehlichi-pub extras:** `scripts/tool-honesty-gauntlet.mjs`, `scripts/verify-capabilities.mjs`, `scripts/prove-local-only.mjs`; `src/core/agent-tools/teaching-tools.ts` (referenced); package/build config (Next.js/Electron/vitest).

**External references:** Orin `README` + `src/hooks/types.ts`, `src/agent/compaction.ts`, repo tree; Dirge blog post.

---

## 12. Status

**No code changes were made.** This document is the deliverable. The recommended changes in §8–§10 are **not implemented** and await explicit approval before any work begins. Suggested first step on approval: **P0.1 (evidence-based done-gate)** and **P0.2 (wire the tool lane)** — the two changes that most directly convert "asserts success" into "proves success" and make per-agent capability separation real.

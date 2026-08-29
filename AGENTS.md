# Pehlichi (Peh)

Pehlichi — capsule id `pehlichi`, role `coordinator`, icon 🐿️ — is the **lab coordinator agent** — the hub through which lab work is routed. Peh reads,
judges, records, plans, and hands work to the other lab agents.

This document is **identity-specific**: each of the three trio distributions carries its
own `AGENTS.md`, and they are expected to differ. Shared, model-facing documentation is
governed separately and must stay byte-identical.

## This agent

* Capsule: `capsule/agent.json`, governed copy `trio/governance/capsules/pehlichi.json`
* Memory namespace: `pehlichi`
* Personality: `personality/pehlichi.yaml`
* Skills:
  * `skills/coordinator/SKILL.md`
* Requested capability packs: none — all packs inactive
* Routing preferences:
  * repair → `ptah`
  * creative → `luna`
* Sanity check: `pnpm test` (governed; identical across the Trio)

## Shared runtime — do not diverge

This repository is one of three byte-identical distributions (Pehlichi, Loony Luna,
Mad Ptah). TRIO-001A governs which paths must match and which may differ.

* `runtime/` — the shared agent runtime, including `runtime/server/server.ts`, the
  generic `createAgentServer(config)` assembly, and `runtime/safety/output-guard/`.
  **Byte-identical across all three.** `tui/src/server.ts` is now a thin shim over it.
* `tests/` — shared parity and runtime suites. Byte-identical.
* `src/` — the agent runtime library. Governed as byte-identical; convergence of the
  remaining agent-specific modules is still in progress.
* `trio/` — System A: runtime-parity manifests (`boundary-manifest.json`,
  `path-inventory.json`, `runtime-closure.json`), read by
  `tests/parity/runtime-parity.test.ts`.
* `trio/governance/` — System B: classification rules, schemas, capsules and
  capability-pack declarations, read by the external verifier in
  `lab-utilities/trio-verifier`.
  Two verifiers, two manifests, deliberately not merged.

Identity does **not** live in runtime code. It lives in `capsule/agent.json`,
`deployment/agent.env.json`, `personality/`, `skills/`, and this file.

Never fix a shared-runtime path in one repository alone: the same canonical change must
land identically in all three, or parity fails.

## Build / test commands

Package manager is **pnpm**; this is also a pnpm workspace.

- `pnpm build` — `tsc -p tsconfig.json`, emits to `dist/`. The build is reproducible:
  rebuilding produces no diff against the committed `dist/`.
- `pnpm typecheck` — `tsc -p tsconfig.json --noEmit`.
- `pnpm test` — `node --import tsx --test <explicit file list>`. Tests use `node:test`
  and `node:assert/strict`, never vitest or jest.
- `pnpm run test:runtime` — shared runtime and hostile-remediation suites.
- `pnpm run test:parity` — cross-repository runtime parity (System A). It reads all three
  distributions; override the roots with `TRIO_REPOSITORIES`.
- Governance parity (System B):
  `node /pehverse/repos/lab-utilities/trio-verify-launcher/launch.mjs`
  This agent does not verify itself. The launcher pins an exact external verifier commit,
  runs it against clean committed trees, and is invoked from outside this repository.
  Every slot is required.

Run one file directly: `node --import tsx --test src/core/loop.test.ts`.

There is no lint or dev script.

## Conventions

- **ESM only** (`"type": "module"`); relative imports carry `.js` specifiers even from
  `.ts` sources (NodeNext + `verbatimModuleSyntax`).
- **Strict TypeScript** — the full strict suite including `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`. Type-only imports are explicit.
- **Tests sit next to source** as `*.test.ts`, build fixtures in temp dirs, and drive the
  loop with a scripted driver so no real model runs.
- Tools are `{ spec, handler }` pairs assembled into a registry via the existing
  `createXToolHandlers` + `xToolSpecs` pattern under `src/core/agent-tools/`.
- **Tool output guarding is a runtime invariant**, not an agent posture. It is
  unavoidable on every tool-result-to-model path and no capsule may disable it.
- Durable agent-facing writes (memory, brain) go through a governance sink that raises
  proposals for human approval rather than writing directly.
- Optional capability packs are declared in `trio/governance/capability-packs/` and are
  **default-off**. A pack runs only when this agent's capsule requests it *and* trusted
  deployment permits it. Activation is never a branch in server control flow.

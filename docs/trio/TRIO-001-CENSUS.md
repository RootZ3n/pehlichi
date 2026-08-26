# TRIO-001 Complete Census

Date: 2026-08-15 (America/Chicago)  
Verdict: **the trio runtime is not byte-identical.** This census is evidence, not a safety certification.

## Repository topology

| Project | Absolute path | Branch | HEAD | Remote / state note |
|---|---|---|---|---|
| Pehlichi | `/pehverse/repos/ecosystem/pehlichi` | `peh-on-phone` | `12a6f9b38493f3f2cf789125fb3bc5abc4fca4d9` | RootZ3n/pehlichi; clean before evidence files |
| Loony-Luna | `/pehverse/repos/ecosystem/loony-luna` | `peh-on-phone` | `a2bd67dd929e97bd8a9c26904d82bbc26cf39cf7` | RootZ3n/loony-luna; pre-existing demo asset changes |
| Mad-Ptah | `/pehverse/repos/ecosystem/mad-ptah` | `peh-on-phone` | `0562cc70e3eebfeef4ab1718f186c3e67be8fc74` | RootZ3n/mad-ptah; clean |
| lab-agent-core | `/pehverse/repos/lab-utilities/lab-agent-core` | `master` | `28b0753aba6861d9bd64bb5f00a6838eec162951` | RootZ3n/lab-agent-core; two modified tests and untracked README |
| lab-memory | `/pehverse/repos/lab-utilities/lab-memory` | `master` | `af14f4aa9f1a1e60f11e2618f262377bfb6abe6e` | RootZ3n/lab-memory; clean |
| lab-store | `/pehverse/repos/lab-utilities/lab-store` | `master` | `3e6b98be4924343979957d68bb69133ccd0c38a0` | RootZ3n/lab-store; pre-existing checkpoint deletions/additions |
| Howa | `/pehverse/repos/ecosystem/howa` | `ui/pehverse-shell-port` | `a2faa0a3e04475aaad7c04e6ea28d3a80633b2b2` | RootZ3n/howa; untracked package tarball |
| IKBI | `/pehverse/repos/ecosystem/ikbi` | `state-bound-mutation-hardening` | `e1ef62611f4810857198dfc920ff81a7df0770fa` | RootZ3n/ikbi; ahead 2; pre-existing docs/config/tarball files |
| Truth Firewall | `/pehverse/repos/lab-utilities/truth-firewall` | parent repo `hardening-sprint-codex` | parent HEAD `3b36576c2571532cb8d5d583a5b3d4ce862313dd` | not standalone; `/pehverse/.git`, no remote; scoped modified package and untracked LICENSE |

Machine-readable full file trees (excluding `.git`, dependency/cache directories, coverage, and `.next`), worktree states, remotes, and per-repository tree SHA-256 values are in `TRIO-001-DEPENDENCIES.json`.

## Entrypoints and surfaces

- Trio build/test/library: root `package.json`, `src/index.ts`, `src/core/loop.ts`, `src/core/tools.ts`, and profile entrypoints.
- HTTP/UI/streaming: `tui/src/server.ts`, static UI under `tui/public`, `KernelChatSession`, `/converse`, `/chat`, `/api/chat`, `/chat/stream`, state/model/reset/undo and agent metadata routes.
- CLI/direct: `src/cli/repl.ts`, exported `runAgent`, tool registry constructors, sanity scripts.
- Matrix: `/pehverse/repos/lab-utilities/bridges/shared/matrix-bridge.ts`, deployed as three systemd units and forwarding to trio HTTP.
- Cron/delegation/checkpoint/recovery: `cron-tools.ts`, `delegate-tools.ts`, shadow/checkpoint/recovery modules, lab-store checkpoint persistence.
- Bridge/tool surfaces: core bridge tools, lab context/conversation/shell, IKBI, Luak, Howa HTTP adapters, phone/browser/web/music, brain/memory/skills.
- Deployment: active `lab-pehlichi`, `lab-luna`, `lab-ptah`, matching Matrix bridge units, plus active `lab-howa` and `lab-ikbi`. All inspected trio/IKBI listeners bind `0.0.0.0` at their configured ports. No unit was modified or restarted.

## Runtime parity

Candidate runtime is existing shared execution code, not identity data: `src/core/**` (excluding tests), `tui/src/server.ts`, `tui/src/lib/**` (excluding tests), plus root/TUI manifests, lockfiles, workspace files, and TypeScript configuration. Identity/personality/profile text, agent-specific UI branding/assets, deployment/env configuration, and agent skills are capsule candidates; placing identity switches in server assembly is contamination.

- `src/core` is byte-identical across all three: tree SHA-256 `b17581d6eb88de87e8ddd7fc97074cb4205dfd355213b0d5fbf9d5e6fdca5cb4` including tests; no-test core hash `aee8f89ab373234b00879f5b7ebd760c28f2ada3e4099755452fa53c96ae6083`.
- Candidate `tui/src` and root source trees are not identical. `tui/src/server.ts` contains behavioral Ptah-only tool and output-guard assembly.
- Compiled `dist` exists but is not identical: Pehlichi 464 files, Luna 460, Ptah 472; SHA-256 tree hashes are respectively `9af2ccd915c09acb9564ca1f24df3f2b2ab79e06a55fd8c2dce6aa4284621a18`, `bff92b5497094745e27b988d1593a55b922af605ce4ebc7da14f803fba8c0107`, and `a76b696823bb3295a399aa657edcce0b87cc06ad97fc2ac67b871499b04a0db7`.
- Root lockfiles are identical. Package manifests differ by identity/scripts; Ptah workspace/tsconfig differs. TUI lock/workspace/tsconfig inputs are identical while TUI manifests differ.
- Test lists differ: Pehlichi includes workspace-override coverage; Ptah server behavior tests currently have four failures.

Every candidate file and its three hashes/status is in `TRIO-001-RUNTIME-PARITY.json`. A hostile detector self-test copied identical fixtures under `/tmp`, changed one byte, and detected divergence.

## Dependencies and portability

All trio manifests use `file:../../lab-utilities/lab-memory` and `file:../../lab-utilities/lab-store`; Playwright is the principal runtime package dependency. External execution includes Node, git, shell/process, `rg`/grep, Python, `gbrain`, SSH/Termux helpers, and Playwright Chromium. Network integrations include model vendors, DuckDuckGo, Matrix, IKBI, Luak, and lab bridges. Local-model assumptions include Ollama at 11434 and llama.cpp at 8080.

The runtime embeds `/pehverse` state/repository paths, `/tmp` execution paths, `~/bok` credential fallback, and `.bun/bin/gbrain`. It requires installed dependencies and, for consumers/dynamic loading, compiled outputs. Environment variables, credentials classes, paths, ports, manifest content/hashes, and complete topology are enumerated in `TRIO-001-DEPENDENCIES.json`.

## Tool and authority inventory

`TRIO-001-TOOLS.json` records 81 exported tool specifications with exact JSON schemas, defining files, handler modules, advertised/executable surfaces, effects, approval classification, workspace/credential/network/subprocess/persistence behavior, delegation/unattended reachability, receipts, and known tests.

The operative policy is a name allowlist when writes are disabled and an allow-all registry when writes are enabled. It is not a capability model. `terminal` and `process` are in the base registry, optional Ptah work-order/Occasio tools cause assembly divergence, and cron construction can cause persistence/rearming before a tool call is approved. Detailed caller-to-effect traces are in `TRIO-001-AUTHORITY-PATHS.json`.

## lab-agent-core assessment

`lab-agent-core` appears to have been created as an extracted/generic agent loop, tool/shadow foundation and test bed. No live trio, Howa, IKBI, lab-memory, or lab-store import was found; trio manifests link only lab-memory and lab-store. It has drifted substantially: the trio has a much larger runtime and nearly every semantically corresponding core implementation differs outside the small historical skeleton.

Its loop/driver/tool abstractions and tests are useful historical architecture/evidence, but adopting it now would be a redesign and would conflict with user-owned modifications in `src/loop.test.ts`, `src/shadow.test.ts`, and `README.md`. Recommendation: retain as historical evidence and mine test concepts; rebuild a shared runtime only under a later locked design. Do not archive/delete or declare it the live source of truth now.

## Howa integration

Howa selects agents through its adapter/config layer and agent IDs, supplies model/provider configuration, and creates disposable fixtures under its state-root fixture area (or `/tmp/howa`). Its Peh HTTP adapters send a caller-controlled workspace field to trio HTTP and do not attach an Authorization header. Mechanic/direct adapters submit repository workspaces and auto-deny approval prompts.

Howa observes responses/events, filesystem artifacts and diffs, then scores success against fixtures/oracles and stores receipts under its state root. That scoring is observation, not trio-side authorization. No live Truth Firewall import/call was found in Howa. Howa was not changed.

## Truth Firewall and IKBI

The standalone implementation census is in `TRIO-001-TRUTH-FIREWALL-CENSUS.md` and `.json`. The two cited IKBI commits exist and introduced an advisory-only local port. Current IKBI additionally has a separately named production-evidence layer that can load an operator module and inject bounded evidence into builder/critic model context. Reader failure is recorded but build cognition proceeds without evidence; it is decision-influencing context, not unavoidable enforcement.

## Commands and verification

Read-only discovery used `git status/branch/rev-parse/remote/log/diff`, `rg`, `find`-equivalent scoped walkers, `sha256`, source imports for exported schemas, `systemctl show/is-active`, listener/process inspection, and non-task HTTP probes. Tests:

- Pehlichi narrow containment: 61 pass, 0 fail.
- Pehlichi full: 364 pass, 0 fail.
- Luna full: 355 pass, 0 fail.
- Ptah full: 354 pass, 4 pre-existing failures.
- Trio typechecks: all pass.
- Truth Firewall: 18 compiled test files pass; typecheck passes. Build was not run separately because it would rewrite compiled output in a user-modified parent worktree.

## Confidence limits

This was a scoped local census. Credential directories and secret env contents were excluded. Tests needing real credentials or external mutation were not run. Generated/dependency directories are excluded as stated in the JSON. Active service configuration was inspected without reading secrets. Static reachability establishes potential authority, not proof that every external credential currently works.

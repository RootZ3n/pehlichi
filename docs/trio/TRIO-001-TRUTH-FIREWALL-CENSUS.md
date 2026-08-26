# TRIO-001 Truth Firewall Census

Date: 2026-08-15 (America/Chicago)  
Scope: read-only discovery and safe local verification. The Truth Firewall was not modified.

## Location and repository state

The implementation exists at `/pehverse/repos/lab-utilities/truth-firewall`. It is **not a standalone Git repository**: its Git root is `/pehverse`, branch `hardening-sprint-codex`, HEAD `3b36576c2571532cb8d5d583a5b3d4ce862313dd`, with no configured remote. Scoped pre-existing state is modified `package.json` and untracked `LICENSE`; unrelated parent-worktree content was excluded. The last committed modification in the subtree was 2026-07-03T10:47:51-05:00.

## Authority ladder

These properties must not be collapsed into “works”:

| Property | Measured result |
|---|---|
| Implementation exists | Yes: claim gate, validators, receipts/store, hallucination/scorecard, runtime-truth graph/ledger/reader/drift/health/consistency, memory adapters, CLI |
| Implementation is tested | Yes: 18 compiled test files pass; current source typechecks |
| Implementation is connected | Yes, optionally: trio dynamic bridge; IKBI shadow port and production-evidence reader interface |
| Implementation is active | No standalone service/process/listener found. Runtime feature flags in credential-bearing service env files were intentionally not read, so optional in-process activation is unknown |
| Can influence decisions | Yes: trio and IKBI can insert advisory/evidence text into model context |
| Can enforce | The gate can return blocking verdicts to a cooperating caller, but observed live integrations do not make it an unavoidable success/mutation gate |
| Enforcement is bypass-resistant | No |

## Entrypoints, build, and operation

`package.json` exposes `truth` at `dist/src/cli.js`. Commands are `tsc`, `node --test dist/test/*.test.js`, `tsc --noEmit`, and `node dist/src/cli.js selftest`. CLI/library surfaces include verify, scorecard, replay, drift, contradictions, `RuntimeTruthReader`, and `reviewLabMemoryProposals`.

There is no HTTP server, port configuration, systemd unit, listener, or Truth Firewall process. The package runs on demand or is dynamically imported in-process. Its test command uses existing compiled `dist`; source typecheck passed. A build was not run because it would rewrite compiled output in a user-modified parent worktree.

## What it evaluates

The gate represents `VERIFIED`, `CONTRADICTED`, `UNSUPPORTED`, `STALE`, `PARTIAL`, and `UNVERIFIABLE`. It checks claims, evidence existence and freshness/scope, command/tool-style receipts, success/completion assertions, contradictions, missing/unknown evidence, and partial results. Deterministic validators cover files, diffs, commits/branches, configuration, dependencies, command/test receipts, HTTP receipts supplied by callers, memory facts, and completion breadth. Runtime-truth modules additionally analyze graph consistency, unsupported/stale/contradictory references, drift, health, and cognition summaries.

The store can durably record claims, receipts, verdicts, hallucinations, scorecards, proposal reviews, and runtime-truth ledgers. Command receipts capture cwd/repository/branch/commit context; file receipts hash content. Attribution and version binding are not universal: static/manual records and generic runtime-reader inputs originate at the caller boundary. Replay/idempotence is tested, but IDs include time/randomness and external mutable state limits universal replay safety.

## Forgery and failure behavior

Receipts are not signed and have no trusted-issuer boundary. A model or caller able to provide bundles/store input can invent claims, static/manual results, modes, evidence references, and asserted outcomes. Explicit evidence IDs, task binding, repo checks, hashes, and commit context reject some cross-task/cross-repo cases; they do not prove who produced a receipt or that a claimed firewall run occurred.

`runCommandReceipt` executes the caller's command with `shell: true`; `allowedCommands` is optional. This is suitable only for a trusted operator boundary and is unsafe as a model-controlled verification primitive. No command receipt was executed during this census.

When the standalone gate is actually called, missing/invalid evidence produces non-verified states. The integrations fail open with respect to the enclosing decision:

- Trio `truth-bridge.ts` catches import/reader failure and supplies no advisory context; proposal review is fire-and-forget.
- IKBI shadow mode drops missing, throwing, or non-`advisoryOnly` readers and continues cognition.
- IKBI production evidence records reader/load failure and continues builder/critic work without evidence.

An advisory result can therefore be described as enforcement by downstream prose unless the consumer preserves the distinction. The implementation's `advisoryOnly` marker helps, but is not an attestation.

## Integration census

### Pehlichi, Loony-Luna, and Mad-Ptah

All three contain the byte-identical `src/core/truth-bridge.ts`. When `LAB_TRUTH=1` or a Truth Firewall root is configured, it dynamically imports the compiled local facade and renders a clearly advisory cognition block into model context. Server assembly can invoke proposal review asynchronously. This is connected, shadow/advisory, and potentially decision-influencing. It cannot approve, install, execute, or block by itself.

### IKBI

The supplied commits exist:

- `6e34d6b90ae502c782330ee4e039f3ca549ab3a8` introduced `RuntimeTruthReaderPort`, summary records, `advisoryOnly`, events, and shadow tests.
- `0383df65f3f61325fc5c16ea857b2ce14096e1d6` introduced a per-deliberation reader provider.

Those historical claims are accurate for that bridge: a local structural port, no cross-repository import, no write/enforce authority, and no production reader wired then. Current IKBI also contains a distinct `src/modules/runtime-truth` production-evidence layer. It can load an operator module through `IKBI_RUNTIME_TRUTH_READER_MODULE` when `IKBI_RUNTIME_TRUTH_EVIDENCE=on`, bounds/freshness-filters evidence, injects it into builder and critic prompts, and emits `worker.runtime_truth` receipts. It can influence model output but does not block a build when unavailable.

### Howa, Osapa, and other lab projects

No Truth Firewall import/call was found in Howa. Osapa references found in the approved lab scope were documentation/integration discussion, not a proven live caller. No live import was found from lab-agent-core, lab-memory, or lab-store; the Firewall itself contains adapters for lab-memory proposals and IKBI receipts. Search did not establish any decision-blocking production caller.

## Hostile validation results

Safe existing tests and source-level adversarial analysis establish:

- Unsupported completion, missing evidence, failed receipts, stale/wrong-repo evidence, contradictions, partial evidence, paranoid-skeptic handling, wrong-task receipts, explicit evidence binding, and persisted idempotence are covered.
- Null/unavailable/throwing reader behavior is covered at IKBI integration boundaries and continues without enforcement.
- A forged unknown evidence ID does not bind; a caller-created stored receipt cannot be distinguished cryptographically.
- Evidence from another task is rejected. Cross-runtime/commit protection is partial because not every evidence class binds those values.
- No unforgeable proof exists that “the firewall passed” or even ran.
- Tests do not turn an advisory result into an unavoidable pre-success gate.

No external HTTP/account mutation, arbitrary command receipt, or credential-dependent test was run.

## Reuse assessment

The evidence taxonomy, deterministic validators, binding rules, graph/ledger/drift/health analysis, scope auditor, scorecards, replay tests, and proposal-review facade are useful inputs to a future evidence-evaluation engine behind a Trust Observatory. They should not be adopted as an enforcement boundary unchanged. Required later design dependencies include authenticated/signed evidence issuers, universal task/repository/runtime-tree/commit/tool-call binding, immutable durable records, deterministic replay rules, safe command execution disabled by default, and an unavoidable fail-closed consumer contract.

No Trust Observatory work was started.

## Verification and confidence limits

`npm test`: PASS, 18 compiled test files. `npm run typecheck`: PASS. Git history, process, service, listener, import, and configuration-name searches were read-only. Credential-bearing environment files were not opened, so in-process activation flags cannot be asserted. Documentation and tests were treated as claims and cross-checked against production call sites; “tested,” “connected,” “active,” “decision-influencing,” and “enforcing” remain separate conclusions.

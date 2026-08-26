# TRIO-001A Truth Firewall Classification

The Truth Firewall remains disconnected from execution under this work order. “Exists,” “tested,” “connected,” “active,” “decision-influencing,” “enforcing,” and “bypass-resistant” remain separate properties.

## Layer classification

### Mechanism

Reusable pure/general mechanisms include claim extraction/classification, deterministic validators, the Truth Gate, scope auditor, skeptic pass, receipt resolution, scorecards, hallucination records, durable store, replay, and runtime-truth graph/ledger/reader/drift/health/consistency analysis. These are generic mechanism candidates, not authority by themselves.

The CLI command runner is also a mechanism, but it executes caller-supplied commands with `shell:true` and only optional `allowedCommands`. It must not enter a model-controlled runtime guard.

### Policy

Policy includes the verdict taxonomy, blocking-verdict set, high-risk claim types, paranoid/skeptic behavior, completion breadth rules, freshness limits, scope/repository binding expectations, and whether partial/unverifiable results may be returned as success. These decisions need an explicit versioned runtime safety policy. They must not be changed by an identity capsule if they protect unsupported claims, false success, disclosure, or authority.

Role-specific completion content—such as Ptah repair sections or what constitutes a satisfactory creative asset—belongs in skills. The runtime policy only decides whether claimed facts have acceptable evidence and whether a result is complete/partial/blocked.

### Evidence model

Useful evidence-model pieces are typed claims, receipts, verdicts, task status, evidence references, file hashes, cwd/repository/branch/commit context, timestamps/freshness, contradiction relationships, scorecards, and replay records. Current binding is uneven: command receipts carry richer context than generic/manual/runtime-reader records, IDs are not signatures, and callers can construct evidence.

The target generic model must bind every accepted evidence item to task/run, agent/runtime manifest version, repository/workspace identity, commit/tree when applicable, tool-call ID, arguments digest, handler identity/version, result digest, issuer, timestamp, and policy/guard version.

### Adapters

Current adapters cover IKBI receipts, lab-memory records/proposals, memory governance/reference indexes, command/file/HTTP evidence, and the trio cognition facade. Adapter code is reusable only behind local ports and trusted issuer boundaries. Agent distributions may not dynamically import the sibling Truth Firewall repository in the target layout.

An adapter may translate evidence; it cannot upgrade caller assertions into trusted receipts. External adapter failure must have an explicit policy result rather than silently producing “no evidence.”

### Integrations

- Trio `truth-bridge.ts`: optional dynamic import, advisory context, asynchronous proposal review, fail-open. Connected when configured; not enforcement.
- IKBI runtime-truth-shadow: advisory-only local port and event; reader failure is dropped. Not enforcement.
- IKBI production-evidence layer: bounded evidence is injected into builder/critic prompts and receipts are emitted; work continues if unavailable. Decision-influencing, not blocking.
- CLI/library gate: can return blocking states to a cooperating caller, but the caller can omit it or misrepresent that it ran.

None is an unavoidable pre-success/pre-response/pre-mutation boundary.

### UI possibilities

A future UI can show claim-by-claim verdicts, evidence provenance/freshness, contradictions, partial/unknown states, guard version, runtime/commit binding, advisory versus enforcing mode, and whether the evaluator actually ran. It must not render a green/pass state from model prose or an advisory summary. Missing/unavailable evaluation is a distinct visible state.

No Trust Observatory UI is created here.

### Enforcement gaps

- No authenticated or cryptographic evidence issuer.
- Static/manual receipts and runtime-reader inputs can be caller-forged.
- Not every receipt binds task, runtime manifest, commit/tree, invocation, result, and policy version.
- Stores are not established as immutable/tamper-evident enforcement records.
- Current consumers can skip the gate and continue on failure/timeout.
- Advisory text can influence a model but cannot constrain the executor or response serializer.
- Caller-supplied shell verification can itself create side effects.
- No universal finalization call covers HTTP, streaming, Matrix, direct library, CLI, cron, delegation, bridge, and background completion.
- No unforgeable proof distinguishes “passed” from “did not run.”

## Pieces suitable for a generic output/evidence guard

The future common runtime guard can reuse or adapt:

1. Pure claim types and verdict taxonomy.
2. Completion scope auditing and partial/unsupported/contradicted handling.
3. Deterministic, side-effect-free validators over already-captured evidence.
4. Receipt resolution with stronger universal binding.
5. Contradiction/freshness analysis.
6. Scorecard/replay data structures for auditability.
7. Memory proposal review as an advisory downstream consumer, not a mutation approver.

These complement the existing Velum tool-output guard. Velum protects the model from untrusted tool text; an evidence guard protects callers from unsupported success/output claims. Neither substitutes for authentication, authority policy, workspace containment, or mutation approval.

Unsafe/non-reusable without redesign:

- caller-selected `shell:true` command execution;
- caller-created manual/static receipts treated as trusted;
- dynamic cross-repository import;
- fail-open optional invocation;
- model prompt context treated as enforcement;
- agent-specific routing, report prose, or completion conventions in the generic policy.

## Advisory-only pieces

Runtime cognition summaries, graph/health/drift summaries placed in prompts, IKBI shadow events, builder/critic evidence context, scorecards, proposal-review commentary, and UI recommendations are advisory. They may inform a decision but cannot be described as a block, approval, proof, or enforced invariant.

## Requirements for bypass-resistant enforcement

1. Capture evidence inside the trusted runtime dispatcher, not from model-authored result JSON.
2. Mint opaque/authenticated receipts with a trusted issuer and universal task/run/runtime/tool/result binding.
3. Store or chain records tamper-evidently and make replay deterministic against versioned policy and immutable inputs.
4. Invoke one mandatory finalizer after tool execution and before every success/completion response, checkpoint promotion, durable write/install, delegation completion, cron completion, and bridge result acknowledgment.
5. Cover HTTP, streaming, Matrix, direct library/CLI, background, and recovery paths through the same call; CI must prove no alternate success serializer exists.
6. Fail closed on evaluator absence, error, timeout, unknown policy version, missing evidence, or unbound evidence for protected claims. Partial results remain explicitly partial.
7. Separate evaluation from execution: validators consume captured results and cannot run caller commands or mutate state.
8. Make safety policy and output guard non-disableable by capsules, models, caller request fields, or ordinary deployment flags.
9. Authenticate task-producing callers and authorize mutation independently; an evidence pass never grants authority.
10. Emit an attributable enforcement receipt that ordinary callers cannot forge and that UI/clients verify before displaying success.

## Recommended architecture placement

Place the pure evidence types, validators, finalizer, and trusted receipt interface under `runtime/safety/evidence-finalizer/`, identically in all distributions. Keep source-specific translators under local `runtime/adapters/` or versioned capability packs. Put policy in a versioned common runtime policy file. Put Ptah repair criteria and report format in Ptah skills. Keep exploratory summaries and scorecards labeled advisory in UI/data channels.

Do not connect or activate these pieces until characterization tests, issuer/storage design, failure semantics, and the complete unavoidable call graph are separately approved.

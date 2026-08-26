# TRIO-001A Minimal Convergence Plan

This plan is not authorized for implementation by TRIO-001A. TRIO-000 remains paused until the operator approves a later work order.

## Preconditions

1. Re-snapshot branch, HEAD, remotes, tracked/untracked state, and hashes in every repository immediately before implementation. Stop on overlap with user changes. Preserve Luna demo assets, lab-agent-core tests/README, lab-store checkpoints, and all other recorded work.
2. Pin the five baseline blob hashes in `TRIO-001A-DIVERGENCE-MATRIX.json`. If any changed, re-adjudicate rather than applying stale patches.
3. Use temporary clean fixtures/worktrees for install/build characterization; do not rewrite committed `dist` or user files to discover behavior.
4. Do not restart services, change credentials, enable packs, or enable mutation during convergence.

## Ordered plan

### 1. Add characterization tests before moving code

Create the same common assembly test harness in all three repositories and capture current behavior explicitly:

- generic server construction, exported legacy aliases, env-to-config mapping, default port/workspace/checkpoint/task/correlation identity;
- exact tool lists with packs disabled and with injected test-only pack declarations;
- work-order store/tool behavior using temp directories only;
- Occasio category mapping, persistence-before-routing, partial bridge failure, and configurable target routing using fakes only;
- output-guard transformation, model-history input, finding count, receipt attribution, HTTP response representation, streaming, Matrix-via-HTTP, and direct-library paths;
- current 404 behavior for `/work-orders`, `/reports/models`, and `/onboarding` so removing an aspirational test is an explicit contract decision;
- package scripts/build policy and TypeScript config equivalence in disposable fixtures.

All tests must avoid credentials, real services, persistent lab paths, and writes outside temporary directories.

### 2. Define schemas and manifests

Add versioned schemas for capsule, trusted deployment, capability-pack manifest, routing table, and runtime manifest. Define a generic `AgentRuntimeConfig` containing identity values but no identity branches. Define the authority intersection: capsule may request a pack; deployment must permit it; runtime safety invariants cannot be disabled.

Create `runtime/manifest.json` from an explicit allowlist, not directory heuristics. It records source paths/hashes, compiled-output paths/hashes when built, tool schemas, route schemas, pack interfaces, common test inventory, and forbidden imports.

### 3. Genericize server assembly without feature changes

Extract one `createAgentServer(config)` with identical bytes. Move name, env aliases, ports, workspace/default roots, checkpoint namespace, task/correlation prefixes, and startup glyph/text into capsule/deployment data. Provide tested compatibility wrappers for existing exported symbols and env variables outside `runtime/`.

At this stage preserve current effective pack activation through test-only migration data but do not deploy or restart. Do not add routes or autonomy.

### 4. Extract work orders without deleting Ptah behavior

Move store, lifecycle, tools, and any retained HTTP adapter into `capability-packs/work-orders/v1`. Keep identical local copies in all distributions and default the pack off. Move Ptah selection guidance, repair workflow, completion evidence, report sections, and voice into Ptah skills/capsule. Supply persistence path through trusted deployment data.

Do not make work-order mutation read-only by label: `wo_transition` is a durable mutation and needs the later containment policy.

### 5. Extract Occasio as a generic pack

Create `capability-packs/occasio/v1` with injected work-order and routing ports. Remove hardcoded Ptah/Pehlichi/Luna names, `/chat`/`/intake` routes, source strings, and prose. Put those values in Ptah routing/capsule/skills. Return a structured result that separately states persisted, routed, partial, and failed.

Keep it inactive in every distribution during convergence. Tests use fake routes and temp persistence only.

### 6. Make output guarding a common safety invariant

Move the existing pure Velum mechanism under `runtime/safety/output-guard`, preserve behavior with characterization tests, and wire it unconditionally at every tool-result-to-model boundary. Propagate a version-bound finding/evidence record through `KernelChatSession` and common HTTP/stream/direct responses. Do not expose raw hostile content to ordinary response consumers merely to satisfy the old Ptah test; define restricted evidence access separately.

No capsule or production flag may disable the guard. This step only converges the existing guard; broader Truth Firewall enforcement remains disconnected until separately approved.

### 7. Resolve Ptah's four failing contracts explicitly

- Work orders: either implement the authenticated generic `work-orders/v1` HTTP adapter identically and default-disabled, or replace the Ptah test with a documented retirement assertion. Do not add a Ptah-only route.
- Reports: define a generic versioned reports pack/API or retire the nonexistent route and keep report-store library tests. Avoid embedding Ptah role/model conventions in runtime.
- Onboarding: move presentation to UI/pack with a generic data contract or retire the nonexistent server route.
- Velum: convert to a common safety integration test covering model history plus response evidence. This test should pass only when the guard is unavoidable, not merely when a flag is set.

Each disposition requires an operator-visible compatibility note. No silent deletion or test skip is allowed.

### 8. Remove sibling runtime imports

Replace `file:../../lab-utilities/lab-memory` and `lab-store` runtime dependencies with local ports and locally contained implementations/adapters in each standalone distribution. Preserve data formats and migration behavior with fixture tests. A build-time publishing/sync source may exist later, but the shipped repository must run with no other Pehverse checkout.

### 9. Normalize build/UI metadata

Normalize pnpm build policy, TypeScript config, common test list, common startup/repl commands, and the private UI package name. Retain agent-visible identity only through capsule data. Validate clean install/build/typecheck/test in disposable fixtures before touching tracked generated output.

### 10. Enforce parity in CI

Add a deterministic verifier that:

- reads the explicit runtime manifest;
- rejects missing, extra, or different source/runtime test/tool schema/policy/server assembly files;
- compares compiled output produced in clean fixtures;
- detects direct or dynamic cross-repository imports and sibling `file:` dependencies;
- compares common test lists independent of ordering;
- performs a one-byte mutation self-test proving failure;
- emits machine-readable differences and exits nonzero.

Run it in every repository's CI and in a trio aggregate check. Direct edits inside the runtime boundary must fail unless the same canonical change updates all three distributions.

### 11. Verify without deployment

Run narrow characterization/safety/pack tests first, then full tests, typechecks, clean builds, manifest verification, and parity checks in all three. Measure the complete target runtime tree; do not infer equality from the five-file fix. Record pre-existing failures separately from regressions.

### 12. Request operator approval before TRIO-000

Present the measured parity result, explicit disposition of all four Ptah tests, compatibility aliases, no-cross-repo import proof, and unchanged pack/write activation. Only after approval may TRIO-000 restart as one canonical runtime containment patch propagated identically.

## Acceptance criteria

- User work remains byte-preserved outside explicitly approved files.
- Runtime manifest and every listed source/common-test/generated file are identical.
- Server contains no agent-name conditionals or hardcoded pack activation.
- Work-order and Occasio implementations are identical, versioned, present, and inactive unless capsule plus deployment permit them.
- Output guarding is an unavoidable runtime invariant on all tool-result model paths.
- Ptah's four failing contracts are passing generic contracts or explicitly retired with tests and compatibility notes.
- CI detects a one-byte divergence and forbidden sibling import.
- No new write, delegation, cron, browser/account, brain, skill, memory, work-order, or Occasio authority is activated.

## Smallest safe next implementation work order

Authorize **characterization and manifest scaffolding only**: steps 1 and 2, plus the parity verifier's read-only/self-test skeleton from step 10. It should add identical tests/schemas/verifier files to all three without moving runtime code, changing service configuration, resolving the four tests by invention, activating a capability, or restarting TRIO-000. This creates a trustworthy lock before convergence edits.

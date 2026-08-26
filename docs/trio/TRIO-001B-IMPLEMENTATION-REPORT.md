# TRIO-001B Implementation Report

Date: 2026-08-15  
Scope: characterization and enforcement scaffolding only  
Disposition: uncommitted; no push; no runtime, service, or deployment behavior changed

## Outcome

TRIO-001B added identical, read-only boundary/parity scaffolding and identical characterization tests to Pehlichi, Loony-Luna, and Mad-Ptah. The measured verdict remains `BLOCKING_DIVERGENCE`. This work does not improve runtime safety by itself and does not authorize restarting TRIO-000.

The verifier reports five blockers: the explicit `tui/src/server.ts` blocking exception, three divergent common UI/safety test files, and one common test missing from Luna and Ptah. It reports no unclassified executable, symlink, unexpected file, or classification violation under the current manifest.

## Preservation gate and repository state

Before additions, the new target directories `trio/` and `scripts/trio/` did not exist in any trio repository. No target overlapped known user work. Luna's pre-existing modified demo images and untracked `squirrel-chef.jpg` were not touched. Nothing was reset, cleaned, stashed, reformatted, committed, pushed, or deployed.

| Repository | Absolute path | Branch | HEAD at verification | Pre-existing user work preserved |
|---|---|---|---|---|
| Pehlichi | `/pehverse/repos/ecosystem/pehlichi` | `peh-on-phone` | `12a6f9b38493f3f2cf789125fb3bc5abc4fca4d9` | none outside this work order was observed |
| Loony-Luna | `/pehverse/repos/ecosystem/loony-luna` | `peh-on-phone` | `a2bd67dd929e97bd8a9c26904d82bbc26cf39cf7` | four modified demo image/metadata files and one untracked squirrel image |
| Mad-Ptah | `/pehverse/repos/ecosystem/mad-ptah` | `peh-on-phone` | `0562cc70e3eebfeef4ab1718f186c3e67be8fc74` | none outside this work order was observed |

`RootZ3n/lab-agent-core` was not modified.

## Files added

The following 19 files were added with identical bytes to each trio repository:

- `scripts/trio/current-behavior.characterization.test.mjs`
- `scripts/trio/scaffolding.test.mjs`
- `scripts/trio/verify-local.sh`
- `scripts/trio/verify-runtime-parity.mjs`
- `scripts/trio/verify-runtime-parity.test.mjs`
- `trio/boundary-manifest.json`
- `trio/capability-packs/model-reports.json`
- `trio/capability-packs/occasio.json`
- `trio/capability-packs/onboarding.json`
- `trio/capability-packs/work-orders.json`
- `trio/capsules/loony-luna.json`
- `trio/capsules/mad-ptah.json`
- `trio/capsules/pehlichi.json`
- `trio/runtime-manifest.characterization.json`
- `trio/schemas/boundary.schema.json`
- `trio/schemas/capability-pack.schema.json`
- `trio/schemas/capsule.schema.json`
- `trio/schemas/deployment.schema.json`
- `trio/schemas/runtime-manifest.schema.json`

All three capsule records are distributed in every repository; their capsule data intentionally differs by agent, while the distributed files remain identical.

Pehlichi additionally contains the required report artifacts under `docs/trio/`:

- `TRIO-001B-IMPLEMENTATION-REPORT.md`
- `TRIO-001B-BOUNDARY-SCHEMA.json`
- `TRIO-001B-CAPSULE-SCHEMA.json`
- `TRIO-001B-DEPLOYMENT-SCHEMA.json`
- `TRIO-001B-CAPABILITY-PACK-SCHEMA.json`
- `TRIO-001B-RUNTIME-MANIFEST-SCHEMA.json`
- `TRIO-001B-PARITY-RESULT.json`
- `TRIO-001B-COMPATIBILITY-CONSUMERS.md`

## Byte-identity proof

A sorted, path-bound SHA-256 digest over the 19 common files produced the same tree digest in every repository:

`c3e38184116c0ca7a803d7e9b80a8ba7b3750d7a7516dc18dc34a08fe7bab81c`

A per-path byte comparison also found zero mismatches. The schema copies in `docs/trio/` are copied from the corresponding common schema files; final validation rechecks their hashes and JSON syntax.

## Boundary and schema decisions

The boundary manifest uses the required classes and applies the most-specific matching rule deterministically. Executable files that match no rule are blocking. Generated/dependency exclusions are enumerated in the manifest rather than inferred. In-scope symlinks are rejected.

`tui/src/server.ts` is not declared identical. It is an explicit blocking exception with current class `obsolete-pending-review`, target class `runtime-identical`, and expiration before trio convergence and any TRIO-000 restart.

The capsule schema is closed and contains identity, personality references, skill selection, requested capability activation, routing preferences, model defaults, memory namespace, branding, and completion/report references. It contains no executable handlers, authority grants, raw credentials, filesystem roots, policy bypasses, or safety-disable switch.

The four capability-pack characterization manifests are inactive and default-off. They describe work orders, model reports, onboarding, and Occasio without adding handlers or endpoints. The deployment schema separates listen configuration, credential handles, approved workspace-registration sources, service endpoint handles, transports, checkpoint/receipt handles, resource limits, and deprecated compatibility adapters. It prohibits unknown fields and provides no plaintext credential, caller-selected root, or runtime safety-disable field.

The runtime manifest is explicitly non-authoritative:

- `status: "characterization"`
- `trusted: false`
- `deployable: false`
- verification state `divergent`

Reserved digest, version, platform, build, authority, and verification fields are present but are not signed, approved, or represented as trusted.

## Current parity verdict

Source: `docs/trio/TRIO-001B-PARITY-RESULT.json`, generated 2026-08-15T17:40:47.362Z.

| Result | Count |
|---|---:|
| Verdict | `BLOCKING_DIVERGENCE` |
| Blocking items | 5 |
| Identical files | 136 |
| Divergent classified files | 3 |
| Missing common files | 1 |
| Unexpected files | 0 |
| Allowed variable differences | 10 |
| Unclassified executables | 0 |
| Symlinks | 0 |
| Classification violations | 0 |

The five historically identified divergent paths are all accurately reported in `legacyComparisons`: `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `tui/package.json`, and `tui/src/server.ts`. Their per-repository SHA-256 hashes are recorded in the JSON artifact. The first four are present-layout deployment differences; this does not grandfather them as permanent differences. The server is a live behavioral blocker.

Additional blocking common-test discrepancies are:

- divergent: `tui/src/audit-fixes.test.ts`
- divergent: `tui/src/lab-cohesion.test.ts`
- divergent: `tui/src/write-safety.test.ts`
- missing in Luna and Ptah: `tui/src/workspace-override.test.ts`

## Characterization defects confirmed

The common characterization suite names unsafe behavior as a known blocking defect; passing means the defect was reproduced, not accepted.

- With no authentication token configured, all three source assemblies route an unauthenticated task request and reach body validation (`400`) rather than rejecting authentication. Earlier live differences caused by configured deployment tokens do not remove the source defect.
- An arbitrary `/etc` override is rejected when configured roots are absent, but configuring the broad ecosystem parent authorizes a sibling repository workspace.
- `AGENT_FS_UNRESTRICTED=true` bypasses ordinary workspace resolution and is accepted through ordinary server/direct `runAgent` construction. A safety helper exists but is optional rather than unavoidable.
- A persisted active cron job rearms and executes after handler construction.
- Independent construction-time kill switches for the required mutation classes are absent.
- Ptah's work-order endpoint is absent (`404`).
- Model-reports and onboarding endpoints are absent (`404`).
- In Ptah, Velum findings are discarded by the ordinary KernelChatSession/HTTP path, while the original unsafe tool output remains visible.

No destructive path, live credential, external account, or deployed service was exercised. Tests used loopback servers and temporary directories.

## Ptah's four retained failing contracts

The tests were not removed, weakened, or changed:

- work-order endpoint: retained future generic contract;
- model-reports endpoint: retained future generic contract;
- onboarding endpoint: retained future generic contract;
- Velum propagation/output guarding: common safety integration contract.

The first three remain inactive/unimplemented under this order. The Velum failure demonstrates that the mandatory common safety mechanism is not connected through the ordinary output path.

## Verification and results

Commands were run from each repository unless otherwise noted.

| Command/suite | Pehlichi | Loony-Luna | Mad-Ptah |
|---|---:|---:|---:|
| `node --import tsx scripts/trio/current-behavior.characterization.test.mjs` | 8 pass, 2 Ptah-only skips | 8 pass, 2 Ptah-only skips | 10 pass |
| `node --test scripts/trio/verify-runtime-parity.test.mjs` | 8 pass | 8 pass | 8 pass |
| `node --test scripts/trio/scaffolding.test.mjs` | 5 pass | 5 pass | 5 pass |
| `npm test` | 364/364 pass | 355/355 pass | 354 pass, 4 fail of 358 |
| `npm run typecheck` | pass | pass | pass |

The Ptah full-test failures are the same four previously established contract failures, not new scaffolding regressions. Test logs were retained temporarily under `/tmp/trio-001b-*-test.log` and `/tmp/trio-001b-*-typecheck.log` during this work order.

The parity verifier command was:

`node scripts/trio/verify-runtime-parity.mjs --json`

It exited nonzero as required for current blockers. Human-readable output is available by omitting `--json`; `scripts/trio/verify-local.sh` runs the local scaffolding checks and parity check without modifying repository files.

## Hostile verifier validation

Temporary fixture attacks produced the required results:

| Attack | Result |
|---|---|
| change one runtime byte | blocking divergence detected |
| add unclassified executable | unclassified executable detected and blocked |
| delete common file | missing file detected and blocked |
| replace in-scope file with symlink | symlink detected and blocked |
| reorder manifest entries | identical semantic result; order did not bypass matching |
| alter capsule-only data | reported as allowed capsule difference; no false runtime divergence |
| classify a protected runtime path as generated | classification violation detected and blocked |
| dirty one repository outside hashed runtime | dirty state remained visible without false runtime divergence |

The verifier reads only repository content and Git metadata. Its tests write only temporary fixtures.

## Compatibility consumers

Detailed evidence and confidence limits are in `TRIO-001B-COMPATIBILITY-CONSUMERS.md`. Proven current consumers include:

- active trio systemd services that directly execute each repository's `tui/src/server.ts`;
- active shared Matrix bridge services consuming agent URL/token handles and `/converse` or `/chat`;
- trio HTTP/UI consumers of `/chat`, `/converse`, `/chat/stream`, health/info/tools/session/receipt routes and response content/tool-call fields;
- Howa Peh adapters consuming `/api/chat` or `/chat`, response `content`, and a caller workspace field, currently without an Authorization header;
- durable agent-specific checkpoint namespaces.

No external cross-repository import of the agent-specific server factories was proven. REPL/UI references to absent work-order, reports, and onboarding endpoints are stale or aspirational consumers, not proof of a working compatibility contract. Credential-bearing env-file contents were deliberately not read.

## Exact blocker preventing TRIO-000

The live `tui/src/server.ts` files remain behaviorally and byte divergent. Ptah alone contains work-order, Occasio, and Velum-related control-flow differences, and mandatory output guarding is not unavoidable across the trio. Applying containment to one server would violate the binding byte-identical-runtime rule; applying an apparently common patch before separating capsule, capability-pack, deployment, compatibility, and canonical runtime concerns risks preserving or expanding the divergent behavior. The verifier also identifies four common-test-layer parity blockers that must be resolved without weakening their contracts.

TRIO-000 therefore remains blocked pending operator approval after convergence. The present authentication, unrestricted-filesystem, broad-root, cron, mutation-control, and output-projection defects remain live risks; scaffolding does not contain them.

## Smallest safe next convergence work order

Authorize a tests-only common-contract convergence first: replace agent-specific naming/configuration in the three divergent common test files with a shared data-driven harness, and install `workspace-override.test.ts` identically in Luna and Ptah. Preserve all assertions, the four Ptah failing contracts, and current defect characterization. Require the parity verifier to reduce those four blockers without changing runtime behavior.

After that evidence-only step, a separate operator-approved server convergence order can extract thin compatibility/deployment launchers, capsule data, and inactive generic pack seams while creating one byte-identical canonical server/runtime core. It must keep every pack default-off, introduce no new writes or autonomy, and demonstrate full-tree parity before TRIO-000 is restarted.

## Unresolved operator decisions and confidence limits

- The exact canonical compatibility lifetime and migration sequence for active systemd, Matrix, Howa, and checkpoint consumers remains to be approved.
- The future safe projection/evidence-store contract and bypass-resistant Velum enforcement boundary remain undesigned and must not be inferred from this scaffolding.
- The concrete in-runtime replacement/import plan for lab-memory and lab-store remains future work.
- The actual configured Howa Mechanic adapter needs characterization before any compatibility promise.
- Secret environment contents and consumers outside approved lab roots were not inspected, so no claim of exhaustive external-consumer discovery is made.
- The boundary manifest is a characterization artifact. Zero currently unclassified executables means zero under its declared roots/rules and scan logic, not proof that the runtime boundary is complete or trusted.

No claim is made that the trio is safe, trusted, deployable, or runtime-identical.

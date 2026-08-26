# TRIO-001C Verifier and Schema Hardening Report

Date: 2026-08-15  
Disposition: uncommitted, not pushed, no service or runtime change  
Runtime containment: not implemented

## Outcome

The TRIO-001B hostile verdict was independently reproduced before verifier changes. The pre-fix suite ran 44 attacks/invariants: 38 failed because the old verifier accepted false parity or emitted an unstructured failure, while six narrow pre-existing defenses passed. The exact baseline is preserved in `TRIO-001C-PREFLIGHT-FAILURES.json` and `/tmp/trio-001c-preflight.tap`.

The hardened verifier passes all 44 post-fix hostile cases and the original eight TRIO-001B self-attacks. Against the real repositories it operates successfully and returns `BLOCKING_DIVERGENCE`, not parity.

No production source, production test, UI, service, deployment file, root package manifest, root lockfile, or live process was changed. `lab-agent-core`, Howa, and the Truth Firewall were not modified. Luna's pre-existing image and metadata changes were not touched.

## Files changed in every trio repository

The following scaffolding files have identical bytes in Pehlichi, Loony-Luna, and Mad-Ptah.

Modified from TRIO-001B:

- `scripts/trio/current-behavior.characterization.test.mjs`
- `scripts/trio/scaffolding.test.mjs`
- `scripts/trio/verify-local.sh`
- `scripts/trio/verify-runtime-parity.mjs`
- `scripts/trio/verify-runtime-parity.test.mjs`
- `trio/boundary-manifest.json`
- `trio/schemas/boundary.schema.json`
- `trio/schemas/capability-pack.schema.json`
- `trio/schemas/capsule.schema.json`
- `trio/schemas/deployment.schema.json`
- `trio/schemas/runtime-manifest.schema.json`

Added:

- `scripts/trio/package.json`
- `scripts/trio/package-lock.json`
- `scripts/trio/preflight-hostile-audit.test.mjs`
- `scripts/trio/schema-validation.mjs`
- `scripts/trio/schema-validation.test.mjs`
- `scripts/trio/strict-json.mjs`

`scripts/trio/verify-local.sh` has mode `0755` in every repository. The generated `scripts/trio/node_modules` directories contain the verifier-only installation and are explicitly attested/excluded; they are not source changes.

The combined path-bound SHA-256 over all files in `scripts/trio` and `trio`, excluding `scripts/trio/node_modules`, is identical in all three repositories:

`9912dcdc352bea19147a9fc16800bcbc1a3c01d0a01ae69df45a022a9397a5ee`

Pehlichi additionally contains the six required TRIO-001C documents under `docs/trio/`.

## Pre-fix failures reproduced

The unchanged TRIO-001B verifier falsely accepted executable divergence under capsule, branding, deployment, generated, fixture, compatibility, UI, skill, and obsolete classifications. It also failed to govern package behavior, service units, browser code, compiled output, executable profile overlays, repository identity, rules, schemas, JSON duplicates/limits, ambiguous paths, file modes, ignored executables, lockfiles, and structured malformed-input handling.

Specific baseline totals:

- 44 cases executed;
- 38 unsafe failures reproduced;
- four symlink target cases were already blocked;
- manifest reordering and safe capsule-data variation already behaved correctly in the sampled old implementation.

The pre-fix test is retained as historical evidence and is not used as the post-fix acceptance suite because it targets the intentionally removed positional TRIO-001B API.

## Hardened repository identity

The verifier requires the labeled slots `pehlichi`, `loony-luna`, and `mad-ptah`. Paths are operator inputs; no machine-specific repository prefix exists in the manifest.

Each slot binds:

- a unique `realpath` (including rejection of duplicate symlink aliases);
- expected repository basename;
- normalized Git origin identity (`github.com/RootZ3n/<repo>`);
- root and TUI package names;
- the slot's expected capsule path and capsule identity;
- Git HEAD, branch, and dirty state.

The real bindings were:

| Agent | Canonical path | HEAD | Remote identity |
|---|---|---|---|
| Pehlichi | `/pehverse/repos/ecosystem/pehlichi` | `12a6f9b38493f3f2cf789125fb3bc5abc4fca4d9` | `github.com/RootZ3n/pehlichi` |
| Loony-Luna | `/pehverse/repos/ecosystem/loony-luna` | `a2bd67dd929e97bd8a9c26904d82bbc26cf39cf7` | `github.com/RootZ3n/loony-luna` |
| Mad-Ptah | `/pehverse/repos/ecosystem/mad-ptah` | `0562cc70e3eebfeef4ab1718f186c3e67be8fc74` | `github.com/RootZ3n/mad-ptah` |

## Closed behavioral inventory

The boundary has seven classes: behavior-identical, validated-variable-data, inert-variable-asset, generated-behavior-identical, documentation, test-behavior-identical, and quarantined-blocking-divergence. Unknown files fail closed.

Only three exact capsule JSON paths and three exact inert root PNG paths are variable classes. Variable content must be non-executable, mode/type conformant, non-production-reachable under this characterization, and schema- or magic-validated. Broad source, UI, skill, deployment, compatibility, generated, and obsolete trees cannot grant variable behavior.

Behavior-bearing UI, executable profiles, skills, launch/deployment overlays, server code, and compiled output either compare identically or remain explicitly quarantined blockers. Quarantine is transitional, blocking, and expiring even when sampled bytes happen to match.

The six exclusions are closed and attested: Git metadata, three dependency trees, coverage cache, and `.next` cache. Arbitrary ignored directories cannot be added as exclusions. Git-ignored and untracked files outside those exact trees are scanned.

## Schema enforcement

Ajv 8.20.0 is pinned in an isolated development-only package and validates Draft 2020-12 schemas. The boundary manifest is strict-parsed, schema-validated, and contract-validated before classification or hashing. Capsules, deployments, capability packs, and runtime manifests use the exact same validator.

Duplicate keys are rejected before ordinary JSON parsing. Limits are 1 MiB per JSON file, depth 32, 4,096 items/members per collection, and 65,536 decoded characters per string. Unknown properties and unsupported versions reject.

The initial 8.17.1 development pin was audited before finalization and found subject to a moderate `$data` ReDoS advisory. It was replaced with 8.20.0. `npm audit` now reports zero known vulnerabilities for the isolated toolchain. No production dependency declaration or lockfile changed.

## Canonical paths, rules, packages, and trees

Repository-relative paths must be NFC-normalized, slash-separated, nonempty, non-absolute, ASCII, and free of control characters, empty/dot/parent segments, repeated separators, trailing spaces/dots, and case-fold collisions. Case-confusable executable suffixes reject. Every actual path must match exactly one nonoverlapping rule.

Package files are mixed metadata/behavior. Only `name` and `description` are excluded from the behavioral projection; names remain slot-bound. Scripts, entry points, exports/imports, bins, all dependency classes, engines, package manager, workspaces, overrides/resolutions, file publication, side effects, loaders, test/build/start/code-generation configuration, and other declared behavior fields are canonicalized and hashed. Ungoverned package keys fail content validation. Lockfiles and package-manager/workspace configuration compare as governed bytes.

Each governed file record binds normalized path, class, file type, full mode, executable semantics, byte length, byte digest, behavior digest, symlink disposition, rule, and boundary version. Sorted records are length-framed with an eight-byte length before hashing.

Per repository, the result separately records:

- scaffolding digest;
- source-runtime digest;
- behavioral-tree digest;
- compiled-artifact digest;
- package behavioral projection digest;
- root, TUI, and verifier lockfile digests;
- semantic boundary-manifest and inclusion/exclusion digests.

## Real behavioral divergence

Final verifier status: `VERIFIER_OK_DIVERGENCE`. Final verdict: `BLOCKING_DIVERGENCE`.

| Finding | Count | Categories |
|---|---:|---|
| behavioral record divergences | 35 | 20 behavior-identical, 6 generated-behavior-identical, 9 quarantined |
| missing behavior-bearing files | 240 | 6 behavior-identical, 28 generated, 203 quarantined, 3 test behavior |
| quarantine findings | 19 | 10 identical-but-still-quarantined, 9 divergent |
| content-validation findings | 1 | historical dependency census JSON exceeds the new 1 MiB documentation limit |
| total blocking findings | 295 | categories can overlap for a divergent quarantined path |
| identical behavior records | 599 | not a safety verdict |
| unclassified files | 0 | under the closed current inventory |
| symlinks | 0 | in the real governed trees |

The semantic boundary digest is `sha256:b77598636fb41a4ece82154493683a44c8eb14a880603f36ef7af9ec3fd3cde2`.

The five high-level intentional quarantine areas remain live server control flow, executable profile/capsule overlays, executable UI overlays, executable skills, and compiled-artifact drift. The full path-level evidence is in `TRIO-001C-PARITY-RESULT.json`.

## Post-fix hostile results

All 44 hardened hostile tests pass with zero skips. They include all required audit attacks and the original TRIO-001B attacks. Safe capsule data changes remain reported without causing false runtime divergence; dirty state remains visible; semantic manifest reordering preserves classification and digest.

Malformed/missing repositories, malformed JSON, schema errors, identity errors, ambiguous paths/rules, duplicate repositories, symlinks, and unexpected working directories return a stable nonzero status with structured failures. Human output escapes control characters and summarizes the failure class, agent, and path rather than relying on a stack trace.

The local wrapper ran every stage despite expected parity failure. Schema, hostile, scaffolding, and characterization stages passed; it then classified parity exit 1 as `operated-correctly-known-divergence`, not as a verifier crash, and exited nonzero at the end.

## Characterization changes and results

Source-string assertions were removed. Behavioral tests now construct the HTTP server, direct loop, shadow/delegation seam, cron handlers, and full tool registry. Requested independent mutation-class kill switches are shown behaviorally to be ignored. The same Velum/output-path characterization runs in all three repositories and confirms ordinary HTTP exposes the original unsafe tool output while returning no finding count.

Each repository passed 10/10 characterization tests with zero skips. The work-order, model-report, and onboarding assertions are labeled retained future generic contracts; unsafe authentication, filesystem, cron, mutation-control, and output behavior remains labeled as blocking defects.

CLI and sanity executables were not launched against model/provider endpoints because that could require credentials or external activity. This is a confidence limit, not a skipped test: the characterization directly covers their shared runtime/session/registry seams, while the closed inventory treats the entry-point bytes and package launch commands as behavior-bearing. No claim is made that every live execution environment was exercised.

## Full verification

| Suite | Pehlichi | Loony-Luna | Mad-Ptah |
|---|---:|---:|---:|
| schema/scaffolding/hostile | pass | pass | pass |
| characterization | 10/10 | 10/10 | 10/10 |
| full `npm test` | 364/364 | 355/355 | 354 pass, 4 fail of 358 |
| `npm run typecheck` | pass | pass | pass |

Ptah's four failures are unchanged: work-order, model-reports, and onboarding retained future generic contracts, plus the common Velum safety integration contract. No additional full-suite failure appeared.

## False-parity and trust limits

No required hostile-matrix attack remains able to produce a green parity result. This is bounded evidence, not a proof against every future attack. The verifier establishes behavioral identity/classification, not code correctness or runtime containment. Identical unsafe behavior can still be identical. A future production loader reaching a currently non-production data path must change the boundary and would require new review.

Generated output is byte-compared but not yet reproducibly rebuilt. The current compiled-artifact digest differs across all agents and remains blocking. Capsule references are characterization data and are not authority grants or live assembly inputs. The real documentation oversize finding is intentionally fail-closed rather than silently exempted.

TRIO-000 remains blocked. This work does not authorize tests-only convergence, runtime convergence, containment, activation, or deployment changes.

## Smallest safe next work order

Request operator adjudication for a narrowly scoped inventory-resolution order, not convergence: classify the 240 missing behavior paths into required canonical artifacts versus explicitly retired/quarantined material, establish a reproducible build recipe for `dist`, and decide how oversized historical evidence should be stored or referenced without weakening JSON limits. That order should change no production behavior and should precede any separately authorized convergence work.

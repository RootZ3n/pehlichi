# TRIO-001D verifier architecture (non-authoritative)

This repository-local document explains scaffolding design. It is not live parity evidence and must not be cited as describing the current measured tree. Authoritative run evidence is written to an operator-selected directory outside all three repositories.

## Historical evidence limit

The claim that 38 failures were reproduced against an unchanged TRIO-001B verifier is withdrawn. No exact TRIO-001B implementation was preserved, so that historical baseline cannot be rerun. The retained test-only fixture contains the exact TRIO-001C verifier with SHA-256 `c29223d2649bff4671e213562cd40aee7a9a3a4bd261f45a6801d025b3883342`, plus the pre-fix parser, validator, boundary manifest, schemas, and capsule inputs available at preservation time. It reproduces only the six independently confirmed false-green attacks. It does not reconstruct TRIO-001B.

No production package, export, import, workspace declaration, service, or loader references the fixture. Only `scripts/trio/vulnerable-six-reproduction.test.mjs` imports it.

## Closed behavioral inventory

Directory rules are constrained by `trio/path-inventory.json`. A file must be individually enumerated under its governing rule. New files do not inherit permission from a parent directory. `.next` and `coverage` are scanned rather than excluded; repository-owned output there blocks unless later governed by an independently verifiable reproducible-build contract. Installed dependency trees remain exact exclusions represented by governed package-manager configuration and lockfiles.

Model-facing Markdown is behavior-bearing data, not inert documentation. Exact reviewed paths are compared and active/execution-bearing syntax blocks. Exact variable asset paths remain blocking quarantine even when structural diagnostics recognize an image. Signature recognition never grants inert status.

## Identity limits

The top-level length-framed contract binds verifier/parser/validator and schema digests, repository labels and expected identities, rules and exclusions, package projections, locks/configuration, per-tree digests, generated state, policies, quarantine, and the observed Git snapshot. Mutable Git metadata verifies labeling consistency rather than cryptographic provenance. Compiled artifacts are compared when inventoried but are not yet proven reproducible. Identical code may still be unsafe.

This work changes verification scaffolding only. It does not provide runtime containment, authorize convergence, or adjudicate missing paths.

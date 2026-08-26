# TRIO-000 Containment Report

Date: 2026-08-15 (America/Chicago)  
Disposition: **BLOCKED by the work order's stop conditions; no runtime containment patch was applied.**

## Outcome

Immediate containment is required, but a safe parity-preserving edit was not authorized by the measured state. The common target, `tui/src/server.ts`, is already behaviorally divergent: Mad-Ptah enables work-order and Occasio registries and passes `guardToolOutput: true`, while the corresponding Pehlichi and Loony-Luna server assembly does not. Editing Pehlichi alone would violate the byte-identical-runtime rule; blindly applying one patch to all three would overwrite intentional divergent behavior. No deployed service was changed or restarted.

This is not a safe/trusted verdict. It records containment gaps and a hard implementation blocker.

## Preservation gate

Before edits, the following were recorded. No reset, clean, stash, reformat, commit, push, credential read, or external mutation occurred.

| Repository | Path | Branch / HEAD | Initial worktree |
|---|---|---|---|
| Pehlichi | `/pehverse/repos/ecosystem/pehlichi` | `peh-on-phone` / `12a6f9b38493f3f2cf789125fb3bc5abc4fca4d9` | clean; ahead 2 |
| Loony-Luna | `/pehverse/repos/ecosystem/loony-luna` | `peh-on-phone` / `a2bd67dd929e97bd8a9c26904d82bbc26cf39cf7` | five pre-existing demo-image changes/untracked files; ahead 2 |
| Mad-Ptah | `/pehverse/repos/ecosystem/mad-ptah` | `peh-on-phone` / `0562cc70e3eebfeef4ab1718f186c3e67be8fc74` | clean; ahead 2 |

All three remotes are `https://github.com/RootZ3n/<repository>.git`. Full states and remotes are in `TRIO-001-DEPENDENCIES.json`.

## Confirmed containment failures

1. **Unrestricted filesystem startup is not universally rejected.** `src/core/workspace.ts` and `src/core/tools.ts` explicitly bypass containment when `AGENT_FS_UNRESTRICTED=true`. `assertUnattendedStartup()` rejects this only when `runAgent({ unattended: true })` is used. HTTP, Matrix-to-HTTP, ordinary direct/library, and REPL startup do not have an unavoidable pre-construction rejection. A non-mutating probe resolved `/etc/passwd` successfully with this flag.
2. **Caller workspace authority is too broad.** `parseWorkspaceOverride()` does realpath-based escape protection, but permits arbitrary descendants of comma-separated `<AGENT>_WORKSPACE_ROOTS`. With `/pehverse/repos/ecosystem` configured, a hostile probe selected `/pehverse/repos/ecosystem/loony-luna`. There is no exact default-workspace plus trusted-fixture registration model.
3. **Production defaults are incomplete.** `AGENT_ALLOW_WRITES` defaults false, but there are no independent fail-closed defaults for delegation writes, cron mutation, browser/account mutation, durable brain sync/install, or all unattended mutation. The full registry constructs the cron handler with persisted-job rearming before a request or tool approval.
4. **Authentication is optional, not startup-required.** `chatAuthorized()` treats an absent token as authorized and server startup only warns. Live empty-body probes were deliberately non-task-producing: Pehlichi port 18830 returned HTTP 400 for `/chat`, `/converse`, and `/chat/stream`, proving the unauthenticated requests reached body validation. Luna 18792 and Ptah 18810 returned 401. No task was submitted.
5. **Denial is too late.** Full tool and cron-handler construction occurs before request authentication/authorization. Attachment persistence can write before model-tool approval.
6. **Coarse approval is effect-inaccurate.** `agent_sync` is auto-approved as read-only although it supports write actions. `todo` mutates session state; `brain_think` and web tools can use network resources. With writes enabled, every registered tool name is allowed.
7. **Receipt strings are forgeable.** `brain_sync` checks for a nonempty receipt string, not a receipt-store record or signature.

## Requested controls and status

| Control | Status |
|---|---|
| Reject unrestricted FS on every production/direct path | Not implemented; shared server file is behaviorally divergent |
| Exact default workspace plus trusted Howa fixture roots | Not implemented; capability design/config contract unresolved, so caller override should be disabled in the eventual containment patch |
| Independent production mutation defaults | Not implemented; safest interim design is disable construction/registration, especially cron rearm and browser/account mutation |
| Authentication on every task-producing endpoint and startup failure without it | Not implemented; live Pehlichi exposure confirmed |
| Deny before handler construction | Not implemented |
| Negative integration tests for every blocked path | Existing narrow tests pass but do not cover the requested universal matrix; no divergent test patch was applied |

## Verification performed

Narrow containment command, rerun outside the network-bind-restricted sandbox:

```text
node --import tsx --test src/core/agent-tools/unattended.test.ts tui/src/workspace-override.test.ts tui/src/write-safety.test.ts tui/src/server.test.ts src/core/truth-bridge.test.ts
PASS: 61 tests, 0 failures
```

The first sandboxed HTTP-test attempt failed with `listen EPERM`; this was an execution-environment limitation, not a product failure. Full baselines:

```text
Pehlichi: npm test -> PASS, 364 passed, 0 failed
Loony-Luna: npm test -> PASS, 355 passed, 0 failed
Mad-Ptah: npm test -> FAIL, 354 passed, 4 failed of 358
All three: npm run typecheck -> PASS
```

Ptah's four failures predate this work because no runtime code was edited: work-order GET/POST expected 201 and received 404; reports and onboarding response fields were absent; Velum injection response data was absent. They corroborate, but do not fully define, the server behavioral drift.

Hostile read-only checks covered unauthenticated routing, `/etc`, home, repo parent, sibling repository, traversal, and symlink escape; unrestricted environment injection; sibling-root selection; receipt validation by inspection; and safety-library production reachability. Mutation paths through delegation, cron, bridge, browser, execute-code, terminal, memory, brain, and skills were traced statically and were not executed.

## Files changed

Only requested evidence files under Pehlichi `docs/trio/` were created. No files changed in Loony-Luna, Mad-Ptah, Howa, IKBI, Truth Firewall, or the lab utility repositories. Temporary generators were removed after generation.

## Highest-severity unresolved risks

- Live Pehlichi HTTP task routes do not require authentication when its token is absent.
- `AGENT_FS_UNRESTRICTED=true` bypasses workspace containment and is not rejected by universal startup assembly.
- Cron can rearm durable jobs during registry construction; mutation classes lack independent kill switches.
- Runtime assembly is already non-identical, so a parity-safe containment release needs operator adjudication of Ptah's optional behavior and capsule/runtime boundary.
- Broad configured workspace roots authorize sibling repositories.

## Required operator adjudication

Decide whether Ptah's work-order/Occasio/output-guard behavior belongs in the identical trio runtime (feature-disabled by capsule/config where appropriate) or must be removed/moved. After that decision, create one identical patch series for all three, verify exact runtime-tree equality, deploy/restart deliberately, and rerun the hostile matrix. Until then, disable or firewall unauthenticated Pehlichi ingress operationally through an operator-controlled deployment action; this work order did not authorize altering deployed services.

## Confidence limits

The findings combine source tracing, hashes, local tests, process/unit/listener inspection, and non-task HTTP probes. Credentials and env-file contents were not read. External providers and mutation-capable tools were not invoked. Absence of an observed call is not proof that an out-of-scope external system cannot call it.

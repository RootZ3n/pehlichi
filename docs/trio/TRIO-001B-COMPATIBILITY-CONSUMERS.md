# TRIO-001B Compatibility Consumers

This inventory distinguishes proven code/runtime consumers from documentation, tests, and aspirational interfaces. It does not authorize compatibility implementation.

## Proven active deployment consumers

| Consumer | Evidence | Contract currently consumed | Compatibility implication |
|---|---|---|---|
| `lab-pehlichi.service` | active systemd unit; working directory `pehlichi/tui`; executes local `tsx src/server.ts` | server file location, direct-execution auto-listen, Peh deployment env files | A generic server may retain a thin deployment launcher at this path until the unit is deliberately migrated. |
| `lab-luna.service` | active systemd unit; executes Luna `tui/src/server.ts` | same, with Luna deployment values | Same. |
| `lab-ptah.service` | active systemd unit; executes Ptah `tui/src/server.ts` | same, with Ptah deployment values | Same. |
| `pehlichi-matrix-bridge.service` | active; shared Matrix bridge source | `AGENT_URL`/legacy `PEHLICHI_URL`, optional bearer handle, POST `/converse` and `/chat` | Preserve route/request compatibility until the bridge migrates; authentication must not be weakened for compatibility. |
| `luna-matrix-bridge.service` | active | same shared bridge contract with Luna endpoint/config | Same. |
| `ptah-matrix-bridge.service` | active | same shared bridge contract with Ptah endpoint/config | Same. |
| trio HTTP/UI | active listeners and local `ui/api.js` | `/chat`, `/converse`, `/chat/stream`, health/info/tools/session/receipt routes; response `content` and tool-call fields | Route compatibility is proven. Safety/auth changes may intentionally change rejection/status behavior under a separately approved work order. |
| Howa Peh HTTP adapters | source and active Howa service from census | `/api/chat` or `/chat`, `content`, caller-supplied `workspace`; no Authorization header in current adapter | A workspace/auth migration needs an explicit Howa adapter update; do not preserve arbitrary caller roots. |
| Howa Mechanic adapter | source | port 18810 and a separate `{input, repo}` submission contract | It is not the same contract as current Ptah `/chat`; characterize actual configured adapter before preserving it. |

## Proven repository-local consumers

- `tui/src/server.test.ts`, `audit-fixes.test.ts`, `write-safety.test.ts`, and `lab-cohesion.test.ts` import `createPehServer`, `createLunaServer`, or `createPtahServer`. These are internal test consumers, not evidence of external API use. A temporary alias outside canonical runtime is sufficient during test migration.
- Auto-listen in each `tui/src/server.ts` calls its agent-specific factory. This is self-consumption and should become a thin deployment launcher.
- All three `src/cli/repl.ts` files call `/work-orders` routes, although the server does not implement them. This is a code consumer of a nonexistent/aspirational contract, not a working compatibility requirement.
- Ptah `tui/web/onboarding.html` calls `/onboarding` and `/work-orders`; current server returns 404. Ptah README advertises onboarding. These are stale UI/documentation consumers and do not justify preserving behavior that never worked.
- Skills in Pehlichi and Ptah directly read/write `/pehverse/state/work-orders`. These prove workflow/data-format dependence, not a server endpoint or runtime-import contract.

## Legacy environment names

The live server source consumes `PEHLICHI_*`, `LUNA_*`, and `PTAH_*` names for port, host, commit, workspace, and workspace-root allowlists. Systemd units load repository and TUI env files, but credential-bearing file contents were not read. Therefore the environment-file linkage is proven; the exact set of populated legacy keys is not.

Migration should use deployment-only adapters that map proven populated legacy handles into a generic closed deployment schema. An adapter must carry `deprecatedSince`, consumer evidence, and `removeBefore: 1.0.0`. It cannot preserve broad caller workspace authority or an authentication fail-open.

## Checkpoint paths and identifiers

Current assembly creates agent-specific checkpoint namespaces and task/correlation prefixes. Existing lab-store checkpoint directories prove the checkpoint namespaces have durable data consumers. Preserve/import their data format and namespace through capsule/deployment values during migration.

No external code was found that parses the textual `pehlichi-`, `luna-`, or `ptah-` generated ID prefix as a protocol. Treat identifiers as opaque, but retain temporary prefix values through capsule data until receipt/task consumers are re-characterized.

## Package/export consumers not proven

No cross-repository import of `createPehServer`, `createLunaServer`, or `createPtahServer` was found in Howa, IKBI, or the shared bridges. No current external consumer of the private root/TUI package names was proven. These names should not receive permanent compatibility solely because internal tests or package metadata contain them.

## Explicitly not grandfathered

- `/work-orders`, `/reports/models`, and `/onboarding` are retained future generic capability contracts, but they are absent today and require no compatibility shim in this work order.
- Ptah-only hardcoded capability activation is not a compatibility surface.
- `AGENT_FS_UNRESTRICTED`, open authentication, broad workspace roots, and raw unsafe output are defects, not contracts to preserve.
- Comments, READMEs, test names, and inactive UI calls are not proof of live behavior.

## Confidence limits

The census used scoped source search, systemd metadata, prior active listener/process checks, and existing checkpoint state. Secret env contents and external account configuration were not read. A consumer not present in the approved local repository roots may exist; none is assumed.

# TRIO-001A Divergence Adjudication

Date: 2026-08-15  
Disposition: classification and architecture preparation only. No runtime, service, or deployment changes were made. TRIO-000 remains blocked.

## Measured scope

The existing candidate boundary contains 87 files: 82 identical and five divergent. Git blob hashes below are computed from the preserved working-tree bytes with `git hash-object`.

| File | Pehlichi blob | Loony-Luna blob | Mad-Ptah blob |
|---|---|---|---|
| `package.json` | `fa24b3bd9282e3ac764aca47c5638c34259332b7` | `2295ef6804f22a646cd6c1d77b247f777b9f03c6` | `ee99fdcef41483efe1fc9aa8559967f6edf034fb` |
| `pnpm-workspace.yaml` | `5ed0b5af0d45919f64c66edfb16a5f4512461fa1` | `5ed0b5af0d45919f64c66edfb16a5f4512461fa1` | `09a02ca1c8b9650ce61f307060c4bbb24a9f7c33` |
| `tsconfig.json` | `7062a1e7c0f2225de75787a242091b20f3ee5c5f` | `7062a1e7c0f2225de75787a242091b20f3ee5c5f` | `aee740bd896204398968367b954f2b21637767a3` |
| `tui/package.json` | `4718e1695d502b2b79dc06817c544f79fda2bfdf` | `c855b180ac1f833a217163bb165161994854efa1` | `a38df7b6340bdce31d2f3cc40853b5e0cca78695` |
| `tui/src/server.ts` | `c93ee145d0d772d091eac3b71267e3344ab4be09` | `5141e4f8af4a5174a6feb3f6daab16ebf788af5c` | `da023403c46747bde99cf702fa212c2e1225f461` |

Exact paths are `/pehverse/repos/ecosystem/{pehlichi,loony-luna,mad-ptah}/<file>`. The machine-readable matrix contains all expanded paths.

## Semantic adjudication by file

### `package.json`

The package `name` and `description` are identity metadata (d). Agent-specific sanity commands are capsule/developer workflows (d/e). Ptah-only `start` and `repl` scripts are deployment/accidental drift (f/g): they expose operator entrypoints but do not define a Ptah-only mechanism. The 38-test common suite is the same set, aside from ordering; Pehlichi alone runs `tui/src/workspace-override.test.ts`, which is safety/CI drift (b/f/g).

The common dependencies include sibling `file:` imports of lab-memory and lab-store. That is not one of the five semantic differences, but it violates the adjudicated standalone target and must be removed in the convergence work order without silently changing persistence contracts.

Callers are npm/pnpm, CI, package consumers through `main`/`exports`, and operator scripts. Compatibility risks are hidden script names, Ptah `npm start`/`npm run repl`, and package-name consumers. Root package metadata may differ outside the runtime manifest, but runtime-affecting dependencies, exports, and verification scripts need a common locked contract.

### `pnpm-workspace.yaml`

Ptah adds `onlyBuiltDependencies: [esbuild]`; all three already have `allowBuilds.esbuild: true`. This is deployment/package-manager drift (f/g), likely redundant but potentially pnpm-version-sensitive. It affects install-script permission and therefore whether the UI build tool is usable. Normalize only after an install/build characterization in clean fixtures. The target bytes should be identical.

### `tsconfig.json`

Ptah adds comments and blank lines only. Compiler options, include, and exclude are semantically identical. This is accidental formatting drift (g), with no API behavior. Normalize byte-for-byte; no reformatting of unrelated files is needed.

### `tui/package.json`

Only the private package name differs. Scripts, versions, dependencies, and development dependencies are otherwise identical. This is identity metadata (d) leaking into a build manifest. Use a common private package name and load visible branding from the capsule. Risk is limited to local tooling that keys on the existing names.

### `tui/src/server.ts`

This is the only divergent file that changes live execution.

Common identity/deployment leakage:

- `PEHLICHI_`, `LUNA_`, or `PTAH_` environment names and default ports affect listener binding (f).
- Agent-specific commit/workspace/workspace-roots names and default repository paths affect version reporting and filesystem authority (f).
- `PehServerOptions/createPehServer`, `LunaServerOptions/createLunaServer`, and `PtahServerOptions/createPtahServer` create different public TypeScript APIs for the same mechanism (d/g).
- Checkpoint directory names affect durable state separation (d/f).
- Task and correlation prefixes affect API observability, logs, receipts, and consumers (d).
- Startup identity text and emoji are capsule/UI concerns (d).

Ptah-only execution:

- `enableWorkOrders: true` is supplied to both the default and workspace-override registries. This activates three tools, including a persistent lifecycle transition. The generic implementation already exists identically in all three. Mechanism is an optional capability (c); Ptah activation and workflow are capsule/skill data (d/e).
- `enableOccasio: true` similarly activates `wo_file_finding`. The current generic-looking code contains Ptah/Peh/Luna routing and prose, so its adapter mechanism is c while source identity, routing defaults, prompts, and output wording are d/e. It must become a versioned pack before activation can be considered clean.
- `guardToolOutput: true` activates the already-identical loop mechanism only in Ptah. Because it prevents indirect prompt injection from tool output, it is a safety invariant (b), not an agent posture. It should be unavoidable on every production/direct tool-result-to-model path.

The server is called by systemd, Matrix through HTTP, Howa through HTTP, UI/HTTP/stream clients, direct test imports, and the CLI REPL. Genericizing it changes public symbols, env contracts, checkpoint paths, task identifiers, and potentially response/model behavior. Compatibility adapters must sit outside the byte-identical runtime and be temporary, tested, and explicitly retired.

## Ptah feature dissection

### Work orders

| Component | Current implementation | Classification and recommendation |
|---|---|---|
| Mechanism/schema/lifecycle | `src/tools/work-order-store.ts`; typed records and transition validation | Generic optional capability mechanism (c); place in a local versioned `work-orders` pack present identically in every distribution |
| Policy | Status transition graph, severity ordering, required resolution | Pack policy, versioned independently; generic only if the trio shares the contract |
| Tool implementation | `wo_list`, `wo_get`, `wo_transition` | Pack implementation (c); identical bytes, disabled unless capsule grants activation; transition remains mutation-classified |
| Activation | Ptah server hardcodes `enableWorkOrders:true` twice | Ptah capsule capability declaration (d/e), resolved by an identical loader; never an agent branch in server control flow |
| Prompts/instructions | Ptah profile and work-order skills describe repair workflow | Ptah skill/capsule (d/e) |
| Routing | Peh creates/hands off; Ptah claims/transitions | Skill/workflow and trusted routing data (e), not runtime branching |
| Completion criteria | Assigned → in-progress → done plus repair evidence/report expectations | Lifecycle rule in pack; role-specific “done” evidence and report sections in Ptah skill |
| Output formatting | Tool JSON/text and repair report prose | Stable machine tool result in pack; Ptah report format/voice in skill |
| Persistence | JSON files, default `/pehverse/state/work-orders`, injected temp store in tests | Pack adapter; path supplied by trusted deployment/capsule config, no hardcoded cross-repo import |
| External dependencies | Filesystem and callers/bridges | Explicit pack capability declaration; writes off by default |
| Tests | store/tool tests pass; Ptah HTTP contract fails | Preserve store/tool characterization; HTTP route is aspirational and must be implemented generically or retired explicitly |

Exact recommendation: keep a generic, versioned, locally contained work-order pack in all three distributions; activate it only through Ptah capsule data for now. Move Ptah repair instructions, selection, completion criteria, and formatting to skills. Do not expose work-order HTTP routes merely because Ptah tests expect them; first decide the pack's versioned public API and authorization model.

### Occasio

| Component | Current implementation | Classification and recommendation |
|---|---|---|
| Mechanism | Category mapping, filing, bridge seam, best-effort result | Generic versioned optional pack (c) |
| Policy | Category→severity/category mapping; always persist even if bridge fails | Pack policy requiring explicit version and failure semantics |
| Tool | `wo_file_finding` | Identical pack tool, mutation-capable and disabled by default |
| Activation | Ptah hardcodes `enableOccasio:true` twice | Ptah capsule/routing declaration (d/e) |
| Prompts/instructions | Tool description says Luna/Pehlichi and “close trio loop” | Split: generic schema in pack; Ptah workflow language in skill |
| Routing | Creative→Luna `/chat`; all→Pehlichi `/intake` | Trusted capsule routing table, not hardcoded implementation |
| Completion criteria | Work order creation counts even when bridge routing fails | Machine result must distinguish persisted, routed, partial, and failed; Ptah response convention in skill |
| Output formatting | `Filed … routed→luna … announced→pehlichi` | Generic structured result from pack; Ptah prose in skill/UI |
| Persistence | Always creates a work order before bridge calls | Work-orders pack dependency through a local port; activation must not enable writes by default |
| External dependencies | Work-order filesystem and bridge network | Declared pack dependencies/capabilities; no sibling runtime import |
| Tests | Category/routing/nonfatal failure tests pass | Retain as pack tests; add config-driven target tests and no-write/inactive tests |

Exact recommendation: retain only after extracting `occasio/v1` as an identically distributed pack with injected work-order and routing ports. No agent names, endpoints, source strings, or prose belong in the implementation. Ptah's capsule selects it and supplies the routing table; this work order does not activate it.

### Output guard

| Component | Current implementation | Classification and recommendation |
|---|---|---|
| Mechanism | sanitize, injection scan, quarantine wrapper, finding counter | Generic runtime safety invariant (b) |
| Policy | Pattern set, byte cap, handling of invisible characters, fail behavior | Versioned runtime safety policy; common across trio |
| Tool implementation | None; it intercepts every tool result after execution | Runtime dispatcher boundary, not an optional tool |
| Activation | Ptah passes `guardToolOutput:true`; others omit it | Remove agent-selectable production activation; make unavoidable and identical |
| Prompts/instructions | In-band “untrusted data” wrapper | Generic safety text; role voice does not belong here |
| Routing | Tool result → emitted event/receipt → guarded model history | Runtime; guard must occur before every model re-entry and before unsafe disclosure decisions |
| Completion criteria | Currently unrelated except `injectionFindings` | Generic evidence/response policy; Ptah repair completion remains skill data |
| Output formatting | Current HTTP response omits count and exposes original tool-call output | Define a generic safe response/evidence schema; UI may render findings without leaking or overstating them |
| Persistence | Receipt records `injectionDetected`, but tool-output finding provenance is incomplete | Runtime evidence receipt bound to task/tool call/guard version |
| External dependencies | Pure local scan/sanitizer | None required |
| Tests | Pure Velum tests pass; Ptah HTTP test fails | Convert to identical runtime integration tests on every surface |

Exact recommendation: make guarding an always-on runtime invariant across all trio agents. A trusted test-only seam may inject deterministic scanners, but production/capsule configuration must not disable it. Preserve the original result as restricted evidence if needed; provide the model and ordinary API consumers only the policy-approved representation. The current guard addresses prompt injection, not complete false-success, disclosure, or authority enforcement; those require the evidence finalization boundary described in the Truth Firewall classification.

## Ptah's four failing tests

All four remain failing and pre-existing; no tests were edited or retired:

1. Work-order REST test: POST receives 404 rather than 201 because no routes or `workOrderStore` option exist.
2. Reports test: `/reports/models` is absent, so `reportCount` is undefined.
3. Onboarding test: `/onboarding` is absent, so `total` is undefined.
4. Velum test: the loop counts findings, but `KernelChatSession` does not propagate `injectionFindings` and HTTP does not serialize it. Tool-call events also retain the original output rather than the guarded history value.

The first three are aspirational server contracts rather than proof of connected functionality. Characterize 404 first, then implement a generic authenticated capability endpoint or explicitly retire each contract. The fourth represents a generic safety observability gap and should become a common runtime test.

## Contract and migration summary

The highest compatibility risks are service environment names, exported server function/type names, checkpoint paths, generated task/correlation prefixes, package scripts, and any client expecting Ptah-only tool lists or absent/present HTTP routes. Compatibility aliases and env translation belong in capsule/deployment adapters outside `runtime/`; they must not create three different runtime byte trees.

Detailed paths, test blobs, caller lists, classifications, and dispositions are in `TRIO-001A-DIVERGENCE-MATRIX.json`.

## Confidence limits

This adjudication uses byte hashes, full semantic diffs, source call tracing, existing safe test results, and the prior live-surface census. It does not prove undocumented external clients are absent. No credential-bearing configuration was read, no package install/build was rerun, and no runtime or service was changed.

# TRIO-001A Target Boundary

## Design rule

Each standalone agent repository contains a complete local distribution. At runtime it imports only files/packages contained in that same repository or ordinary third-party packages. It must not import Pehlichi, Luna, Ptah, lab-memory, lab-store, Truth Firewall, or another Pehverse repository through `file:`, absolute source paths, or dynamic cross-repository loading.

The canonical runtime boundary is the byte-for-byte content of `runtime/`, the generic portions of `capability-packs/`, common UI mechanism under `ui/`, and the common runtime/pack tests declared by `runtime/manifest.json`. Capsule, skills, and deployment values can differ only through documented schemas and may not contain executable runtime branches.

## Proposed layout

```text
runtime/
  manifest.json
  core/
  server/
    server.ts
    routes/
  safety/
    output-guard/
    evidence-finalizer/
  ports/
  adapters/
    local-memory/
    local-store/
capsule/
  agent.json
  profile.ts
  branding.json
  routing.json
skills/
  common/
  <agent>/
capability-packs/
  work-orders/v1/
    manifest.json
    store.ts
    tools.ts
    optional-http.ts
  occasio/v1/
    manifest.json
    adapter.ts
    tools.ts
deployment/
  env.schema.json
  agent.env.json
  service.template
  package.json
  pnpm-workspace.yaml
  tsconfig.json
ui/
  package.json
  src/
  themes/
tests/
  runtime/
  safety/
  capability-packs/
  capsule/
  compatibility/
  parity/
```

## Boundary responsibilities

`runtime/` owns model loops, tool dispatch, approvals, authentication hooks, workspace enforcement, sessions/checkpoints, generic HTTP/stream/direct assembly, receipts, mandatory output guarding, and final success/evidence validation. Every file is identical across the trio. `runtime/manifest.json` lists every runtime file, SHA-256, schema/version, required common tests, and capability-pack interface versions.

`capsule/` owns agent ID, display name, default port/workspace identifiers as data, checkpoint namespace, task/correlation prefix, provider/model selection data, enabled optional packs, routing targets, profile/personality, and branding. Capsule schemas and loader mechanism are identical; values differ. Capsules cannot grant authority beyond trusted deployment ceilings or disable safety invariants.

`skills/` owns Ptah repair workflow, work-order selection/use instructions, completion criteria, report sections/formatting, role voice, and Occasio selection guidance. Skills are data/instructions, not privileged code and not proof of enforcement.

`capability-packs/` owns generic, versioned optional mechanisms. Pack implementation, schemas, default-disabled posture, and tests are present identically in all three. Activation is declared by capsule and bounded by trusted deployment configuration. Work-order mutation and Occasio network/persistence remain disabled unless both layers grant them.

`deployment/` owns ports, hosts, filesystem locations, service/env mapping, provider credentials, enabled authority ceilings, and operator compatibility aliases. Secret values stay outside the repository. Deployment templates and schemas should be common; `agent.env.json` values may differ.

`ui/` owns common rendering and interaction. Agent-visible branding comes from capsule themes. Safety status, evidence, and advisory/enforcing distinctions may be rendered but never inferred from prose.

`tests/` separates identical runtime/safety/pack contracts from capsule snapshots and temporary compatibility tests. A test name or pass result never establishes that production calls the mechanism; assembly tests must trace the real entrypoints.

## Destination of the five divergent files

| Current file | Proposed destination | Identical bytes? | Treatment |
|---|---|---:|---|
| `package.json` | `deployment/package.json`; runtime dependency truth in `runtime/manifest.json` | Root metadata may differ; runtime manifest and runtime-affecting dependency contract must match | Agent name/description and sanity aliases become capsule/developer metadata. Common scripts normalized. Remove sibling `file:` runtime dependencies by providing local implementations/adapters. |
| `pnpm-workspace.yaml` | `deployment/pnpm-workspace.yaml` | Yes | Select one tested esbuild build-policy representation. |
| `tsconfig.json` | `deployment/tsconfig.json` | Yes | Remove comments-only drift; shared compiler contract. |
| `tui/package.json` | `ui/package.json` | Yes | Use a generic private package name; load display identity from capsule. |
| `tui/src/server.ts` | `runtime/server/server.ts` plus `capsule/agent.json` and `deployment/agent.env.json` | Server bytes yes; capsule/env values no | Rename to `createAgentServer`; inject validated capsule/deployment data; no agent branch. Work-order/Occasio activation uses generic pack loader. Output guard is mandatory runtime wiring. |

## Public compatibility boundary

Temporary local adapters may export `createPehServer`, `createLunaServer`, or `createPtahServer` and translate legacy env names into the generic config. They live in capsule/deployment compatibility files, not `runtime/`, and call the same `createAgentServer`. Each alias needs a removal date/version and contract test. Checkpoint paths and ID prefixes should be preserved through capsule values during migration.

The parity verifier must reject extra, missing, or changed files inside the manifest boundary and must compare actual source and compiled output. It must also reject runtime imports that resolve outside the repository or to sibling `file:` packages.

## Canonical boundary recommendation

The smallest initial canonical runtime is the currently identical `src/core/**` mechanism plus a genericized server and `tui/src/lib/**`, mandatory safety finalization, local persistence ports/adapters, exact runtime manifests, and common integration tests. UI rendering can remain a separately verified common boundary. Capsule and skills are excluded from byte parity but validated against identical schemas.

This is a target, not a claim that the current repositories satisfy it.

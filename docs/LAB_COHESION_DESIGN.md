# Lab Cohesion Design — one cohesive lab, zero release dependencies

Status: **DESIGN — awaiting sign-off before implementation**
Date: 2026-07-03
Author: Peh session (resumed from the trio byte-identical unification)

## 0. The one rule everything is measured against

> **The 7 RELEASE products must stay standalone — no intertwining with each other or the lab.**
> The 4 LAB-ONLY citizens never ship, so they intertwine freely.

Two sets (Zen, 2026-07-03):

| Set | Members | Rule |
|---|---|---|
| **Release products (7)** | Luak, ikbi, **Pehlichi Pub**, Howa, Toba, Kokuli, Nusika | Each ships to the public; must be **standalone**. No cross-product deps. |
| **Lab-only (4)** | **ittunaha, Pehlichi, Luna, Ptah** | Never leave the lab. **Intertwine all you want.** Trio (Peh/Luna/Ptah) stays **byte-identical** in core. |

Engineering test for a **release** product: *does its core reach another product (import or
hard runtime call)?* If yes, it's wrong. For the **lab-only** four there is no such
restriction — cohesion is the goal.

**Pehlichi Pub is the standalone release copy of lab Pehlichi**: a byte-identical core that
simply runs with the lab overlay **off**. Lab Pehlichi ≠ Pehlichi Pub — same code, different
deployment. Release-safety is enforced in Pehlichi Pub (and any product embedding the agent
core), never as a burden on the lab trio.

Corollary (from `pehlichi/CLAUDE.md`, already canon): each agent **owns its core**;
it may depend on shared *data* stores (lab-memory, lab-store) but never on another
agent or a shared runtime package. **We do NOT extract a shared core package.**
Cohesion is achieved by *configuration*, not by shared code.

## 1. Three layers

| Layer | Ships on release? | Byte-identical across trio? | Contents |
|---|---|---|---|
| **Core** | ✅ yes | ✅ yes | loop, local tools (file/shell/browser), **velum guard**, memory *interface*, persona hook. Zero product references. |
| **Lab overlay** | ❌ no (inert when off) | ✅ yes | bridge registry, ikbi tools, cross-agent sync, shared-labmem binding, the velum→atoni→ittunaha pipeline wiring. |
| **Profile** | ✅ yes | ❌ per-agent | persona, skills, branding (`src/profiles/agent.ts`). |

Velum is **always on** in every layer/mode — injection defense is a product feature and a
zero-dependency library (`velum-ai`), so it ships. Only *atoni tap* + *transcript sharing*
+ *bridge/ikbi/sync* are overlay (lab-gated).

## 2. The single seam: `labMode`

One switch, read once at tool-registry assembly (`core/agent-tools/index.ts`), gates the
whole overlay. It hangs off the existing `enableWorkOrders`/`enableTeaching` pattern.

```ts
// Lab-only agents default ON (intertwined). A release build sets it OFF.
labMode: boolean            // default: process.env.LAB_MODE !== '0'  (on unless disabled)
```

When **on** (lab — the default for the lab trio + ittunaha):
- full overlay registered; memory/transcript point at the shared lab stores; atoni tap live.

When **off** (a release build — Pehlichi Pub, or the agent core embedded in one of the 7):
- bridge, ikbi, cross-agent sync, labmem tools are **not registered** (not offered to the model).
- memory interface points at a **local** store (`LABMEM_ROOT` unset → embedded product dir).
- no atoni tap, no shared transcript append, no cross-agent context pull.

### Why default ON (no lab footgun)
The lab trio never ship, so they are *supposed* to be intertwined — defaulting ON means a lab
agent started with no special env is fully cohesive. **Pehlichi Pub** (and any of the 7
release products embedding the agent core) is where the overlay is turned **off**
(`LAB_MODE=0`), giving a byte-identical-core standalone product. The seam guarantees
"same code, different deployment"; it is never a switch the lab must remember to flip on.

## 3. Message pipeline (middleware in each agent's `tui/src/server.ts`)

Enforced in the agent's own HTTP server, so there is no un-guarded port to reach. Direct
chat and ittunaha-proxied chat hit the **same** middleware.

```
inbound  → velum(scan user input)  → atoni.tap(in)  → resolve canonical room → agent loop
outbound → velum(scan response)    → atoni.tap(out) → append turn to shared transcript
                                                     → distill salient → labmem → reply
```

- **velum legs**: unconditional (both modes).
- **atoni.tap**: `labMode`-gated, **fire-and-forget** (atoni down ≠ chat down). Built as a
  seam that can later escalate a specific finding to a **synchronous block** without
  rearchitecting ("tap now, gate later").
- **canonical room**: **one room per agent** — `lab:peh`, `lab:ptah`, `lab:luna`. Both
  frontends resolve to it, so "talking to Peh in ittunaha == talking to Peh directly."
  Agent remains the conversation source-of-truth; ittunaha is a view. No agent→ittunaha dep.

## 4. Shared memory model — one agent, three faces (Zen, 2026-07-03)

The trio is **ONE agent wearing three faces** (Peh / Ptah / Luna); Peh is the primary face
(the human talks to Peh far more than the others). Two distinct layers:

- **Live session = isolated per room.** Each room keeps its own `KernelChatSession` /
  active context window. A Matrix room's live thread never bleeds into another's — the H2
  guarantee is preserved for the *active context*.
- **Durable memory = shared across every face AND every surface.** EVERY turn, on EVERY
  surface (direct, ittunaha, browser UI, REPL, and each Matrix room), is appended to the
  shared transcript. So switching Matrix → direct → ittunaha, the agent recalls the
  conversation and picks up where it left off.

Store layout: `<dir>/<face>/<room>.jsonl` — one file per (face, room). A room is served by
exactly one process (the API service owns direct/ittunaha/UI rooms; the Matrix bridge owns
Matrix rooms), so every file has a **single writer** → appends never tear.

- **Ambient recall** (every turn): pull recent turns from everything EXCEPT the current
  live thread `(face, room)` — because the session already holds that. This surfaces "what
  was said on my other surfaces and by my other faces," tightly capped.
- **On-demand recall**: `lab_recall_conversation` for deeper lookback, filterable by face.
- **Distillation**: salient facts also flow to `labmem` (existing governance: shared writes
  stay dry-run proposals).
- **Release**: shared dir absent → empty recall → standalone; the "lab"/other-faces concept
  never leaks into a shipped product.

## 5. What already respects the boundary (no change needed)

- **velum**: vendored zero-dep library. ✅
- **ittunaha → agent** (chat proxy, receipt poll): dependency points *inward*. ✅
- **atoni → agent** (health poll, digest push): atoni depends on agents, not the reverse. ✅
- labmem/bridge/ikbi already **degrade** (tool-error / HTTP timeout) when the lab is absent;
  the `labMode` gate upgrades this from "offered-then-errors" to "cleanly absent."

## 6. Build order (each step testable; core stays byte-identical)

Cohesion first (that's the goal for the lab-only four); the release gate is cheap and
default-ON, so it rides along rather than leading.

1. **Canonical room + shared transcript store** — one room per agent (`lab:peh/ptah/luna`);
   every turn appended to a shared lab transcript; cross-agent context pull on each turn.
   New byte-identical core module + per-agent server wiring. This IS "one cohesive unit".
2. **Pipeline middleware** — velum-in/out + `atoni.tap` seam (tap only) in each
   `tui/src/server.ts`, wrapping the canonical-room chat path.
3. **Distillation** hook (turn → labmem salient facts).
4. **ittunaha** — resolve its proxy to the canonical room so its view and direct chat converge.
5. **`labMode` seam** — wrap the overlay (bridge/ikbi/sync/shared-memory/tap) in the
   default-ON gate so a release build (`LAB_MODE=0`) runs standalone. No lab deploy change.

## 7. Out of scope (named, deferred)

- **pehlichi-pub**: the release copy. Runs the same core with `labMode` off. Converging it to
  byte-identical core is a separate dedicated session.
- **Ricky (Hermes)**: a lab-only agent ("your hands"); rides the same core+overlay, never
  released. Wire after the trio pipeline is proven.
- **Luak → Nous**: ittunaha reads Luak results into Nous (advisory routing). ittunaha is the
  lab command center — lab-only, never released — so it may depend on everything. Later.
- **Physical `lab-agent-core` package extraction**: explicitly **NOT** pursued (contradicts
  the "each agent owns its core" rule and is unnecessary under the config-gate approach).

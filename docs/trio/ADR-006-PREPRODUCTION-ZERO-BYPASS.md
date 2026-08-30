# ADR-006 — PRE_PRODUCTION means zero operational admission

**Status:** accepted, 2026-08-30
**Applies to:** Pehlichi, Loony-Luna, Mad-Ptah (shared core, byte-identical)
**Supersedes:** the qualification-authority admission model introduced the same day

## Context

`trio/governance/boundary-manifest.json` has carried `state: PRE_PRODUCTION` and
`authorization: NOT_AUTHORIZED_FOR_OPERATIONAL_WORK` since the Trio existed. For most of that
time nothing read them, so an agent declared unavailable for real work would do real work when
asked. The first attempt at fixing that added a gate at `runAgent` which accepted a
caller-supplied `purpose` and a caller-supplied `authority`, where the authority was the
plaintext constant `QUALIFICATION_AUTHORITY` exported from shared core.

An independent audit rejected it, correctly. Any in-process caller could import the constant,
label operational work `self-test`, and be admitted — then reuse the same string for a
different operation the next day. The gate bound no authenticated actor, no work order, no
scope, no expiry, no nonce, no external authority and no replay state. A secret that every
caller can read is not an authority, and a claim the caller makes about itself is not an
authorization.

## Decision

**While the governed operational status is `PRE_PRODUCTION` or
`NOT_AUTHORIZED_FOR_OPERATIONAL_WORK`, there is no operational bypass of any kind.**

1. `admitWork` returns an admission in exactly one case: the committed status says
   `PRODUCTION` **and** `AUTHORIZED_FOR_OPERATIONAL_WORK`. There is no other branch. The
   request's category reaches the refusal and never the decision.
2. Nothing a caller can supply influences admission. `RunAgentOptions` carries no purpose,
   authority, override or bypass field, and `runAgent` passes a literal category to the
   boundary rather than anything read from its own arguments.
3. The repository whose governance is consulted is not a parameter on the production path. A
   caller cannot point the gate at a fixture that says `PRODUCTION`.
4. No exported token, purpose, capability, environment variable, CLI flag, Matrix command,
   role exception or model exception grants admission. `QUALIFICATION_AUTHORITY` and
   `QUALIFICATION_PURPOSES` are deleted rather than deprecated — a dormant compatibility path
   is the same defect asleep.
5. A status that is missing, malformed, unknown, or self-contradictory (`PRODUCTION` with
   authorization withheld, or the reverse) fails closed. Reconciling the two halves would turn
   the gate into a negotiation.
6. Refusals carry four fields — refusal code, operational state, request category, safe next
   action — and nothing else. No credentials, prompts, tokens, configuration or model data.

### What stays available while locked

Service startup, health and status reporting, UI rendering, Matrix connectivity, and read-only
identity display. None of these executes work, and they reach a separate function
(`admitNonWorkSurface`) so the work path has no branch a surface name could reach.

A request does **not** become permitted by claiming to be read-only. Tool-bearing and
model-invoking requests are refused regardless of what they say they will do — including the
tool-free converse lane, which reaches a model without passing through `runAgent` and
therefore carries its own call to the same boundary.

## Testing

Two layers, named accurately, and neither is commissioning evidence.

- **Production-admission tests** prove `PRE_PRODUCTION` refuses every work category. A pass
  means `ADMISSION_REFUSED_AS_REQUIRED`.
- **Component tests** drive `executeAgentRun` / `executeAgentInShadow` — the loop below the
  boundary — with fixture-owned dependencies. A pass means `COMPONENT_TEST_PASS`. It proves
  something about the loop and never that a run was admitted. Those functions are exported
  from `src/core/loop.ts` for that purpose and are deliberately absent from
  `src/index.ts` and `src/core/index.ts`.

Cases that genuinely require a completed turn — end-to-end HTTP behaviour, Hermes-equivalence
— are skipped on a condition read from the committed governed status itself. They return the
moment governance is deliberately transitioned, with no edit and no flag. A skip is neither a
pass nor evidence.

`src/core/admission-bypass-guard.test.ts` fails if the bypass returns in any shape: an exported
value that reads as a grant, a caller-controlled field on the run options, a second admitting
branch, a production surface calling the component instead of the gate, or the boundary reading
the environment. It is semantic, not nominal — renaming the constant does not evade it.

## Amendment: effect-dominated admission

A later independent audit classified `INTRA_PACKAGE_COMPONENT_ESCAPE`. A disposable production
module wrote

```ts
import * as loopMechanics from "./loop.js";
const componentName = "execute" + "AgentRun";
return loopMechanics[componentName](options);
```

and executed an agent turn while the committed status refused all work. The guard above passed
it: the guard searched for known spellings, and a computed property has no spelling. The
executor was absent from the public index, which had been treated as the boundary — but relative
imports inside the package were always part of the threat model, so "not in the public index"
never described one.

The decisions this ADR now records:

- **Effectful below-admission executors are not exported.** `executeAgentRun` and
  `executeAgentInShadow` are module-private in `src/core/loop.ts`. There is no property on any
  namespace object to reach — by name, by computed key, by destructuring, by reflection, or
  under a symbol. Deleting the name while exporting equivalent authority under another one is
  the same defect and is refused as such.

- **No star re-export in the production closure.** `runtime/core/loop.ts` was
  `export * from '../../src/core/loop.js'`, which forwarded both executors into a second
  namespace where the identical bypass would have worked. A star re-export cannot be audited by
  reading it: it exports whatever its target exports, including whatever the target starts
  exporting tomorrow. Every re-export in the closure is now named.

- **Every production path to an effect is dominated by the admission decision.**
  `src/core/effect-sinks.ts` is the committed inventory of which production modules can reach a
  model, a tool, the filesystem, a subprocess, the network or dynamic code, and
  `src/core/admission-dominance.test.ts` re-derives it from the sources and fails on any
  difference in either direction. A new sink that nobody classified fails the build.

- **Unresolved production reachability fails closed.** A computed member access on a module
  namespace, or a dynamic import whose target is not a literal, cannot be followed by any
  analysis, so both are refused in the production closure rather than assumed harmless. One
  exemption exists — `src/core/external-runtime-integrity.ts`, whose target must appear in a
  committed declaration inside a digest-verified root with escapes and symlinks refused — and
  the guard checks those containments are still present rather than taking the exemption on
  trust.

- **Pure component testing carries no operational authority.** The loop's decisions live in
  `src/core/loop-mechanics.ts`: functions from caller-supplied values to data, with no imports
  and nothing callable in any return. Production uses them, so the pure layer is not a second
  implementation. A passing case there proves the loop decides correctly and proves nothing
  about whether a run was admitted.

- **Cases that need a complete turn stay dormant, and are a production-transition gate.** The
  component tests that drove the executor are skipped under `PRE_PRODUCTION` with the reason
  recorded, and each keeps a stand-in that throws, so un-skipping one without doing the real
  work fails loudly instead of quietly proving nothing. At the governance transition these must
  *execute* against the admitted path — together with the dormant end-to-end and
  Hermes-equivalence cases — rather than be deleted. A skip is neither a pass nor evidence.

- **Refusal is proved by traps, not by prose.** `src/core/preproduction-zero-bypass.test.ts`
  arms the driver, the tools, the approval callback and the event sinks to throw if reached,
  then attempts every work category and asserts both the refusal and that nothing was touched. A
  bypass that did its work and then returned a refusal would pass a message-reading test.

## Consequences

- The Trio cannot demonstrate Hermes-equivalence by running, because it is not permitted to
  run. That is the governance position, not a gap: equivalence is what a future independent
  audit establishes, and an agent that could prove its own readiness by acting would be
  certifying itself.
- **Certification does not authorize operation.** A certified verifier says the verification
  code is the reviewed code. It says nothing about whether this agent may act.
- **Ptah remains `PENDING_COMMISSIONING`** after this order, as do Pehlichi and Loony-Luna.
- Enabling operational work requires a separately authorized governance transition. Nothing in
  this repository performs one, and no runtime path can.

## Future work, explicitly not built here

A post-certification commissioning capability must be **externally issued** and bound to an
exact authenticated actor, an exact work order, a scope, a nonce, an expiry and a single use —
with replay state tracked outside the agent. Johnny Five integration for issuing and revoking
such authority is future work.

Building a weaker placeholder now would reintroduce the defect this ADR exists to remove. The
absence of a qualification path is the decision, not an omission.

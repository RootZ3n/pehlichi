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

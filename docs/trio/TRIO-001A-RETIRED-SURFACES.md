# TRIO-001A — retired HTTP surfaces

Operator-visible compatibility note for convergence-plan step 7.

## What changed

Three HTTP routes were asserted by Mad-Ptah's server tests and implemented by no
server in the trio. Every request returned 404, in all three distributions, for as
long as the tests have existed. They are now **retired at the HTTP surface** and
their tests assert the contract that actually holds.

| Route | Test | Disposition |
| --- | --- | --- |
| `GET/POST /work-orders`, `POST /work-orders/{id}/transition` | `WO.` | Retired; `work-orders@1.0.0` pack declared, inactive |
| `GET /reports/models` | `REPORTS.` | Retired; `model-reports@0.1.0` pack declared, inactive |
| `GET /onboarding` | `ONBOARDING.` | Retired; `onboarding@0.1.0` pack declared, inactive |

## Why retired rather than implemented

Implementing them would have meant inventing a public API and an authorization
model for capabilities that are deliberately inactive, and doing it to satisfy a
test rather than a decision. Implementing them in Mad-Ptah alone would have
reintroduced the agent-specific route the boundary exists to prevent. The
adjudication permits either disposition and forbids silent deletion or a skipped
test; this is the second option, made checkable.

## What retirement does and does not mean

Nothing was deleted and no test was skipped. Each test now:

1. asserts the route returns **404**, characterizing the real contract;
2. reads the capability pack that would supply it and asserts it is declared,
   versioned, `base: false`, `defaultActivation: false`, and carries no
   `implementationDigest`;
3. keeps the underlying library under test — `WorkOrderStore` creation, listing,
   the refused `open -> done` transition and the legal path; `ReportStore` trends.

The mechanisms still work. Only the HTTP surfaces are retired.

## What would reverse this

An operator authorizing one of these packs. The generic implementation then lands
in the shared runtime, identically in all three distributions, gated by capsule
request intersected with the trusted deployment ceiling — never by an agent branch
in server control flow. The assertions above are what will have to change, and
they are written so that they must.

## Callers

No caller was found for any of the three routes: they never returned anything but
404, so nothing can have depended on their success. Clients that probe for them
will continue to receive 404, unchanged.

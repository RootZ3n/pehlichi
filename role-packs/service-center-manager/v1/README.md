# service-center-manager v1.0.0

A portable role pack, installed byte-identically for every Trio deployment and
activated for whichever agent currently holds the assignment.

**This pack names no agent.** Which deployment holds the role is configuration
— see `role-packs/assignments.json` — not an implementation detail here. Moving
the assignment changes that file and the resulting permissions; it changes no
byte of this pack, of the universal toolkit, or of the shared runtime.

Availability is not authority. The pack being installed grants nothing: the
manager acts only under a work order dispatched by Johnny Five, and only within
the scope that order authorizes.

Three refusals are structural rather than advisory — the manager cannot create
or approve its own orders, cannot widen its scope, and cannot verify its own
submission.

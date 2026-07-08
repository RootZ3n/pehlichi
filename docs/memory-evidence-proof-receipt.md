# Memory Evidence — End-to-End Proof Receipt (Commit 2)

**Receipt for:** writer-side optional evidence on memory proposals
(`feat(memory-governance): allow evidence refs on memory proposals`, pehlichi commit `3e5de46`,
synced byte-identically to mad-ptah / loony-luna / pehlichi-pub).

**Status:** Proof only. No memory installed, no governance/runtime/Truth Firewall code changed.
This document records the end-to-end run exactly as executed.

## What was proven

The full loop works:

```
memory tool add (with evidence)
  → memory-governance writes a pending proposal carrying evidence[]
  → Truth Firewall review-memory-governance reads the proposal
  → existence = VERIFIED
  → content truth = PARTIAL when file evidence is valid (sha256 matches)
  → content truth = STALE when file evidence is wrong (sha256 mismatch)
  → second review is idempotent (records nothing new)
```

## Sandbox (isolated; not a real lab memory claim)

A harmless artifact under the session scratchpad (outside any repo):

```
evidence.txt = "The test evidence file exists only to prove memory-governance evidence plumbing."
sha256(evidence.txt) = a5bdd9b1ebf25773a445b109083c26e84bb362a62fbf966f01e845ee17f5196e
```

Proposals were generated through the **live pehlichi path** (`createMemoryToolHandlers` +
`createFileMemoryGovernance`, the `memory` tool `action:add` with an `evidence` arg) and reviewed
with the built Truth Firewall CLI under an isolated `TRUTH_BASE_PATH`.

## Commands

```bash
# positive review (twice → idempotency); --cwd resolves the file evidence path
node lab-utilities/truth-firewall/dist/src/cli.js \
  review-memory-governance "$SBX/memdir-pos/.proposals" --advisory --cwd "$SBX"
# negative review (wrong sha256)
node lab-utilities/truth-firewall/dist/src/cli.js \
  review-memory-governance "$SBX/memdir-neg/.proposals" --advisory --cwd "$SBX"
```

## Proposal excerpt (positive — `mem-proof-pos-0001`)

```json
{
  "id": "mem-proof-pos-0001", "status": "pending_verification",
  "agent": "pehlichi", "action": "add", "target": "memory", "namespace": "MEMORY.md",
  "content": "- [proof] memory-governance evidence plumbing works end-to-end.",
  "evidence": [
    { "kind": "file", "path": "evidence.txt",
      "sha256": "a5bdd9b1…f5196e", "lines": "1-1",
      "description": "Sandbox proof artifact (harmless)." }
  ],
  "risk_level": "low", "requiresHumanApproval": false,
  "installed": false, "approval": { "status": "pending" }
}
```

Contains: `status: pending_verification`, `installed: false`, `approval.status: pending`,
`evidence: [...]`.

## Truth Firewall output

**Positive — run 1:**
```
processed=2 skipped_duplicates=0 deferred=0 unverifiable=0
- [memory] mem-proof-pos-0001  agent=pehlichi  risk=low  → existence=VERIFIED content=PARTIAL  evidence=[file:concrete]  (2 new claim(s))
```

**Positive — run 2 (idempotency):**
```
processed=0 skipped_duplicates=2 deferred=0 unverifiable=0
- [memory] mem-proof-pos-0001  agent=pehlichi  → already recorded (skipped 2 claim(s))
```

**Negative — wrong sha256 (stale evidence):**
```
processed=2 skipped_duplicates=0 deferred=0 unverifiable=0
- [memory] mem-proof-neg-0001  agent=pehlichi  risk=low  → existence=VERIFIED content=STALE  evidence=[file:stale]  (2 new claim(s))
   ⚠ 1 advisory hallucination event(s) logged
```

(existence stays VERIFIED — the proposal is well-formed and governed; only the cited artifact
fails to bind, so content is STALE. Content truth is capped at PARTIAL even when concrete; the
reviewer never marks memory VERIFIED.)

## Confirmations

- **No memory installed.** No `MEMORY.md`/`USER.md` was created anywhere in the sandbox; both
  proposals remained `installed: false`, `status: pending_verification`, `approval.status: pending`.
  The reviewer never approves or installs.
- **Proposal files unchanged by the reviewer.** Proposal-file sha256 was identical before and after
  all Truth Firewall runs (positive `aad94ed5…64e8`, negative `8024845b…2637`).
- **No code changes.** Working trees were clean across the parent repo, pehlichi, mad-ptah,
  loony-luna, pehlichi-pub, and Truth Firewall during and after the proof. The temporary generator
  script was removed; proof artifacts live only under the session scratchpad (outside any repo).

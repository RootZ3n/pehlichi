---
name: peh-ptah
description: "Bridge to Ptah (builder/repair agent) — delegate builds, fixes, ops, diagnostics, verification"
triggers:
  - "fix"
  - "repair"
  - "diagnose"
  - "ops"
  - "ptah"
  - "mechanic"
  - "broken"
  - "error"
  - "debug"
  - "deploy"
---

# Pehlichi — Ptah Bridge (Builder/Repair Agent)

## Overview

Ptah is the lab's builder and repair agent. When Pehlichi needs something fixed, built, diagnosed, or verified on the real stack, he delegates to Ptah. Your past life as a mechanic gives you direct access — repair is craft.

Ptah lives on Mushin (100.87.140.113) and runs as a separate Hermes instance on port 18810.

## What Ptah Does

- **Diagnostics** — read the code, search for every site of the problem, state root cause
- **Fixes** — patch code, fix every affected site, review diffs
- **Verification** — run on the real stack, prove the fix with actual output
- **Ops** — start/stop services, check health, manage infrastructure
- **Builds** — compile, test, deploy (or route to ikbi for governed builds)

## When to Route to Ptah

| User Says | Route To | Why |
|-----------|----------|-----|
| "X is broken" | Ptah | Repair |
| "Fix the bug in..." | Ptah | Diagnosis + fix |
| "The service won't start" | Ptah | Ops |
| "Check if Y is working" | Ptah | Verification |
| "Deploy Z" | Ptah | Ops/deployment |
| "Why is this failing?" | Ptah | Diagnosis |
| "The tests are red" | Ptah or ikbi | Fix or governed build |

## When NOT to Route to Ptah

| User Says | Route To | Why |
|-----------|----------|-----|
| "Build a new feature for X" | ikbi | Governed build pipeline |
| "Draw me a picture" | Luna | Creative work |
| "Help me with my resume" | Toba | Career tools |
| "Teach me Spanish" | Nusika | Language learning |

## How to Delegate to Ptah

### Via API (if Ptah is running on Mushin)
```bash
# Health check
curl http://100.87.140.113:18810/health

# Submit a task
curl -X POST http://100.87.140.113:18810/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"input": "Fix the TypeScript compilation error in velum/src/stream.ts", "repo": "/pehverse/repos/ecosystem/velum", "executionMode": "direct"}'
```

### Via Work Order (file-based)
Create a work order in the lab's work order system:
```json
{
  "type": "repair",
  "target": "ptah",
  "task": "Fix the streaming guard crash when client disconnects mid-stream",
  "repo": "/pehverse/repos/ecosystem/velum",
  "priority": "high"
}
```

## Ptah's Repair Pipeline

1. **Investigate** — read affected files, search for every site of the problem
2. **Root cause** — state explicitly before touching anything
3. **Fix** — patch every affected site, review each diff
4. **Verify** — run on real stack, try more than one verification path
5. **Report** — root cause / changes / verification done, each claim backed by real result

## ikbi vs Ptah — When to Use Which

| Scenario | Use ikbi | Use Ptah |
|----------|----------|----------|
| New feature with tests | ✅ Governed pipeline | ❌ |
| Simple one-line fix | ❌ Overkill | ✅ Quick fix |
| Bug that needs proof | ✅ Verifier + critic | ✅ Real stack verification |
| Infrastructure/ops | ❌ Not ikbi's domain | ✅ Service management |
| Multi-file refactor | ✅ Scout + builder | ✅ If scope is clear |
| "Make it work" | ✅ Full pipeline | ✅ Direct fix |

**Rule of thumb:** If it needs verification and governance, use ikbi. If it needs a quick fix and proof, use Ptah. When in doubt, route to ikbi — it's slower but more thorough.

## Ptah's Personality

Ptah is the mechanic. He:
- Diagnoses before fixing (never guesses)
- Fixes every affected site (not just the first one)
- Proves on real stack (never says "should work")
- Reports honestly (including when he can't verify)

## Pitfalls

- **Don't assume Ptah is running** — check health first. He's on Mushin.
- **Don't route creative work to Ptah** — that's Luna's job.
- **Don't route governed builds to Ptah** — use ikbi for that.
- **Be specific about the repo** — Ptah needs to know WHERE the problem is.
- **Ptah's work order system is file-based** — he reads JSON work orders from disk.

# ikbi User Guide

> ikbi is your build engine. It takes a goal, builds it, verifies it, and learns from its mistakes.
> This guide explains every feature so you can use ikbi effectively.

## What is ikbi?

ikbi is an automated build engine. You give it a goal ("add idempotency keys to the charge endpoint"), and it:
1. **Scouts** your repo to understand the code
2. **Builds** the change using AI
3. **Verifies** it with real tests (tsc + vitest/jest/etc.)
4. **Critiques** it semantically (does it actually satisfy the goal?)
5. **Refutes** it adversarially (tries to find what's broken)
6. **Integrates** it (promotes or discards)

## How to Use ikbi

### From the Dashboard (http://localhost:18796)

The dashboard has three main areas:

**Runtime TUI** (top) — Terminal-style interface. Type commands like:
- `help` — show available commands
- `health` — check if ikbi is running
- `agent` — show agent info
- `capabilities` — show tools and features
- `ask <question>` — ask Peh a question

**Chat with Peh** (middle) — Conversation with Peh, the medicine man. Ask him anything about your build.

**Hotspot Windows** (bottom) — Click buttons to open:
- **Job Cards** — Pre-built automations (Repo Gardener, Security Sweep, etc.)
- **Repo Doctor** — Health analysis of your repository
- **Spec Artifact** — Structured build plans
- **Build History** — Past build receipts
- **Modules** — ikbi's 36 modules
- **Configuration** — Model, provider, lifecycle settings
- **Corrections** — Lessons learned from past failures

### From Pehlichi (the guide agent)

Pehlichi can submit builds to ikbi for you:
- "Peh, build this feature for me" → Pehlichi uses `ikbi_build`
- "Peh, fix these failing tests" → Pehlichi uses `ikbi_fix`
- "Peh, check the build status" → Pehlichi uses `ikbi_status`

### From the CLI

```bash
ikbi build "add error handling to the login route" --repo /path/to/repo
ikbi fix --repo /path/to/repo
ikbi audit /path/to/repo
ikbi cost
ikbi receipts
```

---

## Features Explained

### 1. Job Cards (pre-built automations)

Job cards are reusable, named tasks with built-in guardrails. Click "Run" on any card in the dashboard.

| Card | What it does | Access |
|------|-------------|--------|
| **Repo Gardener** | Find god files, stale docs, unused exports | write-gated |
| **Receipt Doctor** | Audit receipts for gaps | read-only |
| **Dependency Mapper** | Map dependency graph, find circular deps | read-only |
| **Docs Drift Auditor** | Compare docs to actual code | read-only |
| **Test Gap Finder** | Find untested code paths | read-only |
| **Security Sweep** | Scan for secrets and unsafe patterns | read-only |
| **Refactor Planner** | Suggest bounded refactors with blast radius | read-only |
| **Import Cleaner** | Remove unused imports (max 5 files) | write-gated |

**Guardrails**: Each card has limits — max files it can change, protected paths it can't touch, and requires a clean worktree for write operations.

### 2. Repo Doctor (health analysis)

Click the 🔍 button to scan your repository. It checks 6 dimensions:
- **File health** — god files, stale code
- **Dependency health** — circular deps, unused packages
- **Test health** — coverage gaps, stub tests
- **Doc health** — stale READMEs, missing docs
- **Import health** — unused imports, missing imports
- **Structure health** — project organization

Each dimension gets a score out of 100. Click any dimension to see findings.

### 3. Spec Artifact (structured build plans)

Instead of giving ikbi a loose prompt, you can give it a structured spec card:

```
PROJECT: payments-api
GOAL: add idempotency keys to the charge endpoint
SCOPE:
  in: src/routes/charge.ts, src/lib/idempotency.ts
  out: billing dashboard, refunds
RULES:
  - no new runtime dependencies
  - keep all existing tests green
OUTPUT: a passing build with a new idempotency test
ON CONFLICT: abort and report
```

**Why use specs?** A prompt is loose. A spec is enforceable. ikbi can check whether the build actually satisfied every part of the spec.

**Fields explained:**
- **PROJECT** — the project name
- **GOAL** — what to build
- **SCOPE in** — files that should be modified
- **SCOPE out** — files that should NOT be touched
- **RULES** — constraints (no new deps, keep tests green, etc.)
- **OUTPUT** — what the result should look like
- **ON CONFLICT** — what to do if there's a conflict (abort, report, etc.)

### 4. Corrections Library (lessons learned)

When ikbi finds a problem during a build, it can propose a **correction** — a reusable lesson. Corrections are governed: they're proposed first, then you approve or reject them.

**Categories:**
- **Manifest Change** — package.json change was expected (e.g., stub → real test runner)
- **Tool Limitation** — the tool can't do what was asked
- **Environment Missing** — required tool/dependency not installed
- **Suspicious Pattern** — code pattern that looks wrong
- **Test Weakening** — tests were made less strict
- **Forbidden File** — a protected file was modified
- **Verification Forgery** — test script was faked
- **Conflict Resolution** — merge conflict was silently resolved
- **Custom** — anything else

**How to use:**
1. ikbi proposes corrections automatically when it finds issues
2. Review them in the Corrections panel
3. Click **Approve** to accept (the lesson will be applied to future builds)
4. Click **Reject** to discard

**Why this matters:** Every approved correction makes ikbi smarter. If it learns that "replacing echo with vitest is expected," it won't flag that as suspicious in future builds.

### 5. The Refuter (adversarial verification)

The refuter is ikbi's "devil's advocate." After the builder and critic say "this looks good," the refuter tries to prove them wrong.

**What it checks:**
1. Tests actually ran (not just claimed to pass)
2. Source files match what the builder claims
3. Tests weren't weakened (assertions removed)
4. Protected files weren't modified
5. Test scripts are real (not stubs like `echo pass`)
6. package.json changes are expected
7. Build output matches the spec
8. No merge conflict markers left behind
9. Build receipts exist

**How to enable:** Set `IKBI_WORKER_MODEL_ENABLE_REFUTER=true` in ikbi's environment.

**Important:** The refuter is advisory — it files corrections but doesn't block promotion. The integrator still decides whether to promote or discard.

### 6. Build Pipeline (what happens on every build)

```
Goal → Scout → Builder → Verifier → Critic → Refuter → Integrator
        (read)  (write)   (check)    (judge)   (refute)   (promote/discard)
```

- **Scout** — reads your repo to understand the code
- **Builder** — makes changes using AI + tools
- **Verifier** — runs tsc + tests (deterministic, no AI)
- **Critic** — judges whether the change satisfies the goal (AI-driven)
- **Refuter** — tries to find what's broken (adversarial)
- **Integrator** — decides to promote (merge) or discard

**Cost**: Most builds cost $0.01-0.05. The expensive model (pro) is only used for verification, not generation.

---

## Common Tasks

### "Build this feature"
Use the dashboard chat: "Add error handling to the login route"
Or use Pehlichi: "Peh, build this for me"
Or use CLI: `ikbi build "add error handling to the login route" --repo /path/to/repo`

### "Fix these failing tests"
Use Pehlichi: "Peh, fix these tests"
Or use CLI: `ikbi fix --repo /path/to/repo`

### "Check my repo health"
Click **Repo Doctor** → 🔍 Scan

### "Run a security scan"
Click **Job Cards** → **Security Sweep** → Run

### "Plan a refactor"
Click **Job Cards** → **Refactor Planner** → Run

### "See what ikbi has learned"
Click **Corrections** → Review proposed/approved corrections

### "Write a structured spec"
Click **Spec Artifact** → Generate from goal, or paste a structured spec card

---

## FAQ

**Q: How much does ikbi cost?**
A: Most builds cost $0.01-0.05. 75+ runs cost ~$2 total. The economics let you run lots of attempts.

**Q: Can ikbi break my code?**
A: ikbi works in an isolated workspace. Changes are only promoted if all checks pass. Protected files (.env, package-lock.json) are never touched.

**Q: What if ikbi gets it wrong?**
A: The critic and refuter catch most issues. If something slips through, you can undo a promote. And the correction library ensures ikbi learns from the mistake.

**Q: Do I need to understand the pipeline?**
A: No. Just give ikbi a goal and it handles the rest. The pipeline is there for when you need to understand what happened.

**Q: What's the difference between ikbi and Pehlichi?**
A: Pehlichi is your guide — you talk to Pehlichi, and Pehlichi talks to ikbi. ikbi is the build engine that does the actual work.

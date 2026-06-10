---
name: work-order-creator
description: "Create work orders for Ptah. Use when you encounter a bug, need a report, or want to schedule maintenance."
version: 1.0.0
tags: [work-orders, ptah, lab-maintenance, bug-report]
---

# Work Order Creator

Create work orders that Ptah picks up and resolves. Work orders live in `/pehverse/state/work-orders/` as individual JSON files.

## When to Create a Work Order

- You found a bug but don't want to stop what you're doing
- A test suite is failing
- A service is down
- You want a multi-model comparison report
- You want code quality review on a specific repo
- You want to schedule maintenance

## How to Create

Write a JSON file to `/pehverse/state/work-orders/WO-{NNNN}.json`:

1. Read the directory to find the next ID
2. Write the JSON file with all fields filled
3. Tell the user the work order ID

```bash
# Find next ID
ls /pehverse/state/work-orders/WO-*.json 2>/dev/null | sort | tail -1

# Write the file
cat > /pehverse/state/work-orders/WO-0001.json << 'WOEOF'
{
  "id": "WO-0001",
  "title": "Short descriptive title",
  "description": "Full details, error messages, repro steps",
  "source": "peh",
  "status": "open",
  "severity": "high",
  "category": "bug",
  "repos": ["ikbi"],
  "createdAt": "2026-06-10T12:00:00Z",
  "updatedAt": "2026-06-10T12:00:00Z"
}
WOEOF
```

## Work Order Schema

```json
{
  "id": "WO-NNNN",
  "title": "Short title",
  "description": "Full details",
  "source": "peh|luna|julian|zen|archelon|ptah",
  "status": "open|assigned|in-progress|blocked|done|wontfix|duplicate",
  "severity": "critical|high|medium|low|info",
  "category": "bug|regression|test-failure|service-down|code-quality|audit|report|enhancement|maintenance",
  "repos": ["repo-name"],
  "files": ["path/to/file"],
  "attachments": ["error logs, stack traces"],
  "tags": ["tag1", "tag2"],
  "scheduledFor": "ISO timestamp (optional)",
  "createdAt": "ISO timestamp",
  "updatedAt": "ISO timestamp"
}
```

## Severity Guide

| Severity | When |
|----------|------|
| **critical** | Service is down, data loss, blocking all work |
| **high** | Test suite broken, important feature broken |
| **medium** | Bug that has a workaround, code quality issue |
| **low** | Nice to have, minor annoyance |
| **info** | FYI, no action needed now |

## Tips

- Be specific — include error messages, file paths, repro steps
- Always include `repos` so Ptah knows where to look
- Use `attachments` to paste full stack traces or test output
- Use `tags` for grouping (e.g., ["weekly", "code-quality"])
- Use `scheduledFor` for deferred work

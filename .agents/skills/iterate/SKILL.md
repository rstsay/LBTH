---
name: iterate
description: Determine the next planning or implementation step for an existing feature workspace based on its PRD, decisions, feedback, and issue status.
---

# Iterate

Read the feature workspace at `docs/features/<slug>/`.

Determine the current state and recommend the next command.

## Decision rules

| Situation | Next command |
|---|---|
| No PRD exists | `/to-prd --feature <slug>` |
| New decisions or feedback exist but PRD is outdated | `/to-prd --feature <slug> --update` |
| PRD updated but issues not synchronized | `/to-issues --feature <slug> --sync` |
| Issues exist and are current | Select the highest-priority ready issue and implement it |
| An issue is blocked | Identify the blocker and ask the user how to resolve it |
| Implementation revealed a design problem | `/grill-me --feature <slug>` |
| Feature is complete | Update PRD status to “Implemented” and archive open questions |

## Output

Provide:

1. Current feature status
2. What changed since the last iteration
3. Recommended next command
4. Issues that are ready, blocked, obsolete, or need revision
5. Any decision the user must make before proceeding
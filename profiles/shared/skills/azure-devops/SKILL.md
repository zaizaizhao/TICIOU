---
name: azure-devops
description: Use when creating, updating, reviewing, or linking Azure DevOps work items, pull requests, builds, releases, or sprint tasks.
---

# Azure DevOps Workflow

Use this skill whenever the user asks about Azure DevOps work items, pull requests, boards, builds, releases, or sprint planning.

## Instructions

1. Identify the Azure DevOps object type involved: work item, pull request, branch, build, release, board, or sprint.
2. Ask for the missing identifier only if the request cannot be completed without it.
3. Prefer concise status summaries with direct links, owners, blockers, and next actions.
4. Never print secrets, access tokens, cookies, or private authentication headers.
5. When creating or updating records, summarize the intended change before suggesting the command or API call.

## Output Style

- Lead with the current state or recommended action.
- Include IDs and links when available.
- Keep long audit trails out of the answer unless the user asks for detail.

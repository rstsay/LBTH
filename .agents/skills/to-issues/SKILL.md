## Feature workspace mode

If the user provides `--feature <slug>`, use:

    docs/features/<slug>/

Read:

- `02-prd.md`
- `01-decisions.md`
- `03-feedback.md`
- `issues/*.md`
- `CHANGELOG.md`

### First run

If `issues/` is empty or does not exist:

1. Break the PRD into vertical slices.
2. Save one Markdown issue per slice in `issues/`.
3. Number files sequentially:

    001-<issue-slug>.md
    002-<issue-slug>.md

4. Add traceability fields to every issue:

**Feature:** <slug>  
**PRD version:** v1  
**Source requirement:** <PRD section or requirement ID>  
**Iteration:** 1

5. Append to `CHANGELOG.md`:

## Iteration 1 — Initial issue breakdown

- Created N vertical-slice issues from PRD v1.

### Later iterations: `--sync`

If `issues/` already exists:

1. Compare PRD v<N> against existing issues.
2. Classify each issue:

| Classification | Meaning | Action |
|---|---|---|
| Unchanged | Requirement and acceptance criteria remain valid | Leave unchanged |
| Needs update | Scope, acceptance criteria, dependencies, or implementation notes changed | Revise issue |
| Obsolete | Requirement removed or replaced | Mark closed/superseded; do not delete |
| New | Requirement has no covering issue | Create new issue |
| Split | One issue has become too large or covers multiple deliverables | Split into linked issues |
| Blocked | Requires decision, access, external dependency, or human review | Mark blocked and identify owner |

3. Present a synchronization plan before changing files:

| Issue | Action | Reason |
|---|---|---|
| 001 | Unchanged | Requirement unchanged |
| 002 | Update | PDF template and receipt-numbering rules changed |
| 003 | New | Admin void workflow added in PRD v2 |
| 004 | Obsolete | Automatic email delivery removed |

4. After user approval:

- Update affected issue files.
- Add a revision block to each changed issue:

## Revision history

| Date | PRD version | Change | Reason |
|---|---|---|---|
| YYYY-MM-DD | v2 | Added void workflow | New admin requirement |

- For obsolete issues, retain the file and set:

**Status:** Superseded by <new issue>  
**Reason:** <Why it is no longer needed>

- For new issues, use the next sequential number.
- Update dependency links.
- Append to `CHANGELOG.md`.

## Traceability rule

Every issue must trace to a PRD requirement.

Use this field:

**Source requirement:** <PRD section or requirement ID>

If an issue cannot be traced to a requirement, ask whether it is:
- A missing PRD requirement
- A technical enabler
- A bug fix
- Out of scope

Do not create an untraceable feature issue without user approval.



# To Issues

Break the current PRD, plan, or conversation into independently grabbable issues using vertical slices.

A vertical slice is a small, complete, testable increment that cuts through all necessary layers: data, business logic, interface, and tests. Do not create horizontal layers such as “all database changes,” “all API endpoints,” or “all UI work.”

## Process

### 1. Gather context

Use the current conversation, attached documents, and referenced files.

If the user provides a PRD path, issue number, issue URL, or local Markdown file, read it first.

Identify:

- Product goal
- Users and permissions
- Functional requirements
- Constraints and dependencies
- Existing architecture and conventions
- Testing expectations
- Deployment, migration, or data-privacy concerns

### 2. Explore the repository

If needed, inspect the codebase to understand:

- Relevant modules, services, and data models
- Existing naming and domain vocabulary
- API patterns and UI patterns
- Testing conventions
- Architecture decision records, if present

Prefer reuse of existing modules and patterns.

When useful, identify a small prefactor that makes later implementation easier. Follow the principle: “Make the change easy, then make the easy change.”

### 3. Create vertical slices

Break the work into the smallest useful sequence of independently deliverable slices.

Each issue must:

- Deliver observable value or a meaningful, testable increment
- Be small enough for one person or agent to complete in a focused session
- Have clear acceptance criteria
- Identify its dependencies
- Avoid combining unrelated changes
- Preserve the system in a working state after completion

Classify every issue:

- `AFK`: An agent can implement it without human interaction.
- `HITL`: It requires a human decision, review, approval, external account, credential, legal review, or production access.

Prefer `AFK` where possible.

### 4. Present the plan first

Before creating any issue, present a concise table:

| Order | Proposed issue title | Type | Dependencies | Why this slice |
|---|---|---|---|---|

Ask the user to approve or revise the breakdown.

Do not create issues until the user approves.

### 5. Create issues

After approval:

- If GitHub Issues is available and the user asks for GitHub issues, create them in dependency order.
- Otherwise, write one Markdown file per issue in `docs/issues/`.
- Name files using lowercase hyphenated slugs, for example:
  - `001-member-can-view-donation-history.md`
  - `002-member-can-download-receipt.md`

Include cross-references between dependent issues.

## Issue template

# <Issue title>

**Type:** AFK or HITL  
**Depends on:** <issue title, number, or “None”>  
**Part of:** <PRD or feature name>

## What to build

### User story

As a <role>, I want <capability>, so that <benefit>.

### Scope

Describe exactly what this vertical slice includes.

### Out of scope

List closely related work that belongs in another issue.

## Acceptance criteria

- [ ] Concrete, testable outcome
- [ ] Concrete, testable outcome
- [ ] Error, permission, or edge-case behavior is handled

## Implementation notes

- Relevant files, modules, or services
- Data model or schema changes
- API or UI behavior
- Existing patterns to follow
- Migration or compatibility considerations

## Testing

- Unit tests: <what to cover>
- Integration tests: <what to cover>
- UI or manual tests: <what to verify>

## Research and references

- Link to the PRD, ADR, external API documentation, or relevant discussion.
- Record assumptions and constraints that affect implementation.

## Definition of done

- [ ] Code implemented according to project conventions
- [ ] Tests added or updated
- [ ] Documentation updated if needed
- [ ] Feature works end to end
- [ ] No unrelated refactors included
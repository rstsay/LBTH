## Feature workspace mode

If the user provides `--feature <slug>`, use:

    docs/features/<slug>/

Read:

- `00-context.md`
- `01-decisions.md`
- `03-feedback.md`
- Existing `02-prd.md`, if present

### First iteration

If `02-prd.md` does not exist:

1. Synthesize the conversation and workspace into a full PRD.
2. Save it as `02-prd.md`.
3. Add `v1` to the PRD status.
4. Append to `CHANGELOG.md`:

## v1 — Initial PRD

- Created initial PRD from discovery interview.

### Later iterations

If `02-prd.md` exists:

1. Treat the existing PRD as the source of truth.
2. Apply only changes supported by `01-decisions.md` and `03-feedback.md`.
3. Preserve unchanged sections.
4. Mark changed sections with:

> **Changed in v<N>:** <brief explanation>

5. Update the PRD version:

    Status: Draft — v2

6. Add a “Revision history” section:

## Revision history

| Version | Date | Summary of changes | Source |
|---|---|---|---|
| v2 | YYYY-MM-DD | Added admin void-receipt workflow | Decision log, feedback |

7. Append to `CHANGELOG.md`:

## v2 — PRD revision

- Added admin void-receipt workflow.
- Removed automatic email delivery from initial scope.
- Updated acceptance criteria for receipt numbering.

Do not silently delete requirements. If a requirement is removed, move it to “Removed from scope” with the reason.



# To PRD

Turn the current conversation, user requirements, and your understanding of the repository and update the Product Requirements Document (PRD).

Do not interview the user unless essential information is missing. Synthesize what is already known.

## Process

1. Review the conversation and identify:
   - The user problem
   - Desired outcome
   - Constraints
   - Affected users or roles
   - Any decisions already made

2. Explore the repository enough to understand:
   - Relevant existing features
   - Likely files, modules, services, or data models affected
   - Existing conventions, architecture decisions, and terminology
   - Testing patterns already used in the project

3. Identify the major modules or components to build or change.
   - Prefer reusing existing modules and patterns.
   - Favor simple, testable interfaces.
   - Note any schema, API, permissions, or workflow changes.

4. Write the PRD in Markdown using the template below.

5. Ask the user to review only if there is a material ambiguity, conflicting requirement, or high-risk technical decision.

6. Save the PRD to:
   docs/prd/proud.md

7. Do not create a GitHub issue, Linear issue, or other tracker item unless the user explicitly asks for it.

## PRD template

# PRD: <Feature title>

## Status

Draft

## Problem statement

Describe the problem from the user’s perspective. Explain why it matters and what currently does not work well.

## Goals

- List the primary outcomes this feature must achieve.
- Keep each goal measurable or clearly verifiable where possible.

## Non-goals

- List explicitly excluded work.
- Include nearby ideas that should not be built in this iteration.

## Target users

Describe the primary user roles and their needs.

| Role | Need | Current pain |
|---|---|---|
| Example: Member | Easily download a donation receipt | Must email staff manually |

## Proposed solution

Describe the solution in user-facing terms before implementation details.

## User stories

Write numbered user stories in this format:

1. As a <role>, I want <capability>, so that <benefit>.

Include happy paths, edge cases, permissions, error states, and administrative needs.

## Functional requirements

List concrete, testable requirements.

- The system shall…
- Users must be able to…
- When <condition>, the system shall…

## Implementation notes

Record decisions already made or strongly implied by the conversation:

- Modules or services to create or modify
- Data model or schema changes
- API endpoints or contracts
- UI/UX behavior
- Integrations
- Security, privacy, accessibility, or localization considerations
- Migration or backward-compatibility needs

## Testing strategy

Describe how the feature should be verified.

- Unit tests: which core logic needs coverage
- Integration tests: which workflows or APIs need coverage
- UI tests: which critical user journeys need coverage
- Manual QA: what should be checked before release

Test external behavior rather than implementation details.

## Success metrics

Define how success will be measured.

| Metric | Baseline | Target |
|---|---|---|
| Example: Staff time per receipt | 10 minutes | Under 1 minute |

## Risks and open questions

List unresolved decisions, dependencies, technical risks, and assumptions.

## Rollout plan

Describe how the change will be released:

- Feature flag, staged rollout, or direct release
- Data migration needs
- Documentation or training needs
- Monitoring or support considerations
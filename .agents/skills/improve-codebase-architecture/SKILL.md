---
name: improve-codebase-architecture
description: Survey a codebase or feature area for architectural friction and propose small, testability-focused refactors. Use when the user invokes /improve-codebase-architecture or asks for architecture improvement candidates.
---

# Improve Codebase Architecture

Survey the codebase for architectural friction and propose **module-deepening refactors** that improve testability, maintainability, and navigability.

This is a survey and proposal command. Do not perform a large refactor without explicit user approval.

## Scope

Accept:

- `--area <path>` to inspect a directory, module, or subsystem
- `--feature <slug>` to inspect code touched by a feature workspace
- No argument to inspect recent hot spots across the repository

If no area is provided:

1. Review recent commit history to identify frequently changed files and recurring pain points.
2. Prioritize those hot spots over a whole-repository scan.
3. If changes are scattered, ask the user which area matters most.

Focus on code that is likely to change again. Architecture work should pay for itself by making future changes easier.

## What to look for

Identify concrete friction, such as:

- A module that requires knowledge of many unrelated internals to use safely
- Business rules duplicated across API, UI, background jobs, or tests
- Data access, external-service calls, and business logic tightly mixed
- Functions or classes that are hard to test without a database, network, clock, or filesystem
- Long dependency chains or circular dependencies
- Inconsistent domain vocabulary
- Repeated adapter or integration patterns
- Tests that break when unrelated implementation details change
- Missing seams around external systems, time, randomness, file storage, email, payments, or third-party APIs

## Refactor vocabulary

Use these terms consistently:

- **Module:** A coherent unit of behavior with a clear purpose.
- **Interface:** The set of behavior other code can rely on.
- **Depth:** A module hides complexity behind a small, useful interface.
- **Seam:** A place where behavior can be substituted or tested independently.
- **Adapter:** Code that translates between your domain and an external system.
- **Locality:** Related decisions and changes live near one another.
- **Leverage:** A small change produces a broad, durable benefit.

A good refactor makes a shallow module deeper: it hides more complexity behind a simpler, more meaningful interface.

## Analysis process

1. Read project conventions:
   - `agents.md` or equivalent agent instructions
   - Architecture decision records, if present
   - Domain glossary, if present
   - Existing test conventions

2. Inspect the selected area:
   - Module boundaries
   - Public interfaces
   - Dependencies
   - Test coverage
   - Recent change frequency
   - Duplicate logic
   - External-system coupling

3. Identify up to five candidates. Do not produce an exhaustive list.

4. For each candidate, assess:
   - Current pain
   - Proposed deepening refactor
   - Expected benefit
   - Testability improvement
   - Risk and migration path
   - Estimated size: small, medium, or large
   - Whether it can be done as a standalone issue

5. Present a prioritized proposal table.

## Proposal format

| Priority | Area | Friction | Proposed refactor | Benefit | Risk | Size |
|---|---|---|---|---|---|---|
| 1 | `services/receipts` | Receipt rules duplicated in API and email job | Extract `ReceiptPolicy` module with a clear interface | One place for tax and numbering rules; easier tests | Low | Small |

For each selected candidate, provide:

### Candidate: <name>

**Current friction**

Describe the concrete problem and where it appears.

**Proposed refactor**

Describe the target module, interface, and seam.

**Why now**

Explain the recent or expected change pressure.

**Testability improvement**

Explain which tests become easier or more meaningful.

**Migration path**

Describe small, safe steps that preserve behavior.

**Out of scope**

List refactors that should not be bundled with this work.

## Output rules

- Propose at most five candidates.
- Rank by leverage, change frequency, risk, and testability benefit.
- Prefer small, reversible refactors.
- Do not recommend a rewrite unless there is no viable incremental path.
- Do not re-litigate decisions already recorded in ADRs.
- Do not bundle a refactor with a feature implementation unless it is the minimum necessary seam.

## Creating follow-up work

After the user selects one or more candidates:

1. Ask whether to create:
   - A standalone architecture-refactor issue
   - A follow-up issue in the current feature workspace
   - A local Markdown proposal only

2. If creating an issue, use this template:

# Refactor: <Candidate name>

**Type:** Architecture improvement  
**Area:** <path or module>  
**Depends on:** None or <issue>  
**Risk:** Low / Medium / High

## Problem

Describe the architectural friction.

## Proposed change

Describe the deepening refactor.

## Expected benefit

- Improved testability
- Reduced duplication
- Clearer module interface
- Easier future feature work

## Guardrails

- Preserve existing external behavior.
- Add or strengthen characterization tests before changing behavior-sensitive code.
- Keep the refactor separate from unrelated feature work.
- Use small commits or PRs.

## Acceptance criteria

- [ ] Target module has a clearer interface
- [ ] Duplicate logic is reduced or removed
- [ ] Tests cover the new seam
- [ ] Existing behavior is preserved
- [ ] No unrelated refactors are included

## Feature workspace integration

If `--feature <slug>` is used:

- Record findings in `03-feedback.md` under **Architectural observations**.
- If a refactor is deferred, add it to `01-decisions.md` as a proposed decision.
- If a refactor is approved, create an issue in `issues/` with the next sequential number.
---
name: tdd
description: Implement one issue or small change using test-driven development. Use when the user invokes /tdd, asks to implement an issue, or asks for a red-green-refactor workflow.
---

# TDD

Implement the selected issue or change using a strict red-green-refactor loop.

Work in small vertical slices. Each cycle should move the feature visibly closer to done while keeping the system working.

## Inputs

Accept:

- An issue file path, issue number, issue title, or GitHub issue URL
- `--feature <slug>` to select an issue from `docs/features/<slug>/issues/`
- A direct instruction for a bug fix or small enhancement

If no issue is specified:

1. Look for the current feature workspace.
2. List ready issues in dependency order.
3. Ask the user which issue to implement.

## Before writing code

1. Read the issue, its dependencies, and the linked PRD section.
2. Read the relevant existing code, tests, and project conventions.
3. Identify the smallest first behavior that can be tested.
4. State the plan:

   **Implementing:** <issue title>  
   **First test:** <behavior under test>  
   **Expected result:** <observable outcome>

5. Confirm the plan with the user if the issue is ambiguous, touches production data, changes permissions, or requires an external service.

## Red-green-refactor loop

For each small behavior:

### Red: write a failing test

- Write one focused test for the next required behavior.
- Run it and confirm it fails for the expected reason.
- If it fails for an unrelated reason, fix that problem first.
- Do not write implementation code before the test fails.

### Green: make it pass

- Write the minimum production code needed to pass the test.
- Avoid speculative abstractions, configuration options, and premature generalization.
- Run the test suite.
- Stop when the new test passes and previously passing tests still pass.

### Refactor: improve without changing behavior

After green, improve the code only if it reduces real friction:

- Remove duplication.
- Improve naming using the project’s domain vocabulary.
- Extract a function or module only when duplication or complexity justifies it.
- Improve test clarity.
- Preserve behavior; tests must remain green.

Do not refactor unrelated code during a feature implementation.

## Test quality rules

Prefer tests that verify observable behavior:

- Public function results
- API responses
- UI behavior
- Database state after a user action
- Error and permission outcomes

Avoid tests coupled to implementation details:

- Private function names
- Internal class structure
- Exact SQL text
- Mocked internals where a real integration test is feasible
- Snapshot tests that break on harmless formatting changes

Use the project’s existing test framework and patterns. If no convention exists, propose one before writing many tests.

## Handling a failing test

If a test fails unexpectedly:

1. Read the failure carefully.
2. Determine whether the test expresses the intended behavior.
3. If the test is wrong, revise the test first.
4. If the implementation is wrong, change the implementation.
5. Do not weaken an assertion merely to make the test pass.

## Handling existing untested code

If the issue touches untested legacy code:

1. Add characterization tests only for behavior that must remain unchanged.
2. Make the smallest safe seam or adapter needed to test the new behavior.
3. Avoid a large refactor inside the feature issue.
4. Record architectural friction in the feature workspace or propose it for `/improve-codebase-architecture`.

## Completion checklist

Before marking the issue complete:

- [ ] All acceptance criteria are met
- [ ] New behavior has tests
- [ ] Existing tests pass
- [ ] No unrelated changes are included
- [ ] Code follows project conventions
- [ ] Documentation, migrations, or configuration are updated if needed
- [ ] Issue status and implementation notes are updated

## Feature workspace integration

If working from `docs/features/<slug>/`:

- Update the issue’s status to `In progress` when starting.
- Add an implementation log entry when complete:

## Implementation log

- Date: YYYY-MM-DD
- Tests added: <count or files>
- Key decisions: <brief notes>
- Architectural friction found: <link or description>
- Follow-up work: <issue or none>

- If the work revealed a new requirement, do not silently expand the issue. Record it in `03-feedback.md` and recommend `/grill-me --feature <slug>`.
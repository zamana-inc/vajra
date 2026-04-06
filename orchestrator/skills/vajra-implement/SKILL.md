---
name: vajra-implement
description: Use for Vajra implementation stages to faithfully execute an approved plan, validate the changes, and produce a truthful summary of what was done.
---

# Vajra Implement

You have an approved plan. Execute it faithfully, validate the result, and leave a clear record of what you actually did.

## Context

Ship correct code quickly. Do not overengineer. Do not refactor things that are not in the plan. Do not add abstractions "for the future."

Vajra runs as an automated agent. If the plan describes required manual steps (like database migrations), implement the code that depends on them but flag those steps for human engineers in the PR.

## Mindset

Implementation is translation, not invention. The plan has been investigated and reviewed. Turn it into working code. If the plan says change three files, you change three files — not five.

The most common failure is scope creep. You will see things that could be improved. Resist. You are here to solve one issue. Note it in your summary if you want, but do not act on it.

That said, if you discover the plan has a factual error — wrong function signature, missing import, file moved — adapt minimally. Fix the mismatch, do not redesign the approach.

## Process

### 1. Read the plan before writing code

Understand the ordering of changes, dependencies between them, and what the acceptance checks are. They define "done."

### 2. Implement in the plan's order

Follow the sequence prescribed. Make each change as described. Keep your diff tight:

- Do not reformat surrounding code
- Do not fix unrelated issues
- Do not add blank lines for aesthetics

### 3. Write the tests the plan specifies

Follow the patterns already in the codebase. Look at neighboring tests for conventions. If the plan says "add a test for X," add that test — matching the style of nearby test files.

If the area has no existing tests and the plan does not call for new test infrastructure, do not create it.

### 4. Validate

Run the project's test suite and linter on changed files. At minimum:

- `pytest tests/ --tb=short -q`
- `ruff check --select E,F,W` on changed files

If tests fail from your change, fix it. If it is a pre-existing failure, record it but do not fix unrelated tests.

### 5. Write the summary

Factual record of what you did. Not what you intended — what actually happened. If a test failed and you could not fix it, say so.

## Output Format

```markdown
# Changes
What files changed and what each change does. Brief.

# Validation
Commands run, results. Copy pass/fail output.

# Outstanding Concerns
Only real residual issues. Empty if clean.
```

## Quality Bar

**Good**: tight diff matching the plan. Tests pass. Summary reflects reality.

**Bad**: drifts from the plan without justification, leaves failing tests undocumented, includes cosmetic changes mixed with functional ones, describes the plan instead of what happened.

### Drifting from the plan

- Editing a file the plan does not mention
- Adding a function the plan did not call for
- "Cleaning up" code near your changes
- Diff is significantly larger than the plan suggests

### Dishonest summary

- Describes the plan instead of what you did
- Says "all tests pass" without showing output
- Omits a failing test
- Describes a change you intended but did not make

## Handling Plan Errors

- **Wrong function signature**: adapt the call to match reality
- **File does not exist**: check if renamed or moved, use correct path
- **Missing import**: add it
- **Test file does not exist**: create it following codebase conventions

Note every deviation in your summary. The reviewer needs to know where you diverged and why.

## Rules

- Do not create commits or branches. Code changes only.
- Do not modify the plan file.
- Do not expand scope beyond the plan.
- Do not create database migrations or schema changes.
- Run validation before declaring done. "I think tests pass" is not validation.
- If validation fails and you cannot fix it, document the exact failure. Do not hide it.

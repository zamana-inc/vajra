---
name: vajra-fix
description: Use for Vajra fix stages to address confirmed review findings, revalidate, and update the implementation summary.
---

# Vajra Fix

You are addressing code review feedback. Fix what the reviewer found, verify the fixes, update the record. Nothing more.

## Context

Fixes should be surgical. Do not use review feedback as an excuse to rewrite the implementation. Fix the specific problems. Ship it.

Vajra runs as an automated agent. If a review finding relates to a manual step (like a database migration), note it in the summary for human engineers.

## Mindset

Fixing is surgical. You are addressing specific, documented findings — not "taking another pass." Each finding has a file, an issue, and an impact. Address them one by one.

The most common failure is over-correction: you read the review, feel the urge to "do it properly this time," and rewrite half the implementation. This creates new bugs and wastes time. Fix what was found. Stop.

If the review approved with no findings, your job is even simpler: run validation, update the summary if needed, move on.

## Process

### 1. Read the review artifact

Categorize each finding:

- **Confirmed bug**: fix it
- **Missing handling**: add it
- **Missing test**: add it
- **Disagreement**: verify carefully before dismissing. If you still disagree, record why

### 2. If approved with no findings

Run the test suite. If it passes, update the summary minimally and move on. Do not make cosmetic changes.

### 3. Fix each finding individually

For each confirmed finding:
- Read the specific code flagged
- Make the minimum change that resolves it
- Add a test if the fix warrants one
- Verify the fix does not break other tests

Do not batch-fix by rewriting surrounding code.

### 4. Handle disagreements

If you believe a finding is wrong:
- Re-read the reviewer's reasoning
- Read the code they reference
- Trace the execution path

If still wrong, document your evidence. "The reviewer is wrong" is not sufficient.

### 5. Revalidate

Run the full test suite after all fixes. Non-negotiable.

### 6. Update the summary

The summary must reflect the final state after fixes:
- What findings were addressed and how
- Any findings you disagreed with and why
- Updated validation results

## Output Format

```markdown
# Changes
All code changes including fixes. Group fix-related changes so the reader can see what changed.

# Validation
Commands run after fixes, with results.

# Outstanding Concerns
Any remaining issues. Empty if clean.
```

## Quality Bar

**Good**: each finding addressed directly, no new issues introduced, summary is honest.

**Bad**: rewrites the implementation, ignores findings without justification, skips revalidation.

### Over-fixing

- Changing files no finding references
- Fix diff larger than the implementation diff
- Reorganizing code structure
- Renaming things the review did not flag

### Under-fixing

- Marked a finding as addressed but did not change the code
- Added a comment instead of fixing behavior
- Changed the test to match buggy behavior instead of fixing the code

## Rules

- Do not create commits or branches.
- Do not rewrite the implementation. Fix the specific findings.
- Do not create database migrations.
- Run validation after fixing.
- Update the summary to match reality.
- If approved with no findings, keep changes minimal.

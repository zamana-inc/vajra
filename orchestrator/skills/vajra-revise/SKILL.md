---
name: vajra-revise
description: Use for Vajra revision stages to address human PR feedback on an existing branch, validate the changes, and summarize the revision in .vajra/run/revision-summary.md.
---

# Vajra Revise

This skill is for the PR revision stage after a human requested changes on GitHub.

## Goals

- Read the compiled GitHub feedback in `.vajra/review-feedback.md` or `.vajra/github-review-bundle.md`.
- Make targeted code changes on the existing PR branch.
- Re-run the validation needed to prove the feedback was addressed.
- Leave a concise revision summary for the PR update stage.

## Inputs

- `.vajra/review-feedback.md`
- `.vajra/review-feedback.json`
- `.vajra/github-review-bundle.md`
- `.vajra/github-review-bundle.json`
- `.vajra/pr.json`
- `.vajra/plan.md` when it exists
- `.vajra/implementation-summary.md` when it exists
- The live workspace and diff

## Output

Write `.vajra/run/revision-summary.md` with:

```md
# Feedback Addressed
- each feedback item handled and what changed

# Validation
- exact commands run
- pass/fail result for each command

# Outstanding Concerns
- only real residual risks or follow-ups
```

## Rules

- Stay scoped to the human feedback. Do not reopen unrelated work.
- Prefer the smallest diff that resolves the requested changes cleanly.
- If a feedback item is unclear or conflicts with the code, verify carefully and note the reasoning in the summary.
- Do not create a new PR in this stage.

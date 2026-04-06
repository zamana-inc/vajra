---
name: vajra-prepare-pr
description: Use for Vajra PR preparation stages to prepare, validate, commit, and push the branch for a pull request without mutating GitHub directly.
---

# Vajra Prepare PR

You are shipping the work. Take completed, validated code and turn it into a pull request that an engineer can review and approve in under 5 minutes.

## Context

PR reviewers are busy engineers who want to merge fast. Your PR should make that easy: clear title, concise body, real test evidence. No fluff.

Vajra runs as an automated agent. If the implementation requires manual steps (like a database migration), include a clear "Manual Steps" section in the PR body so the reviewing engineer knows exactly what to run.

## Mindset

A PR is a communication artifact. Its purpose is to help a reviewer understand what changed, why, and how it was verified — so they can approve quickly.

The body is not a retelling of the plan or a log of your process. It is a concise description of what this PR does, how it was tested, and anything the reviewer should know. Respect their time.

## Process

### 1. Verify readiness

Before creating git artifacts:
- Check that the review approved or findings were addressed
- Run tests (do not assume — verify)

If not ready — tests fail, findings unaddressed — stop. Do not create a PR for broken code.

### 2. Inspect the actual diff

`git diff` is the truth. Verify:
- Diff matches the issue's intent
- No debug code, temp files, or unrelated changes
- No secrets in the diff

### 3. Write the PR title

Specific and descriptive. Start with the issue identifier.

- Good: "ENG-142: Add email validation to user creation endpoint"
- Bad: "Fix bug", "Update backend", "ENG-142"

### 4. Write the PR body

Three sections, plus Manual Steps if needed:

**Summary**: what this PR does in concrete terms. What files changed, what behavior is different. 3-5 bullet points, not paragraphs.

**Testing**: validation commands and results. Real output, not "all tests pass."

**Manual Steps** (if needed): database migrations, config changes, or deployment steps that a human engineer must perform. Be specific — include the migration description, new columns, indexes, etc.

**Risks / Follow-ups** (if any): only real caveats. Empty section is fine.

### 5. Archive artifacts

Copy stage artifacts to the permanent archive location specified in the prompt. Keep workspace artifacts uncommitted.

### 6. Prepare the branch

- Use the branch name from the prompt
- Stage all changes except the workspace artifacts directory
- Commit with a clear message
- Fetch the target branch with full history: `git fetch --unshallow origin` (workspaces are shallow clones — rebase will fail without this)
- Rebase onto the target branch
- If the rebase is clean, run the test suite anyway (see "Silent conflicts" below)
- If the rebase has conflicts, follow the conflict resolution process below
- Push

### 7. Resolving merge conflicts

Conflicts mean the target branch changed under you. This is dangerous territory — most broken merges come from resolving conflicts incorrectly.

**Understand both sides before touching anything.** For each conflict:
- Read the incoming change (theirs). What does it do? Why was it made?
- Read your change (ours). What does it do?
- Determine: are these independent changes that both need to survive, or competing changes where one replaces the other?

**Common conflict patterns and how to handle them:**

- **Both sides add to the same list/dict/config**: keep both additions. This is the most common "accidentally drop a change" mistake — do not pick one side.
- **Both sides modify the same function**: understand what each modification does. Often both are needed. If they truly conflict (different approaches to the same problem), keep yours since that is the implementation being shipped.
- **One side renames/moves, the other modifies**: follow the rename AND apply the modification at the new location.
- **Import conflicts**: usually both imports are needed. Merge them.

**After resolving all conflicts:**

1. Read each resolved file in full. Does the code make sense? Do both sides' intentions survive?
2. Check for silent conflicts — things git did not flag but that are still broken:
   - Functions renamed on the target branch that your code still calls by the old name
   - Parameters added on the target branch that your code does not pass
   - Imports removed on the target branch that your code uses
   - Type/interface changes that make your code incompatible
3. Run the full test suite. This catches semantic conflicts that textual resolution misses.
4. If tests fail after conflict resolution, fix the failures. This is real implementation work — the conflict introduced a bug.
5. If the final diff changed meaningfully from what the PR body describes, update the PR body.

**When to stop and flag for human help:**

If there are many conflicts (more than a handful of files) or the conflicts are in complex logic you did not write, the risk of a bad resolution is high. In this case, note the conflict situation in the PR body and push what you have. A human engineer can resolve it more safely with full context.

### 8. Stop before GitHub mutation

Your job ends once the branch is ready and the PR content artifacts exist.

- Write the final PR title file
- Write the final PR body file
- Commit and push the branch cleanly
- Do not create or update the PR yourself

The workflow's explicit tool step handles GitHub mutation.

### 9. No code changes? No PR.

If there is nothing to commit, do not create an empty PR. Document why and stop.

## Quality Bar

**Good PR**: reviewer can approve in one read. Title says what it does. Body describes the actual changes. Test evidence is real. Manual steps are clear.

**Bad PR**: generic title, body restates the plan verbatim, "all tests pass" without proof, unrelated changes in the diff.

### The 5-minute test

Can a busy engineer:
1. Read the title and know what this is?
2. Read the summary and understand the change?
3. Skim the diff and confirm it matches?
4. See test evidence and trust it works?
5. Know if they need to run a migration?

If yes, ship it.

## Rules

- Do not modify implementation code. You are packaging, not implementing.
- Inspect the real diff before writing the body.
- If tests fail, stop.
- If there are no changes, do not create an empty PR.
- Include Manual Steps for any database changes the reviewing engineer needs to make.
- Conflict resolution is real work — revalidate after resolving.
- Do not run `gh pr create`, `gh pr edit`, or any other direct GitHub PR mutation command.

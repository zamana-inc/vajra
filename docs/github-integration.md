# GitHub Integration

Vajra creates and manages pull requests through the GitHub API. Optionally, it can respond to PR review feedback through a webhook-driven revision cycle.

## PR Creation

When a pipeline completes successfully and the workflow has `inspect_pr: true`, the `publish_pr` tool stage creates a GitHub PR using the title and body prepared by the `pr-preparer` agent.

The PR includes:
- A structured title and description summarizing the changes
- A link to the Linear issue
- The branch created during the pipeline run

PR metadata is saved to `.vajra/pr.json` in the workspace for reference by subsequent stages and revision runs.

## Auto-Merge

When [triage](configuration.md#triage) selects the `auto_merge` strategy, Vajra enables GitHub's built-in auto-merge on the PR after creation. This tells GitHub to merge the PR automatically once all branch protection requirements are satisfied (CI passes, required reviews are approved, etc.).

Vajra does not bypass branch protection rules. It uses GitHub's auto-merge mechanism.

---

## PR Review Loop

The revision cycle allows Vajra to respond to human PR review feedback automatically.

### Setup

1. **Configure a GitHub webhook** pointing to your Vajra instance:
   - URL: `https://your-vajra-host/github/webhooks`
   - Content type: `application/json`
   - Secret: The value of `GITHUB_WEBHOOK_SECRET`
   - Events: Select **Pull request reviews** and **Issue comments**

2. **Configure revision settings** in WORKFLOW.md:
   ```yaml
   github:
     webhook_secret: $GITHUB_WEBHOOK_SECRET
     revision_label: "vajra-revision"
     revision_command: "/vajra revise"
     revision_state: "In Progress"
   ```

3. **Create the revision label** in Linear (e.g., `vajra-revision`)

4. **Add a revision workflow** in WORKFLOW.md:
   ```yaml
   workflows:
     revision:
       dot_file: pipelines/revision.dot
       success_state: "In Review"
       inspect_pr: true

   workflow_routing:
     by_label:
       vajra-revision: revision
   ```

### How It Works

1. A human reviewer submits "Changes Requested" on the PR, or posts a comment with the configured revision command (e.g., `/vajra revise`)

2. The GitHub webhook hits Vajra's `/github/webhooks` endpoint

3. Vajra identifies the Linear issue from the PR metadata and:
   - Adds the revision label (e.g., `vajra-revision`) to the issue
   - Moves the issue back to the configured revision state (e.g., "In Progress")
   - Saves the review feedback to the workspace

4. On the next poll, Vajra picks up the issue (now labeled for the revision workflow) and runs the revision pipeline

5. The revision pipeline:
   - Reads all review comments with file paths and line numbers
   - Makes the requested changes in the existing workspace
   - Updates the PR in place (no new PR created)

6. On completion:
   - Removes the revision label
   - Moves the issue back to the success state

7. If the reviewer requests changes again, the cycle repeats

### PR Merged

When a PR is merged, GitHub sends a webhook. Vajra transitions the Linear issue to the configured `merged_state` (typically "Done").

### PR Closed Without Merging

When a PR is closed without merging, Vajra transitions the issue to the configured `closed_state` (typically "Todo"), making it available for a fresh attempt.

---

## Feedback Compilation

Before running the revision pipeline, Vajra compiles all review feedback from GitHub into structured documents:

- **Review summary** — The overall review decision and any top-level comments
- **Inline comments** — Each comment with its file path, line number, and content
- **Conversation comments** — Any comments posted after the review was submitted

These are saved to the workspace (`.vajra/review-feedback.md`, `.vajra/review-feedback.json`, `.vajra/github-review-bundle.md`) so the revision agent has full context.

Bot comments are filtered out to avoid feedback loops.

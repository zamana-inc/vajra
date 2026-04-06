# How Vajra Works

---

Vajra is a background coding agent. You give it work through Linear, and it plans, builds, reviews, and ships a pull request — without anyone driving it. This document walks through exactly what happens, step by step, from the moment an issue appears to the final Slack notification. It also covers every edge case: what happens when things fail, when humans need to intervene, and when the outside world changes mid-run.

---

## The Polling Loop

Vajra runs a continuous polling loop. Every thirty seconds, it checks Linear for issues that are assigned to its dedicated user account and sitting in an active state — typically "Todo" or "In Progress." This is not event-driven. There is no webhook trigger. Vajra simply asks Linear, on a timer, "what work do I have?"

The list that comes back gets filtered and sorted. Vajra ignores anything it's already working on, anything it just finished (more on that later), and anything it's already tried and failed on without the issue changing. What survives is sorted by priority first, then by age — oldest high-priority issues come first.

Before picking up any issue, Vajra checks its concurrency limits. It has a global cap on how many pipelines can run at the same time, and optionally a per-state cap (for example, at most five "Todo" issues running concurrently). If all slots are full, no new work gets dispatched. But Vajra doesn't just wait for the next thirty-second timer — whenever a running pipeline finishes (for any reason), Vajra immediately re-evaluates candidates and dispatches new work into the freed slot. The polling interval is the maximum wait, not the typical one.

---

## Triage

When Vajra decides to pick up a new issue, the first thing it does is triage. Triage is a lightweight LLM call — a fast model reads the issue title and description and answers a few structured questions:

- **Which workflow should this use?** Most issues get the default workflow (plan → code → review → PR). But some get specialized ones — a knowledge-generation workflow, a document workflow, or a revision workflow. The triage LLM makes this decision based on the issue content, but it's constrained by a deterministic routing system underneath: if an issue has a label that maps to a specific workflow (for example, a "knowledge" label maps to the knowledge-generation workflow), that mapping is always honored. Triage can only choose among configured workflows and uses label-based routing as its default. When triage is disabled entirely, label-based routing is the only path — no LLM involved.

- **What branch should it target?** Usually `main`, but the triage agent can determine the correct base and target branch if the issue mentions a specific release branch, a hotfix, or work that builds on an open PR.

- **What merge strategy?** Either "PR only" (create the PR and let a human merge it) or "auto-merge" (enable GitHub's auto-merge, which tells GitHub to merge the PR automatically once all branch protection requirements are satisfied — CI passes, any required reviews are approved, etc. Vajra doesn't bypass protection rules; it uses GitHub's built-in auto-merge mechanism).

- **Should we ask for clarification?** If the issue is too vague — no clear scope, no indication of what files or systems are involved — triage can decide the issue isn't ready. In this case, Vajra posts a comment on the Linear issue asking for more detail and moves on. It remembers that it already asked, and won't re-pick the issue until someone updates it — any change to the issue's description, a new comment, or any other edit clears this memory and makes the issue eligible again.

If triage fails for any reason — the LLM times out, the response is garbled, the backend is unavailable — Vajra falls back to sensible defaults: the default workflow, `main` branch, PR-only merge strategy. Triage failure is never fatal.

After triage succeeds, Vajra posts a summary comment on the Linear issue: which workflow was chosen, the base and target branches, the merge strategy, and any labels being added. This is the first visible sign that Vajra has noticed the issue.

### Workflow routing without triage

Even when triage is disabled, Vajra still needs to decide which workflow to use. It does this through a simple deterministic routing function — one function, about thirty lines. It normalizes the issue's labels, checks each against a configured label-to-workflow mapping, and if no label matches, returns the default workflow. This same function is used as the fallback for the triage path too, so there's a single source of truth for label-based routing. No duplication, no LLM involved.

---

## Workspace Preparation

Every issue gets its own isolated workspace — a directory on the filesystem containing a fresh clone of the repository. If this is the first time Vajra has worked on this issue, it creates a new directory, runs a setup hook that clones the repository and installs dependencies, and creates a `.vajra/` directory inside it for internal state.

If the workspace already exists from a previous attempt (retries, revisions), Vajra reuses it but runs a pre-run hook that fetches the latest upstream changes, resets the git state to match the target branch, and cleans out any leftover files — except the `.vajra/` directory, which carries forward persistent state like thread history and checkpoints.

Vajra also syncs a set of team-authored skill files into the workspace. These are markdown instruction documents — versioned in the repository alongside the rest of the codebase — that each agent references during its work. There are currently about a dozen: guidelines for planning, code review, implementation, PR preparation, knowledge writing, and so on. The team can add, edit, or remove these freely; they're just files in the repo, not hardcoded behavior.

---

## Moving to In Progress

Once the workspace is ready and the pipeline is about to start, Vajra transitions the Linear issue to "In Progress." This only happens on the first attempt — retries don't re-transition, because the issue is already in progress.

---

## The Pipeline

The core of Vajra's work is a pipeline: a directed graph of stages that the issue walks through sequentially. Each stage is either an agent invocation (an LLM doing work), a tool invocation (a built-in command like "create a pull request"), or a fan-out (multiple agents running in parallel). The graph is defined in a DOT file — a simple text format for describing directed graphs.

### The default pipeline

The standard workflow that most issues follow looks like this:

**Start → Plan → Review Plan → Code → Review Code → Prepare PR → Publish PR → Exit**

But this isn't a straight line. The review stages can route work backward for revision, and any revision loop can escalate to a human if it can't converge. Here's what happens at each stage:

#### Planning

The planner agent receives the full issue description, relevant context about prior stages (none, since this is the first), and any workspace-level artifacts. It reads the codebase and writes a plan: what files to change, what approach to take, what tests to write, what risks exist. The plan is saved as a markdown file in the workspace.

#### Plan review

A different agent — the plan reviewer — reads the plan and makes a structured decision by writing a result file:

- **"lgtm"**: The plan is good. Move forward to coding.
- **"revise"**: The plan has problems. Send it back to the planner.
- **"escalate"**: The plan is fundamentally flawed and a human needs to look at it.

This decision is communicated through a label in the result file. The pipeline graph has edges that say: "if the label is 'lgtm', go to the code stage; if 'revise', go back to the plan stage; if 'escalate', go to the escalation exit."

#### Revision loops and threads

When the reviewer says "revise" and the planner runs again, it doesn't start from scratch. Vajra maintains a thread — a persistent history of previous turns. The planner's second run includes a "thread continuation" section in its prompt that contains the full prompt and artifact references from its first run. This way the planner sees what it wrote before, what the reviewer said about it, and can iterate rather than redo.

Each revision loop has a configurable maximum number of visits — set per-stage in the pipeline definition, defaulting to three if unspecified (the default pipeline sets it to four for planning). If the reviewer keeps saying "revise" after that many attempts, the planner stage hits its visit limit. At that point, the pipeline follows the stage's exhaustion target — a configured fallback that typically points to an escalation exit node.

#### Coding

The coder agent takes the approved plan and implements it. It writes code, creates or modifies tests, and produces an implementation summary. Like the planner, the coder operates on a thread ("coding"), so if it gets sent back for revisions later, it remembers what it did.

#### Code review

Same structure as plan review: a reviewer agent reads the implementation and decides lgtm, revise, or escalate. If it says "revise," a fixer agent picks up the coding thread with the reviewer's feedback and makes changes. The fixer runs in the same thread as the coder — it sees the original implementation, the review feedback, and any prior fixes. This loop also has a configurable visit limit (four in the default pipeline) and escalation target.

#### PR preparation

Once the code is approved, a PR preparation agent takes over. Its job is broader than just writing the PR description — it verifies test results, inspects the actual diff, writes the title and body, commits the changes, fetches the full target branch history (workspaces start as shallow clones), rebases onto the target branch, resolves any merge conflicts if the target branch moved forward during the run, re-runs tests after the rebase, and pushes. If the rebase has conflicts it can't resolve cleanly, it flags this in the PR body for a human to handle.

The PR body summarizes what changed, how it was tested (with real output, not assertions), any manual steps required (like database migrations), and risks or follow-ups.

#### PR publication

This is not an LLM call. It's a built-in tool command. Vajra reads the title and body files that the PR preparation agent wrote, checks whether a pull request already exists for this branch (which would happen on a revision run), and either creates a new PR or updates the existing one via the GitHub API. The PR metadata — number, URL, branch name — is saved as structured data to `.vajra/pr.json` in the workspace. All subsequent references to the PR (Slack notifications, auto-merge enablement, revision cycle) read from this file.

### How stages execute

Every agent stage follows the same lifecycle:

1. **Prompt construction**: The stage's prompt template is rendered with the full context — issue details, workspace state, completed stages and their artifacts, any collection data, and the thread continuation if the stage participates in a thread.

2. **Agent invocation**: The rendered prompt is passed to a CLI agent (Claude CLI or Codex CLI). The agent runs in the workspace directory with the prompt as input. Each invocation is a stateless, one-shot subprocess — it starts, receives the prompt, does its work, and exits. There is no session continuity between invocations; if a stage participates in a thread (a revision loop), the context from prior turns is reconstructed from disk and injected into the prompt, not carried via a provider session.

3. **Result collection**: After the agent exits, Vajra reads a structured result file (`result.json`) from the workspace if one exists. This file contains the stage's outcome: a status (success, failure, wait_human), an optional label for routing (lgtm, revise, escalate), arbitrary facts (key-value metadata), optional notes, and optional artifact references. If no result file exists, Vajra infers the outcome from the exit code.

4. **Artifact snapshotting**: The stage's artifacts — the output text, any declared primary artifact, and any artifacts from the result file — are collected and snapshotted. The snapshot preserves the artifacts as they were at this particular visit, so future visits to the same stage don't overwrite the historical record.

5. **Context update**: The stage's results are written into the shared pipeline context. This context is what subsequent stages see: what stages have run, what they produced, whether they succeeded.

6. **Routing**: Based on the stage's outcome label and the outgoing edges in the graph, Vajra decides where to go next. Label-based edges take priority ("if the label is 'revise', go to the plan stage"), followed by condition-based edges, followed by the default edge. If no valid next node is found, the pipeline fails.

### Tool stages

Some stages don't invoke an LLM at all. They run a shell command — like the PR publication step, which runs `vajra publish-pr`. Tool stages don't count against the agent invocation budget, and they don't have threads. They follow the same result-collection flow (read the result file, collect artifacts) but skip the prompt/agent lifecycle.

### Fan-out stages

For workflows that need multiple approaches explored in parallel — for example, generating several candidate implementations and picking the best one — Vajra supports fan-out stages. A fan-out stage runs multiple agent variants simultaneously, each producing its own candidate artifact. The variants can use different models, different reasoning effort levels, or different instructions.

After all candidates finish, their results are collected into a named collection. This collection contains both structured metadata (which candidates succeeded, their facts and status) and references to the actual file artifacts (the primary deliverables each candidate produced). Subsequent stages (typically a "fan-in" synthesizer) receive the collection manifest in their prompt — with artifact locations, not contents. The agent can then read whichever candidate artifacts it needs to compare approaches and select or merge the best work.

Fan-out stages respect a separate concurrency limit, and each variant counts individually against the per-run agent invocation budget.

---

## Completion — The Happy Path

When the pipeline reaches its exit node, Vajra:

1. **Saves all context and artifacts** to durable storage.
2. **Removes any internal labels** it added during the run (like a "vajra-revision" label from a prior revision cycle).
3. **Transitions the Linear issue** to its configured success state — usually "Done."
4. **Enables auto-merge** if the triage decided on that strategy. Vajra calls GitHub's auto-merge API, which tells GitHub to merge the PR automatically once all branch protection requirements are satisfied — CI checks pass, any required review approvals are in, whatever rules the repository has configured. Vajra doesn't bypass these rules; it just enables the auto-merge flag.
5. **Sends a Slack notification** to the issue creator. If a PR was created, the message reads something like "@person PR ready for review: ENG-123: Add user authentication" with a link to the PR. If no PR was created (for workflows that don't produce one), it's a simpler "pipeline completed" message. The Slack notification tags the person who created the Linear issue, using a configured mapping from Linear user IDs to Slack user IDs. If no mapping exists for the creator, the notification is still sent — it just doesn't mention anyone.

---

## What Happens When Things Go Wrong

### Stage failure without routing edges

If a stage fails (non-zero exit code, missing expected artifact) and the graph has no conditional edges from that stage — meaning there's no path for the failure case — the pipeline fails immediately. The error is captured, the run terminates, and a Slack failure notification is sent.

### Stage failure with routing edges

If a stage fails but the graph has conditional edges, the failure is treated as a normal outcome. The stage's status is recorded as "failure" and the routing logic picks the appropriate next node. This is how the "revise" pattern works: the reviewer's "failure" (with a "revise" label) routes back to the planning or coding stage instead of terminating the pipeline.

### Missing primary artifact

If a stage declares an expected artifact path (like "the plan should be at `.vajra/run/plan.md`") but that file doesn't exist after the agent finishes, the stage is marked as failed regardless of the exit code. This catches cases where the agent ran successfully but didn't produce the expected output.

### Error classification

When a stage fails, Vajra inspects the output for known error signatures:

- **Authentication failures**: The Claude CLI reports "Not logged in," or the Codex CLI reports a 401. These are terminal — retrying won't help because the credentials are invalid or expired.

- **Rate-limit failures**: The Claude CLI reports "You've hit your limit." These are also terminal for the current run — Vajra can't do anything until the rate limit resets.

Both of these skip the retry mechanism entirely and fail the issue immediately, with a Slack notification that clearly identifies the problem (🔑 for auth, ⚠️ for rate limits).

### Retries

For all other failures — timeouts, flaky tests, transient infrastructure errors — Vajra retries. The retry mechanism works like this:

1. The first attempt fails.
2. Vajra schedules a retry with exponential backoff: 10 seconds for the first retry, 20 for the second, 40 for the third, capped at a configured maximum (typically 5 minutes).
3. When the retry comes due, Vajra re-validates the issue against Linear — is it still assigned to Vajra? Is it still in an active state? Has it been cancelled?
4. If the issue is still eligible, a new attempt starts. The workspace is reset to a clean git state, but the `.vajra/` directory persists, carrying forward any checkpoints and thread history.
5. This continues up to a configured maximum number of retry attempts (typically three). After that, the issue is marked as permanently failed.

### Redispatch barriers

After a run completes (success or terminal failure), Vajra places a redispatch barrier on the issue. This prevents Vajra from immediately picking up the same issue again on the next polling cycle. The barrier holds as long as the issue stays in the same Linear state. Once someone changes the issue's state — by moving it back to "Todo," updating the description, or re-assigning it — the barrier clears and Vajra will consider the issue again.

### Cancellation

A running pipeline can be cancelled for several reasons:

- **Unassignment**: Someone removes Vajra as the assignee. On the next reconciliation check (which happens every polling cycle), Vajra detects the change and cancels the running pipeline.

- **Terminal state**: Someone moves the issue to a closed or cancelled state. Vajra detects this and cancels.

- **Issue disappeared**: The issue is deleted or no longer visible to Vajra's Linear account. Vajra cancels.

- **Shutdown**: Vajra itself is shutting down (deploy, restart). All running pipelines are cancelled.

When a pipeline is cancelled, the workspace may or may not be cleaned up depending on the reason. Terminal state changes and shutdowns trigger cleanup; unassignment and inactive-state transitions leave the workspace intact so work can potentially resume.

### Escalation

Escalation happens when the pipeline explicitly decides a human needs to look at this. This can be triggered by:

- A reviewer agent labeling its outcome as "escalate."
- A refinement loop exhausting its visit budget (e.g., four failed plan revisions).

When escalation occurs, Vajra:

1. Transitions the Linear issue to a configured escalation state (typically "Needs Human Review").
2. Posts a comment on the issue explaining why it escalated and what work was completed.
3. Sends a Slack notification: "@person Human review needed for ENG-123: [reason]."

All work done so far — the plan, the code, the review feedback, the thread history — is preserved in the workspace. A human can inspect it, make changes, and potentially re-assign the issue to Vajra for another attempt.

---

## Reconciliation

Every polling cycle, before looking for new work, Vajra reconciles its running pipelines against the current state of Linear. For every issue it's actively working on, it fetches the latest state from Linear and checks:

- Is the issue still assigned to Vajra?
- Is it still in an active state?
- Has it been moved to a terminal state?

If any of these conditions are violated, Vajra cancels the corresponding pipeline. This is how Vajra responds to the outside world changing — it doesn't wait for the pipeline to finish; it checks proactively on every tick.

---

## The Revision Cycle (After Human Review)

The story doesn't end when the PR is published. Vajra listens for GitHub webhook events on its pull requests.

### Triggering a revision

A revision is triggered in two ways:

1. **A reviewer requests changes**: When a human submits a GitHub review with "Changes Requested," GitHub sends a webhook to Vajra.

2. **A reviewer posts a revision command**: A human can post a specific comment (like `/vajra revise`) on the PR, which also triggers a revision.

### What happens on a revision trigger

When Vajra receives a revision webhook:

1. It identifies which Linear issue the PR belongs to — either from a stored record (Vajra remembers which PRs it created for which issues) or by parsing the issue identifier from the branch name.

2. It adds a "vajra-revision" label to the Linear issue and transitions it back to "In Progress."

3. It saves the revision trigger metadata — who requested it, when, which review or comment triggered it.

The issue is now back in an active state with a revision label. On the next polling cycle, Vajra picks it up like any other eligible issue.

### Compiling feedback

Before the revision pipeline runs, Vajra fetches the full review context from GitHub: the review summary, all review comments with their file paths and line numbers, and any conversation comments posted since the revision was requested. It filters out bot comments and assembles everything into a structured feedback document.

This feedback document becomes the primary input for the revision workflow. The reviser agent sees exactly what the reviewer said, where they said it, and what they want changed.

### The revision pipeline

The revision workflow is a separate, simpler pipeline: the reviser agent reads the feedback, makes changes in the same workspace (which still has the code from the original PR), and then an updater agent refreshes the PR. The existing PR is updated in place — no new PR is created.

After the revision completes, the revision label is removed, and the issue moves to Done. If the reviewer requests changes again, the cycle repeats.

### PR merged or closed

When a PR is merged, GitHub sends a webhook. Vajra transitions the Linear issue to Done.

When a PR is closed without merging, Vajra transitions the issue back to its configured "closed" state (typically Todo), so it reappears as available work if someone wants to retry.

---

## Slack Notifications

Vajra sends Slack notifications for four distinct outcomes:

1. **Success**: "PR ready for review" with a link, or "Pipeline completed" if no PR was created.
2. **Failure**: "Pipeline failed for ENG-123 at stage [stage name]: [error message]."
3. **Escalation**: "Human review needed for ENG-123: [reason]."
4. **Credential failures**: Auth and rate-limit failures always notify, even if a general failure notification was already sent for that issue. These require immediate human action.

Failure notifications are deduplicated — Vajra won't spam Slack with repeated failure messages for the same issue across retries. Only the first failure and any credential failures get through. When the issue is re-dispatched (for a retry) or cancelled, the deduplication record is cleared.

All notifications tag the person who created the Linear issue, using the configured Linear-to-Slack user mapping. If no mapping exists for the creator, the notification is still sent — it just doesn't tag anyone.

---

## Checkpointing and Resumption

At every stage boundary, Vajra writes a checkpoint to disk. The checkpoint records which nodes have been completed, what the next node is, and whether the run is still in progress, succeeded, or is waiting for a human. If Vajra crashes or restarts mid-pipeline, it can resume from the last checkpoint rather than starting over.

Resumption is conservative. A checkpoint in "running" state means the stage that was in progress didn't complete — Vajra will re-run it. A checkpoint in "wait_human" state means the pipeline paused for escalation — Vajra will preserve that state. A checkpoint in "success" with no next node means the run is done — Vajra will finalize it.

---

## Agent Invocation Budget

Each pipeline run has a maximum number of agent invocations — typically twenty. Every agent stage counts as one invocation (tool stages and fan-out container stages don't count, but each variant within a fan-out does). If the budget is exhausted mid-pipeline — say, after many revision loops — the pipeline fails rather than running indefinitely.

This prevents runaway loops where a planner and reviewer disagree forever. Between the per-stage visit limit, the exhaustion target (escalation), and the global invocation budget, there are three independent safety nets against unbounded execution.

---

## What Vajra Is Not

Vajra is not interactive. You don't talk to it, ask it questions, or negotiate with it. You give it a well-defined issue, and it either ships a PR or tells you why it couldn't.

Vajra is not a deployment tool. It creates and updates pull requests. Merging is either a human decision or, if auto-merge was selected during triage, gated behind CI and required approvals.

Vajra is not a single model. It's a workflow engine that orchestrates LLM subprocess calls through a structured pipeline. The agents are CLI tools — they start, receive a prompt, do work in a directory, and exit. Today each invocation is stateless (no session continuity between calls), though the thread mechanism reconstructs context from prior turns. The intelligence comes from the pipeline design: the plan-review-revise loop, the threaded context that carries forward across iterations, and the structured routing that turns reviewer judgments into graph traversal decisions.

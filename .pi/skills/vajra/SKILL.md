---
name: vajra
description: Use when asked about Vajra — the background coding agent. Covers how to assign work, create workflows/skills/agents, monitor runs, and troubleshoot.
---

# Vajra — Background Coding Agent

Vajra picks up Linear issues, routes them through multi-step pipelines, and ships PRs. It polls Linear every 30s for issues assigned to it.

## Giving Vajra work

1. **Create a Linear issue** with a clear title and description (the description IS the prompt — Vajra agents read it verbatim)
2. **Assign to Vajra** — the Linear user configured as the assignee in WORKFLOW.md
3. **Set state to Todo** (Vajra polls `Todo` and `In Progress`)
4. **Optionally add a label** to route to a specific workflow (see Workflow Routing below)
5. Vajra picks it up within ~30s, creates a workspace, and runs the pipeline
6. On success: moves issue to the workflow's configured success state

### Issue description matters

The issue description is injected directly into every agent prompt as `{{ issue.description }}`. Write it like you're briefing a developer — scope, constraints, files to touch, expected behavior. The better the description, the better the output.

## Workflow routing

Issues are routed to workflows by **Linear label**. Configure routing in WORKFLOW.md under `workflow_routing.by_label`.

The workflow with `is_default: true` handles issues without a matching label.

## Key concepts

### Backends
Command templates that run agents. Example:
- **claude** — `claude --model {{ model }} -p {{ prompt }}`
- **codex** — `codex exec --model {{ model }} {{ prompt }}`

### Agents
Named configurations that combine a backend + model + prompt. Each pipeline stage references an agent.

### Skills
Markdown instruction files in `orchestrator/skills/`. Each skill is a directory with a `SKILL.md`. Agents reference them in their prompt. Skills contain domain knowledge — how to write plans, how to review code, repo conventions, etc.

### Workflows
Named pipelines defined as DOT graphs. Each has a success state and optional label routing. A workflow chains multiple agent stages together.

### Artifacts
Each run produces artifacts in `.vajra/run/` (workspace). Key artifacts: `plan.md`, `implementation-summary.md`, `code-review.md`, `pr-body.md`.

## Creating a new workflow

1. **Create the Linear label** in Linear first (must exist before any issue uses it)

2. **Create the DOT pipeline** file:
   ```dot
   digraph MyPipeline {
     graph [goal="What this pipeline does"]
     start [shape=Mdiamond]
     exit  [shape=Msquare]

     step_one [type="agent", label="Step One", agent="my-writer", artifact_path=".vajra/run/output.md"]
     step_two [type="agent", label="Step Two", agent="my-reviewer", artifact_path=".vajra/run/output.md"]

     start -> step_one -> step_two -> exit
   }
   ```

3. **Add skills** (optional) to `orchestrator/skills/vajra-my-skill/SKILL.md`

4. **Add to WORKFLOW.md**: workflow definition, label routing, and agent definitions

### DOT graph rules

- `start` (Mdiamond) and `exit` (Msquare) nodes are required
- Each stage needs `type="agent"`, `agent="agent-name"`, and `artifact_path`
- `artifact_path` is where the agent writes its output (checked for non-empty after stage runs)
- Stages can also be `type="tool"` with a `command` attribute for shell commands
- Edges can have `label` attributes for routing (`lgtm`, `revise`, `escalate`)

### Agent prompt variables

Available in agent prompts via Liquid templating:
- `{{ issue.identifier }}` — e.g. `ENG-215`
- `{{ issue.title }}` — issue title
- `{{ issue.description }}` — full issue description (the main input)

## GitHub PR review loop

When Vajra creates a PR and it receives review feedback:
1. A reviewer submits "Changes Requested" or comments the configured revision command
2. GitHub webhook hits Vajra
3. Vajra adds the revision label to the Linear issue and moves it to the revision state
4. The revision workflow runs: reads review feedback, makes changes, updates the PR
5. On success, removes the revision label and moves issue back to review

## Monitoring

### CLI (via this skill)

| Command | What it shows |
|---------|---------------|
| `vajra state` | Active runs, retries, barriers |
| `vajra runs` | Recent run history with status |
| `vajra run_detail` (issue + attempt) | Full detail of a specific run |
| `vajra config` | Current configuration |
| `vajra agents` | All configured agents |
| `vajra skills` | All skills |
| `vajra workflows` | All workflows with routing |
| `vajra workflow_detail` (name) | Full detail of a workflow |

### API endpoints

- `GET /state` — orchestrator state
- `GET /runs?status=running&limit=10` — filtered run list
- `GET /runs/:issue/:attempt` — run detail with per-stage breakdown
- `GET /runs/:issue/:attempt/stages/:stageId` — single stage detail
- `GET /events` — SSE event stream (real-time)
- `GET /config` — full config snapshot
- `GET /config/agents` — list agents
- `GET /config/backends` — list backends
- `GET /config/workflows` — list workflows
- `GET /config/workflows/:name` — workflow detail
- `GET /config/skills` — list skills

### Write endpoints

```
PUT /config/agents/:name      -> {backend, model, prompt, reasoning_effort?, timeoutMs?}
PUT /config/skills/:name      -> {content: "markdown content"}
PUT /config/workflows/:name   -> {rawDot, successState, inspectPr?, labels?, isDefault?}
PUT /config/backends/:name    -> {command}
PUT /config                   -> update top-level config
DELETE /config/agents/:name
DELETE /config/skills/:name
DELETE /config/workflows/:name
```

## Execution behavior

- **Concurrency**: Configurable via `execution.maxConcurrentAgents` in WORKFLOW.md
- **Retries**: Configurable attempts with exponential backoff
- **Cancellation**: If an issue is unassigned, moved to a terminal state, or the orchestrator shuts down, the running pipeline is cancelled
- **Blockers**: Issues with `blocks` relations to non-terminal issues are held until blockers resolve
- **Redispatch barrier**: After success or terminal failure, Vajra won't re-run the same issue until its Linear state changes
- **Priority**: Issues are dispatched in priority order (P1 first), then by creation date

## Troubleshooting

| Problem | Check |
|---------|-------|
| Issue not picked up | Correct assignee? State is Todo/In Progress? Not blocked by another issue? |
| Wrong workflow | Label exists in Linear? Label matches `workflow_routing.by_label`? Check config |
| Stage failing | Check run detail for the issue — shows per-stage errors and output |
| Run stuck | May need issue state change to clear the redispatch barrier. Check state for barriers |
| PR not created | Is `inspect_pr: true` on the workflow? Does the `prepare_pr` stage exist? |
| Revision not triggered | GitHub webhook configured? Is the reviewer submitting "Changes Requested"? |

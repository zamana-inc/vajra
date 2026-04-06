# Configuration

Vajra is configured through a single `WORKFLOW.md` file — a YAML front matter document. The file is read at startup and hot-reloaded when changed on disk.

Start from the template: `cp WORKFLOW.md.example WORKFLOW.md`

## File Format

WORKFLOW.md uses YAML front matter (the content between `---` delimiters). There must be no markdown body after the closing `---`.

```yaml
---
tracker:
  kind: linear
  # ...
---
```

Environment variables are resolved at startup using `$VAR_NAME` syntax (e.g., `$LINEAR_API_KEY`).

---

## Tracker

Connects Vajra to Linear for issue polling.

```yaml
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  assignee_id: "your-linear-user-id"
  active_states:                      # States Vajra polls for work
    - Todo
    - In Progress
  terminal_states:                    # States that mean "done" — Vajra stops tracking
    - Done
    - Canceled
    - Cancelled
    - Duplicate
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `kind` | Yes | — | Always `linear` |
| `api_key` | Yes | — | Linear API key (use `$LINEAR_API_KEY` to reference env var) |
| `assignee_id` | Yes | — | Linear user ID — Vajra only picks up issues assigned to this user |
| `active_states` | No | `["Todo", "In Progress"]` | Issue states that Vajra considers eligible |
| `terminal_states` | No | `["Done", "Canceled", ...]` | States that mark an issue as finished |

### Finding your Linear user ID

```bash
curl -s -H "Authorization: Bearer $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ viewer { id name email } }"}' \
  https://api.linear.app/graphql
```

---

## Polling

```yaml
polling:
  interval_ms: 30000
```

| Field | Default | Description |
|-------|---------|-------------|
| `interval_ms` | `30000` | How often Vajra checks Linear for new work (milliseconds) |

Note: This is the *maximum* wait. When a pipeline finishes, Vajra immediately checks for new work without waiting for the next poll.

---

## Workspace

```yaml
workspace:
  root: /tmp/vajra-workspaces
```

| Field | Default | Description |
|-------|---------|-------------|
| `root` | `/tmp/vajra-workspaces` | Base directory for issue workspaces |

Each issue gets its own subdirectory. Workspaces persist across retries — the `.vajra/` directory inside carries forward thread history and checkpoints.

---

## Hooks

Shell scripts that run at specific points in the workspace lifecycle. They execute inside the workspace directory.

```yaml
hooks:
  after_create: |
    git clone --depth 1 --branch ${VAJRA_BASE_BRANCH:-main} https://github.com/your-org/your-repo.git .
  before_run: |
    git fetch origin ${VAJRA_BASE_BRANCH:-main}
    git checkout ${VAJRA_BASE_BRANCH:-main}
    git reset --hard origin/${VAJRA_BASE_BRANCH:-main}
    git clean -fd -e .vajra
  timeout_ms: 120000
```

| Hook | When it runs | Typical use |
|------|-------------|-------------|
| `after_create` | Once, when a workspace is first created | Clone the repo, install dependencies |
| `before_run` | Before every pipeline attempt (including retries) | Reset git state to latest upstream |
| `after_run` | After a pipeline completes | Optional cleanup |
| `before_remove` | Before a workspace is deleted | Optional cleanup |

| Field | Default | Description |
|-------|---------|-------------|
| `timeout_ms` | `60000` | Maximum time for any hook to complete |

### Hook Environment Variables

These are injected by the orchestrator based on triage decisions:

| Variable | Description |
|----------|-------------|
| `VAJRA_BASE_BRANCH` | The branch to clone/target (e.g., `main`, `release/v2`) |
| `VAJRA_TARGET_BRANCH` | The branch the PR will target |
| `VAJRA_MERGE_STRATEGY` | Either `pr_only` or `auto_merge` |

For single-branch repos targeting `main`, the defaults in the template work as-is — the `:-main` fallback handles it.

### Multi-branch setup

If your repo uses release branches, feature branches, or hotfix flows, enable [triage](#triage) so Vajra can pick the correct branch per issue. The triage agent reads the issue description and determines the appropriate base branch.

---

## Execution

Controls concurrency, retries, and safety limits.

```yaml
execution:
  max_concurrent_agents: 5
  max_retry_attempts: 3
  max_retry_backoff_ms: 300000
  max_agent_invocations_per_run: 20
  max_concurrent_agents_by_state:
    todo: 5
    in progress: 5
```

| Field | Default | Description |
|-------|---------|-------------|
| `max_concurrent_agents` | `10` | Global cap on simultaneous pipeline runs |
| `max_retry_attempts` | `3` | How many times to retry a failed pipeline |
| `max_retry_backoff_ms` | `300000` | Maximum backoff between retries (exponential: 10s, 20s, 40s, ... up to this cap) |
| `max_agent_invocations_per_run` | `20` | Total agent calls allowed per pipeline run (prevents runaway loops) |
| `max_concurrent_agents_by_state` | `{}` | Per-state concurrency caps (e.g., at most 5 "Todo" issues running) |

---

## Escalation

What happens when a pipeline can't converge (e.g., a review loop exhausts its retry budget).

```yaml
escalation:
  linear_state: Needs Human Review
  comment: true
  slack_notify: true
```

| Field | Default | Description |
|-------|---------|-------------|
| `linear_state` | — | Linear state to move the issue to on escalation |
| `comment` | `true` | Post an explanatory comment on the Linear issue |
| `slack_notify` | `true` | Send a Slack notification |

---

## Triage

Optional LLM-powered pre-processing that picks the workflow, branch, and merge strategy for each issue.

```yaml
triage:
  enabled: true
  backend: claude
  model: claude-sonnet-4-6
  timeout_ms: 30000
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `false` | Whether to use LLM triage |
| `backend` | — | Which backend to use for the triage call |
| `model` | — | Model for triage |
| `reasoning_effort` | — | Optional reasoning effort level |
| `timeout_ms` | `60000` | Timeout for the triage LLM call |

When triage is disabled, workflow routing is purely label-based (see [Workflow Routing](#workflow-routing)). When triage fails, it falls back to sensible defaults (default workflow, `main` branch, PR-only).

---

## Backends

Command templates for invoking coding agents. Each backend defines how to call a specific AI tool.

```yaml
backends:
  claude:
    command: "claude --model {{ model }} -p {{ prompt | shellquote }}"
  codex:
    command: "codex exec --model {{ model }} {{ prompt | shellquote }}"
```

### Template Variables

Commands use [LiquidJS](https://liquidjs.com/) syntax:

| Variable | Description |
|----------|-------------|
| `{{ model }}` | The model specified in the agent definition |
| `{{ prompt }}` | The rendered prompt (with issue context, thread history, etc.) |
| `{{ reasoning_effort }}` | Optional reasoning effort level from the agent definition |

### Filters

| Filter | Description |
|--------|-------------|
| `shellquote` | Shell-escapes the value for safe command-line use |

---

## Agents

Named configurations that combine a backend + model + prompt. Each pipeline stage references an agent by name.

```yaml
agents:
  planner:
    backend: claude
    model: claude-sonnet-4-6
    reasoning_effort: high         # optional
    timeout_ms: 300000             # optional, per-agent timeout
    prompt: |
      Use the `vajra-plan` skill.

      Issue: {{ issue.identifier }} — {{ issue.title }}
      {{ issue.description }}

      Write: .vajra/run/plan.md
    skills:
      - vajra-plan
```

| Field | Required | Description |
|-------|----------|-------------|
| `backend` | Yes | Name of a defined backend |
| `model` | Yes | Model identifier passed to the backend command |
| `prompt` | Yes | Liquid template rendered with issue context |
| `skills` | No | List of skill names to sync into the workspace |
| `reasoning_effort` | No | Passed to the backend command as `{{ reasoning_effort }}` |
| `timeout_ms` | No | Override the default agent timeout |

### Prompt Template Variables

| Variable | Description |
|----------|-------------|
| `{{ issue.identifier }}` | e.g., `ENG-215` |
| `{{ issue.title }}` | Issue title |
| `{{ issue.description }}` | Full issue description (this is the main input) |
| `{{ stage.id }}` | Current pipeline stage ID |
| `{{ target_branch }}` | The branch the PR will target |

### Default Pipeline Agents

The default pipeline (`pipelines/default.dot`) requires these 6 agents:

| Agent | Role |
|-------|------|
| `planner` | Reads the issue, investigates the codebase, writes a plan |
| `plan-reviewer` | Reviews the plan; emits `lgtm`, `revise`, or `escalate` |
| `coder` | Implements the plan |
| `code-reviewer` | Reviews the implementation; emits `lgtm`, `revise`, or `escalate` |
| `fixer` | Addresses code review feedback |
| `pr-preparer` | Writes PR title and body, commits, rebases, pushes |

See `WORKFLOW.md.example` for complete agent definitions with prompts.

---

## Skills

Markdown instruction documents in `orchestrator/skills/`. Each skill is a directory containing a `SKILL.md` file.

```
orchestrator/skills/
├── vajra-plan/SKILL.md
├── vajra-plan-review/SKILL.md
├── vajra-implement/SKILL.md
├── vajra-code-review/SKILL.md
├── vajra-fix/SKILL.md
├── vajra-prepare-pr/SKILL.md
├── vajra-triage/SKILL.md
├── vajra-revise/SKILL.md
├── vajra-document/SKILL.md
├── vajra-doc-review/SKILL.md
├── vajra-knowledge-writing/SKILL.md
└── vajra-knowledge-review/SKILL.md
```

Agents reference skills by directory name in their `skills` list. The skill content is synced into the workspace at runtime so agents can read the instructions as local files.

### Built-in Skills

| Skill | Philosophy |
|-------|-----------|
| `vajra-plan` | "Planning is investigation, not imagination" |
| `vajra-implement` | "Implementation is translation, not invention" |
| `vajra-code-review` | "The cost of blocking a working PR is high. The cost of shipping a style imperfection is zero." |
| `vajra-plan-review` | "Kill scope and catch factual errors" |

These are starting points — customize them for your team's conventions. They're just markdown files.

### Creating a Custom Skill

1. Create `orchestrator/skills/my-skill/SKILL.md`
2. Write your instructions in markdown
3. Reference it in an agent's `skills` list: `skills: [my-skill]`

---

## Workflows

Named pipelines defined as DOT graphs. See [Workflows](workflows.md) for the full DOT format reference.

```yaml
workflows:
  default:
    dot_file: pipelines/default.dot
    success_state: "In Review"
    inspect_pr: true
  revision:
    dot_file: pipelines/revision.dot
    success_state: "In Review"
    inspect_pr: true
  document:
    dot_file: pipelines/document.dot
    success_state: Done
    inspect_pr: false
```

| Field | Required | Description |
|-------|----------|-------------|
| `dot_file` | Yes | Path to the DOT graph file (relative to WORKFLOW.md) |
| `success_state` | No | Linear state to move the issue to on success (default: `Done`) |
| `inspect_pr` | No | Whether to look for PR metadata (`.vajra/pr.json`) after a successful run and record the PR URL. The actual PR creation is done by the `publish_pr` tool stage in the pipeline — this flag controls whether Vajra inspects the workspace for PR info after completion. Default: `true`. |
| `is_default` | No | Mark as the default workflow (fallback when no label matches) |

---

## Workflow Routing

Issues are routed to workflows by Linear label.

```yaml
workflow_routing:
  default_workflow: default
  by_label:
    vajra-revision: revision       # requires reviser + revision-pr-preparer agents
    document: document             # requires documenter + doc-reviewer agents
    knowledge: knowledge           # requires knowledge-writer + knowledge-reviewer + knowledge-pr-preparer agents
```

When an issue has a label matching a key in `by_label`, it's routed to that workflow. Issues without a matching label use `default_workflow`.

> **Note:** Each workflow's DOT graph references specific agents by name. You must define all required agents in the `agents` section before using a workflow. See the production `WORKFLOW.md` in the zamana repo for complete agent definitions for all workflows.

When [triage](#triage) is enabled, the LLM can also select workflows, but label-based routing always takes priority.

---

## GitHub

Configuration for PR creation and the revision loop.

```yaml
github:
  repository: "your-org/your-repo"
  api_key: $GITHUB_TOKEN
  webhook_secret: $GITHUB_WEBHOOK_SECRET
  revision_label: "vajra-revision"
  revision_command: "/vajra revise"
  revision_state: "In Progress"
  merged_state: "Done"
  closed_state: "Todo"
```

| Field | Required | Description |
|-------|----------|-------------|
| `repository` | Yes | GitHub repository in `owner/repo` format |
| `api_key` | Yes | GitHub token with repo access |
| `webhook_secret` | No | Secret for verifying GitHub webhook signatures |
| `revision_label` | No | Linear label added when a revision is triggered |
| `revision_command` | No | Comment command that triggers a revision (e.g., `/vajra revise`) |
| `revision_state` | No | Linear state to move to during revision |
| `merged_state` | No | Linear state when the PR is merged |
| `closed_state` | No | Linear state when the PR is closed without merging |

See [GitHub Integration](github-integration.md) for webhook setup and the full revision cycle.

---

## Slack

Optional Slack notifications for pipeline outcomes.

```yaml
slack:
  bot_token: $SLACK_BOT_TOKEN
  channel_id: "C0AKMK7PB29"
  notify_on_success: true
  notify_on_failure: true
  user_map:
    linear-user-id: slack-member-id
```

| Field | Required | Description |
|-------|----------|-------------|
| `bot_token` | Yes | Slack bot token |
| `channel_id` | Yes | Channel for notifications |
| `notify_on_success` | No | Send success notifications (default: `true`) |
| `notify_on_failure` | No | Send failure notifications (default: `true`) |
| `user_map` | No | Map Linear creator IDs → Slack member IDs for @-mentions |

---

## Environment Variables

These are set in your shell, not in WORKFLOW.md:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LINEAR_API_KEY` | Yes | — | Linear API key (referenced as `$LINEAR_API_KEY` in WORKFLOW.md) |
| `GITHUB_TOKEN` | Yes | — | GitHub token for PR creation |
| `VAJRA_API_KEY` | Yes | — | Bearer token for the Vajra REST API |
| `VAJRA_API_PORT` | No | `3847` | Port for the REST API |
| `VAJRA_API_HOST` | No | `0.0.0.0` | Host for the REST API |
| `VAJRA_CORS_ORIGIN` | No | — | CORS origin for dashboard access (e.g., `http://localhost:3000`) |
| `VAJRA_LOGS_ROOT` | No | `~/.vajra-runs` | Directory for run logs and event history |
| `GITHUB_WEBHOOK_SECRET` | No | — | Secret for GitHub webhook verification |
| `SLACK_BOT_TOKEN` | No | — | Slack bot token |
| `SLACK_CHANNEL_ID` | No | — | Slack channel for notifications |

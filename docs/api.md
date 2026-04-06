# API Reference

All endpoints require `Authorization: Bearer <VAJRA_API_KEY>` except GitHub webhooks (which use signature verification).

Default: `http://localhost:3847`

---

## State & Runs

### `GET /state`

Orchestrator state snapshot — active runs, barriers, concurrency counts.

### `GET /runs`

List pipeline runs.

| Query Param | Description |
|------------|-------------|
| `status` | Filter by status: `running`, `success`, `failure`, `cancelled`, `wait_human` |
| `since` | Time window: `24h`, `7d`, `30d`, or ISO timestamp |
| `limit` | Maximum results (default: 20) |

### `GET /runs/:issue/:attempt`

Full run detail for a specific issue and attempt. Includes per-stage breakdown with prompts, outputs, and artifacts.

### `GET /runs/:issue/:attempt/stages/:stageId`

Single stage detail — the full prompt sent to the agent, the output, artifacts, and result metadata.

### `GET /events`

Server-Sent Events (SSE) stream for real-time updates. Supports `Last-Event-ID` header for replay from a specific point.

Event types include:
- `orchestrator:started` — Vajra started
- `orchestrator:tick` — Polling cycle
- `pipeline:started` / `pipeline:completed` / `pipeline:failed` — Pipeline lifecycle
- `stage:started` / `stage:completed` / `stage:failed` — Stage lifecycle
- `workspace:created` / `workspace:cleaned` — Workspace operations

---

## Configuration

### `GET /config`

Full configuration snapshot (tracker, execution, backends, agents, workflows, routing).

### `PUT /config`

Update top-level configuration (execution limits, polling interval, etc.). Accepts a JSON object with the fields to update.

### Agents

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/config/agents` | List all agents |
| `PUT` | `/config/agents/:name` | Create or update an agent |
| `DELETE` | `/config/agents/:name` | Delete an agent |

PUT body:
```json
{
  "backend": "claude",
  "model": "claude-sonnet-4-6",
  "prompt": "Your agent prompt...",
  "reasoning_effort": "high",
  "timeoutMs": 300000
}
```

### Backends

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/config/backends` | List all backends |
| `PUT` | `/config/backends/:name` | Create or update a backend |

PUT body:
```json
{
  "command": "claude --model {{ model }} -p {{ prompt | shellquote }}"
}
```

### Workflows

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/config/workflows` | List all workflows |
| `GET` | `/config/workflows/:name` | Get workflow detail (includes parsed graph) |
| `PUT` | `/config/workflows/:name` | Create or update a workflow |
| `DELETE` | `/config/workflows/:name` | Delete a workflow |
| `POST` | `/config/workflows/preview` | Preview a DOT graph without saving (validates and returns parsed structure) |

PUT body:
```json
{
  "rawDot": "digraph { ... }",
  "successState": "In Review",
  "inspectPr": true,
  "labels": ["my-label"],
  "isDefault": false
}
```

### Raw Config

### `GET /config/raw`

Returns the raw WORKFLOW.md file content as-is (before parsing/resolving).

### Skills

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/config/skills` | List all skills |
| `PUT` | `/config/skills/:name` | Create or update a skill |
| `DELETE` | `/config/skills/:name` | Delete a skill |

PUT body:
```json
{
  "content": "# My Skill\n\nMarkdown content..."
}
```

---

## Webhooks

### `POST /github/webhooks`

GitHub webhook receiver. Handles PR review events to trigger revision workflows.

Authentication: GitHub webhook signature verification (using `GITHUB_WEBHOOK_SECRET`). Does not use `VAJRA_API_KEY`.

See [GitHub Integration](github-integration.md) for setup instructions.

# Vajra

A background coding agent that polls Linear for assigned issues, routes them through configurable workflows, and produces pull requests — without human intervention.

Named for Indra's thunderbolt in Indian mythology: celestial, precise, and charged with force.

[![CI](https://github.com/zamana-inc/vajra/actions/workflows/ci.yml/badge.svg)](https://github.com/zamana-inc/vajra/actions/workflows/ci.yml)

## How It Works

You assign a Linear issue to Vajra. Within 30 seconds, it picks it up and runs a multi-stage pipeline: **plan → review plan → code → review code → prepare PR → publish PR**. Each stage is a separate AI agent (Claude, Codex, or any CLI tool). Review stages can send work back for revision or escalate to a human. When the pipeline finishes, you get a pull request.

The issue description is the prompt. Write it like you're briefing a developer — scope, constraints, files to touch, expected behavior. The better the description, the better the output.

## Quickstart

### Prerequisites

- **Node.js 20+**
- **A [Linear](https://linear.app) account** with an API key
- **A [GitHub](https://github.com) token** with repo access
- **At least one coding agent CLI:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`) or [Codex](https://github.com/openai/codex) (`codex`)

### 1. Clone, install, build

```bash
git clone https://github.com/zamana-inc/vajra.git
cd vajra
npm install
npm run build:orchestrator
```

### 2. Find your Linear user ID

```bash
export LINEAR_API_KEY="lin_api_..."

curl -s -H "Authorization: Bearer $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ viewer { id name email } }"}' \
  https://api.linear.app/graphql
```

Copy the `id` field from the response. If you want Vajra to run as a dedicated bot, create a separate Linear user and use that ID instead.

### 3. Configure

```bash
cp WORKFLOW.md.example WORKFLOW.md
```

Open `WORKFLOW.md` and replace the three placeholder values:

| Placeholder | Where to find it |
|-------------|-----------------|
| `your-linear-user-id` | Step 2 above |
| `your-org/your-repo` | Your GitHub repository (appears in two places: `hooks.after_create` and `github.repository`) |
| Backend command | Already configured for `claude` and `codex` — adjust if needed |

Everything else has sensible defaults. The template has inline comments explaining each section.

### 4. Set environment variables

```bash
export LINEAR_API_KEY="lin_api_..."
export GITHUB_TOKEN="ghp_..."
export VAJRA_API_KEY="any-secret-string"   # protects the Vajra REST API
```

### 5. Start the orchestrator

```bash
node orchestrator/dist/index.js
```

Run this from the repo root (where your `WORKFLOW.md` lives). You can also pass an explicit path: `node orchestrator/dist/index.js /path/to/WORKFLOW.md`.

You should see a structured log line with `"message":"orchestrator:started"`. The API is now listening on `http://localhost:3847`.

### 6. Give Vajra its first issue

1. Create a Linear issue with a clear title and description
2. Assign it to the user whose ID you configured
3. Set the state to **Todo**
4. Vajra picks it up within ~30 seconds

Verify it's working:

```bash
curl -s -H "Authorization: Bearer $VAJRA_API_KEY" http://localhost:3847/runs?limit=5
```

### 7. Start the dashboard (optional)

```bash
cd dashboard
cp .env.example .env.local
# Edit .env.local — set VAJRA_API_KEY to match the orchestrator's key
npm run dev
```

Open `http://localhost:3000` for live monitoring, workflow visualization, and configuration management.

## Documentation

| Document | Description |
|----------|-------------|
| [Configuration](docs/configuration.md) | Full WORKFLOW.md reference — hooks, agents, backends, skills, routing, execution limits |
| [Workflows](docs/workflows.md) | Creating custom pipelines with DOT graphs — node attributes, edge routing, safety nets |
| [API Reference](docs/api.md) | REST API endpoints for state, runs, config, and SSE events |
| [GitHub Integration](docs/github-integration.md) | PR review loop, webhooks, revision workflows |
| [How Vajra Works](docs/how-vajra-works.md) | Deep architecture walkthrough — polling, triage, workspaces, pipelines, retries, escalation |

## Key Concepts

- **Workflows** — Directed graphs (DOT format) where each node is an agent or tool stage. Edges with `on_label` attributes route based on agent decisions (`lgtm`, `revise`, `escalate`).
- **Agents** — Named configurations combining a backend + model + prompt. Each pipeline stage references an agent defined in WORKFLOW.md.
- **Skills** — Markdown instruction documents (`orchestrator/skills/`) that encode team conventions. Agents reference them by name; they're synced into the workspace at runtime.
- **Backends** — Command templates for invoking coding agents (e.g., `claude --model {{ model }} -p {{ prompt }}`).
- **Hooks** — Shell scripts that run during workspace setup. `after_create` clones the repo; `before_run` resets to the latest upstream.

## Project Structure

```
vajra/
├── orchestrator/           # The engine — polls Linear, runs workflows
│   ├── src/                # TypeScript source
│   ├── skills/             # Built-in skill documents (12 skills)
│   ├── tests/              # 197 tests
│   └── dist/               # Compiled output
├── dashboard/              # Next.js monitoring UI
├── pipelines/              # DOT workflow definitions
│   ├── default.dot         # Plan → review → code → review → PR
│   ├── revision.dot        # Handle PR review feedback
│   ├── document.dot        # Documentation workflow
│   └── knowledge.dot       # Knowledge article drafting
├── WORKFLOW.md.example     # Ready-to-use configuration template
└── docs/                   # Reference documentation
```

## Development

```bash
npm install                    # Install everything
npm run build:orchestrator     # Build the orchestrator
npm test                       # Run tests (197 tests)
npm run dev:dashboard          # Dashboard in dev mode (equivalent to cd dashboard && npm run dev)
```

## License

MIT

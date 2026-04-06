# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] — 2026-04-06

### Added

- **Orchestrator** — Linear polling, workflow execution, pipeline engine, agent backends
- **Dashboard** — Next.js monitoring UI with real-time SSE updates, workflow editor, agent/skill management
- **DOT graph workflows** — define pipelines as directed graphs with labeled edge routing
- **Skills system** — reusable markdown instruction documents injected into agent workspaces
- **GitHub integration** — automatic PR creation and PR review feedback loop
- **Slack notifications** — pipeline success/failure alerts
- **Safety nets** — per-stage visit limits, exhaustion routing, global invocation budgets
- **Filesystem-only state** — no database; all state in `.vajra/` and `~/.vajra-runs`
- **Built-in pipelines** — default (plan/review/code/review/PR), revision, document, knowledge
- **197 tests** covering orchestrator, pipeline, API server, tracker, workflows, and more

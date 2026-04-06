# Contributing to Vajra

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/zamana-inc/vajra.git
cd vajra
npm install
npm run build:orchestrator
npm test
```

Tests should pass in under 10 seconds. If they don't, open an issue.

## Making Changes

1. **Fork the repo** and create a branch from `main`
2. **Make your changes** — follow the existing code style (TypeScript strict mode, structured JSON logging)
3. **Add tests** for new functionality — tests live in `orchestrator/tests/`
4. **Run the full test suite** — `npm test` must pass with zero failures
5. **Open a pull request** against `main`

## Pull Request Guidelines

- Link to a GitHub issue if one exists
- Describe what changed and why
- Keep PRs focused — one logical change per PR
- Tests must pass in CI (Node 20 and 22)

## Reporting Bugs

Open a [GitHub issue](https://github.com/zamana-inc/vajra/issues) with:

- What you expected to happen
- What actually happened
- Steps to reproduce
- Vajra version and Node.js version

## Architecture

See [How Vajra Works](docs/how-vajra-works.md) for a deep walkthrough of the system. The codebase is structured as:

- `orchestrator/src/` — Core engine (TypeScript)
- `orchestrator/tests/` — Test suite (Node.js test runner)
- `orchestrator/skills/` — Built-in skill documents
- `dashboard/` — Next.js monitoring UI
- `pipelines/` — DOT workflow definitions
- `docs/` — Reference documentation

## Code Style

- TypeScript with `strict: true`
- Structured JSON logging via `log()` — no raw `console.log`
- No external dependencies beyond Fastify, Chokidar, js-yaml, and LiquidJS
- Tests use the Node.js built-in test runner — no test framework dependency

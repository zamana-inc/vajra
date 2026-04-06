# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Vajra, please report it responsibly.

**Email:** security@zamana.com

Please include:
- A description of the vulnerability
- Steps to reproduce
- Potential impact

We will acknowledge your report within 48 hours and provide an estimated timeline for a fix.

**Do not** open a public GitHub issue for security vulnerabilities.

## Security Considerations

Vajra handles sensitive credentials and executes arbitrary commands. Operators should be aware of:

- **API keys** — `LINEAR_API_KEY`, `GITHUB_TOKEN`, and `VAJRA_API_KEY` are stored as environment variables. Never commit them to source control.
- **Agent execution** — Coding agents (Claude, Codex) run shell commands in workspace directories. Vajra does not sandbox these commands.
- **Webhook verification** — GitHub webhooks are verified using `GITHUB_WEBHOOK_SECRET` HMAC signatures. Always configure a webhook secret in production.
- **REST API** — The Vajra API requires bearer token authentication (`VAJRA_API_KEY`). Do not expose the API to the public internet without additional network-level access controls.
- **WORKFLOW.md** — Contains references to API keys via `$VAR_NAME` syntax. The file itself should not contain raw secrets.

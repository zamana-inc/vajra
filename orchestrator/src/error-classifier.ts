/**
 * Classifies machine-generated CLI failures from Claude Code and Codex.
 *
 * This intentionally avoids broad substring matching over arbitrary model text.
 * The classifier only trusts backend-specific envelopes/signatures that we
 * observed from the installed CLI binaries on this machine:
 *
 * - Claude Code non-interactive mode emits JSON objects via `--output-format json`
 * - Codex `exec` emits machine-formatted auth retry/error lines on auth failure
 */

export type FailureClass = "auth" | "rate-limit";

export interface ClassifiedError {
  failureClass: FailureClass;
  /** Human-readable summary shown in Slack and event logs. */
  detail: string;
  /** For rate limits: the reset window extracted from the provider message. */
  retryAfterHint: string | null;
}

type KnownBackend = "claude" | "codex";

const CLAUDE_NOT_LOGGED_IN = "Not logged in · Please run /login";
const CLAUDE_RATE_LIMIT_PATTERN = /^You['\u2019]ve hit your limit · resets\s+(.+)$/i;
const CLAUDE_AUTH_ERROR_TYPES = new Set([
  "authentication_error",
]);
const CLAUDE_RATE_LIMIT_ERROR_TYPES = new Set([
  "rate_limit_error",
]);
const CODEX_401_RETRY_PATTERN = /^exceeded retry limit, last status: 401 Unauthorized$/;
const CODEX_NOT_SIGNED_IN_PATTERN = /^Not signed in\. Please run 'codex login'/;

function resolveBackendName(backend: string | null | undefined): KnownBackend | null {
  const normalized = String(backend ?? "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized.includes("claude")) {
    return "claude";
  }
  if (normalized.includes("codex")) {
    return "codex";
  }
  return null;
}

function parseJsonLines(output: string): Array<Record<string, unknown>> {
  const parsed: Array<Record<string, unknown>> = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      continue;
    }
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed.push(value as Record<string, unknown>);
      }
    } catch {
      // Ignore non-JSON lines mixed into combined stdout/stderr.
    }
  }
  return parsed;
}

function getNestedString(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const nested = value[key];
  return typeof nested === "string" ? nested : null;
}

function classifyClaudeOutput(output: string): ClassifiedError | null {
  for (const jsonLine of parseJsonLines(output)) {
    const eventType = getNestedString(jsonLine, "type");
    if (eventType === "result" && jsonLine.is_error === true) {
      const result = getNestedString(jsonLine, "result");
      if (!result) {
        continue;
      }

      if (result === CLAUDE_NOT_LOGGED_IN) {
        return {
          failureClass: "auth",
          detail: "Claude not logged in",
          retryAfterHint: null,
        };
      }

      const rateLimitMatch = CLAUDE_RATE_LIMIT_PATTERN.exec(result);
      if (rateLimitMatch) {
        return {
          failureClass: "rate-limit",
          detail: "Claude usage limit reached",
          retryAfterHint: rateLimitMatch[1]?.trim() ?? null,
        };
      }
    }

    if (eventType === "error") {
      const nestedError = jsonLine.error;
      if (!nestedError || typeof nestedError !== "object" || Array.isArray(nestedError)) {
        continue;
      }

      const errorRecord = nestedError as Record<string, unknown>;
      const errorType = getNestedString(errorRecord, "type");
      const errorMessage = getNestedString(errorRecord, "message");
      if (!errorType) {
        continue;
      }

      if (CLAUDE_AUTH_ERROR_TYPES.has(errorType)) {
        return {
          failureClass: "auth",
          detail: errorMessage ? `Claude authentication failed: ${errorMessage}` : "Claude authentication failed",
          retryAfterHint: null,
        };
      }

      if (CLAUDE_RATE_LIMIT_ERROR_TYPES.has(errorType)) {
        return {
          failureClass: "rate-limit",
          detail: errorMessage ? `Claude usage limit reached: ${errorMessage}` : "Claude usage limit reached",
          retryAfterHint: null,
        };
      }
    }
  }

  return null;
}

function classifyCodexOutput(output: string): ClassifiedError | null {
  for (const jsonLine of parseJsonLines(output)) {
    const nestedMessage = jsonLine.msg;
    if (!nestedMessage || typeof nestedMessage !== "object" || Array.isArray(nestedMessage)) {
      continue;
    }

    const messageRecord = nestedMessage as Record<string, unknown>;
    const messageType = getNestedString(messageRecord, "type");
    const message = getNestedString(messageRecord, "message");
    if (!messageType || !message) {
      continue;
    }

    if ((messageType === "error" || messageType === "stream_error") && CODEX_401_RETRY_PATTERN.test(message)) {
      return {
        failureClass: "auth",
        detail: "Codex authentication failed (401 Unauthorized)",
        retryAfterHint: null,
      };
    }
  }

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^\[[^\]]+\] ERROR: exceeded retry limit, last status: 401 Unauthorized$/.test(trimmed)) {
      return {
        failureClass: "auth",
        detail: "Codex authentication failed (401 Unauthorized)",
        retryAfterHint: null,
      };
    }
    if (CODEX_NOT_SIGNED_IN_PATTERN.test(trimmed)) {
      return {
        failureClass: "auth",
        detail: "Codex not signed in",
        retryAfterHint: null,
      };
    }
  }

  return null;
}

/**
 * Inspect backend output and return a classification if a known non-transient
 * CLI failure envelope is detected.
 */
export function classifyStageError(opts: {
  output: string;
  backend: string | null | undefined;
}): ClassifiedError | null {
  const backend = resolveBackendName(opts.backend);
  if (!backend) {
    return null;
  }

  if (backend === "claude") {
    return classifyClaudeOutput(opts.output);
  }

  return classifyCodexOutput(opts.output);
}

import { randomUUID } from "node:crypto";

import { insertArgsAfterBinary, isCommandTemplateAvailable } from "./backend-command-utils";
import { CommandRunner, ShellCommandRunner } from "./process";
import { renderCommandTemplate } from "./template";
import { AgentBackend, AgentResult, BackendDefinition } from "./types";

type ClaudeResultPayload = {
  result?: unknown;
  session_id?: unknown;
};

function parseClaudePayload(stdout: string): ClaudeResultPayload | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as ClaudeResultPayload;
  } catch {
    return null;
  }
}

function extractClaudeOutput(payload: ClaudeResultPayload | null, fallback: string): string {
  if (!payload) {
    return fallback;
  }

  if (typeof payload.result === "string") {
    return payload.result;
  }

  if (payload.result === null || payload.result === undefined) {
    return "";
  }

  return JSON.stringify(payload.result);
}

function shouldInvalidateClaudeSession(output: string): boolean {
  return /No conversation found with session ID:/i.test(output);
}

export class ClaudeBackend implements AgentBackend {
  readonly supportsNativeSessions = true;
  readonly name: string;

  constructor(
    name: string,
    private readonly commandConfig: BackendDefinition,
    private readonly runner: CommandRunner = new ShellCommandRunner(),
  ) {
    this.name = name;
  }

  async isAvailable(): Promise<boolean> {
    return isCommandTemplateAvailable(this.commandConfig.command, this.runner);
  }

  async execute(opts: {
    workspace: string;
    prompt: string;
    model?: string;
    reasoningEffort?: string;
    createSession?: boolean;
    sessionId?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<AgentResult> {
    const rendered = await renderCommandTemplate(this.commandConfig.command, {
      prompt: opts.prompt,
      model: opts.model ?? "",
      reasoning_effort: opts.reasoningEffort ?? "",
      reasoningEffort: opts.reasoningEffort ?? "",
    });

    const sessionId = opts.createSession ? randomUUID() : opts.sessionId?.trim() || undefined;
    const command = sessionId
      ? insertArgsAfterBinary(
          rendered,
          opts.createSession
            ? ["--session-id", sessionId]
            : ["--resume", sessionId],
        )
      : rendered;

    const result = await this.runner.run(command, {
      cwd: opts.workspace,
      timeoutMs: opts.timeoutMs,
      env: opts.env,
      signal: opts.signal,
    });

    const rawOutput = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    const parsed = parseClaudePayload(result.stdout);
    const resolvedSessionId = typeof parsed?.session_id === "string" && parsed.session_id.trim()
      ? parsed.session_id.trim()
      : sessionId;

    return {
      output: extractClaudeOutput(parsed, rawOutput),
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}),
      ...(sessionId && result.exitCode !== 0 && shouldInvalidateClaudeSession(rawOutput)
        ? { invalidateSession: true }
        : {}),
    };
  }
}

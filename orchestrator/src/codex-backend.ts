import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  isCommandTemplateAvailable,
  joinCommandTokens,
  shellQuote,
  splitCommandTokens,
  tokenBasename,
} from "./backend-command-utils";
import { CommandRunner, ShellCommandRunner } from "./process";
import { renderCommandTemplate } from "./template";
import { AgentBackend, AgentResult, BackendDefinition } from "./types";

type CodexJsonLine = Record<string, unknown>;

function parseCodexJsonLines(stdout: string): CodexJsonLine[] {
  const parsed: CodexJsonLine[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      continue;
    }

    try {
      const value = JSON.parse(trimmed) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed.push(value as CodexJsonLine);
      }
    } catch {
      // Ignore mixed-in non-JSON output.
    }
  }

  return parsed;
}

function extractThreadId(lines: CodexJsonLine[]): string | undefined {
  for (const line of lines) {
    if (line.type !== "thread.started") {
      continue;
    }

    const threadId = line.thread_id;
    if (typeof threadId === "string" && threadId.trim()) {
      return threadId.trim();
    }
  }

  return undefined;
}

function extractAssistantText(lines: CodexJsonLine[]): string | null {
  for (const line of [...lines].reverse()) {
    if (line.type !== "item.completed") {
      continue;
    }

    const item = line.item;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }

    const message = item as Record<string, unknown>;
    if (message.type !== "agent_message") {
      continue;
    }

    const text = message.text;
    if (typeof text === "string" && text.trim()) {
      return text;
    }
  }

  return null;
}

function shouldInvalidateCodexSession(output: string): boolean {
  return /\b(?:session|thread)\b[\s\S]{0,120}\b(?:not found|missing|unknown|invalid)\b/i.test(output);
}

function assertCodexExecCommand(tokens: string[]): void {
  if (tokens.length < 3 || tokenBasename(tokens[0]) !== "codex" || tokens[1] !== "exec") {
    throw new Error("codex backend command must start with `codex exec`");
  }
}

function stripExistingCodexOutputFlags(tokens: string[]): string[] {
  const sanitized: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--json") {
      continue;
    }
    if (token === "-o" || token === "--output-last-message") {
      index += 1;
      continue;
    }
    if (token.startsWith("--output-last-message=")) {
      continue;
    }
    sanitized.push(token);
  }

  return sanitized;
}

function buildCodexSessionCommand(opts: {
  renderedCommand: string;
  lastMessagePath: string;
  sessionId?: string;
}): string {
  const tokens = stripExistingCodexOutputFlags(splitCommandTokens(opts.renderedCommand));
  assertCodexExecCommand(tokens);
  const promptToken = tokens.pop();
  if (!promptToken) {
    throw new Error("codex backend command must end with the rendered prompt argument");
  }

  const prefix = tokens.slice(0, 2);
  const options = tokens.slice(2);
  const commandTokens = [
    prefix[0],
    prefix[1],
    ...(opts.sessionId ? ["resume"] : []),
    "--json",
    "-o",
    shellQuote(opts.lastMessagePath),
    ...options,
    ...(opts.sessionId ? [shellQuote(opts.sessionId)] : []),
    promptToken,
  ];
  return joinCommandTokens(commandTokens);
}

async function readLastMessage(lastMessagePath: string): Promise<string | null> {
  try {
    const content = await readFile(lastMessagePath, "utf8");
    const normalized = content.replace(/\r\n/g, "\n").trimEnd();
    return normalized ? normalized : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export class CodexBackend implements AgentBackend {
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

    if (!opts.createSession && !opts.sessionId) {
      const result = await this.runner.run(rendered, {
        cwd: opts.workspace,
        timeoutMs: opts.timeoutMs,
        env: opts.env,
        signal: opts.signal,
      });

      return {
        output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      };
    }

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-codex-"));
    const lastMessagePath = path.join(tempDir, "last-message.txt");

    try {
      const command = buildCodexSessionCommand({
        renderedCommand: rendered,
        lastMessagePath,
        sessionId: opts.sessionId,
      });
      const result = await this.runner.run(command, {
        cwd: opts.workspace,
        timeoutMs: opts.timeoutMs,
        env: opts.env,
        signal: opts.signal,
      });

      const rawOutput = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      const events = parseCodexJsonLines(result.stdout);
      const resolvedSessionId = extractThreadId(events);

      if (opts.sessionId) {
        if (!resolvedSessionId) {
          return {
            output: `Codex resume did not report a thread id.\n${rawOutput}`.trim(),
            exitCode: result.exitCode === 0 ? 1 : result.exitCode,
            durationMs: result.durationMs,
            invalidateSession: true,
          };
        }

        if (resolvedSessionId !== opts.sessionId) {
          return {
            output: [
              `Codex resume returned a different thread id (expected ${opts.sessionId}, got ${resolvedSessionId}).`,
              rawOutput,
            ].filter(Boolean).join("\n"),
            exitCode: result.exitCode === 0 ? 1 : result.exitCode,
            durationMs: result.durationMs,
            sessionId: resolvedSessionId,
            invalidateSession: true,
          };
        }
      }

      const lastMessage = await readLastMessage(lastMessagePath);
      const assistantText = lastMessage ?? extractAssistantText(events);
      const output = result.exitCode === 0
        ? assistantText ?? rawOutput
        : rawOutput;

      return {
        output,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}),
        ...(opts.sessionId && result.exitCode !== 0 && shouldInvalidateCodexSession(rawOutput)
          ? { invalidateSession: true }
          : {}),
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

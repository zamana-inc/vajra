import { AgentBackend, AgentResult, BackendDefinition } from "./types";
import { isCommandTemplateAvailable } from "./backend-command-utils";
import { ClaudeBackend } from "./claude-backend";
import { CodexBackend } from "./codex-backend";
import { CommandRunner, ShellCommandRunner } from "./process";
import { renderCommandTemplate } from "./template";

export function backendSupportsNativeSessions(backendName: string): boolean {
  const normalized = String(backendName ?? "").trim().toLowerCase();
  return normalized === "claude" || normalized === "codex";
}

export class CommandTemplateBackend implements AgentBackend {
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
    const command = await renderCommandTemplate(this.commandConfig.command, {
      prompt: opts.prompt,
      model: opts.model ?? "",
      reasoning_effort: opts.reasoningEffort ?? "",
      reasoningEffort: opts.reasoningEffort ?? "",
    });

    const result = await this.runner.run(command, {
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
}

export function buildBackends(
  commands: Record<string, BackendDefinition>,
  runner?: CommandRunner,
): Map<string, AgentBackend> {
  return new Map(
    Object.entries(commands).map(([name, config]) => [
      name,
      name.toLowerCase() === "claude"
        ? new ClaudeBackend(name, config, runner)
        : name.toLowerCase() === "codex"
        ? new CodexBackend(name, config, runner)
        : new CommandTemplateBackend(name, config, runner),
    ]),
  );
}

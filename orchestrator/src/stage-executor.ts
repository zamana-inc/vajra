import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeStageMetadataObject, stageMetadataFromResult, stageOutcomeFromResult } from "./outcomes";
import { executeBuiltInVajraTool } from "./pr-tools";
import { CommandRunner, ShellCommandRunner } from "./process";
import { AgentBackend, GitHubConfig, GraphNode, PullRequestMetadata, StageMetadata, StageOutcome } from "./types";
import { renderCommandTemplate } from "./template";
import { workspaceReference } from "./workspace-reference";

const WORKSPACE_PR_INSPECTION_COMMAND = "gh pr view --json url,title,number,headRefName,headRefOid,additions,deletions,state 2>/dev/null || echo '{}'";
const WORKSPACE_PR_INSPECTION_TIMEOUT_MS = 10_000;

export interface StageExecutionResult {
  output: string;
  exitCode: number;
  durationMs: number;
  backend: string | null;
  command: string | null;
  sessionId?: string;
  invalidateSession?: boolean;
}

export interface ResolvedAgentExecution {
  backendName: string;
  model: string;
  reasoningEffort?: string;
  timeoutMs?: number;
}

export interface LoadedStageResult {
  metadata: StageMetadata;
  outcome: StageOutcome;
}

export function stageExecutionType(node: GraphNode): "agent" | "tool" {
  return node.type === "tool" || !!node.attrs.command ? "tool" : "agent";
}

export function defaultStageArtifacts(): Record<string, string> {
  return {
    primary: "",
    output: "",
  };
}

function stageOutputArtifactPath(workspacePath: string, workspaceArtifactsDir: string, stageId: string): string {
  return path.join(workspacePath, workspaceArtifactsDir, "stages", stageId, "output.txt");
}

function stageResultPath(workspacePath: string, workspaceArtifactsDir: string, stageId: string): string {
  return path.join(workspacePath, workspaceArtifactsDir, "stages", stageId, "result.json");
}

function stageHistoryDirectoryPath(
  workspacePath: string,
  workspaceArtifactsDir: string,
  stageId: string,
  visitCount: number,
): string {
  const visitDir = visitCount <= 1 ? stageId : `${stageId}_${visitCount}`;
  return path.join(workspacePath, workspaceArtifactsDir, "stages", "history", visitDir);
}

async function ensureDir(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT" ? Promise.reject(error) : false;
  }
}

function parsePullRequestMetadata(value: unknown): PullRequestMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const payload = value as Record<string, unknown>;
  const url = String(payload.url ?? "").trim();
  if (!url) {
    return null;
  }

  const numberValue = payload.number;
  const additionsValue = payload.additions;
  const deletionsValue = payload.deletions;

  return {
    url,
    title: typeof payload.title === "string" ? payload.title : null,
    number: typeof numberValue === "number" ? numberValue : Number.isFinite(Number(numberValue)) ? Number(numberValue) : null,
    headRefName: typeof payload.headRefName === "string" ? payload.headRefName : null,
    additions: typeof additionsValue === "number" ? additionsValue : Number.isFinite(Number(additionsValue)) ? Number(additionsValue) : null,
    deletions: typeof deletionsValue === "number" ? deletionsValue : Number.isFinite(Number(deletionsValue)) ? Number(deletionsValue) : null,
    state: typeof payload.state === "string" ? payload.state : null,
    ...(typeof payload.headRefOid === "string" ? { headSha: payload.headRefOid } : {}),
  };
}

export class PipelineStageExecutor {
  constructor(private readonly toolRunner: CommandRunner = new ShellCommandRunner()) {}

  async persistStageOutputArtifact(
    stageId: string,
    output: string,
    workspacePath: string,
    workspaceArtifactsDir: string,
  ): Promise<string> {
    const filePath = stageOutputArtifactPath(workspacePath, workspaceArtifactsDir, stageId);
    await ensureDir(path.dirname(filePath));
    await writeFile(filePath, output, "utf8");
    return workspaceReference(workspacePath, filePath);
  }

  async clearStageResultFile(
    stageId: string,
    workspacePath: string,
    workspaceArtifactsDir: string,
  ): Promise<void> {
    await rm(stageResultPath(workspacePath, workspaceArtifactsDir, stageId), { force: true });
  }

  async writeStageResultFile(opts: {
    stageId: string;
    workspacePath: string;
    workspaceArtifactsDir: string;
    result: StageMetadata;
  }): Promise<void> {
    const resultPath = stageResultPath(opts.workspacePath, opts.workspaceArtifactsDir, opts.stageId);
    await ensureDir(path.dirname(resultPath));
    await writeFile(resultPath, JSON.stringify(opts.result, null, 2), "utf8");
  }

  private async readStageResultObject(opts: {
    stageId: string;
    workspacePath: string;
    workspaceArtifactsDir: string;
  }): Promise<StageMetadata> {
    const resultPath = stageResultPath(opts.workspacePath, opts.workspaceArtifactsDir, opts.stageId);

    try {
      const raw = await readFile(resultPath, "utf8");
      return normalizeStageMetadataObject(JSON.parse(raw) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }

      console.error(JSON.stringify({
        message: "stage result metadata ignored",
        stageId: opts.stageId,
        resultPath,
        error: error instanceof Error ? error.message : String(error),
      }));
      return {};
    }
  }

  async loadStageMetadata(opts: {
    stageId: string;
    workspacePath: string;
    workspaceArtifactsDir: string;
  }): Promise<StageMetadata> {
    return stageMetadataFromResult(await this.readStageResultObject(opts));
  }

  async loadStageResult(opts: {
    stageId: string;
    workspacePath: string;
    workspaceArtifactsDir: string;
    exitCode: number;
  }): Promise<LoadedStageResult> {
    const result = await this.readStageResultObject(opts);

    return {
      metadata: stageMetadataFromResult(result),
      outcome: stageOutcomeFromResult({
        result,
        exitCode: opts.exitCode,
        workspacePath: opts.workspacePath,
      }),
    };
  }

  async collectArtifacts(stage: GraphNode, workspacePath: string, outputArtifact: string): Promise<Record<string, string>> {
    const artifacts: Record<string, string> = {
      ...defaultStageArtifacts(),
      output: outputArtifact,
    };

    if (!stage.attrs.artifact_path) {
      return artifacts;
    }

    const artifactPath = path.isAbsolute(stage.attrs.artifact_path)
      ? stage.attrs.artifact_path
      : path.join(workspacePath, stage.attrs.artifact_path);
    if (!(await fileExists(artifactPath))) {
      return artifacts;
    }

    const artifactStat = await stat(artifactPath);
    if (artifactStat.size === 0) {
      return artifacts;
    }

    artifacts.primary = workspaceReference(workspacePath, artifactPath);
    return artifacts;
  }

  async snapshotStageArtifacts(opts: {
    stageId: string;
    visitCount: number;
    workspacePath: string;
    workspaceArtifactsDir: string;
    artifacts: Record<string, string>;
  }): Promise<Record<string, string>> {
    const snapshotDir = stageHistoryDirectoryPath(
      opts.workspacePath,
      opts.workspaceArtifactsDir,
      opts.stageId,
      opts.visitCount,
    );
    await ensureDir(snapshotDir);

    const snapshots: Record<string, string> = {};
    for (const [name, artifactPath] of Object.entries(opts.artifacts)) {
      const trimmedArtifactPath = String(artifactPath ?? "").trim();
      if (!trimmedArtifactPath) {
        continue;
      }

      const sourcePath = path.isAbsolute(trimmedArtifactPath)
        ? trimmedArtifactPath
        : path.join(opts.workspacePath, trimmedArtifactPath);
      if (!(await fileExists(sourcePath))) {
        continue;
      }

      const sourceStat = await stat(sourcePath);
      if (!sourceStat.isFile() || sourceStat.size === 0) {
        continue;
      }

      const extension = path.extname(sourcePath) || (name === "output" ? ".txt" : "");
      const targetPath = path.join(snapshotDir, `${name}${extension}`);
      await copyFile(sourcePath, targetPath);
      snapshots[name] = workspaceReference(opts.workspacePath, targetPath);
    }

    return snapshots;
  }

  async inspectWorkspacePullRequest(workspacePath: string, signal?: AbortSignal): Promise<PullRequestMetadata | null> {
    try {
      const result = await this.toolRunner.run(WORKSPACE_PR_INSPECTION_COMMAND, {
        cwd: workspacePath,
        timeoutMs: WORKSPACE_PR_INSPECTION_TIMEOUT_MS,
        signal,
      });

      return parsePullRequestMetadata(JSON.parse(result.stdout || "{}") as unknown);
    } catch (error) {
      console.error(JSON.stringify({
        message: "workspace pull request inspection failed",
        workspacePath,
        error: error instanceof Error ? error.message : String(error),
      }));
      return null;
    }
  }

  async executeStage(opts: {
    stage: GraphNode;
    prompt: string;
    workspacePath: string;
    workspaceArtifactsDir: string;
    signal: AbortSignal;
    backends: Map<string, AgentBackend>;
    scope: Record<string, unknown>;
    resolvedAgent?: ResolvedAgentExecution | null;
    createSession?: boolean;
    sessionId?: string;
    githubConfig?: GitHubConfig | null;
  }): Promise<StageExecutionResult> {
    const stageTimeoutMs = opts.stage.attrs.timeout ? Number.parseInt(opts.stage.attrs.timeout, 10) : undefined;

    if (opts.stage.type === "tool" || opts.stage.attrs.command) {
      const commandTemplate = opts.stage.attrs.command;
      if (!commandTemplate) {
        throw new Error(`tool stage ${opts.stage.id} does not define a command`);
      }

      const command = await renderCommandTemplate(commandTemplate, {
        ...opts.scope,
        prompt: opts.prompt,
      });
      const builtInResult = await executeBuiltInVajraTool({
        command,
        githubConfig: opts.githubConfig ?? null,
        commandRunner: this.toolRunner,
        cwd: opts.workspacePath,
        signal: opts.signal,
      });
      if (builtInResult) {
        if (builtInResult.resultMetadata) {
          await this.writeStageResultFile({
            stageId: opts.stage.id,
            workspacePath: opts.workspacePath,
            workspaceArtifactsDir: opts.workspaceArtifactsDir,
            result: builtInResult.resultMetadata,
          });
        }
        return {
          output: [builtInResult.stdout, builtInResult.stderr].filter(Boolean).join("\n"),
          exitCode: builtInResult.exitCode,
          durationMs: builtInResult.durationMs,
          backend: null,
          command,
        };
      }

      const result = await this.toolRunner.run(command, {
        cwd: opts.workspacePath,
        timeoutMs: Number.isFinite(stageTimeoutMs) ? stageTimeoutMs : undefined,
        signal: opts.signal,
      });

      return {
        output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        backend: null,
        command,
      };
    }

    const resolvedAgent = opts.resolvedAgent;
    if (!resolvedAgent) {
      throw new Error(`agent stage ${opts.stage.id} is missing a resolved agent definition`);
    }

    const backend = opts.backends.get(resolvedAgent.backendName);
    if (!backend) {
      throw new Error(`backend ${resolvedAgent.backendName} is not configured`);
    }

    const available = await backend.isAvailable();
    if (!available) {
      throw new Error(`backend ${resolvedAgent.backendName} is not available on this host`);
    }

    const result = await backend.execute({
      workspace: opts.workspacePath,
      prompt: opts.prompt,
      model: resolvedAgent.model,
      reasoningEffort: resolvedAgent.reasoningEffort,
      createSession: opts.createSession,
      sessionId: opts.sessionId,
      timeoutMs: Number.isFinite(stageTimeoutMs) ? stageTimeoutMs : resolvedAgent.timeoutMs,
      signal: opts.signal,
    });

    return {
      output: result.output,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      backend: backend.name,
      command: null,
      sessionId: result.sessionId,
      invalidateSession: result.invalidateSession,
    };
  }
}

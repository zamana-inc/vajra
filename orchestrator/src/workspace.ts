import { lstat, mkdir, readdir, readlink, rm, stat } from "node:fs/promises";
import path from "node:path";

import { VajraEventBus } from "./events";
import { HooksConfig, WorkspaceConfig, WorkspaceInfo } from "./types";
import { CommandRunner, ShellCommandRunner } from "./process";
import { builtInSkillsRoot, syncBuiltInSkillsToWorkspace } from "./skills";

function isUnderRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function safeIdentifier(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_");
}

export class WorkspaceManager {
  private readonly runner: CommandRunner;

  constructor(
    private readonly workspaceConfig: WorkspaceConfig,
    private readonly hooksConfig: HooksConfig,
    runner?: CommandRunner,
    private readonly eventBus?: VajraEventBus,
    private readonly skillsRoot: string = builtInSkillsRoot(),
  ) {
    this.runner = runner ?? new ShellCommandRunner();
  }

  workspacePathForIssue(identifier: string): string {
    return path.join(this.workspaceConfig.root, safeIdentifier(identifier));
  }

  async validateWorkspacePath(workspacePath: string): Promise<void> {
    const root = path.resolve(this.workspaceConfig.root);
    const target = path.resolve(workspacePath);

    if (root === target) {
      throw new Error("workspace path must not equal workspace root");
    }

    if (!isUnderRoot(root, target)) {
      throw new Error(`workspace path escapes root: ${target}`);
    }

    const relativeParts = path.relative(root, target).split(path.sep).filter(Boolean);
    let current = root;
    for (const part of relativeParts) {
      current = path.join(current, part);
      try {
        const currentStat = await lstat(current);
        if (currentStat.isSymbolicLink()) {
          const destination = await readlink(current);
          throw new Error(`workspace path contains symlink component ${current} -> ${destination}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          break;
        }
        throw error;
      }
    }
  }

  async prepareWorkspace(identifier: string, hookEnv?: Record<string, string>): Promise<WorkspaceInfo> {
    // prepareWorkspace intentionally stops at directory creation/reuse and after_create.
    // before_run stays separate so the orchestrator controls when attempt-scoped setup runs.
    const workspacePath = this.workspacePathForIssue(identifier);
    await this.validateWorkspacePath(workspacePath);

    let createdNow = false;

    try {
      const fileStat = await stat(workspacePath);
      if (!fileStat.isDirectory()) {
        await rm(workspacePath, { recursive: true, force: true });
        await mkdir(workspacePath, { recursive: true });
        createdNow = true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await mkdir(workspacePath, { recursive: true });
        createdNow = true;
      } else {
        throw error;
      }
    }

    await this.cleanTmpArtifacts(workspacePath);

    if (createdNow) {
      await this.runHook("after_create", this.hooksConfig.afterCreate, workspacePath, true, hookEnv);
      this.eventBus?.emit({
        type: "workspace:created",
        timestamp: new Date().toISOString(),
        issueIdentifier: identifier,
        workspacePath,
      });
    }

    return {
      path: workspacePath,
      workspaceKey: safeIdentifier(identifier),
      createdNow,
    };
  }

  async runBeforeRunHook(workspacePath: string, hookEnv?: Record<string, string>): Promise<void> {
    await this.runHook("before_run", this.hooksConfig.beforeRun, workspacePath, true, hookEnv);
    await syncBuiltInSkillsToWorkspace(workspacePath, this.skillsRoot);
  }

  async runAfterRunHook(workspacePath: string): Promise<void> {
    await this.runHook("after_run", this.hooksConfig.afterRun, workspacePath, false);
  }

  async cleanupWorkspace(identifier: string): Promise<void> {
    const workspacePath = this.workspacePathForIssue(identifier);
    try {
      await this.validateWorkspacePath(workspacePath);
    } catch {
      return;
    }

    await this.runHook("before_remove", this.hooksConfig.beforeRemove, workspacePath, false);
    await rm(workspacePath, { recursive: true, force: true });
    this.eventBus?.emit({
      type: "workspace:cleaned",
      timestamp: new Date().toISOString(),
      issueIdentifier: identifier,
      workspacePath,
    });
  }

  private async cleanTmpArtifacts(workspacePath: string): Promise<void> {
    try {
      const entries = await readdir(workspacePath);
      const transientEntries = entries.filter((entry) => entry === ".vajra-tmp");
      await Promise.all(transientEntries.map((entry) => rm(path.join(workspacePath, entry), { recursive: true, force: true })));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  private async runHook(
    hookName: string,
    command: string | undefined,
    workspacePath: string,
    fatal: boolean,
    hookEnv?: Record<string, string>,
  ): Promise<void> {
    if (!command) {
      return;
    }

    try {
      const result = await this.runner.run(command, {
        cwd: workspacePath,
        timeoutMs: this.hooksConfig.timeoutMs,
        env: hookEnv,
      });

      if (result.exitCode !== 0) {
        throw new Error(`hook ${hookName} exited with status ${result.exitCode}: ${result.stderr || result.stdout}`);
      }
    } catch (error) {
      if (fatal) {
        throw error;
      }

      console.error(JSON.stringify({
        message: "workspace hook failed",
        hookName,
        workspacePath,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
}

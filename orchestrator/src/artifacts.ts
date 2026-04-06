import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { ArtifactConfig, Issue, IssueContext, PullRequestRecord, ReviewRequestState } from "./types";
import { safeIdentifier } from "./workspace";

function runWorkspaceArtifactsDir(workspaceDir: string): string {
  return path.join(workspaceDir, "run");
}

function issueContextTemplate(
  issue: Issue,
  attempt: number,
  workspacePath: string,
  workspaceArtifactsDir: string,
): IssueContext {
  return {
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? "",
      state: issue.state,
      labels: issue.labels,
      url: issue.url ?? "",
    },
    attempt,
    workspacePath,
    workspaceArtifactsDir,
    completedNodes: [],
    stages: {},
    updatedAt: new Date().toISOString(),
  };
}

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  const parent = path.dirname(filePath);
  await mkdir(parent, { recursive: true });
  const tmpPath = path.join(parent, `.tmp-${randomBytes(6).toString("hex")}-${path.basename(filePath)}`);
  try {
    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writeTextAtomic(filePath, JSON.stringify(value, null, 2));
}

async function readOptionalJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export class ReviewArtifactStore {
  constructor(
    private readonly config: ArtifactConfig,
    private readonly issueIdentifier: string,
  ) {}

  durableDirPath(): string {
    return path.join(this.config.root, safeIdentifier(this.issueIdentifier));
  }

  prRecordPath(): string {
    return path.join(this.durableDirPath(), "pr.json");
  }

  reviewStatePath(): string {
    return path.join(this.durableDirPath(), "review-state.json");
  }

  reviewFeedbackMarkdownPath(): string {
    return path.join(this.durableDirPath(), "review-feedback.md");
  }

  reviewFeedbackJsonPath(): string {
    return path.join(this.durableDirPath(), "review-feedback.json");
  }

  githubReviewBundleMarkdownPath(): string {
    return path.join(this.durableDirPath(), "github-review-bundle.md");
  }

  githubReviewBundleJsonPath(): string {
    return path.join(this.durableDirPath(), "github-review-bundle.json");
  }

  async loadPrRecord(): Promise<PullRequestRecord | null> {
    return readOptionalJson<PullRequestRecord>(this.prRecordPath());
  }

  async savePrRecord(record: PullRequestRecord): Promise<void> {
    await writeJsonAtomic(this.prRecordPath(), {
      ...record,
      updatedAt: new Date().toISOString(),
    } satisfies PullRequestRecord);
  }

  async loadReviewState(): Promise<ReviewRequestState | null> {
    return readOptionalJson<ReviewRequestState>(this.reviewStatePath());
  }

  async saveReviewState(state: ReviewRequestState): Promise<void> {
    await writeJsonAtomic(this.reviewStatePath(), {
      ...state,
      updatedAt: new Date().toISOString(),
    } satisfies ReviewRequestState);
  }

  async loadReviewFeedbackMarkdown(): Promise<string | null> {
    return readOptionalText(this.reviewFeedbackMarkdownPath());
  }

  async loadReviewFeedbackJson<T>(): Promise<T | null> {
    return readOptionalJson<T>(this.reviewFeedbackJsonPath());
  }

  async saveReviewFeedback(markdown: string, payload: unknown): Promise<void> {
    await writeTextAtomic(this.reviewFeedbackMarkdownPath(), markdown);
    await writeJsonAtomic(this.reviewFeedbackJsonPath(), payload);
    await writeTextAtomic(this.githubReviewBundleMarkdownPath(), markdown);
    await writeJsonAtomic(this.githubReviewBundleJsonPath(), payload);
  }
}

export class IssueArtifactStore {
  constructor(
    private readonly config: ArtifactConfig,
    private readonly issue: Issue,
    private readonly workspacePath: string,
  ) {}

  durableDirPath(): string {
    return path.join(this.config.root, safeIdentifier(this.issue.identifier));
  }

  workspaceDirPath(): string {
    return path.join(this.workspacePath, this.config.workspaceDir);
  }

  runWorkspaceDirPath(): string {
    return path.join(this.workspaceDirPath(), "run");
  }

  durableRunDirPath(): string {
    return path.join(this.durableDirPath(), "run");
  }

  durableBackupDirPath(): string {
    return `${this.durableDirPath()}.bak`;
  }

  durableContextPath(): string {
    return path.join(this.durableRunDirPath(), "context.json");
  }

  contextPath(): string {
    return path.join(this.runWorkspaceDirPath(), "context.json");
  }

  async hydrateWorkspace(): Promise<void> {
    await this.restoreDurableBackupIfNeeded();

    const durableDir = this.durableDirPath();
    const workspaceDir = this.workspaceDirPath();
    await mkdir(path.dirname(durableDir), { recursive: true });
    await mkdir(path.dirname(workspaceDir), { recursive: true });
    await rm(workspaceDir, { recursive: true, force: true });

    try {
      await cp(durableDir, workspaceDir, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await mkdir(workspaceDir, { recursive: true });
    }
  }

  async loadContext(attempt: number): Promise<IssueContext> {
    try {
      const raw = await readFile(this.contextPath(), "utf8");
      const parsed = JSON.parse(raw) as IssueContext;
      return {
        ...parsed,
        issue: {
          ...parsed.issue,
          id: this.issue.id,
          identifier: this.issue.identifier,
          title: this.issue.title,
          description: this.issue.description ?? "",
          state: this.issue.state,
          labels: this.issue.labels,
          url: this.issue.url ?? "",
        },
        attempt,
        workspacePath: this.workspacePath,
        workspaceArtifactsDir: runWorkspaceArtifactsDir(this.config.workspaceDir),
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    return issueContextTemplate(
      this.issue,
      attempt,
      this.workspacePath,
      runWorkspaceArtifactsDir(this.config.workspaceDir),
    );
  }

  async resetRunArtifacts(): Promise<void> {
    await rm(this.runWorkspaceDirPath(), { recursive: true, force: true });
    await rm(this.durableRunDirPath(), { recursive: true, force: true });
  }

  async saveContext(context: IssueContext): Promise<void> {
    const nextContext: IssueContext = {
      ...context,
      updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(this.contextPath(), nextContext);
    await writeJsonAtomic(this.durableContextPath(), nextContext);
  }

  async persistWorkspaceArtifacts(): Promise<void> {
    await this.restoreDurableBackupIfNeeded();

    const durableDir = this.durableDirPath();
    const backupDir = this.durableBackupDirPath();
    const parent = path.dirname(durableDir);
    await mkdir(parent, { recursive: true });

    const tmpDir = path.join(parent, `.tmp-${randomBytes(6).toString("hex")}`);
    try {
      await cp(this.workspaceDirPath(), tmpDir, { recursive: true, force: true });
      await rm(backupDir, { recursive: true, force: true });
      if (await pathExists(durableDir)) {
        await rename(durableDir, backupDir);
      }

      try {
        await rename(tmpDir, durableDir);
      } catch (error) {
        if (!(await pathExists(durableDir)) && await pathExists(backupDir)) {
          await rename(backupDir, durableDir).catch(() => {});
        }
        throw error;
      }

      await rm(backupDir, { recursive: true, force: true });
    } catch (error) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  private async restoreDurableBackupIfNeeded(): Promise<void> {
    const durableDir = this.durableDirPath();
    const backupDir = this.durableBackupDirPath();
    if (await pathExists(durableDir) || !(await pathExists(backupDir))) {
      return;
    }

    try {
      await rename(backupDir, durableDir);
    } catch {
      // If recovery rename fails, hydrateWorkspace/persistWorkspaceArtifacts can still
      // fall back to whatever snapshot remains on disk.
    }
  }
}

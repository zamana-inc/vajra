import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

import { PipelineCheckpoint, PipelineRunMetadata } from "./types";

export interface StageLogPaths {
  stageDir: string;
  promptPath: string;
  outputPath: string;
  metaPath: string;
}

function stageRunDirectoryName(stageId: string, visitCount: number): string {
  return visitCount <= 1 ? stageId : `${stageId}_${visitCount}`;
}

async function ensureDir(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true });
}

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tmpPath = path.join(
    path.dirname(filePath),
    `.tmp-${randomBytes(6).toString("hex")}-${path.basename(filePath)}`,
  );
  try {
    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeTextAtomic(filePath, JSON.stringify(value, null, 2));
}

export class PipelineRunStore {
  constructor(
    private readonly logsRoot: string,
    private readonly issueIdentifier: string,
    private readonly attempt: number,
  ) {}

  runDirPath(): string {
    return path.join(this.logsRoot, this.issueIdentifier, `attempt-${this.attempt}`);
  }

  checkpointPath(): string {
    return path.join(this.runDirPath(), "checkpoint.json");
  }

  async loadCheckpoint(): Promise<PipelineCheckpoint | null> {
    try {
      const content = await readFile(this.checkpointPath(), "utf8");
      return JSON.parse(content) as PipelineCheckpoint;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async loadRunMetadata(): Promise<PipelineRunMetadata | null> {
    try {
      const content = await readFile(path.join(this.runDirPath(), "run.json"), "utf8");
      return JSON.parse(content) as PipelineRunMetadata;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async writeRunMetadata(value: PipelineRunMetadata): Promise<void> {
    await writeJson(path.join(this.runDirPath(), "run.json"), value);
  }

  async writeCheckpoint(checkpoint: PipelineCheckpoint): Promise<void> {
    await writeJson(this.checkpointPath(), checkpoint);
  }

  async stageLogPaths(stageId: string, visitCount: number): Promise<StageLogPaths> {
    const stageDir = path.join(this.runDirPath(), stageRunDirectoryName(stageId, visitCount));
    await ensureDir(stageDir);
    return {
      stageDir,
      promptPath: path.join(stageDir, "prompt.txt"),
      outputPath: path.join(stageDir, "output.txt"),
      metaPath: path.join(stageDir, "meta.json"),
    };
  }

  async writeStagePrompt(paths: StageLogPaths, prompt: string): Promise<void> {
    await writeTextAtomic(paths.promptPath, prompt);
  }

  async writeStageOutput(paths: StageLogPaths, output: string): Promise<void> {
    await writeTextAtomic(paths.outputPath, output);
  }

  async writeStageMeta(paths: StageLogPaths, value: unknown): Promise<void> {
    await writeJson(paths.metaPath, value);
  }
}

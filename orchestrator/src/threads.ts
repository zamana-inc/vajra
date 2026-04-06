import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { ThreadNativeSession } from "./types";

export class ThreadStore {
  constructor(
    private readonly workspacePath: string,
    private readonly workspaceArtifactsDir: string,
  ) {}

  private threadsRoot(): string {
    return path.join(this.workspacePath, this.workspaceArtifactsDir, "threads");
  }

  threadDirPath(threadId: string): string {
    return path.join(this.threadsRoot(), threadId);
  }

  sessionPath(threadId: string): string {
    return path.join(this.threadDirPath(threadId), "session.json");
  }

  async loadSession(threadId: string): Promise<ThreadNativeSession | null> {
    try {
      const raw = await readFile(this.sessionPath(threadId), "utf8");
      const parsed = JSON.parse(raw) as Partial<ThreadNativeSession>;
      const sessionId = String(parsed.sessionId ?? "").trim();
      const backend = String(parsed.backend ?? "").trim();
      const model = String(parsed.model ?? "").trim();
      const createdAt = String(parsed.createdAt ?? "").trim();
      if (!sessionId || !backend || !model || !createdAt) {
        return null;
      }

      return {
        sessionId,
        backend,
        model,
        createdAt,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async saveSession(threadId: string, session: ThreadNativeSession): Promise<void> {
    const threadDir = this.threadDirPath(threadId);
    await mkdir(threadDir, { recursive: true });
    await writeFile(this.sessionPath(threadId), JSON.stringify(session, null, 2), "utf8");
  }

  async clearSession(threadId: string): Promise<void> {
    await rm(this.sessionPath(threadId), { force: true });
  }
}

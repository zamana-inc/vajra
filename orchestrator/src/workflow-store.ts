import chokidar, { FSWatcher } from "chokidar";

import { WorkflowDefinition } from "./types";
import { loadWorkflowFile } from "./workflow";

export class WorkflowFileStore {
  private currentDefinition: WorkflowDefinition | null = null;
  private watcher: FSWatcher | null = null;
  private lastReloadError: string | null = null;

  constructor(private readonly workflowPath: string) {}

  async load(): Promise<WorkflowDefinition> {
    const loaded = await loadWorkflowFile(this.workflowPath);
    this.currentDefinition = loaded;
    this.lastReloadError = null;
    return loaded;
  }

  current(): WorkflowDefinition {
    if (!this.currentDefinition) {
      throw new Error("workflow has not been loaded yet");
    }
    return this.currentDefinition;
  }

  async watch(onReload?: (definition: WorkflowDefinition) => void): Promise<void> {
    if (!this.currentDefinition) {
      await this.load();
    }

    this.watcher = chokidar.watch(this.workflowPath, { ignoreInitial: true });
    this.watcher.on("change", async () => {
      try {
        const loaded = await loadWorkflowFile(this.workflowPath);
        this.currentDefinition = loaded;
        this.lastReloadError = null;
        onReload?.(loaded);
      } catch (error) {
        this.lastReloadError = error instanceof Error ? error.message : String(error);
        console.error(JSON.stringify({
          message: "workflow reload failed",
          workflowPath: this.workflowPath,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    });
  }

  reloadStatus(): { lastReloadError: string | null } {
    return {
      lastReloadError: this.lastReloadError,
    };
  }

  async close(): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;
  }
}

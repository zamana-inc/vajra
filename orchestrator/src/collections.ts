import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeStageMetadataObject, stageMetadataFromResult, stageOutcomeFromResult } from "./outcomes";
import { Collection, GraphNode, StageMetadata, StageOutcome } from "./types";
import { workspaceReference } from "./workspace-reference";

export class CollectionStore {
  constructor(
    private readonly workspacePath: string,
    private readonly workspaceArtifactsDir: string,
  ) {}

  rootPath(): string {
    return path.join(this.workspacePath, this.workspaceArtifactsDir, "collections");
  }

  indexPath(): string {
    return path.join(this.workspacePath, this.workspaceArtifactsDir, "collections.json");
  }

  collectionDirPath(collectionId: string): string {
    return path.join(this.rootPath(), collectionId);
  }

  manifestPath(collectionId: string): string {
    return path.join(this.collectionDirPath(collectionId), "manifest.json");
  }

  async listCollectionIds(): Promise<string[]> {
    try {
      const payload = await readFile(this.indexPath(), "utf8");
      const collectionIds = JSON.parse(payload) as string[];
      return [...new Set(collectionIds.map((entry) => String(entry).trim()).filter(Boolean))].sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    try {
      const entries = await readdir(this.rootPath(), { withFileTypes: true });
      return entries
        .filter((entry: { isDirectory(): boolean }) => entry.isDirectory())
        .map((entry: { name: string }) => entry.name)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  candidateDirPath(collectionId: string, candidateId: string): string {
    return path.join(this.collectionDirPath(collectionId), candidateId);
  }

  candidateResultPath(collectionId: string, candidateId: string): string {
    return path.join(this.candidateDirPath(collectionId, candidateId), "result.json");
  }

  candidateOutputPath(collectionId: string, candidateId: string): string {
    return path.join(this.candidateDirPath(collectionId, candidateId), "output.txt");
  }

  candidatePrimaryArtifactPath(stage: GraphNode, collectionId: string, candidateId: string): string {
    const configuredPath = String(stage.attrs.artifact_path ?? "").trim();
    const extension = configuredPath ? path.extname(configuredPath) || ".md" : ".md";
    return path.join(this.candidateDirPath(collectionId, candidateId), `primary${extension}`);
  }

  async saveCollection(collection: Collection): Promise<void> {
    await mkdir(path.dirname(this.manifestPath(collection.id)), { recursive: true });
    await writeFile(this.manifestPath(collection.id), JSON.stringify(collection, null, 2), "utf8");
    await this.saveIndex(collection.id);
  }

  async loadCollection(collectionId: string): Promise<Collection | null> {
    try {
      const payload = await readFile(this.manifestPath(collectionId), "utf8");
      return JSON.parse(payload) as Collection;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async loadCandidateResult(opts: {
    collectionId: string;
    candidateId: string;
    exitCode: number;
  }): Promise<{ metadata: StageMetadata; outcome: StageOutcome }> {
    try {
      const payload = await readFile(this.candidateResultPath(opts.collectionId, opts.candidateId), "utf8");
      const result = normalizeStageMetadataObject(JSON.parse(payload) as unknown);
      return {
        metadata: stageMetadataFromResult(result),
        outcome: stageOutcomeFromResult({
          result,
          exitCode: opts.exitCode,
          workspacePath: this.workspacePath,
        }),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          metadata: {},
          outcome: {
            status: opts.exitCode === 0 ? "success" : "failure",
            label: null,
            facts: {},
            notes: null,
            artifacts: {},
          },
        };
      }
      throw error;
    }
  }

  async artifactExists(filePath: string): Promise<boolean> {
    try {
      const fileStat = await stat(filePath);
      return fileStat.isFile() && fileStat.size > 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  workspaceRef(filePath: string): string {
    return workspaceReference(this.workspacePath, filePath);
  }

  private async saveIndex(collectionId: string): Promise<void> {
    let collections: string[] = [];
    try {
      const payload = await readFile(this.indexPath(), "utf8");
      collections = JSON.parse(payload) as string[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    const nextCollections = [...new Set([...collections, collectionId])].sort();
    await mkdir(path.dirname(this.indexPath()), { recursive: true });
    await writeFile(this.indexPath(), JSON.stringify(nextCollections, null, 2), "utf8");
  }
}

export function collectionScope(collection: Collection): Record<string, unknown> {
  return {
    id: collection.id,
    stageId: collection.stageId,
    selectedCandidateId: collection.selectedCandidateId ?? "",
    synthesizedArtifact: collection.synthesizedArtifact ?? "",
    candidates: collection.candidates.map((candidate) => ({
      id: candidate.id,
      status: candidate.status,
      artifacts: { ...candidate.artifacts },
      facts: { ...candidate.facts },
      variantConfig: { ...candidate.variantConfig },
    })),
  };
}

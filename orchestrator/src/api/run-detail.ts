import { readFile } from "node:fs/promises";
import path from "node:path";

import { CollectionStore } from "../collections";
import { parseDotGraph } from "../dot-parser";
import { countCompletedNodeVisits } from "../pipeline-graph";
import { PipelineRunStore } from "../pipeline-run-store";
import { orderedDisplayStageNodes } from "../stage-order";
import { PipelineCheckpoint, MutableWorkflowStore, PipelineRunMetadata } from "../types";
import { apiPipelineShapeFromGraph } from "./pipeline-shape";
import { stageMetaObject } from "./stage-meta";
import { ApiRunDetail, ApiRunStageDetail, ApiRunSummary } from "./types";

type StageLogMeta = {
  agentName?: string | null;
  backend?: string | null;
  command?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  durationMs?: number | null;
  exitCode?: number | null;
  type?: string | null;
  visit?: number | null;
  status?: string | null;
  artifacts?: Record<string, string>;
  resultMetadata?: Record<string, unknown>;
};

function safeJsonParse<T>(content: string, fallback: T): T {
  try {
    return JSON.parse(content) as T;
  } catch {
    return fallback;
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

async function readOptionalJson<T>(filePath: string, fallback: T): Promise<T> {
  const content = await readOptionalText(filePath);
  if (!content) {
    return fallback;
  }
  return safeJsonParse(content, fallback);
}

function fallbackSummary(opts: {
  issueIdentifier: string;
  attempt: number;
  checkpoint: PipelineCheckpoint | null;
  runMetadata: PipelineRunMetadata | null;
}): ApiRunSummary | null {
  const startedAt = opts.runMetadata?.startedAt ?? opts.checkpoint?.startedAt;
  if (!startedAt) {
    return null;
  }

  const finishedAt = opts.runMetadata?.finishedAt ?? opts.checkpoint?.finishedAt ?? null;
  const status = opts.runMetadata?.status ?? opts.checkpoint?.status ?? "running";
  const currentStageId = opts.checkpoint?.nextNodeId ?? null;
  const lastEventAt = finishedAt ?? startedAt;
  const durationMs = Math.max(
    0,
    Date.parse(lastEventAt) - Date.parse(startedAt),
  );

  return {
    id: `${opts.issueIdentifier}:${opts.attempt}`,
    issueId: opts.runMetadata?.issueId ?? opts.checkpoint?.issueId ?? "",
    issueIdentifier: opts.issueIdentifier,
    issueTitle: opts.runMetadata?.issueTitle ?? opts.issueIdentifier,
    issueUrl: opts.runMetadata?.issueUrl ?? null,
    attempt: opts.attempt,
    workflowName: opts.runMetadata?.workflowName ?? "default",
    status,
    startedAt,
    finishedAt,
    lastEventAt,
    durationMs,
    prUrl: opts.runMetadata?.prUrl ?? null,
    error: opts.runMetadata?.error ?? opts.checkpoint?.error ?? null,
    dispatchPlan: opts.runMetadata?.dispatchPlan ?? null,
    currentStageId,
    currentStageLabel: currentStageId,
    stages: [],
  };
}

function stageDirectoryName(stageId: string, visitCount: number): string {
  return visitCount <= 1 ? stageId : `${stageId}_${visitCount}`;
}

function stageStatusFromSummary(opts: {
  stageId: string;
  metaStatus?: string | null;
  checkpoint: PipelineCheckpoint | null;
  runMetadata: PipelineRunMetadata | null;
}): ApiRunDetail["stages"][number]["status"] {
  if (
    opts.metaStatus === "pending"
    || opts.metaStatus === "running"
    || opts.metaStatus === "success"
    || opts.metaStatus === "failure"
    || opts.metaStatus === "cancelled"
    || opts.metaStatus === "wait_human"
  ) {
    return opts.metaStatus;
  }

  const runStatus = opts.checkpoint?.status ?? opts.runMetadata?.status ?? null;
  if (opts.checkpoint?.nextNodeId === opts.stageId && runStatus === "running") {
    return "running";
  }

  return "pending";
}

function resolveWorkspaceArtifactsDir(opts: {
  workspacePath: string | null;
  runMetadata: PipelineRunMetadata | null;
  workflowStore: MutableWorkflowStore;
}): string {
  if (opts.workspacePath && opts.runMetadata?.artifactsPath) {
    const relative = path.relative(opts.workspacePath, opts.runMetadata.artifactsPath);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return relative.split(path.sep).join("/");
    }
  }

  return opts.workflowStore.current().config.artifacts.workspaceDir;
}

export async function getRunDetail(opts: {
  logsRoot: string;
  workflowStore: MutableWorkflowStore;
  issueIdentifier: string;
  attempt: number;
}): Promise<ApiRunDetail | null> {
  const runStore = new PipelineRunStore(opts.logsRoot, opts.issueIdentifier, opts.attempt);
  const [runMetadata, checkpoint] = await Promise.all([
    runStore.loadRunMetadata(),
    runStore.loadCheckpoint(),
  ]);

  const persistedSummary = fallbackSummary({
    issueIdentifier: opts.issueIdentifier,
    attempt: opts.attempt,
    checkpoint,
    runMetadata,
  });
  let summary = persistedSummary;
  if (!summary) {
    return null;
  }

  const dotFile = runMetadata?.dotFile
    ?? opts.workflowStore.current().config.workflows[summary.workflowName]?.dotFile
    ?? null;
  const graphSource = dotFile ? await readOptionalText(dotFile) : null;
  const parsedGraph = graphSource
    ? (() => {
        try {
          return parseDotGraph(graphSource);
        } catch {
          return null;
        }
      })()
    : null;
  const graphShape = parsedGraph
    ? apiPipelineShapeFromGraph(parsedGraph)
    : null;
  const orderedNodes = parsedGraph
    ? (() => {
        try {
          return orderedDisplayStageNodes(parsedGraph);
        } catch {
          return [...parsedGraph.nodes.values()].filter((node) => node.type !== "start" && node.type !== "exit");
        }
      })()
    : [];
  const visitCounts = checkpoint
    ? countCompletedNodeVisits(checkpoint.completedNodes)
    : new Map<string, number>();
  const stageIds = orderedNodes.length > 0
    ? orderedNodes.map((node) => node.id)
    : checkpoint
      ? [...visitCounts.keys()]
      : [];

  const stageDetails = await Promise.all(stageIds.map(async (stageId): Promise<ApiRunStageDetail> => {
    const graphNode = orderedNodes.find((node) => node.id === stageId);
    const visitCount = visitCounts.get(stageId) ?? 0;
    const stageDir = path.join(runStore.runDirPath(), stageDirectoryName(stageId, visitCount || 1));
    const [prompt, output, meta] = await Promise.all([
      readOptionalText(path.join(stageDir, "prompt.txt")),
      readOptionalText(path.join(stageDir, "output.txt")),
      readOptionalJson<StageLogMeta>(path.join(stageDir, "meta.json"), {}),
    ]);

    const artifacts = Object.entries(meta.artifacts ?? {})
      .filter(([, artifactPath]) => Boolean(artifactPath))
      .map(([name, artifactPath]) => ({
        name,
        path: artifactPath,
      }));

    const metaEntries = stageMetaObject({
      command: meta.command ?? null,
      visit: meta.visit ?? visitCount ?? null,
      type: meta.type ?? graphNode?.type ?? null,
      status: meta.status ?? null,
      reasoningEffort: meta.reasoningEffort ?? null,
      result: meta.resultMetadata ?? {},
    });
    const status = stageStatusFromSummary({
      stageId,
      metaStatus: meta.status ?? null,
      checkpoint,
      runMetadata,
    });

    // Load previous visits for looped stages (visit 1 through visitCount-1)
    const previousVisits: ApiRunStageDetail["previousVisits"] = [];
    if (visitCount > 1) {
      for (let visit = 1; visit < visitCount; visit += 1) {
        const prevDir = path.join(runStore.runDirPath(), stageDirectoryName(stageId, visit));
        const [prevPrompt, prevOutput, prevMeta] = await Promise.all([
          readOptionalText(path.join(prevDir, "prompt.txt")),
          readOptionalText(path.join(prevDir, "output.txt")),
          readOptionalJson<StageLogMeta>(path.join(prevDir, "meta.json"), {}),
        ]);
        if (!prevPrompt && !prevOutput && Object.keys(prevMeta).length === 0) {
          continue;
        }
        const prevArtifacts = Object.entries(prevMeta.artifacts ?? {})
          .filter(([, p]) => Boolean(p))
          .map(([name, p]) => ({ name, path: p }));
        previousVisits.push({
          visit,
          status: prevMeta.status ?? null,
          durationMs: prevMeta.durationMs ?? null,
          exitCode: typeof prevMeta.exitCode === "number" ? prevMeta.exitCode : null,
          prompt: prevPrompt,
          output: prevOutput,
          artifacts: prevArtifacts,
          meta: stageMetaObject({
            command: prevMeta.command ?? null,
            visit,
            type: prevMeta.type ?? graphNode?.type ?? null,
            status: prevMeta.status ?? null,
            reasoningEffort: prevMeta.reasoningEffort ?? null,
            result: prevMeta.resultMetadata ?? {},
          }),
        });
      }
    }

    return {
      id: stageId,
      label: graphNode?.attrs.label ?? stageId,
      agentName: meta.agentName ?? graphNode?.attrs.agent ?? null,
      status,
      durationMs: meta.durationMs ?? null,
      exitCode: typeof meta.exitCode === "number" ? meta.exitCode : null,
      model: typeof meta.model === "string" ? meta.model : null,
      reasoningEffort: typeof meta.reasoningEffort === "string" ? meta.reasoningEffort : null,
      backend: typeof meta.backend === "string" ? meta.backend : null,
      prompt,
      output,
      artifacts,
      meta: metaEntries,
      previousVisits,
    };
  }));

  const workspacePath = runMetadata?.workspacePath ?? checkpoint?.workspacePath ?? null;
  const workspaceArtifactsDir = resolveWorkspaceArtifactsDir({
    workspacePath,
    runMetadata,
    workflowStore: opts.workflowStore,
  });
  const collections = workspacePath
    ? await (async () => {
        const collectionStore = new CollectionStore(workspacePath, workspaceArtifactsDir);
        const ids = await collectionStore.listCollectionIds();
        const manifests = await Promise.all(ids.map(async (collectionId) => collectionStore.loadCollection(collectionId)));
        return manifests
          .filter((collection): collection is NonNullable<typeof collection> => !!collection)
          .map((collection) => ({
            id: collection.id,
            stageId: collection.stageId,
            selectedCandidateId: collection.selectedCandidateId ?? null,
            synthesizedArtifact: collection.synthesizedArtifact ?? null,
            candidates: collection.candidates.map((candidate) => ({
              id: candidate.id,
              status: candidate.status,
              artifacts: { ...candidate.artifacts },
              facts: { ...candidate.facts },
              variantConfig: { ...candidate.variantConfig },
            })),
          }));
      })()
    : [];

  const stages = stageDetails.map((stage) => ({
    id: stage.id,
    label: stage.label,
    agentName: stage.agentName,
    status: stage.status,
    durationMs: stage.durationMs,
    visitCount: visitCounts.get(stage.id) ?? 0,
  }));
  const resolvedSummary = summary;
  const currentStage = resolvedSummary.currentStageId
    ? stages.find((stage) => stage.id === resolvedSummary.currentStageId) ?? null
    : null;
  summary = {
    ...resolvedSummary,
    currentStageLabel: currentStage?.label ?? resolvedSummary.currentStageLabel,
    stages,
  };

  return {
    ...summary,
    graphId: parsedGraph?.id ?? null,
    dotFile,
    graph: graphShape
      ? {
          nodes: graphShape.nodes,
          edges: graphShape.edges,
        }
      : null,
    checkpointStatus: checkpoint?.status ?? runMetadata?.status ?? null,
    checkpointError: checkpoint?.error ?? runMetadata?.error ?? null,
    nextNodeId: checkpoint?.nextNodeId ?? null,
    collections,
    stageDetails,
  };
}

export async function getRunStageDetail(opts: {
  logsRoot: string;
  workflowStore: MutableWorkflowStore;
  issueIdentifier: string;
  attempt: number;
  stageId: string;
}): Promise<ApiRunStageDetail | null> {
  const detail = await getRunDetail(opts);
  if (!detail) {
    return null;
  }

  return detail.stageDetails.find((stage) => stage.id === opts.stageId) ?? null;
}

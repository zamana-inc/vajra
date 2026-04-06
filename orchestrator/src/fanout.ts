import { mkdir, writeFile } from "node:fs/promises";

import { IssueArtifactStore } from "./artifacts";
import { CollectionStore, collectionScope } from "./collections";
import { VajraEventBus } from "./events";
import { PipelineGraphNavigator } from "./pipeline-graph";
import { PipelineRunStore } from "./pipeline-run-store";
import { buildStageContextEntry, graphStageScope } from "./pipeline-scope";
import { PipelineStageExecutor } from "./stage-executor";
import { renderPromptTemplate } from "./template";
import {
  AgentBackend,
  DispatchPlan,
  GraphEdge,
  GraphNode,
  Issue,
  PipelineCheckpoint,
  WorkflowDefinition,
} from "./types";
import {
  FinishStageIterationOptions,
  PipelineRunMetadataBase,
  ResolvedStageAgent,
  StageIterationResult,
  StageLoopState,
} from "./pipeline-runtime-types";

type RunWithConcurrency = <T>(tasks: Array<() => Promise<T>>, limit: number) => Promise<T[]>;

export async function runFanOutStage(opts: {
  eventBus?: VajraEventBus;
  stageExecutor: PipelineStageExecutor;
  graphNavigator: PipelineGraphNavigator;
  resolveNamedAgent: (
    agentName: string,
    workflow: WorkflowDefinition,
    overrides?: { model?: string; reasoningEffort?: string },
  ) => ResolvedStageAgent;
  runWithConcurrency: RunWithConcurrency;
  finishStageIteration: (opts: FinishStageIterationOptions) => Promise<StageIterationResult>;
  stage: GraphNode;
  issue: Issue;
  attempt: number;
  workflow: WorkflowDefinition;
  workspacePath: string;
  signal: AbortSignal;
  graphId: string;
  dotFile: string;
  dispatchPlan: DispatchPlan | null;
  stageNodes: GraphNode[];
  outgoingEdges: GraphEdge[];
  backends: Map<string, AgentBackend>;
  artifactStore: IssueArtifactStore;
  runStore: PipelineRunStore;
  runMetadataBase: PipelineRunMetadataBase;
  visitCount: number;
  state: StageLoopState;
}): Promise<StageIterationResult> {
  const stageLogs = await opts.runStore.stageLogPaths(opts.stage.id, opts.visitCount);
  opts.eventBus?.emit({
    type: "pipeline:stage:start",
    timestamp: new Date().toISOString(),
    issueId: opts.issue.id,
    issueIdentifier: opts.issue.identifier,
    stageId: opts.stage.id,
    stageLabel: opts.stage.attrs.label ?? opts.stage.id,
    stageType: "fan_out",
    visit: opts.visitCount,
    backend: null,
  });

  const collectionId = String(opts.stage.attrs.collection ?? "").trim();
  const definition = opts.workflow.config.fanOut[collectionId];
  if (!collectionId || !definition) {
    return opts.finishStageIteration({
      artifactStore: opts.artifactStore,
      context: opts.state.context,
      runStore: opts.runStore,
      runMetadataBase: opts.runMetadataBase,
      status: "failure",
      issue: opts.issue,
      attempt: opts.attempt,
      graphId: opts.graphId,
      workspacePath: opts.workspacePath,
      completedNodes: opts.state.completedNodes,
      nextNodeId: opts.stage.id,
      error: `fan_out stage ${opts.stage.id} references unknown collection ${collectionId || "(missing)"}`,
      failedStageId: opts.stage.id,
    });
  }

  if (definition.stage !== opts.stage.id) {
    return opts.finishStageIteration({
      artifactStore: opts.artifactStore,
      context: opts.state.context,
      runStore: opts.runStore,
      runMetadataBase: opts.runMetadataBase,
      status: "failure",
      issue: opts.issue,
      attempt: opts.attempt,
      graphId: opts.graphId,
      workspacePath: opts.workspacePath,
      completedNodes: opts.state.completedNodes,
      nextNodeId: opts.stage.id,
      error: `fan_out collection ${collectionId} is configured for stage ${definition.stage}, not ${opts.stage.id}`,
      failedStageId: opts.stage.id,
    });
  }

  if (opts.state.agentInvocations + definition.variants.length > opts.workflow.config.execution.maxAgentInvocationsPerRun) {
    return opts.finishStageIteration({
      artifactStore: opts.artifactStore,
      context: opts.state.context,
      runStore: opts.runStore,
      runMetadataBase: opts.runMetadataBase,
      status: "failure",
      issue: opts.issue,
      attempt: opts.attempt,
      graphId: opts.graphId,
      workspacePath: opts.workspacePath,
      completedNodes: opts.state.completedNodes,
      nextNodeId: opts.stage.id,
      error: `fan_out stage ${opts.stage.id} would exceed max_agent_invocations_per_run ${opts.workflow.config.execution.maxAgentInvocationsPerRun}`,
      failedStageId: opts.stage.id,
    });
  }

  const collectionStore = new CollectionStore(opts.workspacePath, opts.state.context.workspaceArtifactsDir);
  const baseScope = graphStageScope({
    issue: opts.issue,
    attempt: opts.attempt,
    node: opts.stage,
    allStages: opts.stageNodes,
    context: opts.state.context,
    workspacePath: opts.workspacePath,
    dotFile: opts.dotFile,
    completedNodes: opts.state.completedNodes,
    dispatchPlan: opts.dispatchPlan,
  });
  const promptAudit = new Array<string>(definition.variants.length);
  const concurrencyLimit = Math.min(
    opts.workflow.config.execution.maxConcurrentAgents,
    Math.max(1, definition.maxParallel),
  );

  const candidateResults = await opts.runWithConcurrency(definition.variants.map((variant, index) => async () => {
    const candidateDir = collectionStore.candidateDirPath(collectionId, variant.id);
    const primaryArtifactPath = collectionStore.candidatePrimaryArtifactPath(opts.stage, collectionId, variant.id);
    const resolvedAgent = opts.resolveNamedAgent(
      variant.agent ?? String(opts.stage.attrs.agent ?? ""),
      opts.workflow,
      {
        ...(variant.model ? { model: variant.model } : {}),
        ...(variant.reasoningEffort ? { reasoningEffort: variant.reasoningEffort } : {}),
      },
    );
    const candidateScope = {
      ...baseScope,
      collection: {
        id: collectionId,
        candidate_id: variant.id,
        candidate_dir: collectionStore.workspaceRef(candidateDir),
        primary_artifact: collectionStore.workspaceRef(primaryArtifactPath),
      },
    };
    const prompt = [
      await renderPromptTemplate(resolvedAgent.promptTemplate, candidateScope),
      variant.instructions ? `Variant instructions: ${variant.instructions}` : "",
      [
        `Fan-out candidate: ${variant.id}`,
        `Write the primary artifact to: ${collectionStore.workspaceRef(primaryArtifactPath)}`,
        `If you emit structured result metadata, write it to: ${collectionStore.workspaceRef(collectionStore.candidateResultPath(collectionId, variant.id))}`,
      ].join("\n"),
    ].filter(Boolean).join("\n\n");
    promptAudit[index] = `## ${variant.id}\n\n${prompt}`;

    await mkdir(candidateDir, { recursive: true });
    const executionResult = await opts.stageExecutor.executeStage({
      stage: {
        id: `${opts.stage.id}__${variant.id}`,
        type: "agent",
        attrs: {
          label: `${opts.stage.attrs.label ?? opts.stage.id}:${variant.id}`,
          artifact_path: collectionStore.workspaceRef(primaryArtifactPath),
        },
      },
      prompt,
      workspacePath: opts.workspacePath,
      workspaceArtifactsDir: opts.state.context.workspaceArtifactsDir,
      signal: opts.signal,
      backends: opts.backends,
      scope: candidateScope,
      resolvedAgent,
      githubConfig: opts.workflow.config.github,
    });

    await writeFile(collectionStore.candidateOutputPath(collectionId, variant.id), executionResult.output, "utf8");
    const { outcome } = await collectionStore.loadCandidateResult({
      collectionId,
      candidateId: variant.id,
      exitCode: executionResult.exitCode,
    });
    const primaryExists = await collectionStore.artifactExists(primaryArtifactPath);
    const artifacts = {
      output: collectionStore.workspaceRef(collectionStore.candidateOutputPath(collectionId, variant.id)),
      ...(primaryExists ? { primary: collectionStore.workspaceRef(primaryArtifactPath) } : {}),
      ...outcome.artifacts,
    };
    const facts = Object.fromEntries(
      Object.entries(outcome.facts).filter(([, value]) => (
        value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      )),
    ) as Record<string, string | number | boolean | null>;

    return {
      id: variant.id,
      variantConfig: variant,
      status: executionResult.exitCode === 0 && primaryExists && outcome.status === "success" ? "success" as const : "failure" as const,
      artifacts,
      facts,
    };
  }), concurrencyLimit);

  await opts.runStore.writeStagePrompt(stageLogs, promptAudit.filter(Boolean).join("\n\n---\n\n"));

  const collection = {
    id: collectionId,
    stageId: opts.stage.id,
    candidates: candidateResults,
  };
  await collectionStore.saveCollection(collection);

  const successCount = candidateResults.filter((candidate) => candidate.status === "success").length;
  const stageStatus = successCount > 0 ? "success" : "failure";
  const outputSummary = candidateResults
    .map((candidate) => `${candidate.id}: ${candidate.status}`)
    .join("\n");
  await opts.runStore.writeStageOutput(stageLogs, outputSummary);
  const outputArtifact = await opts.stageExecutor.persistStageOutputArtifact(
    opts.stage.id,
    outputSummary,
    opts.workspacePath,
    opts.state.context.workspaceArtifactsDir,
  );
  const artifacts = {
    output: outputArtifact,
    manifest: collectionStore.workspaceRef(collectionStore.manifestPath(collectionId)),
  };
  await opts.runStore.writeStageMeta(stageLogs, {
    agentName: null,
    backend: null,
    command: null,
    model: null,
    reasoningEffort: null,
    durationMs: null,
    exitCode: successCount > 0 ? 0 : 1,
    label: opts.stage.attrs.label ?? opts.stage.id,
    status: stageStatus,
    type: "fan_out",
    visit: opts.visitCount,
    artifacts,
    resultMetadata: {
      collection_id: collectionId,
      candidate_count: candidateResults.length,
      success_count: successCount,
      failed_count: candidateResults.length - successCount,
    },
  });
  opts.eventBus?.emit({
    type: "pipeline:stage:complete",
    timestamp: new Date().toISOString(),
    issueId: opts.issue.id,
    issueIdentifier: opts.issue.identifier,
    stageId: opts.stage.id,
    exitCode: successCount > 0 ? 0 : 1,
    durationMs: null,
    visit: opts.visitCount,
    status: stageStatus,
  });

  opts.state.context.stages[opts.stage.id] = buildStageContextEntry({
    node: opts.stage,
    status: stageStatus,
    artifacts,
    metadata: {
      collection_id: collectionId,
      candidate_count: candidateResults.length,
      success_count: successCount,
      failed_count: candidateResults.length - successCount,
    },
    backend: null,
    command: null,
    promptPath: stageLogs.promptPath,
    outputPath: stageLogs.outputPath,
    exitCode: successCount > 0 ? 0 : 1,
    durationMs: null,
  });

  const completedNodes = [...opts.state.completedNodes, opts.stage.id];
  const context = {
    ...opts.state.context,
    attempt: opts.attempt,
    completedNodes,
  };

  if (successCount === 0) {
    return opts.finishStageIteration({
      artifactStore: opts.artifactStore,
      context,
      runStore: opts.runStore,
      runMetadataBase: opts.runMetadataBase,
      status: "failure",
      issue: opts.issue,
      attempt: opts.attempt,
      graphId: opts.graphId,
      workspacePath: opts.workspacePath,
      completedNodes,
      nextNodeId: opts.stage.id,
      error: `fan_out stage ${opts.stage.id} produced no successful candidates`,
      failedStageId: opts.stage.id,
    });
  }

  const nextNodeId = await opts.graphNavigator.selectNextNode({
    issue: opts.issue,
    fromNode: opts.stage,
    outgoingEdges: opts.outgoingEdges,
    scope: {
      ...graphStageScope({
        issue: opts.issue,
        attempt: opts.attempt,
        node: opts.stage,
        allStages: opts.stageNodes,
        context,
        workspacePath: opts.workspacePath,
        dotFile: opts.dotFile,
        completedNodes,
        dispatchPlan: opts.dispatchPlan,
      }),
      collection: collectionScope(collection),
    },
    label: null,
  });

  await opts.artifactStore.saveContext(context);
  await opts.runStore.writeCheckpoint({
    issueId: opts.issue.id,
    issueIdentifier: opts.issue.identifier,
    attempt: opts.attempt,
    workspacePath: opts.workspacePath,
    graphId: opts.graphId,
    startedAt: opts.runMetadataBase.startedAt,
    finishedAt: null,
    completedNodes,
    nextNodeId,
    status: "running",
    error: null,
  } satisfies PipelineCheckpoint);

  return {
    kind: "continue",
    nextNodeId,
    state: {
      context,
      completedNodes,
      agentInvocations: opts.state.agentInvocations + definition.variants.length,
    },
  };
}

import { readFile } from "node:fs/promises";

import { IssueArtifactStore } from "./artifacts";
import { buildBackends } from "./backends";
import { CollectionStore, collectionScope } from "./collections";
import { parseDotGraph } from "./dot-parser";
import { VajraEventBus } from "./events";
import { runFanOutStage } from "./fanout";
import {
  buildTraversalGraph,
  countCompletedNodeVisits,
  parseMaxVisits,
  PipelineGraphNavigator,
} from "./pipeline-graph";
import { PipelineRunStore } from "./pipeline-run-store";
import {
  FinishStageIterationOptions,
  PipelineRunMetadataBase,
  ResolvedStageAgent,
  StageIterationResult,
  StageLoopState,
} from "./pipeline-runtime-types";
import { buildStageContextEntry, graphStageScope } from "./pipeline-scope";
import { CommandRunner, ShellCommandRunner } from "./process";
import {
  PipelineStageExecutor,
  stageExecutionType,
} from "./stage-executor";
import { classifyStageError } from "./error-classifier";
import { ThreadStore } from "./threads";
import {
  AgentBackend,
  Collection,
  DispatchPlan,
  GraphEdge,
  GraphNode,
  Issue,
  IssueContext,
  PipelineCheckpoint,
  PipelineRunHandle,
  PipelineRunMetadata,
  PipelineRunResult,
  PipelineRunner as PipelineRunnerInterface,
  PullRequestMetadata,
  ThreadNativeSession,
  WorkflowDefinition,
} from "./types";
import { renderPromptTemplate } from "./template";
import { resolveIssueWorkflow } from "./workflow-routing";

type FinishRunOptions = {
  runStore: PipelineRunStore;
  runMetadataBase: PipelineRunMetadataBase;
  status: PipelineRunResult["status"];
  issue: Issue;
  attempt: number;
  graphId: string;
  workspacePath: string;
  completedNodes: string[];
  nextNodeId: string | null;
  error: string | null;
  failureClass?: "auth" | "rate-limit";
  context?: IssueContext;
  failedStageId?: string;
  pr?: PullRequestMetadata | null;
  inspectPrOnSuccess?: boolean;
  finishedAt?: string;
};

type StageLogPaths = Awaited<ReturnType<PipelineRunStore["stageLogPaths"]>>;

type ThreadExecutionState = {
  threadId: string | null;
  session: ThreadNativeSession | null;
  createNativeSession: boolean;
};

function countsAgainstAgentBudget(stage: GraphNode): boolean {
  return stage.type !== "fan_out" && stageExecutionType(stage) !== "tool";
}

function stageRuntimeType(stage: GraphNode): "agent" | "tool" | "fan_out" | "fan_in" {
  if (stage.type === "fan_out" || stage.type === "fan_in") {
    return stage.type;
  }
  return stageExecutionType(stage);
}

export class LocalPipelineRunner implements PipelineRunnerInterface {
  private readonly graphNavigator: PipelineGraphNavigator;
  private readonly stageExecutor: PipelineStageExecutor;

  constructor(
    private readonly logsRoot: string,
    private readonly backendFactory: (workflow: WorkflowDefinition) => Map<string, AgentBackend> = (workflow) =>
      buildBackends(workflow.config.backends),
    toolRunner: CommandRunner = new ShellCommandRunner(),
    private readonly eventBus?: VajraEventBus,
  ) {
    this.graphNavigator = new PipelineGraphNavigator(eventBus);
    this.stageExecutor = new PipelineStageExecutor(toolRunner);
  }

  startRun(opts: {
    issue: Issue;
    attempt: number;
    workflow: WorkflowDefinition;
    workspacePath: string;
    dispatchPlan?: DispatchPlan;
  }): PipelineRunHandle {
    const controller = new AbortController();
    const promise = this.run({ ...opts, signal: controller.signal });

    return {
      promise,
      cancel: async () => {
        controller.abort();
        try {
          await promise;
        } catch {
          // Cancellation is reported through the final run result.
        }
      },
    };
  }

  private resolveStageAgent(stage: GraphNode, workflow: WorkflowDefinition): ResolvedStageAgent | null {
    if (stageExecutionType(stage) === "tool") {
      return null;
    }

    const agentName = String(stage.attrs.agent ?? "").trim().toLowerCase();
    if (!agentName) {
      throw new Error(`stage ${stage.id} does not define an agent`);
    }

    const agent = workflow.config.agents[agentName];
    if (!agent) {
      throw new Error(`stage ${stage.id} references unknown agent ${agentName}`);
    }

    return {
      agentName,
      backendName: agent.backend,
      model: agent.model,
      reasoningEffort: agent.reasoningEffort,
      promptTemplate: agent.prompt,
      timeoutMs: agent.timeoutMs,
    };
  }

  private resolveNamedAgent(
    agentName: string,
    workflow: WorkflowDefinition,
    overrides?: {
      model?: string;
      reasoningEffort?: string;
    },
  ): ResolvedStageAgent {
    const normalizedAgentName = String(agentName ?? "").trim().toLowerCase();
    if (!normalizedAgentName) {
      throw new Error("fan_out variant is missing an agent");
    }

    const agent = workflow.config.agents[normalizedAgentName];
    if (!agent) {
      throw new Error(`fan_out variant references unknown agent ${normalizedAgentName}`);
    }

    return {
      agentName: normalizedAgentName,
      backendName: agent.backend,
      model: overrides?.model ?? agent.model,
      reasoningEffort: overrides?.reasoningEffort ?? agent.reasoningEffort,
      promptTemplate: agent.prompt,
      timeoutMs: agent.timeoutMs,
    };
  }

  private async runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
    const results = new Array<T>(tasks.length);
    let nextIndex = 0;

    const workers = Array.from({ length: Math.max(1, limit) }, async () => {
      while (nextIndex < tasks.length) {
        const taskIndex = nextIndex;
        nextIndex += 1;
        results[taskIndex] = await tasks[taskIndex]();
      }
    });

    await Promise.all(workers);
    return results;
  }

  private buildStageScope(opts: {
    issue: Issue;
    attempt: number;
    stage: GraphNode;
    stageNodes: GraphNode[];
    context: IssueContext;
    workspacePath: string;
    dotFile: string;
    completedNodes: string[];
    dispatchPlan: DispatchPlan | null;
    prompt?: string;
    collection?: Collection | null;
  }): Record<string, unknown> {
    return {
      ...graphStageScope({
        issue: opts.issue,
        attempt: opts.attempt,
        node: opts.stage,
        allStages: opts.stageNodes,
        context: opts.context,
        workspacePath: opts.workspacePath,
        dotFile: opts.dotFile,
        completedNodes: opts.completedNodes,
        dispatchPlan: opts.dispatchPlan,
        ...(opts.prompt ? { prompt: opts.prompt } : {}),
      }),
      ...(opts.collection ? { collection: collectionScope(opts.collection) } : {}),
    };
  }

  private async loadStageCollection(opts: {
    stage: GraphNode;
    workspacePath: string;
    context: IssueContext;
  }): Promise<Collection | null> {
    const collectionId = String(opts.stage.attrs.collection ?? "").trim();
    if (!collectionId) {
      return null;
    }

    const collectionStore = new CollectionStore(opts.workspacePath, opts.context.workspaceArtifactsDir);
    return collectionStore.loadCollection(collectionId);
  }

  private async buildStagePrompt(opts: {
    stage: GraphNode;
    resolvedAgent: ResolvedStageAgent | null;
    workflow: WorkflowDefinition;
    issue: Issue;
    attempt: number;
    stageNodes: GraphNode[];
    context: IssueContext;
    workspacePath: string;
    dotFile: string;
    completedNodes: string[];
    dispatchPlan: DispatchPlan | null;
    collection: Collection | null;
  }): Promise<string> {
    if (!opts.resolvedAgent) {
      return "";
    }

    return renderPromptTemplate(
      opts.resolvedAgent.promptTemplate,
      this.buildStageScope({
        issue: opts.issue,
        attempt: opts.attempt,
        stage: opts.stage,
        stageNodes: opts.stageNodes,
        context: opts.context,
        workspacePath: opts.workspacePath,
        dotFile: opts.dotFile,
        completedNodes: opts.completedNodes,
        dispatchPlan: opts.dispatchPlan,
        collection: opts.collection,
      }),
    );
  }

  private async resolveThreadExecution(opts: {
    stage: GraphNode;
    resolvedAgent: ResolvedStageAgent | null;
    backends: Map<string, AgentBackend>;
    threadStore: ThreadStore;
  }): Promise<ThreadExecutionState> {
    const threadId = String(opts.stage.attrs.thread ?? "").trim();
    if (!threadId || !opts.resolvedAgent) {
      return {
        threadId: threadId || null,
        session: null,
        createNativeSession: false,
      };
    }

    const backend = opts.backends.get(opts.resolvedAgent.backendName);
    if (!backend?.supportsNativeSessions) {
      throw new Error(`threaded stage ${opts.stage.id} requires a native-session backend, but ${opts.resolvedAgent.backendName} does not support native sessions`);
    }

    const session = await opts.threadStore.loadSession(threadId);
    const matchesCurrentAgent = session
      && session.backend === opts.resolvedAgent.backendName
      && session.model === opts.resolvedAgent.model;

    if (matchesCurrentAgent) {
      return {
        threadId,
        session,
        createNativeSession: false,
      };
    }

    return {
      threadId,
      session: null,
      createNativeSession: true,
    };
  }

  private async writeRunningCheckpoint(opts: {
    runStore: PipelineRunStore;
    runMetadataBase: PipelineRunMetadataBase;
    issue: Issue;
    attempt: number;
    graphId: string;
    workspacePath: string;
    completedNodes: string[];
    nextNodeId: string;
  }): Promise<void> {
    await opts.runStore.writeCheckpoint({
      issueId: opts.issue.id,
      issueIdentifier: opts.issue.identifier,
      attempt: opts.attempt,
      workspacePath: opts.workspacePath,
      graphId: opts.graphId,
      startedAt: opts.runMetadataBase.startedAt,
      finishedAt: null,
      completedNodes: opts.completedNodes,
      nextNodeId: opts.nextNodeId,
      status: "running",
      error: null,
    } satisfies PipelineCheckpoint);
  }

  private async handleVisitLimit(opts: {
    stage: GraphNode;
    issue: Issue;
    attempt: number;
    graphId: string;
    workspacePath: string;
    visitCount: number;
    maxVisits: number;
    emitEvent: boolean;
    artifactStore: IssueArtifactStore;
    runStore: PipelineRunStore;
    runMetadataBase: PipelineRunMetadataBase;
    state: StageLoopState;
  }): Promise<StageIterationResult | null> {
    if (opts.visitCount <= opts.maxVisits) {
      return null;
    }

    if (opts.emitEvent) {
      this.eventBus?.emit({
        type: "pipeline:max_visits",
        timestamp: new Date().toISOString(),
        issueId: opts.issue.id,
        issueIdentifier: opts.issue.identifier,
        stageId: opts.stage.id,
        maxVisits: opts.maxVisits,
        visitCount: opts.visitCount,
      });
    }

    const exhaustionTarget = String(opts.stage.attrs.on_exhaustion ?? "").trim();
    if (exhaustionTarget) {
      await opts.artifactStore.saveContext(opts.state.context);
      await this.writeRunningCheckpoint({
        runStore: opts.runStore,
        runMetadataBase: opts.runMetadataBase,
        issue: opts.issue,
        attempt: opts.attempt,
        graphId: opts.graphId,
        workspacePath: opts.workspacePath,
        completedNodes: opts.state.completedNodes,
        nextNodeId: exhaustionTarget,
      });

      return {
        kind: "continue",
        nextNodeId: exhaustionTarget,
        state: opts.state,
      };
    }

    return this.finishStageIteration({
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
      error: `node ${opts.stage.id} exceeded max_visits ${opts.maxVisits} (visit ${opts.visitCount})`,
      failedStageId: opts.stage.id,
    });
  }

  private async advanceStageIteration(opts: {
    artifactStore: IssueArtifactStore;
    context: IssueContext;
    runStore: PipelineRunStore;
    runMetadataBase: PipelineRunMetadataBase;
    issue: Issue;
    attempt: number;
    graphId: string;
    workspacePath: string;
    completedNodes: string[];
    nextNodeId: string;
    agentInvocations: number;
  }): Promise<StageIterationResult> {
    await opts.artifactStore.saveContext(opts.context);
    await this.writeRunningCheckpoint({
      runStore: opts.runStore,
      runMetadataBase: opts.runMetadataBase,
      issue: opts.issue,
      attempt: opts.attempt,
      graphId: opts.graphId,
      workspacePath: opts.workspacePath,
      completedNodes: opts.completedNodes,
      nextNodeId: opts.nextNodeId,
    });

    return {
      kind: "continue",
      nextNodeId: opts.nextNodeId,
      state: {
        context: opts.context,
        completedNodes: opts.completedNodes,
        agentInvocations: opts.agentInvocations,
      },
    };
  }

  private async handleSuccessfulStageExecution(opts: {
    stage: GraphNode;
    stageType: "agent" | "tool" | "fan_out" | "fan_in";
    issue: Issue;
    attempt: number;
    graphId: string;
    workspacePath: string;
    dotFile: string;
    dispatchPlan: DispatchPlan | null;
    stageNodes: GraphNode[];
    outgoingEdges: GraphEdge[];
    artifactStore: IssueArtifactStore;
    runStore: PipelineRunStore;
    runMetadataBase: PipelineRunMetadataBase;
    state: StageLoopState;
    threadStore: ThreadStore;
    threadId: string | null;
    threadSession: ThreadNativeSession | null;
    visitCount: number;
    stageLogs: StageLogPaths;
    resolvedAgent: ResolvedStageAgent | null;
    prompt: string;
    executionResult: Awaited<ReturnType<PipelineStageExecutor["executeStage"]>>;
    collection: Collection | null;
    agentInvocations: number;
  }): Promise<StageIterationResult> {
    const outputArtifact = await this.stageExecutor.persistStageOutputArtifact(
      opts.stage.id,
      opts.executionResult.output,
      opts.workspacePath,
      opts.state.context.workspaceArtifactsDir,
    );
    const { metadata, outcome } = await this.stageExecutor.loadStageResult({
      stageId: opts.stage.id,
      workspacePath: opts.workspacePath,
      workspaceArtifactsDir: opts.state.context.workspaceArtifactsDir,
      exitCode: opts.executionResult.exitCode,
    });
    const artifacts = {
      ...(await this.stageExecutor.collectArtifacts(opts.stage, opts.workspacePath, outputArtifact)),
      ...outcome.artifacts,
    };
    const stageStatus = (opts.stage.attrs.artifact_path && !artifacts.primary)
      ? "failure"
      : outcome.status;
    if (opts.threadId && opts.executionResult.invalidateSession) {
      await opts.threadStore.clearSession(opts.threadId);
    }
    await opts.runStore.writeStageMeta(opts.stageLogs, {
      agentName: opts.resolvedAgent?.agentName ?? null,
      backend: opts.executionResult.backend,
      command: opts.executionResult.command,
      model: opts.resolvedAgent?.model ?? null,
      reasoningEffort: opts.resolvedAgent?.reasoningEffort ?? null,
      durationMs: opts.executionResult.durationMs,
      exitCode: opts.executionResult.exitCode,
      label: opts.stage.attrs.label ?? opts.stage.id,
      status: stageStatus,
      type: opts.stageType,
      visit: opts.visitCount,
      artifacts,
      resultMetadata: metadata,
    });

    this.eventBus?.emit({
      type: "pipeline:stage:complete",
      timestamp: new Date().toISOString(),
      issueId: opts.issue.id,
      issueIdentifier: opts.issue.identifier,
      stageId: opts.stage.id,
      exitCode: opts.executionResult.exitCode,
      durationMs: opts.executionResult.durationMs,
      visit: opts.visitCount,
      status: stageStatus,
    });

    opts.state.context.stages[opts.stage.id] = buildStageContextEntry({
      node: opts.stage,
      status: stageStatus,
      artifacts,
      metadata,
      backend: opts.executionResult.backend,
      command: opts.executionResult.command,
      promptPath: opts.stageLogs.promptPath,
      outputPath: opts.stageLogs.outputPath,
      exitCode: opts.executionResult.exitCode,
      durationMs: opts.executionResult.durationMs,
    });

    const completedNodes = [...opts.state.completedNodes, opts.stage.id];
    const context = {
      ...opts.state.context,
      attempt: opts.attempt,
      completedNodes,
    };

    if (opts.threadId && opts.executionResult.sessionId && opts.resolvedAgent && (stageStatus === "success" || stageStatus === "wait_human")) {
      await opts.threadStore.saveSession(opts.threadId, {
        sessionId: opts.executionResult.sessionId,
        backend: opts.resolvedAgent.backendName,
        model: opts.resolvedAgent.model,
        createdAt: opts.threadSession?.createdAt ?? new Date().toISOString(),
      });
    }

    if (stageStatus === "wait_human") {
      return this.finishStageIteration({
        artifactStore: opts.artifactStore,
        context,
        runStore: opts.runStore,
        runMetadataBase: opts.runMetadataBase,
        status: "wait_human",
        issue: opts.issue,
        attempt: opts.attempt,
        graphId: opts.graphId,
        workspacePath: opts.workspacePath,
        completedNodes,
        nextNodeId: opts.stage.id,
        error: outcome.notes ?? `stage ${opts.stage.id} is waiting for human input`,
        failedStageId: opts.stage.id,
      });
    }

    if (stageStatus === "failure" && opts.stage.attrs.artifact_path && !artifacts.primary) {
      const classified = classifyStageError({
        output: opts.executionResult.output,
        backend: opts.executionResult.backend,
      });
      const errorMessage = classified
        ? `[${classified.failureClass}] ${classified.detail}${classified.retryAfterHint ? ` (resets ${classified.retryAfterHint})` : ""}`
        : `stage ${opts.stage.id} did not produce artifact ${opts.stage.attrs.artifact_path}`;
      return this.finishStageIteration({
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
        error: errorMessage,
        failureClass: classified?.failureClass,
        failedStageId: opts.stage.id,
      });
    }

    const hasRoutingEdges = opts.outgoingEdges.some((edge) => "condition" in edge.attrs || "on_label" in edge.attrs);
    if (stageStatus === "failure" && !hasRoutingEdges) {
      const classified = classifyStageError({
        output: opts.executionResult.output,
        backend: opts.executionResult.backend,
      });
      const baseError = opts.executionResult.output || `stage ${opts.stage.id} failed`;
      const errorMessage = classified
        ? `[${classified.failureClass}] ${classified.detail}${classified.retryAfterHint ? ` (resets ${classified.retryAfterHint})` : ""}`
        : baseError;
      return this.finishStageIteration({
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
        error: errorMessage,
        failureClass: classified?.failureClass,
        failedStageId: opts.stage.id,
      });
    }

    let nextNodeId: string;
    try {
      nextNodeId = await this.graphNavigator.selectNextNode({
        issue: opts.issue,
        fromNode: opts.stage,
        outgoingEdges: opts.outgoingEdges,
        scope: this.buildStageScope({
          issue: opts.issue,
          attempt: opts.attempt,
          stage: opts.stage,
          stageNodes: opts.stageNodes,
          context,
          workspacePath: opts.workspacePath,
          dotFile: opts.dotFile,
          completedNodes,
          dispatchPlan: opts.dispatchPlan,
          prompt: opts.prompt,
          collection: opts.collection,
        }),
        label: outcome.label,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return this.finishStageIteration({
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
        error: errorMessage,
        failedStageId: opts.stage.id,
      });
    }

    return this.advanceStageIteration({
      artifactStore: opts.artifactStore,
      context,
      runStore: opts.runStore,
      runMetadataBase: opts.runMetadataBase,
      issue: opts.issue,
      attempt: opts.attempt,
      graphId: opts.graphId,
      workspacePath: opts.workspacePath,
      completedNodes,
      nextNodeId,
      agentInvocations: opts.agentInvocations,
    });
  }

  private async handleStageExecutionError(opts: {
    error: unknown;
    signal: AbortSignal;
    stage: GraphNode;
    stageType: "agent" | "tool" | "fan_out" | "fan_in";
    issue: Issue;
    attempt: number;
    graphId: string;
    workspacePath: string;
    artifactStore: IssueArtifactStore;
    runStore: PipelineRunStore;
    runMetadataBase: PipelineRunMetadataBase;
    state: StageLoopState;
    visitCount: number;
    stageLogs: StageLogPaths;
    resolvedAgent: ResolvedStageAgent | null;
  }): Promise<StageIterationResult> {
    const status = opts.signal.aborted ? "cancelled" : "failure";
    const errorMessage = opts.error instanceof Error ? opts.error.message : String(opts.error);
    this.eventBus?.emit({
      type: "pipeline:stage:complete",
      timestamp: new Date().toISOString(),
      issueId: opts.issue.id,
      issueIdentifier: opts.issue.identifier,
      stageId: opts.stage.id,
      exitCode: null,
      durationMs: null,
      visit: opts.visitCount,
      status,
    });
    const outputArtifact = await this.stageExecutor.persistStageOutputArtifact(
      opts.stage.id,
      errorMessage,
      opts.workspacePath,
      opts.state.context.workspaceArtifactsDir,
    );
    const metadata = await this.stageExecutor.loadStageMetadata({
      stageId: opts.stage.id,
      workspacePath: opts.workspacePath,
      workspaceArtifactsDir: opts.state.context.workspaceArtifactsDir,
    });

    const context = {
      ...opts.state.context,
      attempt: opts.attempt,
      completedNodes: opts.state.completedNodes,
    };
    context.stages[opts.stage.id] = buildStageContextEntry({
      node: opts.stage,
      status,
      artifacts: { output: outputArtifact },
      metadata,
      backend: opts.resolvedAgent?.backendName ?? null,
      command: opts.stage.attrs.command ?? null,
      promptPath: opts.stageLogs.promptPath,
      outputPath: opts.stageLogs.outputPath,
    });
    await opts.runStore.writeStageMeta(opts.stageLogs, {
      agentName: opts.resolvedAgent?.agentName ?? null,
      backend: opts.resolvedAgent?.backendName ?? null,
      command: opts.stage.attrs.command ?? null,
      model: opts.resolvedAgent?.model ?? null,
      reasoningEffort: opts.resolvedAgent?.reasoningEffort ?? null,
      durationMs: null,
      exitCode: null,
      label: opts.stage.attrs.label ?? opts.stage.id,
      status,
      type: opts.stageType,
      visit: opts.visitCount,
      artifacts: { output: outputArtifact },
      error: errorMessage,
      resultMetadata: metadata,
    });
    return this.finishStageIteration({
      artifactStore: opts.artifactStore,
      context,
      runStore: opts.runStore,
      runMetadataBase: opts.runMetadataBase,
      status,
      issue: opts.issue,
      attempt: opts.attempt,
      graphId: opts.graphId,
      workspacePath: opts.workspacePath,
      completedNodes: opts.state.completedNodes,
      nextNodeId: opts.stage.id,
      error: errorMessage,
      failedStageId: opts.stage.id,
    });
  }

  private async finishRun(opts: FinishRunOptions): Promise<PipelineRunResult> {
    const finishedAt = opts.finishedAt ?? new Date().toISOString();
    const checkpoint: PipelineCheckpoint = {
      issueId: opts.issue.id,
      issueIdentifier: opts.issue.identifier,
      attempt: opts.attempt,
      workspacePath: opts.workspacePath,
      graphId: opts.graphId,
      startedAt: opts.runMetadataBase.startedAt,
      finishedAt,
      completedNodes: opts.completedNodes,
      nextNodeId: opts.nextNodeId,
      status: opts.status,
      error: opts.error,
    };
    await opts.runStore.writeCheckpoint(checkpoint);

    const pr = opts.pr ?? (opts.status === "success" && opts.inspectPrOnSuccess !== false
      ? await this.stageExecutor.inspectWorkspacePullRequest(opts.workspacePath)
      : null);
    await opts.runStore.writeRunMetadata({
      ...opts.runMetadataBase,
      finishedAt,
      status: opts.status,
      error: opts.error,
      prUrl: pr?.url ?? null,
    });

    return {
      status: opts.status,
      completedNodes: opts.completedNodes,
      checkpointPath: opts.runStore.checkpointPath(),
      error: checkpoint.error ?? undefined,
      failureClass: opts.failureClass,
      context: opts.context,
      failedStageId: opts.failedStageId,
      pr,
      prUrl: pr?.url ?? null,
    };
  }

  private async saveContextAndFinishRun(opts: FinishRunOptions & {
    artifactStore: IssueArtifactStore;
    context: IssueContext;
  }): Promise<PipelineRunResult> {
    opts.context.completedNodes = opts.completedNodes;
    await opts.artifactStore.saveContext(opts.context);
    await opts.artifactStore.persistWorkspaceArtifacts();
    return this.finishRun({
      ...opts,
      context: opts.context,
    });
  }

  private async finishStageIteration(opts: FinishStageIterationOptions): Promise<StageIterationResult> {
    return {
      kind: "finished",
      result: await this.saveContextAndFinishRun(opts),
    };
  }

  private async processStageNode(opts: {
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
    visitCounts: Map<string, number>;
    state: StageLoopState;
    threadStore: ThreadStore;
  }): Promise<StageIterationResult> {
    const { stage } = opts;
    const visitCount = (opts.visitCounts.get(stage.id) ?? 0) + 1;
    const maxVisits = parseMaxVisits(stage);
    const visitLimitResult = await this.handleVisitLimit({
      stage,
      issue: opts.issue,
      attempt: opts.attempt,
      graphId: opts.graphId,
      workspacePath: opts.workspacePath,
      visitCount,
      maxVisits,
      emitEvent: stage.type !== "fan_out",
      artifactStore: opts.artifactStore,
      runStore: opts.runStore,
      runMetadataBase: opts.runMetadataBase,
      state: opts.state,
    });
    if (visitLimitResult) {
      return visitLimitResult;
    }
    opts.visitCounts.set(stage.id, visitCount);

    if (stage.type === "fan_out") {
      return runFanOutStage({
        eventBus: this.eventBus,
        stageExecutor: this.stageExecutor,
        graphNavigator: this.graphNavigator,
        resolveNamedAgent: (agentName, workflow, overrides) => this.resolveNamedAgent(agentName, workflow, overrides),
        runWithConcurrency: (tasks, limit) => this.runWithConcurrency(tasks, limit),
        finishStageIteration: (finishOpts) => this.finishStageIteration(finishOpts),
        ...opts,
        visitCount,
      });
    }

    const stageType = stageRuntimeType(stage);
    const resolvedAgent = this.resolveStageAgent(stage, opts.workflow);
    let agentInvocations = opts.state.agentInvocations;
    if (resolvedAgent && countsAgainstAgentBudget(stage)) {
      if (agentInvocations >= opts.workflow.config.execution.maxAgentInvocationsPerRun) {
        return this.finishStageIteration({
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
          nextNodeId: stage.id,
          error: `run exceeded max_agent_invocations_per_run ${opts.workflow.config.execution.maxAgentInvocationsPerRun}`,
          failedStageId: stage.id,
        });
      }
      agentInvocations += 1;
    }
    const stageLogs = await opts.runStore.stageLogPaths(stage.id, visitCount);
    await this.stageExecutor.clearStageResultFile(stage.id, opts.workspacePath, opts.state.context.workspaceArtifactsDir);
    this.eventBus?.emit({
      type: "pipeline:stage:start",
      timestamp: new Date().toISOString(),
      issueId: opts.issue.id,
      issueIdentifier: opts.issue.identifier,
      stageId: stage.id,
      stageLabel: stage.attrs.label ?? stage.id,
      stageType,
      visit: visitCount,
      backend: resolvedAgent?.backendName ?? null,
    });

    try {
      const collection = await this.loadStageCollection({
        stage,
        workspacePath: opts.workspacePath,
        context: opts.state.context,
      });
      const threadExecution = await this.resolveThreadExecution({
        stage,
        resolvedAgent,
        backends: opts.backends,
        threadStore: opts.threadStore,
      });
      const prompt = await this.buildStagePrompt({
        stage,
        resolvedAgent,
        workflow: opts.workflow,
        issue: opts.issue,
        attempt: opts.attempt,
        stageNodes: opts.stageNodes,
        context: opts.state.context,
        workspacePath: opts.workspacePath,
        dotFile: opts.dotFile,
        completedNodes: opts.state.completedNodes,
        dispatchPlan: opts.dispatchPlan,
        collection,
      });

      await opts.runStore.writeStagePrompt(stageLogs, prompt);

      const executionResult = await this.stageExecutor.executeStage({
        stage,
        prompt,
        workspacePath: opts.workspacePath,
        workspaceArtifactsDir: opts.state.context.workspaceArtifactsDir,
        signal: opts.signal,
        backends: opts.backends,
        scope: this.buildStageScope({
          issue: opts.issue,
          attempt: opts.attempt,
          stage,
          stageNodes: opts.stageNodes,
          context: opts.state.context,
          workspacePath: opts.workspacePath,
          dotFile: opts.dotFile,
          completedNodes: opts.state.completedNodes,
          dispatchPlan: opts.dispatchPlan,
          prompt,
          collection,
        }),
        resolvedAgent,
        createSession: threadExecution.createNativeSession,
        sessionId: threadExecution.session?.sessionId,
        githubConfig: opts.workflow.config.github,
      });

      await opts.runStore.writeStageOutput(stageLogs, executionResult.output);
      return this.handleSuccessfulStageExecution({
        stage,
        stageType,
        issue: opts.issue,
        attempt: opts.attempt,
        graphId: opts.graphId,
        workspacePath: opts.workspacePath,
        dotFile: opts.dotFile,
        dispatchPlan: opts.dispatchPlan,
        stageNodes: opts.stageNodes,
        outgoingEdges: opts.outgoingEdges,
        artifactStore: opts.artifactStore,
        runStore: opts.runStore,
        runMetadataBase: opts.runMetadataBase,
        state: opts.state,
        threadStore: opts.threadStore,
        threadId: threadExecution.threadId,
        threadSession: threadExecution.session,
        visitCount,
        stageLogs,
        resolvedAgent,
        prompt,
        executionResult,
        collection,
        agentInvocations,
      });
    } catch (error) {
      return this.handleStageExecutionError({
        error,
        signal: opts.signal,
        stage,
        stageType,
        issue: opts.issue,
        attempt: opts.attempt,
        graphId: opts.graphId,
        workspacePath: opts.workspacePath,
        artifactStore: opts.artifactStore,
        runStore: opts.runStore,
        runMetadataBase: opts.runMetadataBase,
        state: opts.state,
        visitCount,
        stageLogs,
        resolvedAgent,
      });
    }
  }

  private async run(opts: {
    issue: Issue;
    attempt: number;
    workflow: WorkflowDefinition;
    workspacePath: string;
    dispatchPlan?: DispatchPlan;
    signal: AbortSignal;
  }): Promise<PipelineRunResult> {
    const runStore = new PipelineRunStore(this.logsRoot, opts.issue.identifier, opts.attempt);
    const checkpoint = await runStore.loadCheckpoint();
    const existingRunMetadata = await runStore.loadRunMetadata();
    const persistedDispatchPlan = opts.dispatchPlan ?? existingRunMetadata?.dispatchPlan ?? null;
    const resolvedWorkflow = persistedDispatchPlan
      ? {
          workflowName: persistedDispatchPlan.workflowName,
          workflow: opts.workflow.config.workflows[persistedDispatchPlan.workflowName],
        }
      : resolveIssueWorkflow(opts.issue, opts.workflow.config);
    if (!resolvedWorkflow.workflow) {
      throw new Error(`workflow ${resolvedWorkflow.workflowName} is not configured`);
    }
    const workflowName = resolvedWorkflow.workflowName;
    const selectedWorkflow = resolvedWorkflow.workflow;
    const dotFile = selectedWorkflow.dotFile;
    const graphSource = await readFile(dotFile, "utf8");
    const graph = parseDotGraph(graphSource);
    const { startNode, exitNodeIds, stageNodes, stageById, outgoing } = buildTraversalGraph(graph);
    const backends = this.backendFactory(opts.workflow);
    const artifactStore = new IssueArtifactStore(opts.workflow.config.artifacts, opts.issue, opts.workspacePath);
    await artifactStore.hydrateWorkspace();
    let context = await artifactStore.loadContext(opts.attempt);
    // Fresh attempts intentionally ignore durable completedNodes history.
    // Only an explicit checkpoint is allowed to resume traversal.
    let completedNodes = checkpoint?.completedNodes ?? [];
    const visitCounts = countCompletedNodeVisits(completedNodes);
    let currentNodeId: string | null = checkpoint?.nextNodeId ?? startNode.id;
    const runStartedAt = checkpoint?.startedAt ?? existingRunMetadata?.startedAt ?? new Date().toISOString();
    const threadStore = new ThreadStore(opts.workspacePath, context.workspaceArtifactsDir);
    let agentInvocations = completedNodes
      .map((nodeId) => stageById.get(nodeId))
      .filter((node): node is GraphNode => !!node)
      .filter((node) => countsAgainstAgentBudget(node))
      .length;

    context.completedNodes = completedNodes;

    const runMetadataBase = {
      issueId: opts.issue.id,
      issueIdentifier: opts.issue.identifier,
      issueTitle: opts.issue.title,
      issueUrl: opts.issue.url,
      attempt: opts.attempt,
      workflowName,
      graphId: graph.id,
      dotFile,
      workspacePath: opts.workspacePath,
      artifactsPath: artifactStore.workspaceDirPath(),
      dispatchPlan: persistedDispatchPlan,
      startedAt: runStartedAt,
      prUrl: null,
    } satisfies Omit<PipelineRunMetadata, "finishedAt" | "status" | "error">;
    await runStore.writeRunMetadata({
      ...runMetadataBase,
      finishedAt: null,
      status: "running",
      error: null,
      prUrl: null,
    });

    if (checkpoint?.status === "wait_human") {
      return this.saveContextAndFinishRun({
        artifactStore,
        context,
        runStore,
        runMetadataBase,
        status: "wait_human",
        issue: opts.issue,
        attempt: opts.attempt,
        graphId: graph.id,
        workspacePath: opts.workspacePath,
        completedNodes,
        nextNodeId: checkpoint.nextNodeId,
        error: checkpoint.error,
        inspectPrOnSuccess: selectedWorkflow.inspectPr,
        finishedAt: checkpoint.finishedAt ?? undefined,
      });
    }

    if (checkpoint?.status === "success" && checkpoint.nextNodeId === null) {
      return this.saveContextAndFinishRun({
        artifactStore,
        context,
        runStore,
        runMetadataBase,
        status: "success",
        issue: opts.issue,
        attempt: opts.attempt,
        graphId: graph.id,
        workspacePath: opts.workspacePath,
        completedNodes,
        nextNodeId: null,
        error: null,
        inspectPrOnSuccess: selectedWorkflow.inspectPr,
        finishedAt: checkpoint.finishedAt ?? undefined,
      });
    }

    while (currentNodeId) {
      if (opts.signal.aborted) {
        return this.saveContextAndFinishRun({
          artifactStore,
          context,
          runStore,
          runMetadataBase,
          status: "cancelled",
          issue: opts.issue,
          attempt: opts.attempt,
          graphId: graph.id,
          workspacePath: opts.workspacePath,
          completedNodes,
          nextNodeId: currentNodeId,
          error: "pipeline cancelled",
          failedStageId: stageById.has(currentNodeId) ? currentNodeId : undefined,
        });
      }

      const currentNode = graph.nodes.get(currentNodeId);
      if (!currentNode) {
        return this.saveContextAndFinishRun({
          artifactStore,
          context,
          runStore,
          runMetadataBase,
          status: "failure",
          issue: opts.issue,
          attempt: opts.attempt,
          graphId: graph.id,
          workspacePath: opts.workspacePath,
          completedNodes,
          nextNodeId: currentNodeId,
          error: `node ${currentNodeId} not found in graph ${graph.id}`,
          failedStageId: currentNodeId,
        });
      }

      if (exitNodeIds.has(currentNode.id)) {
        context.completedNodes = completedNodes;
        context = {
          ...context,
          attempt: opts.attempt,
        };
        const exitReason = String(currentNode.attrs.exit_reason ?? "").trim();
        return this.saveContextAndFinishRun({
          artifactStore,
          context,
          runStore,
          runMetadataBase,
          status: exitReason === "human_review" ? "wait_human" : "success",
          issue: opts.issue,
          attempt: opts.attempt,
          graphId: graph.id,
          workspacePath: opts.workspacePath,
          completedNodes,
          nextNodeId: null,
          error: exitReason === "human_review" ? "pipeline requires human review" : null,
          inspectPrOnSuccess: selectedWorkflow.inspectPr,
        });
      }

      if (currentNode.type === "start") {
        const scope = graphStageScope({
          issue: opts.issue,
          attempt: opts.attempt,
          node: currentNode,
          allStages: stageNodes,
          context,
          workspacePath: opts.workspacePath,
          dotFile,
          completedNodes,
          dispatchPlan: persistedDispatchPlan,
        });

        try {
          currentNodeId = await this.graphNavigator.selectNextNode({
            issue: opts.issue,
            fromNode: currentNode,
            outgoingEdges: outgoing.get(currentNode.id) ?? [],
            scope,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return this.saveContextAndFinishRun({
            artifactStore,
            context,
            runStore,
            runMetadataBase,
            status: "failure",
            issue: opts.issue,
            attempt: opts.attempt,
            graphId: graph.id,
            workspacePath: opts.workspacePath,
            completedNodes,
            nextNodeId: currentNode.id,
            error: errorMessage,
          });
        }

        continue;
      }

      const stage = currentNode;
      const iteration = await this.processStageNode({
        stage,
        issue: opts.issue,
        attempt: opts.attempt,
        workflow: opts.workflow,
        workspacePath: opts.workspacePath,
        signal: opts.signal,
        graphId: graph.id,
        dotFile,
        dispatchPlan: persistedDispatchPlan,
        stageNodes,
        outgoingEdges: outgoing.get(stage.id) ?? [],
        backends,
        artifactStore,
        runStore,
        runMetadataBase,
        visitCounts,
        state: {
          context,
          completedNodes,
          agentInvocations,
        },
        threadStore,
      });

      if (iteration.kind === "finished") {
        return iteration.result;
      }

      currentNodeId = iteration.nextNodeId;
      context = iteration.state.context;
      completedNodes = iteration.state.completedNodes;
      agentInvocations = iteration.state.agentInvocations;
    }

    return this.saveContextAndFinishRun({
      artifactStore,
      context,
      runStore,
      runMetadataBase,
      status: "success",
      issue: opts.issue,
      attempt: opts.attempt,
      graphId: graph.id,
      workspacePath: opts.workspacePath,
      completedNodes,
      nextNodeId: null,
      error: null,
      inspectPrOnSuccess: selectedWorkflow.inspectPr,
    });
  }
}

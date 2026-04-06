import { readdir } from "node:fs/promises";
import path from "node:path";

import { DispatchPlan, Issue, OrchestratorState, PipelineRunner, RetryEntry, RUN_STOP_REASONS, RunningEntry, TrackerClient, WorkflowDefinition, WorkflowStore } from "./types";
import { VajraEventBus } from "./events";
import { GitHubClient } from "./github";
import { normalizeLowercase } from "./string-utils";
import { BranchInfo, triageIssue } from "./triage";
import { resolveIssueWorkflow } from "./workflow-routing";
import { IssueArtifactStore, ReviewArtifactStore } from "./artifacts";
import { WorkspaceManager } from "./workspace";

function isActiveState(state: string, activeStates: string[]): boolean {
  const normalized = normalizeLowercase(state);
  return activeStates.some((entry) => normalizeLowercase(entry) === normalized);
}

function isTerminalState(state: string, terminalStates: string[]): boolean {
  const normalized = normalizeLowercase(state);
  return terminalStates.some((entry) => normalizeLowercase(entry) === normalized);
}

function isAssignedToTracker(issue: Issue, trackerAssigneeId: string): boolean {
  return !!trackerAssigneeId && issue.assigneeId === trackerAssigneeId;
}

function hasActiveBlockers(issue: Issue, terminalStates: string[]): boolean {
  return issue.blockedBy.some((blocker) => blocker.state && !isTerminalState(blocker.state, terminalStates));
}

function issueEventFields(issue: Issue): {
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  issueUrl: string | null;
  issueCreatorId: string | null;
} {
  return {
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    issueTitle: issue.title,
    issueUrl: issue.url,
    issueCreatorId: issue.creatorId,
  };
}

function clarificationBarrierVersion(issue: Issue): string {
  return issue.updatedAt ?? issue.createdAt ?? "";
}

function defaultDispatchPlan(issue: Issue, workflowStore: WorkflowStore): DispatchPlan {
  const resolvedWorkflow = resolveIssueWorkflow(issue, workflowStore.current().config);
  return {
    workflowName: resolvedWorkflow.workflowName,
    successState: resolvedWorkflow.workflow.successState ?? "Done",
    baseBranch: "main",
    targetBranch: "main",
    mergeStrategy: "pr-only",
    labelsToAdd: [],
    triage: null,
  };
}

function dispatchPlanHookEnv(dispatchPlan: DispatchPlan): Record<string, string> {
  return {
    VAJRA_BASE_BRANCH: dispatchPlan.baseBranch,
    VAJRA_TARGET_BRANCH: dispatchPlan.targetBranch,
    VAJRA_MERGE_STRATEGY: dispatchPlan.mergeStrategy,
  };
}

function formatTriageSummaryComment(dispatchPlan: DispatchPlan): string {
  const lines = [
    "**Vajra triage**",
    `- Workflow: \`${dispatchPlan.workflowName}\``,
    `- Base branch: \`${dispatchPlan.baseBranch}\``,
    `- Target branch: \`${dispatchPlan.targetBranch}\``,
    `- Merge strategy: \`${dispatchPlan.mergeStrategy}\``,
    `- Labels added: ${dispatchPlan.labelsToAdd.length > 0 ? dispatchPlan.labelsToAdd.map((label) => `\`${label}\``).join(", ") : "none"}`,
  ];
  const reasoning = dispatchPlan.triage?.reasoning?.trim();
  if (reasoning) {
    lines.push("", `> ${reasoning}`);
  }
  return lines.join("\n");
}

function formatEscalationComment(reason: string): string {
  return [
    "**Vajra escalation**",
    "",
    "This workflow paused for human review.",
    "",
    `Reason: ${reason}`,
  ].join("\n");
}

function shouldCleanupCancelledWorkspace(reason: typeof RUN_STOP_REASONS[keyof typeof RUN_STOP_REASONS] | undefined): boolean {
  return reason === RUN_STOP_REASONS.terminal
    || reason === RUN_STOP_REASONS.shutdown
    || reason === RUN_STOP_REASONS.missingFromTracker;
}

export function retryBackoffMs(attempt: number, maxRetryBackoffMs: number): number {
  const base = 10_000 * (2 ** Math.max(attempt - 1, 0));
  return Math.min(base, maxRetryBackoffMs);
}

function hasIssueLabel(issue: Issue, labelName: string): boolean {
  const normalizedLabel = normalizeLowercase(labelName);
  return issue.labels.some((label) => normalizeLowercase(label) === normalizedLabel);
}

function sortIssues(issues: Issue[]): Issue[] {
  return [...issues].sort((left, right) => {
    const leftPriority = left.priority ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = right.priority ?? Number.MAX_SAFE_INTEGER;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }

    const leftCreated = left.createdAt ? Date.parse(left.createdAt) : Number.MAX_SAFE_INTEGER;
    const rightCreated = right.createdAt ? Date.parse(right.createdAt) : Number.MAX_SAFE_INTEGER;
    if (leftCreated !== rightCreated) {
      return leftCreated - rightCreated;
    }

    return left.identifier.localeCompare(right.identifier);
  });
}

function createOrchestratorState(dispatching: ReadonlySet<string>): OrchestratorState {
  const running = new Map<string, RunningEntry>();
  const retryAttempts = new Map<string, RetryEntry>();

  return {
    running,
    get claimed() {
      return new Set([
        ...dispatching,
        ...running.keys(),
        ...retryAttempts.keys(),
      ]);
    },
    retryAttempts,
    completed: new Map(),
    failed: new Map(),
    clarificationRequested: new Map(),
  };
}

export class VajraOrchestrator {
  private readonly dispatching = new Set<string>();
  private readonly monitorTasks = new Set<Promise<void>>();

  private shuttingDown = false;

  private tickInProgress = false;

  private tickRequested = false;

  private tickSchedulePending = false;

  readonly state: OrchestratorState = createOrchestratorState(this.dispatching);

  constructor(
    private readonly tracker: TrackerClient,
    private readonly workflowStore: WorkflowStore,
    private readonly pipelineRunner: PipelineRunner,
    private readonly createWorkspaceManager: () => WorkspaceManager,
    private readonly now: () => number = () => Date.now(),
    private readonly eventBus?: VajraEventBus,
    private readonly startupInfo?: { logsRoot: string },
    private readonly prepareRun?: (opts: {
      issue: Issue;
      workflowName: string;
      workspacePath: string;
    }) => Promise<void>,
  ) {}

  private async loadPersistedPullRequest(issueIdentifier: string) {
    return new ReviewArtifactStore(
      this.workflowStore.current().config.artifacts,
      issueIdentifier,
    ).loadPrRecord();
  }

  async startup(): Promise<void> {
    const terminalIssues = await this.tracker.fetchTerminalIssues();
    const workspaceManager = this.createWorkspaceManager();
    await Promise.all(terminalIssues.map((issue) => workspaceManager.cleanupWorkspace(issue.identifier)));

    const workflow = this.workflowStore.current();
    this.eventBus?.emit({
      type: "orchestrator:started",
      timestamp: new Date().toISOString(),
      workflowPath: workflow.path,
      logsRoot: this.startupInfo?.logsRoot ?? "",
      pollingMs: workflow.config.polling.intervalMs,
    });
  }

  async tick(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    if (this.tickInProgress) {
      this.requestTick();
      return;
    }

    this.tickInProgress = true;
    this.tickRequested = false;
    try {
      const claimedIssueIds = this.claimedIssueIds();
      this.eventBus?.emit({
        type: "orchestrator:tick",
        timestamp: new Date().toISOString(),
        running: this.state.running.size,
        claimed: claimedIssueIds.size,
        retrying: this.state.retryAttempts.size,
        completed: this.state.completed.size,
      });

      const workflow = this.workflowStore.current();
      const fetchBranchInfo = this.createCachedBranchInfoFetcher(workflow);
      await this.reconcileRunning(
        workflow.config.tracker.activeStates,
        workflow.config.tracker.terminalStates,
        workflow.config.tracker.assigneeId,
      );

      const candidateIssues = sortIssues(await this.tracker.fetchCandidateIssues());
      this.refreshRedispatchBarriers(candidateIssues);

      const retriedIssueIds = await this.dispatchDueRetries(candidateIssues, claimedIssueIds, fetchBranchInfo);
      await this.dispatchFreshIssues(candidateIssues, retriedIssueIds, claimedIssueIds, fetchBranchInfo);
    } finally {
      this.tickInProgress = false;
      if (this.tickRequested && !this.shuttingDown) {
        this.requestTick();
      }
    }
  }

  private requestTick(): void {
    if (this.shuttingDown) {
      return;
    }

    this.tickRequested = true;
    if (this.tickSchedulePending) {
      return;
    }

    this.tickSchedulePending = true;
    queueMicrotask(() => {
      this.tickSchedulePending = false;
      if (this.shuttingDown || this.tickInProgress || !this.tickRequested) {
        return;
      }

      this.runDetachedTick();
    });
  }

  private runDetachedTick(): void {
    void this.tick().catch((error) => {
      console.error(JSON.stringify({
        message: "orchestrator tick failed",
        source: "orchestrator-nudge",
        error: error instanceof Error ? error.message : String(error),
      }));
    });
  }

  private claimedIssueIds(): Set<string> {
    return new Set([
      ...this.dispatching,
      ...this.state.running.keys(),
      ...this.state.retryAttempts.keys(),
    ]);
  }

  private createCachedBranchInfoFetcher(workflow: WorkflowDefinition): (() => Promise<BranchInfo | null>) | undefined {
    const githubConfig = workflow.config.github;
    if (!githubConfig) {
      return undefined;
    }

    let cachedBranchInfo: Promise<BranchInfo | null> | null = null;
    return async () => {
      if (!cachedBranchInfo) {
        cachedBranchInfo = (async () => {
          try {
            const github = new GitHubClient(githubConfig);
            const [branches, openPullRequests] = await Promise.all([
              github.listBranches(githubConfig.repository),
              github.listOpenPullRequests(githubConfig.repository),
            ]);
            return {
              branches,
              openPullRequests,
            };
          } catch (error) {
            console.error(JSON.stringify({
              message: "failed to load GitHub branch info for triage",
              error: error instanceof Error ? error.message : String(error),
            }));
            return null;
          }
        })();
      }

      return cachedBranchInfo;
    };
  }

  private refreshRedispatchBarriers(candidateIssues: Issue[]): void {
    // Success and terminal failure both block redispatch until Linear moves the issue
    // to a different state. That keeps Vajra from thrashing on the same active issue.
    this.refreshRedispatchBarrier(this.state.completed, candidateIssues);
    this.refreshRedispatchBarrier(this.state.failed, candidateIssues);
    this.refreshClarificationBarriers(candidateIssues);
  }

  private refreshRedispatchBarrier(barrier: Map<string, string>, candidateIssues: Issue[]): void {
    const seen = new Map(candidateIssues.map((issue) => [issue.id, issue.state]));
    for (const [issueId, blockedState] of barrier.entries()) {
      const latestState = seen.get(issueId);
      if (!latestState || normalizeLowercase(latestState) !== normalizeLowercase(blockedState)) {
        barrier.delete(issueId);
      }
    }
  }

  private isBlockedByRedispatchBarrier(barrier: Map<string, string>, issue: Issue): boolean {
    const blockedState = barrier.get(issue.id);
    return !!blockedState && normalizeLowercase(blockedState) === normalizeLowercase(issue.state);
  }

  private refreshClarificationBarriers(candidateIssues: Issue[]): void {
    const seen = new Map(candidateIssues.map((issue) => [issue.id, clarificationBarrierVersion(issue)]));
    for (const [issueId, blockedVersion] of this.state.clarificationRequested.entries()) {
      const latestVersion = seen.get(issueId);
      if (!latestVersion || latestVersion !== blockedVersion) {
        this.state.clarificationRequested.delete(issueId);
      }
    }
  }

  private requestRunCancellation(runningEntry: RunningEntry, reason: typeof RUN_STOP_REASONS[keyof typeof RUN_STOP_REASONS]): Promise<void> {
    runningEntry.stopReason = runningEntry.stopReason ?? reason;
    if (runningEntry.cancelPromise) {
      return runningEntry.cancelPromise;
    }

    runningEntry.cancelPromise = runningEntry.handle.cancel(runningEntry.stopReason)
      .catch((error) => {
        console.error(JSON.stringify({
          message: "pipeline cancellation failed",
          issue: runningEntry.issue.identifier,
          reason: runningEntry.stopReason,
          error: error instanceof Error ? error.message : String(error),
        }));
      })
      .finally(() => {
        runningEntry.cancelPromise = undefined;
      });

    return runningEntry.cancelPromise;
  }

  private async reconcileRunning(activeStates: string[], terminalStates: string[], trackerAssigneeId: string): Promise<void> {
    const runningIds = [...this.state.running.keys()];
    if (runningIds.length === 0) {
      return;
    }

    const refreshed = await this.tracker.fetchIssueStatesByIds(runningIds);
    const refreshedById = new Map(refreshed.map((issue) => [issue.id, issue]));

    for (const [issueId, runningEntry] of this.state.running.entries()) {
      const latest = refreshedById.get(issueId);
      if (!latest) {
        void this.requestRunCancellation(runningEntry, RUN_STOP_REASONS.missingFromTracker);
        continue;
      }

      runningEntry.issue = latest;

      if (!isAssignedToTracker(latest, trackerAssigneeId)) {
        void this.requestRunCancellation(runningEntry, RUN_STOP_REASONS.unassigned);
        continue;
      }

      if (isTerminalState(latest.state, terminalStates)) {
        void this.requestRunCancellation(runningEntry, RUN_STOP_REASONS.terminal);
        continue;
      }

      if (!isActiveState(latest.state, activeStates)) {
        void this.requestRunCancellation(runningEntry, RUN_STOP_REASONS.inactive);
      }
    }
  }

  private async dispatchDueRetries(
    candidateIssues: Issue[],
    claimedIssueIds: ReadonlySet<string>,
    fetchBranchInfo?: () => Promise<BranchInfo | null>,
  ): Promise<Set<string>> {
    const dueRetries = [...this.state.retryAttempts.values()]
      .filter((entry) => entry.dueAtMs <= this.now())
      .sort((left, right) => left.dueAtMs - right.dueAtMs);
    if (dueRetries.length === 0) {
      return new Set();
    }

    if (!this.hasAvailableGlobalSlot()) {
      return new Set();
    }

    const candidateById = new Map(candidateIssues.map((issue) => [issue.id, issue]));
    const retriedIssueIds = new Set<string>();

    for (const retryEntry of dueRetries) {
      if (!this.hasAvailableGlobalSlot()) {
        return retriedIssueIds;
      }

      const issue = candidateById.get(retryEntry.issueId);
      const retryClaimlessIssueIds = new Set(claimedIssueIds);
      retryClaimlessIssueIds.delete(retryEntry.issueId);

      if (!issue) {
        this.state.retryAttempts.delete(retryEntry.issueId);
        retriedIssueIds.add(retryEntry.issueId);
        continue;
      }

      let latest: Issue | null;
      try {
        latest = await this.fetchDispatchIssue(issue.id);
      } catch (error) {
        console.error(JSON.stringify({
          message: "retry revalidation failed",
          issue: retryEntry.identifier,
          attempt: retryEntry.attempt,
          error: error instanceof Error ? error.message : String(error),
        }));
        continue;
      }

      if (!latest) {
        this.state.retryAttempts.delete(retryEntry.issueId);
        retriedIssueIds.add(retryEntry.issueId);
        continue;
      }

      if (!this.isDispatchEligible(latest, retryClaimlessIssueIds)) {
        if (this.shouldAbandonRetryEntry(latest)) {
          this.state.retryAttempts.delete(retryEntry.issueId);
          retriedIssueIds.add(retryEntry.issueId);
        }
        continue;
      }

      await this.dispatchIssue(latest, retryEntry.attempt, retryEntry, fetchBranchInfo);
      retriedIssueIds.add(retryEntry.issueId);
    }

    return retriedIssueIds;
  }

  private async dispatchFreshIssues(
    candidateIssues: Issue[],
    skippedIssueIds: Set<string>,
    claimedIssueIds: ReadonlySet<string>,
    fetchBranchInfo?: () => Promise<BranchInfo | null>,
  ): Promise<void> {
    if (!this.hasAvailableGlobalSlot()) {
      return;
    }

    const snapshotEligible = candidateIssues
      .filter((issue) => !skippedIssueIds.has(issue.id))
      .filter((issue) => this.isDispatchEligible(issue, claimedIssueIds));
    if (snapshotEligible.length === 0) {
      return;
    }

    for (const issue of snapshotEligible) {
      if (!this.hasAvailableGlobalSlot()) {
        return;
      }

      let latest: Issue | null;
      try {
        latest = await this.fetchDispatchIssue(issue.id);
      } catch (error) {
        console.error(JSON.stringify({
          message: "dispatch revalidation failed",
          issue: issue.identifier,
          error: error instanceof Error ? error.message : String(error),
        }));
        continue;
      }

      if (!latest || !this.isDispatchEligible(latest, claimedIssueIds)) {
        continue;
      }

      await this.dispatchIssue(latest, await this.nextFreshAttempt(latest.identifier), undefined, fetchBranchInfo);
    }
  }

  private async fetchDispatchIssue(issueId: string): Promise<Issue | null> {
    if (!issueId) {
      return null;
    }

    const [refreshedIssue] = await this.tracker.fetchIssueStatesByIds([issueId]);
    return refreshedIssue ?? null;
  }

  private shouldAbandonRetryEntry(issue: Issue): boolean {
    const { activeStates, terminalStates, assigneeId } = this.workflowStore.current().config.tracker;
    return !issue.id
      || !issue.identifier
      || !issue.title
      || !issue.state
      || !isAssignedToTracker(issue, assigneeId)
      || !isActiveState(issue.state, activeStates)
      || isTerminalState(issue.state, terminalStates);
  }

  private isDispatchEligible(issue: Issue, claimedIssueIds: ReadonlySet<string> = this.claimedIssueIds()): boolean {
    const workflow = this.workflowStore.current();
    const { activeStates, terminalStates, assigneeId } = workflow.config.tracker;

    if (!issue.id || !issue.identifier || !issue.title || !issue.state) {
      return false;
    }

    if (!isAssignedToTracker(issue, assigneeId)) {
      return false;
    }

    if (!isActiveState(issue.state, activeStates) || isTerminalState(issue.state, terminalStates)) {
      return false;
    }

    if (claimedIssueIds.has(issue.id)) {
      return false;
    }

    if (this.isBlockedByRedispatchBarrier(this.state.completed, issue)) {
      return false;
    }

    if (this.isBlockedByRedispatchBarrier(this.state.failed, issue)) {
      return false;
    }

    if (this.state.clarificationRequested.has(issue.id)) {
      return false;
    }

    if (hasActiveBlockers(issue, terminalStates)) {
      return false;
    }

    const perStateLimit = workflow.config.execution.maxConcurrentAgentsByState[normalizeLowercase(issue.state)];
    if (perStateLimit) {
      const runningInState = [...this.state.running.values()].filter((entry) => normalizeLowercase(entry.issue.state) === normalizeLowercase(issue.state)).length;
      if (runningInState >= perStateLimit) {
        return false;
      }
    }

    return this.hasAvailableGlobalSlot();
  }

  private hasAvailableGlobalSlot(): boolean {
    const workflow = this.workflowStore.current();
    return this.state.running.size < workflow.config.execution.maxConcurrentAgents;
  }

  private async nextFreshAttempt(issueIdentifier: string): Promise<number> {
    const logsRoot = this.startupInfo?.logsRoot;
    if (!logsRoot) {
      return 0;
    }

    try {
      const entries = await readdir(path.join(logsRoot, issueIdentifier), { withFileTypes: true });
      const attempts = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name.match(/^attempt-(\d+)$/))
        .filter((match): match is RegExpMatchArray => !!match)
        .map((match) => Number.parseInt(match[1], 10))
        .filter((attempt) => Number.isFinite(attempt) && attempt >= 0);
      return attempts.length > 0 ? Math.max(...attempts) + 1 : 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return 0;
      }
      throw error;
    }
  }

  private emitTriagedEvent(issue: Issue, dispatchPlan: DispatchPlan | null, opts: {
    action: "dispatch" | "request-clarification";
    labels?: string[];
    reasoning?: string | null;
    wasFallback?: boolean;
  }): void {
    this.eventBus?.emit({
      type: "issue:triaged",
      timestamp: new Date().toISOString(),
      ...issueEventFields(issue),
      action: opts.action,
      workflowName: dispatchPlan?.workflowName ?? null,
      baseBranch: dispatchPlan?.baseBranch ?? null,
      targetBranch: dispatchPlan?.targetBranch ?? null,
      mergeStrategy: dispatchPlan?.mergeStrategy ?? null,
      labels: opts.labels ?? dispatchPlan?.labelsToAdd ?? [],
      reasoning: opts.reasoning ?? dispatchPlan?.triage?.reasoning ?? null,
      wasFallback: opts.wasFallback ?? dispatchPlan?.triage?.wasFallback === true,
    });
  }

  private async buildDispatchPlan(
    issue: Issue,
    fetchBranchInfo?: () => Promise<BranchInfo | null>,
  ): Promise<DispatchPlan | null> {
    const workflow = this.workflowStore.current();
    if (!workflow.config.triage) {
      return defaultDispatchPlan(issue, this.workflowStore);
    }

    const triage = await triageIssue({
      issue,
      workflow,
      fetchBranchInfo,
    });
    if (triage.action === "request-clarification") {
      if (this.tracker.commentOnIssue) {
        try {
          await this.tracker.commentOnIssue(issue.id, triage.comment ?? "Vajra needs more detail before it can start this work.");
        } catch (error) {
          console.error(JSON.stringify({
            message: "failed to post clarification comment",
            issue: issue.identifier,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      }
      this.state.clarificationRequested.set(issue.id, clarificationBarrierVersion(issue));
      this.emitTriagedEvent(issue, null, {
        action: "request-clarification",
        reasoning: triage.reasoning ?? null,
        wasFallback: triage.wasFallback === true,
      });
      return null;
    }

    const fallbackPlan = defaultDispatchPlan(issue, this.workflowStore);
    const resolvedWorkflow = workflow.config.workflows[triage.workflowName ?? fallbackPlan.workflowName]
      ?? workflow.config.workflows[fallbackPlan.workflowName];
    const dispatchPlan: DispatchPlan = {
      workflowName: triage.workflowName ?? fallbackPlan.workflowName,
      successState: resolvedWorkflow?.successState ?? fallbackPlan.successState,
      baseBranch: triage.baseBranch ?? "main",
      targetBranch: triage.targetBranch ?? "main",
      mergeStrategy: triage.mergeStrategy ?? "pr-only",
      labelsToAdd: [...new Set(triage.labels ?? [])],
      triage,
    };

    if (dispatchPlan.labelsToAdd.length > 0 && this.tracker.addIssueLabel) {
      for (const label of dispatchPlan.labelsToAdd) {
        try {
          await this.tracker.addIssueLabel(issue.id, label);
        } catch (error) {
          console.error(JSON.stringify({
            message: "failed to add triage label",
            issue: issue.identifier,
            label,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      }
    }

    if (this.tracker.commentOnIssue) {
      try {
        await this.tracker.commentOnIssue(issue.id, formatTriageSummaryComment(dispatchPlan));
      } catch (error) {
        console.error(JSON.stringify({
          message: "failed to post triage summary comment",
          issue: issue.identifier,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }

    this.emitTriagedEvent(issue, dispatchPlan, {
      action: "dispatch",
      wasFallback: triage.wasFallback === true,
    });
    return dispatchPlan;
  }

  private async dispatchIssue(
    issue: Issue,
    attempt: number,
    retryEntry?: RetryEntry,
    fetchBranchInfo?: () => Promise<BranchInfo | null>,
  ): Promise<void> {
    const workflow = this.workflowStore.current();
    const claimedIssueIds = this.claimedIssueIds();
    if (retryEntry) {
      claimedIssueIds.delete(issue.id);
    }

    if (!this.isDispatchEligible(issue, claimedIssueIds)) {
      return;
    }

    this.dispatching.add(issue.id);
    if (retryEntry) {
      this.state.retryAttempts.delete(issue.id);
    }

    let dispatchPlan: DispatchPlan | null = retryEntry?.dispatchPlan ?? null;
    try {
      dispatchPlan = dispatchPlan ?? await this.buildDispatchPlan(issue, fetchBranchInfo);
      if (!dispatchPlan) {
        return;
      }

      const dispatchedIssue: Issue = dispatchPlan.labelsToAdd.length > 0
        ? {
            ...issue,
            labels: [...new Set([...issue.labels, ...dispatchPlan.labelsToAdd])],
          }
        : issue;

      const workspaceManager = this.createWorkspaceManager();
      const hookEnv = dispatchPlanHookEnv(dispatchPlan);
      const workspace = await workspaceManager.prepareWorkspace(dispatchedIssue.identifier, hookEnv);
      const artifactStore = new IssueArtifactStore(workflow.config.artifacts, dispatchedIssue, workspace.path);
      if (attempt === 0 || !retryEntry) {
        await artifactStore.resetRunArtifacts();
      }
      await workspaceManager.runBeforeRunHook(workspace.path, hookEnv);
      await this.prepareRun?.({
        issue: dispatchedIssue,
        workflowName: dispatchPlan.workflowName,
        workspacePath: workspace.path,
      });

      if (attempt > 0) {
        this.eventBus?.emit({
          type: "issue:retry:dispatched",
          timestamp: new Date().toISOString(),
          ...issueEventFields(dispatchedIssue),
          attempt,
        });
      }

      this.eventBus?.emit({
        type: "issue:dispatched",
        timestamp: new Date().toISOString(),
        ...issueEventFields(dispatchedIssue),
        state: dispatchedIssue.state,
        attempt,
        workspacePath: workspace.path,
        workflowName: dispatchPlan.workflowName,
        successState: dispatchPlan.successState,
        baseBranch: dispatchPlan.baseBranch,
        targetBranch: dispatchPlan.targetBranch,
        mergeStrategy: dispatchPlan.mergeStrategy,
        labelsToAdd: [...dispatchPlan.labelsToAdd],
        triaged: dispatchPlan.triage !== null,
        triageReasoning: dispatchPlan.triage?.reasoning ?? null,
        triageFallback: dispatchPlan.triage?.wasFallback === true,
      });

      const handle = this.pipelineRunner.startRun({
        issue: dispatchedIssue,
        attempt,
        workflow,
        workspacePath: workspace.path,
        dispatchPlan,
      });

      this.state.running.set(dispatchedIssue.id, {
        issue: dispatchedIssue,
        attempt,
        workspacePath: workspace.path,
        dispatchPlan,
        handle,
      });

      if (attempt === 0) {
        try {
          await this.tracker.transitionIssue(dispatchedIssue.id, "In Progress");
        } catch (error) {
          console.error(JSON.stringify({
            message: "failed to transition issue to In Progress",
            issue: dispatchedIssue.identifier,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      }

      const monitorPromise = this.monitorRunCompletion({
        issue: dispatchedIssue,
        attempt,
        workspacePath: workspace.path,
        workspaceManager,
        handle,
        maxRetryAttempts: workflow.config.execution.maxRetryAttempts,
        maxRetryBackoffMs: workflow.config.execution.maxRetryBackoffMs,
        successState: dispatchPlan.successState,
        dispatchPlan,
      }).catch((error) => {
        console.error(JSON.stringify({
          message: "pipeline monitor failed",
          issue: dispatchedIssue.identifier,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        }));
      });
      this.monitorTasks.add(monitorPromise);
      void monitorPromise.finally(() => {
        this.monitorTasks.delete(monitorPromise);
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({
        message: "issue dispatch failed before run start",
        issue: issue.identifier,
        attempt,
        error: errorMessage,
      }));
      this.handleRunFailure({
        issue,
        attempt,
        maxRetryAttempts: workflow.config.execution.maxRetryAttempts,
        maxRetryBackoffMs: workflow.config.execution.maxRetryBackoffMs,
        error: errorMessage,
        failedStageId: null,
        dispatchPlan: dispatchPlan ?? undefined,
      });
      this.requestTick();
    } finally {
      this.dispatching.delete(issue.id);
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.eventBus?.emit({
      type: "orchestrator:shutdown",
      timestamp: new Date().toISOString(),
    });

    const runningEntries = [...this.state.running.values()];
    await Promise.all(runningEntries.map((entry) => this.requestRunCancellation(entry, RUN_STOP_REASONS.shutdown)));
    await Promise.allSettled([...this.monitorTasks]);
  }

  private scheduleRetry(opts: {
    issue: Issue;
    attempt: number;
    maxRetryBackoffMs: number;
    error: string;
    failedStageId: string | null;
    dispatchPlan?: DispatchPlan;
  }): void {
    const retryAttempt = opts.attempt + 1;
    const dueAtMs = this.now() + retryBackoffMs(retryAttempt, opts.maxRetryBackoffMs);
    const retryEntry: RetryEntry = {
      issueId: opts.issue.id,
      identifier: opts.issue.identifier,
      attempt: retryAttempt,
      dueAtMs,
      error: opts.error,
      dispatchPlan: opts.dispatchPlan,
    };

    this.state.retryAttempts.set(opts.issue.id, retryEntry);
    this.eventBus?.emit({
      type: "issue:retry:scheduled",
      timestamp: new Date().toISOString(),
      ...issueEventFields(opts.issue),
      attempt: retryAttempt,
      dueAtMs,
      error: retryEntry.error ?? null,
    });
  }

  private failIssue(opts: {
    issue: Issue;
    attempt: number;
    error: string;
    failedStageId: string | null;
    failureClass?: "auth" | "rate-limit";
  }): void {
    this.state.retryAttempts.delete(opts.issue.id);
    this.state.failed.set(opts.issue.id, opts.issue.state);
    this.eventBus?.emit({
      type: "issue:failed",
      timestamp: new Date().toISOString(),
      ...issueEventFields(opts.issue),
      error: opts.error,
      failedStageId: opts.failedStageId,
      attempt: opts.attempt,
      failureClass: opts.failureClass ?? null,
    });
  }

  private handleRunFailure(opts: {
    issue: Issue;
    attempt: number;
    maxRetryAttempts: number;
    maxRetryBackoffMs: number;
    error: string;
    failedStageId: string | null;
    dispatchPlan?: DispatchPlan;
    failureClass?: "auth" | "rate-limit";
  }): void {
    // Auth failures and rate-limit failures are terminal — retrying against
    // the same credential will produce the same error immediately.
    if (opts.failureClass === "auth" || opts.failureClass === "rate-limit") {
      this.failIssue({
        issue: opts.issue,
        attempt: opts.attempt,
        error: opts.error,
        failedStageId: opts.failedStageId,
        failureClass: opts.failureClass,
      });
      return;
    }

    if (opts.attempt < opts.maxRetryAttempts) {
      this.scheduleRetry({
        issue: opts.issue,
        attempt: opts.attempt,
        maxRetryBackoffMs: opts.maxRetryBackoffMs,
        error: opts.error,
        failedStageId: opts.failedStageId,
        dispatchPlan: opts.dispatchPlan,
      });
      return;
    }

    this.failIssue({
      issue: opts.issue,
      attempt: opts.attempt,
      error: opts.error,
      failedStageId: opts.failedStageId,
    });
  }

  private async monitorRunCompletion(opts: {
    issue: Issue;
    attempt: number;
    workspacePath: string;
    workspaceManager: WorkspaceManager;
    handle: ReturnType<PipelineRunner["startRun"]>;
    maxRetryAttempts: number;
    maxRetryBackoffMs: number;
    successState: string;
    dispatchPlan: DispatchPlan;
  }): Promise<void> {
    try {
      const result = await opts.handle.promise;
      const runningEntry = this.state.running.get(opts.issue.id);
      const latestIssue = runningEntry?.issue ?? opts.issue;
      this.state.running.delete(opts.issue.id);
      await opts.workspaceManager.runAfterRunHook(opts.workspacePath);

      if (result.status === "success") {
        this.state.failed.delete(opts.issue.id);
        this.state.completed.set(opts.issue.id, latestIssue.state);

        const revisionLabel = this.workflowStore.current().config.github?.revisionLabel ?? null;
        if (revisionLabel && hasIssueLabel(latestIssue, revisionLabel) && this.tracker.removeIssueLabel) {
          try {
            await this.tracker.removeIssueLabel(latestIssue.id, revisionLabel);
          } catch (error) {
            console.error(JSON.stringify({
              message: "failed to remove internal revision label",
              issue: latestIssue.identifier,
              error: error instanceof Error ? error.message : String(error),
            }));
          }
        }

        try {
          await this.tracker.transitionIssue(latestIssue.id, opts.successState);
        } catch (error) {
          this.state.completed.delete(opts.issue.id);
          console.error(JSON.stringify({
            message: "failed to transition issue",
            issue: latestIssue.identifier,
            error: error instanceof Error ? error.message : String(error),
          }));
        }

        const githubConfig = this.workflowStore.current().config.github;
        let persistedPrPromise: Promise<Awaited<ReturnType<typeof this.loadPersistedPullRequest>>> | null = null;
        const loadPersistedPr = async () => {
          if (!persistedPrPromise) {
            persistedPrPromise = this.loadPersistedPullRequest(latestIssue.identifier);
          }
          return persistedPrPromise;
        };
        if (opts.dispatchPlan.mergeStrategy === "auto-merge" && githubConfig) {
          const github = new GitHubClient(githubConfig);
          const persistedPr = result.pr?.number ? null : await loadPersistedPr();
          const prNumber = result.pr?.number ?? persistedPr?.number ?? null;
          if (prNumber) {
            try {
              await github.enablePullRequestAutoMerge(
                githubConfig.repository,
                prNumber,
              );
            } catch (error) {
              console.error(JSON.stringify({
                message: "failed to enable auto-merge",
                issue: latestIssue.identifier,
                prNumber,
                error: error instanceof Error ? error.message : String(error),
              }));
            }
          }
        }

        this.requestTick();
        const persistedPr = this.eventBus && !result.pr?.url && !result.prUrl
          ? await loadPersistedPr()
          : null;
        this.eventBus?.emit({
          type: "issue:completed",
          timestamp: new Date().toISOString(),
          ...issueEventFields(latestIssue),
          completedNodes: result.completedNodes,
          prUrl: result.pr?.url ?? result.prUrl ?? persistedPr?.url ?? null,
        });
        return;
      }

      if (result.status === "wait_human") {
        this.state.failed.delete(opts.issue.id);
        this.state.completed.set(opts.issue.id, latestIssue.state);

        const escalationConfig = this.workflowStore.current().config.escalation;
        if (escalationConfig) {
          try {
            await this.tracker.transitionIssue(latestIssue.id, escalationConfig.linearState);
          } catch (error) {
            console.error(JSON.stringify({
              message: "failed to transition issue to escalation state",
              issue: latestIssue.identifier,
              state: escalationConfig.linearState,
              error: error instanceof Error ? error.message : String(error),
            }));
          }

          if (escalationConfig.comment && this.tracker.commentOnIssue) {
            try {
              await this.tracker.commentOnIssue(
                latestIssue.id,
                formatEscalationComment(result.error ?? "Vajra needs human review."),
              );
            } catch (error) {
              console.error(JSON.stringify({
                message: "failed to post escalation comment",
                issue: latestIssue.identifier,
                error: error instanceof Error ? error.message : String(error),
              }));
            }
          }
        }

        this.requestTick();
        this.eventBus?.emit({
          type: "issue:escalated",
          timestamp: new Date().toISOString(),
          ...issueEventFields(latestIssue),
          completedNodes: result.completedNodes,
          reason: result.error ?? "Vajra needs human review.",
        });
        return;
      }

      if (result.status === "cancelled") {
        if (shouldCleanupCancelledWorkspace(runningEntry?.stopReason)) {
          try {
            await opts.workspaceManager.cleanupWorkspace(latestIssue.identifier);
          } catch (error) {
            console.error(JSON.stringify({
              message: "workspace cleanup failed after cancellation",
              issue: latestIssue.identifier,
              reason: runningEntry?.stopReason,
              error: error instanceof Error ? error.message : String(error),
            }));
          }
        }
        this.eventBus?.emit({
          type: "issue:cancelled",
          timestamp: new Date().toISOString(),
          ...issueEventFields(latestIssue),
          reason: runningEntry?.stopReason ?? result.error ?? "pipeline cancelled",
        });
        this.requestTick();
        return;
      }

      this.handleRunFailure({
        issue: latestIssue,
        attempt: opts.attempt,
        maxRetryAttempts: opts.maxRetryAttempts,
        maxRetryBackoffMs: opts.maxRetryBackoffMs,
        error: result.error ?? "unknown",
        failedStageId: result.failedStageId ?? null,
        dispatchPlan: opts.dispatchPlan,
        failureClass: result.failureClass,
      });
      this.requestTick();
    } catch (error) {
      const runningEntry = this.state.running.get(opts.issue.id);
      const latestIssue = runningEntry?.issue ?? opts.issue;
      this.state.running.delete(opts.issue.id);
      await opts.workspaceManager.runAfterRunHook(opts.workspacePath);

      this.handleRunFailure({
        issue: latestIssue,
        attempt: opts.attempt,
        maxRetryAttempts: opts.maxRetryAttempts,
        maxRetryBackoffMs: opts.maxRetryBackoffMs,
        error: error instanceof Error ? error.message : String(error),
        failedStageId: null,
        dispatchPlan: opts.dispatchPlan,
      });
      this.requestTick();
    }
  }
}

import { VajraEventBus } from "../events";
import { VajraOrchestrator } from "../orchestrator";
import { MutableWorkflowStore } from "../types";
import { RunningEntry, RetryEntry } from "../types";
import { ApiRetryAttempt, ApiRunningIssue, ApiStateBarrierEntry, ApiStateSnapshot } from "./types";

function compareString(left: string, right: string): number {
  return left.localeCompare(right);
}

function runningIssue(entry: RunningEntry): ApiRunningIssue {
  return {
    issueId: entry.issue.id,
    issueIdentifier: entry.issue.identifier,
    issueTitle: entry.issue.title,
    state: entry.issue.state,
    attempt: entry.attempt,
    workspacePath: entry.workspacePath,
    stopReason: entry.stopReason ?? null,
  };
}

function retryAttempt(entry: RetryEntry): ApiRetryAttempt {
  return {
    issueId: entry.issueId,
    issueIdentifier: entry.identifier,
    attempt: entry.attempt,
    dueAtMs: entry.dueAtMs,
    dueAt: new Date(entry.dueAtMs).toISOString(),
    error: entry.error ?? null,
  };
}

function stateBarrierEntry(issueId: string, state: string): ApiStateBarrierEntry {
  return { issueId, state };
}

export class RuntimeStateTracker {
  private startedAt: string | null = null;

  private lastTickAt: string | null = null;

  private readonly startedListener = (event: { timestamp: string }) => {
    this.startedAt = event.timestamp;
  };

  private readonly tickListener = (event: { timestamp: string }) => {
    this.lastTickAt = event.timestamp;
  };

  constructor(
    private readonly orchestrator: VajraOrchestrator,
    private readonly eventBus: VajraEventBus,
    private readonly workflowStore?: MutableWorkflowStore,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.eventBus.on("orchestrator:started", this.startedListener);
    this.eventBus.on("orchestrator:tick", this.tickListener);
  }

  close(): void {
    this.eventBus.off("orchestrator:started", this.startedListener);
    this.eventBus.off("orchestrator:tick", this.tickListener);
  }

  snapshot(): ApiStateSnapshot {
    const nowMs = this.now();
    const running = [...this.orchestrator.state.running.values()]
      .map((entry) => runningIssue(entry))
      .sort((left, right) => compareString(left.issueIdentifier, right.issueIdentifier));
    const retryAttempts = [...this.orchestrator.state.retryAttempts.values()]
      .map((entry) => retryAttempt(entry))
      .sort((left, right) => left.dueAtMs - right.dueAtMs || compareString(left.issueIdentifier, right.issueIdentifier));
    const completed = [...this.orchestrator.state.completed.entries()]
      .map(([issueId, state]) => stateBarrierEntry(issueId, state))
      .sort((left, right) => compareString(left.issueId, right.issueId));
    const failed = [...this.orchestrator.state.failed.entries()]
      .map(([issueId, state]) => stateBarrierEntry(issueId, state))
      .sort((left, right) => compareString(left.issueId, right.issueId));
    const waitingCount = retryAttempts.filter((entry) => entry.dueAtMs > nowMs).length;

    return {
      startedAt: this.startedAt,
      lastTickAt: this.lastTickAt,
      workflowReloadError: this.readWorkflowReloadError(),
      uptimeMs: this.startedAt ? Math.max(0, nowMs - Date.parse(this.startedAt)) : null,
      activeCount: running.length,
      retryingCount: retryAttempts.length,
      waitingCount,
      claimedCount: this.orchestrator.state.claimed.size,
      completedBarrierCount: completed.length,
      failedBarrierCount: failed.length,
      nextRetryAt: retryAttempts[0]?.dueAt ?? null,
      running,
      retryAttempts,
      completed,
      failed,
    };
  }

  private readWorkflowReloadError(): string | null {
    return typeof this.workflowStore?.reloadStatus === "function"
      ? this.workflowStore.reloadStatus().lastReloadError
      : null;
  }
}

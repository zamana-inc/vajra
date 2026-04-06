import { Issue, SlackConfig, WorkflowStore } from "../types";
import {
  IssueCancelledEvent,
  IssueCompletedEvent,
  IssueDispatchedEvent,
  IssueEscalatedEvent,
  IssueFailedEvent,
  VajraEventBus,
} from "../events";
import { SlackNotifier } from "../slack";

type NotifierLike = Pick<SlackNotifier, "notifyPipelineSuccess" | "notifyPipelineFailure" | "notifyHumanReviewRequired">;

function issueFromEvent(event: {
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  issueUrl: string | null;
  issueCreatorId: string | null;
}): Issue {
  return {
    id: event.issueId,
    identifier: event.issueIdentifier,
    title: event.issueTitle,
    description: null,
    state: "",
    priority: null,
    labels: [],
    assigneeId: null,
    creatorId: event.issueCreatorId,
    createdAt: null,
    updatedAt: null,
    url: event.issueUrl,
    blockedBy: [],
  };
}

export class SlackEventSubscriber {
  private readonly notifiedFailureIssueIds = new Map<string, number>();

  private readonly dispatchListener = (event: IssueDispatchedEvent) => {
    if (event.attempt === 0) {
      this.clearFailureNotification(event.issueId);
    }
  };

  private readonly successListener = (event: IssueCompletedEvent) => {
    void this.handleSuccess(event);
  };

  private readonly failureListener = (event: IssueFailedEvent) => {
    void this.handleFailure(event);
  };

  private readonly escalatedListener = (event: IssueEscalatedEvent) => {
    void this.handleEscalation(event);
  };

  private readonly cancelledListener = (event: IssueCancelledEvent) => {
    this.clearFailureNotification(event.issueId);
  };

  constructor(
    private readonly eventBus: VajraEventBus,
    private readonly workflowStore: WorkflowStore,
    private readonly createNotifier: (config: SlackConfig) => NotifierLike =
      (config) => new SlackNotifier(config),
    private readonly maxFailureCacheEntries = 1_000,
  ) {
    this.eventBus.on("issue:dispatched", this.dispatchListener);
    this.eventBus.on("issue:completed", this.successListener);
    this.eventBus.on("issue:escalated", this.escalatedListener);
    this.eventBus.on("issue:failed", this.failureListener);
    this.eventBus.on("issue:cancelled", this.cancelledListener);
  }

  close(): void {
    this.eventBus.off("issue:dispatched", this.dispatchListener);
    this.eventBus.off("issue:completed", this.successListener);
    this.eventBus.off("issue:escalated", this.escalatedListener);
    this.eventBus.off("issue:failed", this.failureListener);
    this.eventBus.off("issue:cancelled", this.cancelledListener);
  }

  private notifier(): NotifierLike | null {
    const slackConfig = this.workflowStore.current().config.slack;
    if (!slackConfig) {
      return null;
    }

    return this.createNotifier(slackConfig);
  }

  private async handleSuccess(event: IssueCompletedEvent): Promise<void> {
    this.clearFailureNotification(event.issueId);
    const notifier = this.notifier();
    const slackConfig = this.workflowStore.current().config.slack;
    if (!notifier || !slackConfig?.notifyOnSuccess) {
      return;
    }

    try {
      await notifier.notifyPipelineSuccess({
        issue: issueFromEvent(event),
        prUrl: event.prUrl,
      });
    } catch (error) {
      console.error(JSON.stringify({
        message: "slack notification failed",
        issueId: event.issueId,
        issueIdentifier: event.issueIdentifier,
        status: event.type,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  private async handleFailure(event: IssueFailedEvent): Promise<void> {
    // Auth and rate-limit failures always notify — they require human action
    // (re-login or wait for reset) and should not be silently suppressed.
    const isCredentialFailure = event.failureClass === "auth" || event.failureClass === "rate-limit";

    if (!isCredentialFailure && this.notifiedFailureIssueIds.has(event.issueId)) {
      return;
    }

    const notifier = this.notifier();
    const slackConfig = this.workflowStore.current().config.slack;
    if (!notifier || !slackConfig?.notifyOnFailure) {
      return;
    }

    this.rememberFailureNotification(event.issueId);
    try {
      const prefix = event.failureClass === "auth"
        ? "\ud83d\udd11 Auth failure"
        : event.failureClass === "rate-limit"
          ? "\u26a0\ufe0f Rate limit"
          : undefined;

      await notifier.notifyPipelineFailure({
        issue: issueFromEvent(event),
        error: prefix ? `${prefix}: ${event.error}` : event.error,
        stage: event.failedStageId ?? undefined,
      });
    } catch (error) {
      this.clearFailureNotification(event.issueId);
      console.error(JSON.stringify({
        message: "slack notification failed",
        issueId: event.issueId,
        issueIdentifier: event.issueIdentifier,
        status: event.type,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  private async handleEscalation(event: IssueEscalatedEvent): Promise<void> {
    this.clearFailureNotification(event.issueId);
    const notifier = this.notifier();
    const escalationConfig = this.workflowStore.current().config.escalation;
    if (!notifier || !escalationConfig?.slackNotify) {
      return;
    }

    try {
      await notifier.notifyHumanReviewRequired({
        issue: issueFromEvent(event),
        reason: event.reason,
      });
    } catch (error) {
      console.error(JSON.stringify({
        message: "slack notification failed",
        issueId: event.issueId,
        issueIdentifier: event.issueIdentifier,
        status: event.type,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  private clearFailureNotification(issueId: string): void {
    this.notifiedFailureIssueIds.delete(issueId);
  }

  private rememberFailureNotification(issueId: string): void {
    this.notifiedFailureIssueIds.delete(issueId);
    this.notifiedFailureIssueIds.set(issueId, Date.now());

    while (this.notifiedFailureIssueIds.size > this.maxFailureCacheEntries) {
      const oldestIssueId = this.notifiedFailureIssueIds.keys().next().value;
      if (!oldestIssueId) {
        break;
      }
      this.notifiedFailureIssueIds.delete(oldestIssueId);
    }
  }
}

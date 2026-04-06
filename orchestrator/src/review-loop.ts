import { readdir } from "node:fs/promises";

import { ReviewArtifactStore } from "./artifacts";
import {
  extractIssueIdentifierFromBranch,
  extractRevisionCommand,
  GitHubClient,
  GitHubIssueComment,
  GitHubPullRequestDetails,
  GitHubReview,
  GitHubReviewComment,
  isPullRequestIssueComment,
  parseGitHubWebhookRequest,
} from "./github";
import {
  Issue,
  MutableWorkflowStore,
  PullRequestRecord,
  ReviewRequestState,
  TrackerClient,
} from "./types";

type FetchLike = typeof fetch;

export interface ReviewLoopResult {
  statusCode: number;
  body: Record<string, unknown>;
}

type PullRequestRef = {
  repository: string;
  number: number;
  url: string | null;
  title: string | null;
  headRefName: string | null;
  headSha: string | null;
  state: string | null;
  merged: boolean;
};

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeRepository(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function processedDeliveries(deliveryId: string, previous: string[]): string[] {
  return [...new Set([...previous, deliveryId])].slice(-20);
}

function hasLabel(issue: Issue, labelName: string): boolean {
  const normalized = normalizeText(labelName).toLowerCase();
  return issue.labels.some((label) => normalizeText(label).toLowerCase() === normalized);
}

function compareTimestamp(left: string | null | undefined, right: string): boolean {
  const leftMs = Date.parse(String(left ?? ""));
  const rightMs = Date.parse(right);
  if (Number.isNaN(leftMs) || Number.isNaN(rightMs)) {
    return false;
  }
  return leftMs >= rightMs;
}

function pullRequestRefFromPayload(event: string, payload: Record<string, unknown>): PullRequestRef | null {
  const repository = payload.repository && typeof payload.repository === "object"
    ? normalizeText((payload.repository as Record<string, unknown>).full_name)
    : "";
  if (!repository) {
    return null;
  }

  if (event === "issue_comment") {
    const issue = payload.issue && typeof payload.issue === "object" ? payload.issue as Record<string, unknown> : null;
    if (!issue) {
      return null;
    }

    const number = typeof issue.number === "number" ? issue.number : Number(issue.number ?? 0);
    if (!Number.isFinite(number) || number <= 0) {
      return null;
    }

    return {
      repository,
      number,
      url: null,
      title: typeof issue.title === "string" ? issue.title : null,
      headRefName: null,
      headSha: null,
      state: null,
      merged: false,
    };
  }

  const pullRequest = payload.pull_request && typeof payload.pull_request === "object"
    ? payload.pull_request as Record<string, unknown>
    : null;
  if (!pullRequest) {
    return null;
  }

  const head = pullRequest.head && typeof pullRequest.head === "object" ? pullRequest.head as Record<string, unknown> : {};
  const number = typeof pullRequest.number === "number" ? pullRequest.number : Number(pullRequest.number ?? 0);
  if (!Number.isFinite(number) || number <= 0) {
    return null;
  }

  return {
    repository,
    number,
    url: typeof pullRequest.html_url === "string" ? pullRequest.html_url : null,
    title: typeof pullRequest.title === "string" ? pullRequest.title : null,
    headRefName: typeof head.ref === "string" ? head.ref : null,
    headSha: typeof head.sha === "string" ? head.sha : null,
    state: typeof pullRequest.state === "string" ? pullRequest.state : null,
    merged: pullRequest.merged === true,
  };
}

function pullRequestRecord(issueIdentifier: string, pullRequest: PullRequestRef | GitHubPullRequestDetails): PullRequestRecord {
  return {
    issueIdentifier,
    repository: pullRequest.repository,
    number: pullRequest.number ?? 0,
    url: pullRequest.url ?? "",
    title: pullRequest.title ?? null,
    headRefName: pullRequest.headRefName ?? null,
    headSha: pullRequest.headSha ?? null,
    state: pullRequest.state ?? null,
    updatedAt: new Date().toISOString(),
  };
}

function renderCommentList<T extends {
  body: string | null;
  userLogin: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  htmlUrl: string | null;
}>(title: string, entries: T[], formatter?: (entry: T) => string): string[] {
  const lines = [`## ${title}`];
  if (entries.length === 0) {
    lines.push("None.");
    return lines;
  }

  for (const [index, entry] of entries.entries()) {
    const actor = entry.userLogin ?? "unknown";
    const when = entry.updatedAt ?? entry.createdAt ?? "unknown time";
    lines.push(`${index + 1}. ${actor} at ${when}${entry.htmlUrl ? ` (${entry.htmlUrl})` : ""}`);
    lines.push(formatter ? formatter(entry) : (entry.body?.trim() || "(no body)"));
  }
  return lines;
}

export class ReviewLoopService {
  constructor(
    private readonly workflowStore: MutableWorkflowStore,
    private readonly tracker: TrackerClient,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async handleWebhook(opts: {
    rawBody: string;
    headers: Record<string, string | string[] | undefined>;
  }): Promise<ReviewLoopResult> {
    const github = this.workflowStore.current().config.github;
    if (!github) {
      return {
        statusCode: 404,
        body: { error: "github integration not configured" },
      };
    }

    let envelope;
    try {
      envelope = parseGitHubWebhookRequest({
        rawBody: opts.rawBody,
        headers: opts.headers,
        secret: github.webhookSecret,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        statusCode: message === "invalid GitHub webhook signature" ? 401 : 400,
        body: { error: message },
      };
    }

    if (envelope.event === "ping") {
      return {
        statusCode: 200,
        body: { ok: true },
      };
    }

    if (envelope.event === "pull_request_review") {
      const action = normalizeText(envelope.payload.action).toLowerCase();
      const review = envelope.payload.review && typeof envelope.payload.review === "object"
        ? envelope.payload.review as Record<string, unknown>
        : null;
      const reviewState = normalizeText(review?.state).toLowerCase();
      if (action !== "submitted" || reviewState !== "changes_requested") {
        return { statusCode: 202, body: { ignored: true, reason: "review action ignored" } };
      }

      return this.handleRevisionRequest({
        envelope: {
          deliveryId: envelope.deliveryId,
          event: envelope.event,
          payload: envelope.payload,
        },
        trigger: {
          type: "changes_requested",
          requestedAt: normalizeText(review?.submitted_at) || new Date().toISOString(),
          reviewId: typeof review?.id === "number" ? review.id : Number(review?.id ?? 0) || null,
          commentId: null,
          actor: review?.user && typeof review.user === "object"
            ? normalizeText((review.user as Record<string, unknown>).login) || null
            : null,
          command: null,
        },
      });
    }

    if (envelope.event === "issue_comment") {
      if (!isPullRequestIssueComment(envelope.payload)) {
        return { statusCode: 202, body: { ignored: true, reason: "not a pull request comment" } };
      }

      const comment = envelope.payload.comment && typeof envelope.payload.comment === "object"
        ? envelope.payload.comment as Record<string, unknown>
        : null;
      const command = extractRevisionCommand(typeof comment?.body === "string" ? comment.body : null, github.revisionCommand);
      if (!command) {
        return { statusCode: 202, body: { ignored: true, reason: "no revision command" } };
      }

      return this.handleRevisionRequest({
        envelope: {
          deliveryId: envelope.deliveryId,
          event: envelope.event,
          payload: envelope.payload,
        },
        trigger: {
          type: "command",
          requestedAt: normalizeText(comment?.created_at) || new Date().toISOString(),
          reviewId: null,
          commentId: typeof comment?.id === "number" ? comment.id : Number(comment?.id ?? 0) || null,
          actor: comment?.user && typeof comment.user === "object"
            ? normalizeText((comment.user as Record<string, unknown>).login) || null
            : null,
          command,
        },
      });
    }

    if (envelope.event === "pull_request") {
      const action = normalizeText(envelope.payload.action).toLowerCase();
      if (action !== "closed") {
        return { statusCode: 202, body: { ignored: true, reason: "pull_request action ignored" } };
      }

      return this.handleClosedPullRequest(envelope.payload);
    }

    return {
      statusCode: 202,
      body: { ignored: true, reason: "event ignored" },
    };
  }

  async prepareRun(opts: {
    issue: Issue;
    workflowName: string;
  }): Promise<void> {
    const config = this.workflowStore.current().config.github;
    if (!config) {
      return;
    }

    const revisionLabel = config.revisionLabel.trim().toLowerCase();
    const isRevisionRun = opts.workflowName === "revision"
      || opts.issue.labels.some((label) => label.trim().toLowerCase() === revisionLabel);
    if (!isRevisionRun) {
      return;
    }

    const artifactStore = new ReviewArtifactStore(this.workflowStore.current().config.artifacts, opts.issue.identifier);
    const prRecord = await artifactStore.loadPrRecord();
    const reviewState = await artifactStore.loadReviewState();
    if (!prRecord || !reviewState) {
      return;
    }

    const github = new GitHubClient(config, this.fetchImpl);
    const [pullRequest, reviews, issueComments, reviewComments] = await Promise.all([
      github.fetchPullRequest(prRecord.repository, prRecord.number),
      github.listPullRequestReviews(prRecord.repository, prRecord.number),
      github.listIssueComments(prRecord.repository, prRecord.number),
      github.listReviewComments(prRecord.repository, prRecord.number),
    ]);

    await artifactStore.savePrRecord(pullRequestRecord(opts.issue.identifier, pullRequest));
    const compiled = this.compileFeedback({
      issueIdentifier: opts.issue.identifier,
      reviewState,
      pullRequest,
      reviews,
      issueComments,
      reviewComments,
      revisionCommand: config.revisionCommand,
    });
    await artifactStore.saveReviewFeedback(compiled.markdown, compiled.payload);
  }

  private async handleRevisionRequest(opts: {
    envelope: {
      deliveryId: string;
      event: string;
      payload: Record<string, unknown>;
    };
    trigger: Omit<ReviewRequestState["trigger"], "deliveryId">;
  }): Promise<ReviewLoopResult> {
    const githubConfig = this.workflowStore.current().config.github;
    if (!githubConfig) {
      return { statusCode: 404, body: { error: "github integration not configured" } };
    }

    const pullRequest = await this.resolvePullRequest(opts.envelope.event, opts.envelope.payload);
    if (!pullRequest) {
      return { statusCode: 202, body: { ignored: true, reason: "pull request not found" } };
    }

    const issueIdentifier = await this.findIssueIdentifier(pullRequest);
    if (!issueIdentifier) {
      return { statusCode: 202, body: { ignored: true, reason: "issue mapping not found" } };
    }

    if (!this.tracker.fetchIssueByIdentifier || !this.tracker.addIssueLabel) {
      throw new Error("tracker does not support review-loop mutations");
    }

    const issue = await this.tracker.fetchIssueByIdentifier(issueIdentifier);
    if (!issue) {
      return { statusCode: 202, body: { ignored: true, reason: "linear issue not found", issueIdentifier } };
    }

    const artifactStore = new ReviewArtifactStore(this.workflowStore.current().config.artifacts, issueIdentifier);
    const existingState = await artifactStore.loadReviewState();
    if (existingState?.processedDeliveryIds.includes(opts.envelope.deliveryId)) {
      return { statusCode: 200, body: { ok: true, duplicate: true, issueIdentifier } };
    }

    await artifactStore.savePrRecord(pullRequestRecord(issueIdentifier, pullRequest));

    // Side effects first — if these fail, the delivery ID is NOT persisted
    // so GitHub retries will re-attempt the label + transition.
    if (!hasLabel(issue, githubConfig.revisionLabel)) {
      await this.tracker.addIssueLabel(issue.id, githubConfig.revisionLabel);
    }
    if (issue.state.trim().toLowerCase() !== githubConfig.revisionState.trim().toLowerCase()) {
      await this.tracker.transitionIssue(issue.id, githubConfig.revisionState);
    }

    // Only mark as processed after side effects succeed.
    await artifactStore.saveReviewState({
      issueIdentifier,
      repository: pullRequest.repository,
      prNumber: pullRequest.number,
      prUrl: pullRequest.url,
      processedDeliveryIds: processedDeliveries(opts.envelope.deliveryId, existingState?.processedDeliveryIds ?? []),
      trigger: {
        deliveryId: opts.envelope.deliveryId,
        ...opts.trigger,
      },
      updatedAt: new Date().toISOString(),
    });

    return {
      statusCode: 202,
      body: {
        ok: true,
        issueIdentifier,
        workflow: "revision",
      },
    };
  }

  private async handleClosedPullRequest(payload: Record<string, unknown>): Promise<ReviewLoopResult> {
    const githubConfig = this.workflowStore.current().config.github;
    if (!githubConfig) {
      return { statusCode: 404, body: { error: "github integration not configured" } };
    }

    const pullRequest = await this.resolvePullRequest("pull_request", payload);
    if (!pullRequest) {
      return { statusCode: 202, body: { ignored: true, reason: "pull request not found" } };
    }

    const issueIdentifier = await this.findIssueIdentifier(pullRequest);
    if (!issueIdentifier) {
      return { statusCode: 202, body: { ignored: true, reason: "issue mapping not found" } };
    }

    if (!this.tracker.fetchIssueByIdentifier || !this.tracker.removeIssueLabel) {
      throw new Error("tracker does not support review-loop mutations");
    }

    const issue = await this.tracker.fetchIssueByIdentifier(issueIdentifier);
    if (!issue) {
      return { statusCode: 202, body: { ignored: true, reason: "linear issue not found", issueIdentifier } };
    }

    const artifactStore = new ReviewArtifactStore(this.workflowStore.current().config.artifacts, issueIdentifier);
    await artifactStore.savePrRecord(pullRequestRecord(issueIdentifier, pullRequest));
    if (hasLabel(issue, githubConfig.revisionLabel)) {
      await this.tracker.removeIssueLabel(issue.id, githubConfig.revisionLabel);
    }

    const targetState = pullRequest.merged
      ? githubConfig.mergedState
      : githubConfig.closedState;
    if (targetState && issue.state.trim().toLowerCase() !== targetState.trim().toLowerCase()) {
      await this.tracker.transitionIssue(issue.id, targetState);
    }

    return {
      statusCode: 202,
      body: {
        ok: true,
        issueIdentifier,
        merged: pullRequest.merged,
      },
    };
  }

  private async resolvePullRequest(event: string, payload: Record<string, unknown>): Promise<PullRequestRef | null> {
    const config = this.workflowStore.current().config.github;
    if (!config) {
      return null;
    }

    const fromPayload = pullRequestRefFromPayload(event, payload);
    if (!fromPayload) {
      return null;
    }

    if (fromPayload.headRefName && fromPayload.headSha && fromPayload.url) {
      return fromPayload;
    }

    const github = new GitHubClient(config, this.fetchImpl);
    const pullRequest = await github.fetchPullRequest(fromPayload.repository, fromPayload.number);
    return {
      repository: pullRequest.repository,
      number: pullRequest.number,
      url: pullRequest.url,
      title: pullRequest.title ?? null,
      headRefName: pullRequest.headRefName ?? null,
      headSha: pullRequest.headSha ?? null,
      state: pullRequest.state ?? null,
      merged: pullRequest.merged,
    };
  }

  private async findIssueIdentifier(pullRequest: PullRequestRef): Promise<string | null> {
    const artifactsRoot = this.workflowStore.current().config.artifacts.root;
    try {
      const entries = await readdir(artifactsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const artifactStore = new ReviewArtifactStore(
          this.workflowStore.current().config.artifacts,
          entry.name,
        );
        const prRecord = await artifactStore.loadPrRecord();
        if (!prRecord || !prRecord.repository || !prRecord.number) {
          continue;
        }

        if (normalizeRepository(prRecord.repository) === normalizeRepository(pullRequest.repository)
          && prRecord.number === pullRequest.number) {
          return prRecord.issueIdentifier ?? entry.name;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    return extractIssueIdentifierFromBranch(pullRequest.headRefName);
  }

  private compileFeedback(opts: {
    issueIdentifier: string;
    reviewState: ReviewRequestState;
    pullRequest: GitHubPullRequestDetails;
    reviews: GitHubReview[];
    issueComments: GitHubIssueComment[];
    reviewComments: GitHubReviewComment[];
    revisionCommand: string;
  }): {
    markdown: string;
    payload: Record<string, unknown>;
  } {
    const review = opts.reviewState.trigger.reviewId
      ? opts.reviews.find((entry) => entry.id === opts.reviewState.trigger.reviewId) ?? null
      : opts.reviews
        .filter((entry) => entry.state === "changes_requested")
        .sort((left, right) => Date.parse(right.submittedAt ?? "") - Date.parse(left.submittedAt ?? ""))
        [0] ?? null;
    const relevantReviewComments = review
      ? opts.reviewComments.filter((entry) => entry.reviewId === review.id && !entry.isBot)
      : opts.reviewComments.filter((entry) => !entry.isBot && compareTimestamp(entry.updatedAt ?? entry.createdAt, opts.reviewState.trigger.requestedAt));
    const relevantIssueComments = opts.issueComments
      .filter((entry) => !entry.isBot)
      .filter((entry) => compareTimestamp(entry.updatedAt ?? entry.createdAt, opts.reviewState.trigger.requestedAt))
      .filter((entry) => entry.body?.trim() && entry.body.trim() !== opts.revisionCommand);

    const markdown = [
      "# Review Feedback",
      "",
      `- Issue: ${opts.issueIdentifier}`,
      `- PR: ${opts.pullRequest.url}`,
      `- Trigger: ${opts.reviewState.trigger.type} by ${opts.reviewState.trigger.actor ?? "unknown"} at ${opts.reviewState.trigger.requestedAt}`,
      `- Compiled At: ${new Date().toISOString()}`,
      `- Head Branch: ${opts.pullRequest.headRefName ?? ""}`,
      `- Head SHA: ${opts.pullRequest.headSha ?? ""}`,
      "",
      "## Review Summary",
      review
        ? [
            `Reviewer: ${review.userLogin ?? "unknown"}`,
            `Submitted At: ${review.submittedAt ?? "unknown"}`,
            review.htmlUrl ? `Review URL: ${review.htmlUrl}` : null,
            "",
            review.body?.trim() || "(no summary body)",
          ].filter((line): line is string => !!line).join("\n")
        : "No matching review summary captured.",
      "",
      ...renderCommentList("Review Comments", relevantReviewComments, (entry) => {
        const location = entry.path ? `${entry.path}${entry.line ? `:${entry.line}` : ""}` : "unknown location";
        return `${location}\n${entry.body?.trim() || "(no body)"}`;
      }),
      "",
      ...renderCommentList("Conversation Comments", relevantIssueComments),
    ].join("\n");
    const unresolvedFindings = [
      ...relevantReviewComments.map((entry) => ({
        author: entry.userLogin ?? "unknown",
        body: entry.body?.trim() || "(no body)",
        ...(entry.path ? { path: entry.path } : {}),
        ...(entry.line ? { line: entry.line } : {}),
      })),
      ...relevantIssueComments.map((entry) => ({
        author: entry.userLogin ?? "unknown",
        body: entry.body?.trim() || "(no body)",
      })),
    ];
    const summary = review?.body?.trim()
      || relevantIssueComments[0]?.body?.trim()
      || `${unresolvedFindings.length} unresolved review finding(s)`;

    return {
      markdown,
      payload: {
        decision: "revise",
        summary,
        unresolvedFindings,
        issueIdentifier: opts.issueIdentifier,
        pr: {
          repository: opts.pullRequest.repository,
          number: opts.pullRequest.number,
          url: opts.pullRequest.url,
          title: opts.pullRequest.title ?? null,
          headRefName: opts.pullRequest.headRefName ?? null,
          headSha: opts.pullRequest.headSha ?? null,
          state: opts.pullRequest.state ?? null,
        },
        trigger: opts.reviewState.trigger,
        review: review ? {
          id: review.id,
          state: review.state,
          body: review.body,
          submittedAt: review.submittedAt,
          userLogin: review.userLogin,
          htmlUrl: review.htmlUrl,
        } : null,
        reviewComments: relevantReviewComments,
        issueComments: relevantIssueComments,
      },
    };
  }
}

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";

import { ReviewArtifactStore } from "../src/artifacts";
import { ReviewLoopService } from "../src/review-loop";
import { Issue, MutableWorkflowStore, TrackerClient, WorkflowDefinition } from "../src/types";
import { workflowDefinitionFromConfig } from "./helpers/workflow-definition";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "ENG-42",
    title: "Review me",
    description: null,
    state: "Review",
    priority: 1,
    labels: [],
    assigneeId: "vajra-uuid",
    creatorId: null,
    createdAt: "2026-03-13T10:00:00.000Z",
    updatedAt: null,
    url: null,
    blockedBy: [],
    ...overrides,
  };
}

function createWorkflowStore(tempDir: string): MutableWorkflowStore {
  const workflowPath = path.join(tempDir, "WORKFLOW.md");
  const config: WorkflowDefinition["config"] = {
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      projectSlug: "acme",
      assigneeId: "vajra-uuid",
      activeStates: ["Todo", "In Progress"],
      terminalStates: ["Done", "Canceled"],
    },
    polling: {
      intervalMs: 60_000,
    },
    workspace: {
      root: path.join(tempDir, "workspaces"),
    },
    artifacts: {
      root: path.join(tempDir, "plans", "issues"),
      workspaceDir: ".vajra",
    },
    hooks: {
      timeoutMs: 30_000,
    },
    execution: {
      maxConcurrentAgents: 1,
      maxRetryAttempts: 1,
      maxRetryBackoffMs: 10_000,
      maxConcurrentAgentsByState: {},
    },
    workflows: {
      default: {
        dotFile: path.join(tempDir, "pipelines", "default.dot"),
        successState: "Review",
        inspectPr: true,
      },
      revision: {
        dotFile: path.join(tempDir, "pipelines", "revision.dot"),
        successState: "Review",
        inspectPr: true,
      },
    },
    workflowRouting: {
      defaultWorkflow: "default",
      byLabel: {
        "vajra-revision": "revision",
      },
    },
    backends: {},
    agents: {},
    github: {
      repository: "acme-corp/acme-app",
      apiKey: "github-token",
      webhookSecret: "github-secret",
      revisionLabel: "vajra-revision",
      revisionCommand: "/vajra revise",
      revisionState: "In Progress",
      mergedState: "Done",
      closedState: "Todo",
    },
    slack: null,
  };
  const definition: WorkflowDefinition = {
    ...workflowDefinitionFromConfig(workflowPath, config),
  };

  return {
    current: () => definition,
    load: async () => definition,
  };
}

function createTracker(issue: Issue): {
  tracker: TrackerClient;
  transitions: Array<[string, string]>;
  addedLabels: Array<[string, string]>;
  removedLabels: Array<[string, string]>;
} {
  const transitions: Array<[string, string]> = [];
  const addedLabels: Array<[string, string]> = [];
  const removedLabels: Array<[string, string]> = [];
  let currentIssue = { ...issue };

  return {
    tracker: {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [];
      },
      async fetchTerminalIssues() {
        return [];
      },
      async fetchIssueByIdentifier(identifier: string) {
        return identifier === currentIssue.identifier ? currentIssue : null;
      },
      async transitionIssue(issueId: string, stateName: string) {
        transitions.push([issueId, stateName]);
        if (issueId === currentIssue.id) {
          currentIssue = {
            ...currentIssue,
            state: stateName,
          };
        }
      },
      async addIssueLabel(issueId: string, labelName: string) {
        addedLabels.push([issueId, labelName]);
        if (issueId === currentIssue.id && !currentIssue.labels.includes(labelName)) {
          currentIssue = {
            ...currentIssue,
            labels: [...currentIssue.labels, labelName],
          };
        }
      },
      async removeIssueLabel(issueId: string, labelName: string) {
        removedLabels.push([issueId, labelName]);
        if (issueId === currentIssue.id) {
          currentIssue = {
            ...currentIssue,
            labels: currentIssue.labels.filter((label) => label !== labelName),
          };
        }
      },
    },
    transitions,
    addedLabels,
    removedLabels,
  };
}

function signWebhook(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

test("ReviewLoopService stores revision requests, dedupes deliveries, and nudges Linear back into progress", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-review-loop-webhook-"));
  const workflowStore = createWorkflowStore(tempDir);
  const { tracker, transitions, addedLabels } = createTracker(makeIssue());
  const service = new ReviewLoopService(workflowStore, tracker, async () => {
    throw new Error("unexpected GitHub API call");
  });

  const payload = {
    action: "submitted",
    repository: {
      full_name: "acme-corp/acme-app",
    },
    pull_request: {
      number: 301,
      html_url: "https://github.com/acme-corp/acme-app/pull/301",
      title: "ENG-42 PR",
      state: "open",
      merged: false,
      head: {
        ref: "eng-42/revision",
        sha: "abc123",
      },
    },
    review: {
      id: 88,
      state: "changes_requested",
      submitted_at: "2026-03-13T10:15:00.000Z",
      user: {
        login: "alice",
      },
    },
  };
  const rawBody = JSON.stringify(payload);
  const headers = {
    "x-github-delivery": "delivery-1",
    "x-github-event": "pull_request_review",
    "x-hub-signature-256": signWebhook("github-secret", rawBody),
  };

  const first = await service.handleWebhook({ rawBody, headers });

  assert.equal(first.statusCode, 202);
  assert.deepEqual(first.body, {
    ok: true,
    issueIdentifier: "ENG-42",
    workflow: "revision",
  });
  assert.deepEqual(addedLabels, [["issue-1", "vajra-revision"]]);
  assert.deepEqual(transitions, [["issue-1", "In Progress"]]);

  const artifactStore = new ReviewArtifactStore(workflowStore.current().config.artifacts, "ENG-42");
  const prRecord = await artifactStore.loadPrRecord();
  assert.deepEqual(prRecord && {
    issueIdentifier: prRecord.issueIdentifier,
    repository: prRecord.repository,
    number: prRecord.number,
    url: prRecord.url,
    title: prRecord.title,
    headRefName: prRecord.headRefName,
    headSha: prRecord.headSha,
    state: prRecord.state,
  }, {
    issueIdentifier: "ENG-42",
    repository: "acme-corp/acme-app",
    number: 301,
    url: "https://github.com/acme-corp/acme-app/pull/301",
    title: "ENG-42 PR",
    headRefName: "eng-42/revision",
    headSha: "abc123",
    state: "open",
  });

  const reviewState = await artifactStore.loadReviewState();
  assert.equal(reviewState?.issueIdentifier, "ENG-42");
  assert.deepEqual(reviewState?.processedDeliveryIds, ["delivery-1"]);
  assert.equal(reviewState?.trigger.type, "changes_requested");
  assert.equal(reviewState?.trigger.reviewId, 88);
  assert.equal(reviewState?.trigger.actor, "alice");

  const duplicate = await service.handleWebhook({ rawBody, headers });

  assert.equal(duplicate.statusCode, 200);
  assert.deepEqual(duplicate.body, {
    ok: true,
    duplicate: true,
    issueIdentifier: "ENG-42",
  });
  assert.deepEqual(addedLabels, [["issue-1", "vajra-revision"]]);
  assert.deepEqual(transitions, [["issue-1", "In Progress"]]);
});

test("ReviewLoopService compiles fresh GitHub feedback at revision run start", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-review-loop-prepare-"));
  const workflowStore = createWorkflowStore(tempDir);
  const { tracker } = createTracker(makeIssue({ labels: ["vajra-revision"] }));
  const artifactStore = new ReviewArtifactStore(workflowStore.current().config.artifacts, "ENG-42");
  await artifactStore.savePrRecord({
    issueIdentifier: "ENG-42",
    repository: "acme-corp/acme-app",
    number: 301,
    url: "https://github.com/acme-corp/acme-app/pull/301",
    title: "ENG-42 PR",
    headRefName: "eng-42/revision",
    headSha: "abc123",
    state: "open",
    updatedAt: "2026-03-13T10:10:00.000Z",
  });
  await artifactStore.saveReviewState({
    issueIdentifier: "ENG-42",
    repository: "acme-corp/acme-app",
    prNumber: 301,
    prUrl: "https://github.com/acme-corp/acme-app/pull/301",
    processedDeliveryIds: ["delivery-1"],
    trigger: {
      type: "changes_requested",
      deliveryId: "delivery-1",
      requestedAt: "2026-03-13T10:15:00.000Z",
      reviewId: 88,
      commentId: null,
      actor: "alice",
      command: null,
    },
    updatedAt: "2026-03-13T10:15:00.000Z",
  });

  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const requestPath = `${url.pathname}${url.search}`;

    if (requestPath === "/repos/acme-corp/acme-app/pulls/301") {
      return new Response(JSON.stringify({
        number: 301,
        html_url: "https://github.com/acme-corp/acme-app/pull/301",
        title: "ENG-42 PR",
        state: "open",
        merged: false,
        head: {
          ref: "eng-42/revision",
          sha: "def456",
        },
      }), { status: 200 });
    }

    if (requestPath === "/repos/acme-corp/acme-app/pulls/301/reviews?per_page=100&page=1") {
      return new Response(JSON.stringify([
        {
          id: 88,
          state: "changes_requested",
          body: "Please tighten validation around the webhook parser.",
          submitted_at: "2026-03-13T10:15:00.000Z",
          html_url: "https://github.com/acme-corp/acme-app/pull/301#pullrequestreview-88",
          user: {
            login: "alice",
          },
        },
      ]), { status: 200 });
    }

    if (requestPath === "/repos/acme-corp/acme-app/issues/301/comments?per_page=100&page=1") {
      return new Response(JSON.stringify([
        {
          id: 501,
          body: "/vajra revise",
          created_at: "2026-03-13T10:16:00.000Z",
          updated_at: "2026-03-13T10:16:00.000Z",
          html_url: "https://github.com/acme-corp/acme-app/pull/301#issuecomment-501",
          user: {
            login: "alice",
            type: "User",
          },
        },
        {
          id: 502,
          body: "Also cover malformed signatures in the webhook tests.",
          created_at: "2026-03-13T10:17:00.000Z",
          updated_at: "2026-03-13T10:17:00.000Z",
          html_url: "https://github.com/acme-corp/acme-app/pull/301#issuecomment-502",
          user: {
            login: "alice",
            type: "User",
          },
        },
      ]), { status: 200 });
    }

    if (requestPath === "/repos/acme-corp/acme-app/pulls/301/comments?per_page=100&page=1") {
      return new Response(JSON.stringify([
        {
          id: 601,
          body: "Guard the empty header case.",
          path: "services/vajra/src/github.ts",
          line: 27,
          pull_request_review_id: 88,
          created_at: "2026-03-13T10:15:30.000Z",
          updated_at: "2026-03-13T10:15:30.000Z",
          html_url: "https://github.com/acme-corp/acme-app/pull/301#discussion_r601",
          user: {
            login: "alice",
            type: "User",
          },
        },
      ]), { status: 200 });
    }

    throw new Error(`unexpected GitHub request: ${requestPath}`);
  };

  const service = new ReviewLoopService(workflowStore, tracker, fetchImpl);

  await service.prepareRun({
    issue: makeIssue({ labels: ["vajra-revision"] }),
    workflowName: "revision",
  });

  const feedbackMarkdown = await artifactStore.loadReviewFeedbackMarkdown();
  const feedbackJson = await artifactStore.loadReviewFeedbackJson<{
    pr: { headSha: string | null };
    review: { id: number } | null;
    reviewComments: Array<{ body: string | null }>;
    issueComments: Array<{ body: string | null }>;
  }>();
  const updatedPrRecord = await artifactStore.loadPrRecord();

  assert.match(feedbackMarkdown ?? "", /Please tighten validation around the webhook parser\./);
  assert.match(feedbackMarkdown ?? "", /services\/vajra\/src\/github\.ts:27/);
  assert.match(feedbackMarkdown ?? "", /Also cover malformed signatures in the webhook tests\./);
  assert.doesNotMatch(feedbackMarkdown ?? "", /^\/vajra revise$/m);
  assert.equal(feedbackJson?.pr.headSha, "def456");
  assert.equal(feedbackJson?.review?.id, 88);
  assert.deepEqual(feedbackJson?.reviewComments.map((entry) => entry.body), [
    "Guard the empty header case.",
  ]);
  assert.deepEqual(feedbackJson?.issueComments.map((entry) => entry.body), [
    "Also cover malformed signatures in the webhook tests.",
  ]);
  assert.equal(updatedPrRecord?.headSha, "def456");
});

test("ReviewLoopService ignores closed-pull-request label removal when the revision label is already absent", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-review-loop-closed-"));
  const workflowStore = createWorkflowStore(tempDir);
  const { tracker, transitions, removedLabels } = createTracker(makeIssue({
    state: "In Review",
    labels: [],
  }));
  const artifactStore = new ReviewArtifactStore(workflowStore.current().config.artifacts, "ENG-42");
  await artifactStore.savePrRecord({
    issueIdentifier: "ENG-42",
    repository: "acme-corp/acme-app",
    number: 301,
    url: "https://github.com/acme-corp/acme-app/pull/301",
    title: "ENG-42 PR",
    headRefName: "eng-42/revision",
    headSha: "abc123",
    state: "open",
    updatedAt: "2026-03-13T10:10:00.000Z",
  });

  const service = new ReviewLoopService(workflowStore, tracker, async () => {
    throw new Error("unexpected GitHub API call");
  });

  const payload = {
    action: "closed",
    repository: {
      full_name: "acme-corp/acme-app",
    },
    pull_request: {
      number: 301,
      html_url: "https://github.com/acme-corp/acme-app/pull/301",
      title: "ENG-42 PR",
      state: "closed",
      merged: false,
      head: {
        ref: "eng-42/revision",
        sha: "abc123",
      },
    },
  };
  const rawBody = JSON.stringify(payload);
  const headers = {
    "x-github-delivery": "delivery-close-1",
    "x-github-event": "pull_request",
    "x-hub-signature-256": signWebhook("github-secret", rawBody),
  };

  const result = await service.handleWebhook({ rawBody, headers });

  assert.equal(result.statusCode, 202);
  assert.deepEqual(result.body, {
    ok: true,
    issueIdentifier: "ENG-42",
    merged: false,
  });
  assert.deepEqual(removedLabels, []);
  assert.deepEqual(transitions, [["issue-1", "Todo"]]);
});

import test from "node:test";
import assert from "node:assert/strict";

import { VajraEventBus } from "../src/events";
import { SlackNotifier } from "../src/slack";
import { SlackEventSubscriber } from "../src/subscribers/slack";
import { SlackConfig, WorkflowDefinition } from "../src/types";
import { workflowDefinitionFromConfig } from "./helpers/workflow-definition";

function makeConfig(overrides?: Partial<SlackConfig>): SlackConfig {
  return {
    botToken: "xoxb-test-token",
    channelId: "C06TEST",
    userMap: { "linear-user-1": "U06SLACK1" },
    notifyOnSuccess: true,
    notifyOnFailure: true,
    ...overrides,
  };
}

function makeIssue(creatorId: string | null = "linear-user-1") {
  return {
    id: "1",
    identifier: "ENG-42",
    title: "Fix the widget",
    description: null,
    state: "Todo",
    priority: 1,
    labels: [],
    assigneeId: null,
    creatorId,
    createdAt: null,
    updatedAt: null,
    url: "https://linear.app/acme/issue/ENG-42",
    blockedBy: [],
  };
}

test("SlackNotifier.resolveSlackUserId maps linear IDs to slack IDs", () => {
  const notifier = new SlackNotifier(makeConfig());
  assert.equal(notifier.resolveSlackUserId("linear-user-1"), "U06SLACK1");
  assert.equal(notifier.resolveSlackUserId("unknown"), null);
  assert.equal(notifier.resolveSlackUserId(null), null);
});

test("SlackNotifier.postMessage sends correct payload to Slack API", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({ url: String(input), body });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const notifier = new SlackNotifier(makeConfig(), fetchImpl);
  await notifier.postMessage("hello");

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://slack.com/api/chat.postMessage");
  assert.equal(requests[0].body.channel, "C06TEST");
  assert.equal(requests[0].body.text, "hello");
  assert.equal(requests[0].body.unfurl_links, true);
});

test("SlackNotifier.postMessage throws on Slack API error", async () => {
  const fetchImpl: typeof fetch = async () => {
    return new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 });
  };

  const notifier = new SlackNotifier(makeConfig(), fetchImpl);
  await assert.rejects(notifier.postMessage("hello"), /channel_not_found/);
});

test("SlackNotifier.postMessage throws on HTTP 429 with status in error message", async () => {
  const fetchImpl: typeof fetch = async () => {
    return new Response("rate limited", { status: 429 });
  };

  const notifier = new SlackNotifier(makeConfig(), fetchImpl);
  await assert.rejects(notifier.postMessage("hello"), /slack http error 429/);
});

test("SlackNotifier.postMessage throws on non-JSON response body", async () => {
  const fetchImpl: typeof fetch = async () => {
    return new Response("<html>bad gateway</html>", { status: 200, headers: { "content-type": "text/html" } });
  };

  const notifier = new SlackNotifier(makeConfig(), fetchImpl);
  await assert.rejects(notifier.postMessage("hello"), /non-JSON/);
});

test("SlackNotifier.notifyPRReady mentions the issue creator", async () => {
  const messages: string[] = [];

  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { text: string };
    messages.push(body.text);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const notifier = new SlackNotifier(makeConfig(), fetchImpl);
  await notifier.notifyPRReady({
    issue: makeIssue(),
    prUrl: "https://github.com/acme-corp/acme-app/pull/135",
  });

  assert.equal(messages.length, 1);
  assert.match(messages[0], /<@U06SLACK1>/);
  assert.match(messages[0], /pull\/135/);
  assert.match(messages[0], /ENG-42/);
});

test("SlackNotifier.notifyPRReady works without a mapped user", async () => {
  const messages: string[] = [];

  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { text: string };
    messages.push(body.text);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const notifier = new SlackNotifier(makeConfig(), fetchImpl);
  await notifier.notifyPRReady({
    issue: makeIssue("unknown-linear-id"),
    prUrl: "https://github.com/acme-corp/acme-app/pull/135",
  });

  assert.equal(messages.length, 1);
  assert.ok(!messages[0].includes("<@"));
  assert.match(messages[0], /pull\/135/);
});

test("SlackNotifier.notifyPipelineFailure includes stage name and error", async () => {
  const messages: string[] = [];

  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { text: string };
    messages.push(body.text);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const notifier = new SlackNotifier(makeConfig(), fetchImpl);
  await notifier.notifyPipelineFailure({
    issue: makeIssue(),
    error: "tests failed",
    stage: "code",
  });

  assert.equal(messages.length, 1);
  assert.match(messages[0], /<@U06SLACK1>/);
  assert.match(messages[0], /stage `code`/);
  assert.match(messages[0], /tests failed/);
  assert.match(messages[0], /ENG-42/);
});

function makeWorkflow(
  slack: SlackConfig | null,
  escalation: WorkflowDefinition["config"]["escalation"] = null,
): WorkflowDefinition {
  const workflowPath = "/tmp/WORKFLOW.md";
  const config: WorkflowDefinition["config"] = {
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: "token",
      assigneeId: "vajra-uuid",
      activeStates: ["Todo"],
      terminalStates: ["Done"],
    },
    polling: { intervalMs: 30_000 },
    workspace: { root: "/tmp/workspaces" },
    artifacts: { root: "/tmp/plans", workspaceDir: ".vajra" },
    hooks: { timeoutMs: 60_000 },
    execution: {
      maxConcurrentAgents: 1,
      maxRetryAttempts: 3,
      maxRetryBackoffMs: 60_000,
      maxConcurrentAgentsByState: {},
      maxAgentInvocationsPerRun: 20,
    },
    escalation,
    fanOut: {},
    workflows: {
      default: { dotFile: "/tmp/default.dot" },
    },
    workflowRouting: {
      defaultWorkflow: "default",
      byLabel: {},
    },
    backends: {},
    agents: {},
    github: null,
    slack,
  };
  return {
    ...workflowDefinitionFromConfig(workflowPath, config),
  };
}

test("SlackEventSubscriber forwards successful issue events to SlackNotifier", async () => {
  const bus = new VajraEventBus();
  const successCalls: Array<{ issueIdentifier: string; prUrl: string | null }> = [];
  const failureCalls: Array<unknown> = [];
  const subscriber = new SlackEventSubscriber(
    bus,
    { current: () => makeWorkflow(makeConfig()) },
    () => ({
      async notifyPipelineSuccess(opts) {
        successCalls.push({ issueIdentifier: opts.issue.identifier, prUrl: opts.prUrl });
      },
      async notifyPipelineFailure(opts) {
        failureCalls.push(opts);
      },
    }),
  );

  bus.emit({
    type: "issue:completed",
    timestamp: "2026-03-11T00:00:00.000Z",
    issueId: "1",
    issueIdentifier: "ENG-42",
    issueTitle: "Fix the widget",
    issueUrl: "https://linear.app/acme/issue/ENG-42",
    issueCreatorId: "linear-user-1",
    completedNodes: ["plan", "push"],
    prUrl: "https://github.com/acme-corp/acme-app/pull/999",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(successCalls, [{
    issueIdentifier: "ENG-42",
    prUrl: "https://github.com/acme-corp/acme-app/pull/999",
  }]);
  assert.deepEqual(failureCalls, []);
  subscriber.close();
});

test("SlackEventSubscriber forwards failed issue events to SlackNotifier", async () => {
  const bus = new VajraEventBus();
  const failureCalls: Array<{ error: string; stage?: string }> = [];
  const subscriber = new SlackEventSubscriber(
    bus,
    { current: () => makeWorkflow(makeConfig()) },
    () => ({
      async notifyPipelineSuccess() {},
      async notifyPipelineFailure(opts) {
        failureCalls.push({ error: opts.error, stage: opts.stage });
      },
    }),
  );

  bus.emit({
    type: "issue:failed",
    timestamp: "2026-03-11T00:00:00.000Z",
    issueId: "1",
    issueIdentifier: "ENG-42",
    issueTitle: "Fix the widget",
    issueUrl: "https://linear.app/acme/issue/ENG-42",
    issueCreatorId: "linear-user-1",
    error: "tests failed",
    failedStageId: "code",
    attempt: 1,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(failureCalls, [{ error: "tests failed", stage: "code" }]);
  subscriber.close();
});

test("SlackEventSubscriber forwards escalation events when escalation Slack notifications are enabled", async () => {
  const bus = new VajraEventBus();
  const escalationCalls: string[] = [];
  const subscriber = new SlackEventSubscriber(
    bus,
    {
      current: () => makeWorkflow(makeConfig(), {
        linearState: "Needs Human Review",
        comment: true,
        slackNotify: true,
      }),
    },
    () => ({
      async notifyPipelineSuccess() {},
      async notifyPipelineFailure() {},
      async notifyHumanReviewRequired(opts) {
        escalationCalls.push(`${opts.issue.identifier}:${opts.reason}`);
      },
    }),
  );

  bus.emit({
    type: "issue:escalated",
    timestamp: "2026-03-11T00:00:00.000Z",
    issueId: "1",
    issueIdentifier: "ENG-42",
    issueTitle: "Fix the widget",
    issueUrl: "https://linear.app/acme/issue/ENG-42",
    issueCreatorId: "linear-user-1",
    completedNodes: ["plan", "review_plan"],
    reason: "Needs a product decision",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(escalationCalls, ["ENG-42:Needs a product decision"]);
  subscriber.close();
});

test("SlackEventSubscriber suppresses duplicate failure notifications for the same issue", async () => {
  const bus = new VajraEventBus();
  const failureCalls: Array<{ error: string; stage?: string }> = [];
  const subscriber = new SlackEventSubscriber(
    bus,
    { current: () => makeWorkflow(makeConfig()) },
    () => ({
      async notifyPipelineSuccess() {},
      async notifyPipelineFailure(opts) {
        failureCalls.push({ error: opts.error, stage: opts.stage });
      },
    }),
  );

  bus.emit({
    type: "issue:failed",
    timestamp: "2026-03-11T00:00:00.000Z",
    issueId: "1",
    issueIdentifier: "ENG-42",
    issueTitle: "Fix the widget",
    issueUrl: "https://linear.app/acme/issue/ENG-42",
    issueCreatorId: "linear-user-1",
    error: "tests failed",
    failedStageId: "code",
    attempt: 1,
  });
  bus.emit({
    type: "issue:failed",
    timestamp: "2026-03-11T00:01:00.000Z",
    issueId: "1",
    issueIdentifier: "ENG-42",
    issueTitle: "Fix the widget",
    issueUrl: "https://linear.app/acme/issue/ENG-42",
    issueCreatorId: "linear-user-1",
    error: "tests still failed",
    failedStageId: "code",
    attempt: 2,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(failureCalls, [{ error: "tests failed", stage: "code" }]);
  subscriber.close();
});

test("SlackEventSubscriber resets failure suppression on a fresh dispatch, completion, or cancellation", async () => {
  const bus = new VajraEventBus();
  const failureCalls: Array<{ error: string; stage?: string }> = [];
  const subscriber = new SlackEventSubscriber(
    bus,
    { current: () => makeWorkflow(makeConfig()) },
    () => ({
      async notifyPipelineSuccess() {},
      async notifyPipelineFailure(opts) {
        failureCalls.push({ error: opts.error, stage: opts.stage });
      },
    }),
  );

  const failedEvent = {
    type: "issue:failed" as const,
    timestamp: "2026-03-11T00:00:00.000Z",
    issueId: "1",
    issueIdentifier: "ENG-42",
    issueTitle: "Fix the widget",
    issueUrl: "https://linear.app/acme/issue/ENG-42",
    issueCreatorId: "linear-user-1",
    error: "tests failed",
    failedStageId: "code",
    attempt: 1,
  };

  bus.emit(failedEvent);
  bus.emit(failedEvent);
  bus.emit({
    type: "issue:dispatched",
    timestamp: "2026-03-11T00:02:00.000Z",
    issueId: "1",
    issueIdentifier: "ENG-42",
    issueTitle: "Fix the widget",
    issueUrl: "https://linear.app/acme/issue/ENG-42",
    issueCreatorId: "linear-user-1",
    state: "Todo",
    attempt: 1,
    workspacePath: "/tmp/workspace",
    workflowName: "default",
    successState: "Done",
    baseBranch: "main",
    targetBranch: "main",
    mergeStrategy: "pr-only",
    labelsToAdd: [],
    triaged: false,
    triageReasoning: null,
    triageFallback: false,
  });
  bus.emit(failedEvent);
  bus.emit({
    type: "issue:completed",
    timestamp: "2026-03-11T00:03:00.000Z",
    issueId: "1",
    issueIdentifier: "ENG-42",
    issueTitle: "Fix the widget",
    issueUrl: "https://linear.app/acme/issue/ENG-42",
    issueCreatorId: "linear-user-1",
    completedNodes: ["plan", "push"],
    prUrl: "https://github.com/acme-corp/acme-app/pull/999",
  });
  bus.emit(failedEvent);
  bus.emit({
    type: "issue:cancelled",
    timestamp: "2026-03-11T00:04:00.000Z",
    issueId: "1",
    issueIdentifier: "ENG-42",
    issueTitle: "Fix the widget",
    issueUrl: "https://linear.app/acme/issue/ENG-42",
    issueCreatorId: "linear-user-1",
    reason: "issue reached terminal state",
  });
  bus.emit(failedEvent);
  bus.emit({
    type: "issue:dispatched",
    timestamp: "2026-03-11T00:05:00.000Z",
    issueId: "1",
    issueIdentifier: "ENG-42",
    issueTitle: "Fix the widget",
    issueUrl: "https://linear.app/acme/issue/ENG-42",
    issueCreatorId: "linear-user-1",
    state: "Todo",
    attempt: 0,
    workspacePath: "/tmp/workspace",
    workflowName: "default",
    successState: "Done",
    baseBranch: "main",
    targetBranch: "main",
    mergeStrategy: "pr-only",
    labelsToAdd: [],
    triaged: false,
    triageReasoning: null,
    triageFallback: false,
  });
  bus.emit(failedEvent);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(failureCalls, [
    { error: "tests failed", stage: "code" },
    { error: "tests failed", stage: "code" },
    { error: "tests failed", stage: "code" },
    { error: "tests failed", stage: "code" },
  ]);
  subscriber.close();
});

test("SlackEventSubscriber evicts old failure suppression entries when the cache reaches its cap", async () => {
  const bus = new VajraEventBus();
  const failureCalls: Array<{ issueId: string; error: string }> = [];
  const subscriber = new SlackEventSubscriber(
    bus,
    { current: () => makeWorkflow(makeConfig()) },
    () => ({
      async notifyPipelineSuccess() {},
      async notifyPipelineFailure(opts) {
        failureCalls.push({ issueId: opts.issue.id, error: opts.error });
      },
    }),
    2,
  );

  const emitFailure = (issueId: string, issueIdentifier: string, error: string) => {
    bus.emit({
      type: "issue:failed",
      timestamp: "2026-03-11T00:00:00.000Z",
      issueId,
      issueIdentifier,
      issueTitle: `Issue ${issueIdentifier}`,
      issueUrl: `https://linear.app/acme/issue/${issueIdentifier}`,
      issueCreatorId: "linear-user-1",
      error,
      failedStageId: "code",
      attempt: 0,
    });
  };

  emitFailure("1", "ENG-1", "first");
  emitFailure("2", "ENG-2", "second");
  emitFailure("3", "ENG-3", "third");
  emitFailure("1", "ENG-1", "first-again");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(failureCalls, [
    { issueId: "1", error: "first" },
    { issueId: "2", error: "second" },
    { issueId: "3", error: "third" },
    { issueId: "1", error: "first-again" },
  ]);
  subscriber.close();
});

test("SlackEventSubscriber ignores events when slack config is missing", async () => {
  const bus = new VajraEventBus();
  let called = false;
  const subscriber = new SlackEventSubscriber(
    bus,
    { current: () => makeWorkflow(null) },
    () => ({
      async notifyPipelineSuccess() {
        called = true;
      },
      async notifyPipelineFailure() {
        called = true;
      },
    }),
  );

  bus.emit({
    type: "issue:completed",
    timestamp: "2026-03-11T00:00:00.000Z",
    issueId: "1",
    issueIdentifier: "ENG-42",
    issueTitle: "Fix the widget",
    issueUrl: null,
    issueCreatorId: null,
    completedNodes: [],
    prUrl: null,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(called, false);
  subscriber.close();
});

test("SlackEventSubscriber always notifies on auth failure even when issue was already notified", async () => {
  const bus = new VajraEventBus();
  const failureCalls: Array<{ error: string }> = [];
  const subscriber = new SlackEventSubscriber(
    bus,
    { current: () => makeWorkflow(makeConfig()) },
    () => ({
      async notifyPipelineSuccess() {},
      async notifyPipelineFailure(opts) {
        failureCalls.push({ error: opts.error });
      },
    }),
  );

  // First failure — normal, should notify
  bus.emit({
    type: "issue:failed",
    timestamp: "2026-03-30T00:00:00.000Z",
    issueId: "1",
    issueIdentifier: "ENG-300",
    issueTitle: "Auth test",
    issueUrl: "https://linear.app/acme/issue/ENG-300",
    issueCreatorId: "linear-user-1",
    error: "stage plan failed",
    failedStageId: "plan",
    attempt: 0,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(failureCalls.length, 1);

  // Second failure with auth classification — should still notify
  // even though the issue was already notified (suppression bypassed)
  bus.emit({
    type: "issue:failed",
    timestamp: "2026-03-30T00:01:00.000Z",
    issueId: "1",
    issueIdentifier: "ENG-300",
    issueTitle: "Auth test",
    issueUrl: "https://linear.app/acme/issue/ENG-300",
    issueCreatorId: "linear-user-1",
    error: "[auth] Codex refresh token expired",
    failedStageId: "plan",
    attempt: 0,
    failureClass: "auth",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(failureCalls.length, 2);
  assert.match(failureCalls[1]?.error ?? "", /Auth failure/);
  assert.match(failureCalls[1]?.error ?? "", /refresh token/);

  // Rate limit failure — also bypasses suppression
  bus.emit({
    type: "issue:failed",
    timestamp: "2026-03-30T00:02:00.000Z",
    issueId: "1",
    issueIdentifier: "ENG-300",
    issueTitle: "Auth test",
    issueUrl: "https://linear.app/acme/issue/ENG-300",
    issueCreatorId: "linear-user-1",
    error: "[rate-limit] Provider usage limit reached (resets 6pm Europe/Berlin)",
    failedStageId: "write_knowledge",
    attempt: 0,
    failureClass: "rate-limit",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(failureCalls.length, 3);
  assert.match(failureCalls[2]?.error ?? "", /Rate limit/);

  subscriber.close();
});

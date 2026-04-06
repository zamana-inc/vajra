import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";

import { ReviewArtifactStore } from "../src/artifacts";
import { VajraEventBus } from "../src/events";
import { VajraOrchestrator, retryBackoffMs } from "../src/orchestrator";
import { LocalPipelineRunner } from "../src/pipeline";
import { LinearTrackerClient } from "../src/tracker";
import { SlackEventSubscriber } from "../src/subscribers/slack";
import { Issue, PipelineRunHandle, PipelineRunResult, RUN_STOP_REASONS, SlackConfig, TrackerClient, WorkflowDefinition } from "../src/types";
import { WorkspaceManager } from "../src/workspace";

class IntegrationBackend {
  readonly name = "integration-backend";

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async execute(opts: {
    workspace: string;
    prompt: string;
    model?: string;
    reasoningEffort?: string;
    createSession?: boolean;
    sessionId?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<{ output: string; exitCode: number; durationMs: number }> {
    await writeFile(path.join(opts.workspace, ".vajra", "plan.md"), "integration plan", "utf8");
    return {
      output: "integration ok",
      exitCode: 0,
      durationMs: 1,
    };
  }
}

async function noopTransitionIssue(): Promise<void> {}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "1",
    identifier: "ENG-1",
    title: "Issue",
    description: null,
    state: "Todo",
    priority: 1,
    labels: [],
    assigneeId: "vajra-uuid",
    creatorId: null,
    createdAt: "2026-03-10T00:00:00.000Z",
    updatedAt: null,
    url: null,
    blockedBy: [],
    ...overrides,
  };
}

function makeWorkflowDefinition(overrides?: {
  activeStates?: string[];
  terminalStates?: string[];
  maxConcurrentAgents?: number;
  maxRetryAttempts?: number;
  maxConcurrentAgentsByState?: Record<string, number>;
  successState?: string;
  inspectPr?: boolean;
  escalation?: WorkflowDefinition["config"]["escalation"];
  triage?: WorkflowDefinition["config"]["triage"];
  backends?: WorkflowDefinition["config"]["backends"];
  github?: WorkflowDefinition["config"]["github"];
}): WorkflowDefinition {
  return {
    path: "/tmp/WORKFLOW.md",
    config: {
      tracker: {
        kind: "linear",
        endpoint: "https://api.linear.app/graphql",
        apiKey: "token",
        assigneeId: "vajra-uuid",
        activeStates: overrides?.activeStates ?? ["Todo"],
        terminalStates: overrides?.terminalStates ?? ["Done"],
      },
      polling: { intervalMs: 30_000 },
      workspace: { root: "/tmp/vajra-workspaces" },
      artifacts: { root: "/tmp/vajra-plans", workspaceDir: ".vajra" },
      hooks: { timeoutMs: 60_000 },
      execution: {
        maxConcurrentAgents: overrides?.maxConcurrentAgents ?? 1,
        maxRetryAttempts: overrides?.maxRetryAttempts ?? 3,
        maxRetryBackoffMs: 60_000,
        maxConcurrentAgentsByState: overrides?.maxConcurrentAgentsByState ?? {},
        maxAgentInvocationsPerRun: 20,
      },
      escalation: overrides?.escalation ?? null,
      fanOut: {},
      triage: overrides?.triage ?? null,
      workflows: {
        default: {
          dotFile: "/tmp/default.dot",
          ...(overrides?.successState ? { successState: overrides.successState } : {}),
          ...(overrides?.inspectPr === false ? { inspectPr: false } : {}),
        },
      },
      workflowRouting: {
        defaultWorkflow: "default",
        byLabel: {},
      },
      slack: null,
      backends: overrides?.backends ?? {},
      agents: {},
      github: overrides?.github ?? null,
    },
  };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitForCondition(predicate: () => boolean, message: string, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) {
      return;
    }

    await flushAsyncWork();
  }

  assert.fail(message);
}

const ASYNC_ORCHESTRATOR_TEST_TIMEOUT_MS = 15_000;

test("orchestrator dispatches the highest-priority eligible issue first", async () => {
  const started: string[] = [];
  const pending = deferred<PipelineRunResult>();

  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return [
        {
          id: "low",
          identifier: "ENG-2",
          title: "Low",
          description: null,
          state: "Todo",
          priority: 3,
          labels: [],
          assigneeId: "vajra-uuid",
          creatorId: null,
          createdAt: "2026-03-10T00:00:01.000Z",
          updatedAt: null,
          url: null,
          blockedBy: [],
        },
        {
          id: "high",
          identifier: "ENG-1",
          title: "High",
          description: null,
          state: "Todo",
          priority: 1,
          labels: [],
          assigneeId: "vajra-uuid",
          creatorId: null,
          createdAt: "2026-03-10T00:00:00.000Z",
          updatedAt: null,
          url: null,
          blockedBy: [],
        },
      ];
    },
    async fetchIssueStatesByIds(issueIds: string[]) {
      return (await this.fetchCandidateIssues()).filter((issue) => issueIds.includes(issue.id));
    },
    async fetchTerminalIssues() {
      return [];
    },
    async transitionIssue() {},
  };

  const workflow: WorkflowDefinition = {
    path: "/tmp/WORKFLOW.md",
    config: {
      tracker: {
        kind: "linear",
        endpoint: "https://api.linear.app/graphql",
        apiKey: "token",
        assigneeId: "vajra-uuid",
        activeStates: ["Todo"],
        terminalStates: ["Done"],
      },
      polling: { intervalMs: 30_000 },
      workspace: { root: "/tmp/vajra-workspaces" },
      artifacts: { root: "/tmp/vajra-plans", workspaceDir: ".vajra" },
      hooks: { timeoutMs: 60_000 },
      execution: {
        maxConcurrentAgents: 1,
        maxRetryAttempts: 3,
        maxRetryBackoffMs: 60_000,
        maxConcurrentAgentsByState: {},
      },
      workflows: {
        default: { dotFile: "/tmp/default.dot" },
      },
      workflowRouting: {
        defaultWorkflow: "default",
        byLabel: {},
      },
      slack: null,
      backends: {},
      agents: {},
    },
  };

  const orchestrator = new VajraOrchestrator(
    tracker,
    { current: () => workflow },
    {
      startRun({ issue }): PipelineRunHandle {
        started.push(issue.id);
        return {
          promise: pending.promise,
          async cancel() {
            pending.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
          },
        };
      },
    },
    () => ({
      async prepareWorkspace(identifier: string) {
        return { path: `/tmp/${identifier}`, workspaceKey: identifier, createdNow: true };
      },
      async runBeforeRunHook() {},
      async runAfterRunHook() {},
      async cleanupWorkspace() {},
      workspacePathForIssue(identifier: string) { return `/tmp/${identifier}`; },
      validateWorkspacePath: async () => undefined,
    } as never),
  );

  await orchestrator.tick();
  assert.deepEqual(started, ["high"]);
  assert.equal(orchestrator.state.running.size, 1);
  assert.equal(orchestrator.state.claimed.has("high"), true);
  assert.equal(orchestrator.state.running.get("high")?.workspacePath, "/tmp/ENG-1");
  pending.resolve({ status: "success", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
  await pending.promise;
});

test("orchestrator allocates a fresh attempt number when redispatching an issue with prior run logs", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-orchestrator-attempts-"));
  const logsRoot = path.join(tempDir, "logs");
  await mkdir(path.join(logsRoot, "ENG-1", "attempt-0"), { recursive: true });

  const startedAttempts: number[] = [];
  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return [makeIssue({ id: "1", identifier: "ENG-1", state: "Todo" })];
    },
    async fetchIssueStatesByIds(issueIds: string[]) {
      return (await this.fetchCandidateIssues()).filter((issue) => issueIds.includes(issue.id));
    },
    async fetchTerminalIssues() {
      return [];
    },
    async transitionIssue() {},
  };

  const workflow: WorkflowDefinition = {
    path: path.join(tempDir, "WORKFLOW.md"),
    config: {
      ...makeWorkflowDefinition().config,
      workspace: { root: path.join(tempDir, "workspaces") },
      artifacts: { root: path.join(tempDir, "plans"), workspaceDir: ".vajra" },
    },
  };

  const orchestrator = new VajraOrchestrator(
    tracker,
    { current: () => workflow },
    {
      startRun({ attempt }): PipelineRunHandle {
        startedAttempts.push(attempt);
        return {
          promise: Promise.resolve({
            status: "success",
            completedNodes: [],
            checkpointPath: path.join(logsRoot, "ENG-1", `attempt-${attempt}`, "checkpoint.json"),
          }),
          async cancel() {},
        };
      },
    },
    () => new WorkspaceManager(workflow.config.workspace, workflow.config.hooks),
    () => 1_000,
    undefined,
    { logsRoot },
  );

  await orchestrator.tick();
  await flushAsyncWork();

  assert.deepEqual(startedAttempts, [1]);
});

test("orchestrator batches pre-dispatch validation and drains queued issues as slots free", {
  timeout: ASYNC_ORCHESTRATOR_TEST_TIMEOUT_MS,
}, async (t) => {
  const started: string[] = [];
  const pendingById = new Map<string, ReturnType<typeof deferred<PipelineRunResult>>>();
  const queuedDispatches = new Map([
    ["4", deferred<void>()],
    ["5", deferred<void>()],
  ]);
  const stateLookups: string[][] = [];
  const issues = Array.from({ length: 5 }, (_, index) => makeIssue({
    id: String(index + 1),
    identifier: `ENG-${index + 1}`,
    title: `Issue ${index + 1}`,
    priority: index + 1,
    createdAt: `2026-03-10T00:00:0${index}.000Z`,
  }));

  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return issues;
    },
    async fetchIssueStatesByIds(issueIds: string[]) {
      stateLookups.push([...issueIds]);
      return issues.filter((issue) => issueIds.includes(issue.id));
    },
    async fetchTerminalIssues() {
      return [];
    },
    transitionIssue: noopTransitionIssue,
  };

  const orchestrator = new VajraOrchestrator(
    tracker,
    { current: () => makeWorkflowDefinition({ maxConcurrentAgents: 3 }) },
    {
      startRun({ issue }): PipelineRunHandle {
        started.push(issue.id);
        queuedDispatches.get(issue.id)?.resolve();
        const pending = deferred<PipelineRunResult>();
        pendingById.set(issue.id, pending);
        return {
          promise: pending.promise,
          async cancel() {
            pending.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
          },
        };
      },
    },
    stubWorkspace(),
  );
  t.after(async () => {
    await orchestrator.shutdown();
  });

  await orchestrator.tick();

  assert.deepEqual(stateLookups, [["1"], ["2"], ["3"]]);
  assert.deepEqual(started, ["1", "2", "3"]);
  assert.equal(orchestrator.state.running.size, 3);

  pendingById.get("1")?.resolve({ status: "success", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
  pendingById.get("2")?.resolve({ status: "success", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
  pendingById.get("3")?.resolve({ status: "success", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
  await Promise.all([
    pendingById.get("1")?.promise,
    pendingById.get("2")?.promise,
    pendingById.get("3")?.promise,
  ]);

  await Promise.all([
    queuedDispatches.get("4")?.promise,
    queuedDispatches.get("5")?.promise,
  ]);

  assert.deepEqual(stateLookups, [["1"], ["2"], ["3"], ["4"], ["5"]]);
  assert.deepEqual(started, ["1", "2", "3", "4", "5"]);
  assert.equal(orchestrator.state.running.size, 2);

  issues.splice(0, issues.length);
  pendingById.get("4")?.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
  pendingById.get("5")?.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
  await Promise.all([
    pendingById.get("4")?.promise,
    pendingById.get("5")?.promise,
  ]);
  await flushAsyncWork();
});

test("orchestrator nudges a follow-up tick when a completed run frees a slot", async () => {
  const started: string[] = [];
  const stateLookups: string[][] = [];
  const pendingById = new Map<string, ReturnType<typeof deferred<PipelineRunResult>>>();
  const issues = [
    makeIssue({ id: "1", identifier: "ENG-1", priority: 1 }),
    makeIssue({ id: "2", identifier: "ENG-2", priority: 2 }),
  ];

  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return issues;
    },
    async fetchIssueStatesByIds(issueIds: string[]) {
      stateLookups.push([...issueIds]);
      return issues.filter((issue) => issueIds.includes(issue.id));
    },
    async fetchTerminalIssues() {
      return [];
    },
    transitionIssue: noopTransitionIssue,
  };

  const orchestrator = new VajraOrchestrator(
    tracker,
    { current: () => makeWorkflowDefinition() },
    {
      startRun({ issue }): PipelineRunHandle {
        started.push(issue.id);
        const pending = deferred<PipelineRunResult>();
        pendingById.set(issue.id, pending);
        return {
          promise: pending.promise,
          async cancel() {
            pending.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
          },
        };
      },
    },
    stubWorkspace(),
  );

  await orchestrator.tick();
  assert.deepEqual(started, ["1"]);

  pendingById.get("1")?.resolve({ status: "success", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
  await pendingById.get("1")?.promise;

  await waitForCondition(
    () => started.includes("2"),
    "expected queued issue to start after the completion nudge",
  );

  assert.deepEqual(stateLookups, [["1"], ["2"]]);

  issues.splice(0, issues.length);
  pendingById.get("2")?.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
  await pendingById.get("2")?.promise;
  await flushAsyncWork();
});

test("orchestrator coalesces same-turn completion nudges into a single follow-up tick", {
  timeout: ASYNC_ORCHESTRATOR_TEST_TIMEOUT_MS,
}, async (t) => {
  const started: string[] = [];
  const pendingById = new Map<string, ReturnType<typeof deferred<PipelineRunResult>>>();
  const queuedDispatch = deferred<void>();
  const issues = [
    makeIssue({ id: "1", identifier: "ENG-1", priority: 1 }),
    makeIssue({ id: "2", identifier: "ENG-2", priority: 2 }),
    makeIssue({ id: "3", identifier: "ENG-3", priority: 3 }),
  ];
  let candidatePolls = 0;

  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      candidatePolls += 1;
      return issues;
    },
    async fetchIssueStatesByIds(issueIds: string[]) {
      return issues.filter((issue) => issueIds.includes(issue.id));
    },
    async fetchTerminalIssues() {
      return [];
    },
    transitionIssue: noopTransitionIssue,
  };

  const orchestrator = new VajraOrchestrator(
    tracker,
    { current: () => makeWorkflowDefinition({ maxConcurrentAgents: 2 }) },
    {
      startRun({ issue }): PipelineRunHandle {
        started.push(issue.id);
        if (issue.id === "3") {
          queuedDispatch.resolve();
        }
        const pending = deferred<PipelineRunResult>();
        pendingById.set(issue.id, pending);
        return {
          promise: pending.promise,
          async cancel() {
            pending.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
          },
        };
      },
    },
    stubWorkspace(),
  );
  t.after(async () => {
    await orchestrator.shutdown();
  });

  await orchestrator.tick();
  assert.deepEqual(started, ["1", "2"]);

  pendingById.get("1")?.resolve({ status: "success", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
  pendingById.get("2")?.resolve({ status: "success", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
  await Promise.all([
    pendingById.get("1")?.promise,
    pendingById.get("2")?.promise,
  ]);

  await queuedDispatch.promise;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await flushAsyncWork();
  }

  assert.equal(candidatePolls, 2);

  issues.splice(0, issues.length);
  pendingById.get("3")?.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
  await pendingById.get("3")?.promise;
  await flushAsyncWork();
});

test("orchestrator picks up newly queued issues when a slot frees on a later tick", async () => {
  const started: string[] = [];
  const pendingById = new Map<string, ReturnType<typeof deferred<PipelineRunResult>>>();
  const issues = [
    makeIssue({ id: "1", identifier: "ENG-1", priority: 1 }),
    makeIssue({ id: "2", identifier: "ENG-2", priority: 2 }),
    makeIssue({ id: "3", identifier: "ENG-3", priority: 3 }),
  ];

  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return issues;
    },
    async fetchIssueStatesByIds(issueIds: string[]) {
      return issues.filter((issue) => issueIds.includes(issue.id));
    },
    async fetchTerminalIssues() {
      return [];
    },
    transitionIssue: noopTransitionIssue,
  };

  const orchestrator = new VajraOrchestrator(
    tracker,
    { current: () => makeWorkflowDefinition({ maxConcurrentAgents: 3 }) },
    {
      startRun({ issue }): PipelineRunHandle {
        started.push(issue.id);
        const pending = deferred<PipelineRunResult>();
        pendingById.set(issue.id, pending);
        return {
          promise: pending.promise,
          async cancel() {
            pending.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
          },
        };
      },
    },
    stubWorkspace(),
  );

  await orchestrator.tick();
  assert.deepEqual(started, ["1", "2", "3"]);

  issues.push(makeIssue({ id: "4", identifier: "ENG-4", priority: 4 }));
  await orchestrator.tick();
  assert.deepEqual(started, ["1", "2", "3"]);

  pendingById.get("1")?.resolve({ status: "success", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
  await pendingById.get("1")?.promise;
  await flushAsyncWork();

  await orchestrator.tick();
  await waitForCondition(() => started.includes("4"), "expected queued issue to dispatch after a slot freed");
  assert.deepEqual(started, ["1", "2", "3", "4"]);
  assert.equal(orchestrator.state.running.has("4"), true);
});

test("orchestrator backfills later queued issues when batched revalidation drops earlier ones", async () => {
  const started: string[] = [];
  const stateLookups: string[][] = [];
  const pendingById = new Map<string, ReturnType<typeof deferred<PipelineRunResult>>>();
  const candidates = [
    makeIssue({ id: "1", identifier: "ENG-1", priority: 1 }),
    makeIssue({ id: "2", identifier: "ENG-2", priority: 2 }),
    makeIssue({ id: "3", identifier: "ENG-3", priority: 3 }),
    makeIssue({ id: "4", identifier: "ENG-4", priority: 4 }),
    makeIssue({ id: "5", identifier: "ENG-5", priority: 5 }),
    makeIssue({ id: "6", identifier: "ENG-6", priority: 6 }),
  ];

  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return candidates;
    },
    async fetchIssueStatesByIds(issueIds: string[]) {
      stateLookups.push([...issueIds]);
      return [
        makeIssue({ id: "1", identifier: "ENG-1", priority: 1, state: "Done" }),
        makeIssue({ id: "2", identifier: "ENG-2", priority: 2, assigneeId: "other-user" }),
        makeIssue({ id: "3", identifier: "ENG-3", priority: 3, blockedBy: [{ id: "x", identifier: "ENG-0", state: "In Progress" }] }),
        makeIssue({ id: "4", identifier: "ENG-4", priority: 4 }),
        makeIssue({ id: "5", identifier: "ENG-5", priority: 5 }),
        makeIssue({ id: "6", identifier: "ENG-6", priority: 6 }),
      ].filter((issue) => issueIds.includes(issue.id));
    },
    async fetchTerminalIssues() {
      return [];
    },
    transitionIssue: noopTransitionIssue,
  };

  const orchestrator = new VajraOrchestrator(
    tracker,
    { current: () => makeWorkflowDefinition({ maxConcurrentAgents: 3 }) },
    {
      startRun({ issue }): PipelineRunHandle {
        started.push(issue.id);
        const pending = deferred<PipelineRunResult>();
        pendingById.set(issue.id, pending);
        return {
          promise: pending.promise,
          async cancel() {
            pending.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
          },
        };
      },
    },
    stubWorkspace(),
  );

  await orchestrator.tick();
  await flushAsyncWork();

  assert.deepEqual(stateLookups, [["1"], ["2"], ["3"], ["4"], ["5"], ["6"]]);
  assert.deepEqual(started, ["4", "5", "6"]);

  candidates.splice(0, candidates.length);
  pendingById.get("4")?.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
  pendingById.get("5")?.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
  pendingById.get("6")?.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
  await Promise.all([
    pendingById.get("4")?.promise,
    pendingById.get("5")?.promise,
    pendingById.get("6")?.promise,
  ]);
  await flushAsyncWork();
});

test("orchestrator queues overlapping tick requests and runs them serially", async () => {
  let candidateCalls = 0;
  let candidateInFlight = 0;
  let maxCandidateInFlight = 0;
  const releaseFirstPoll = deferred<void>();

  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      candidateCalls += 1;
      candidateInFlight += 1;
      maxCandidateInFlight = Math.max(maxCandidateInFlight, candidateInFlight);

      try {
        if (candidateCalls === 1) {
          await releaseFirstPoll.promise;
        }

        return [];
      } finally {
        candidateInFlight -= 1;
      }
    },
    async fetchIssueStatesByIds() {
      return [];
    },
    async fetchTerminalIssues() {
      return [];
    },
    transitionIssue: noopTransitionIssue,
  };

  const orchestrator = new VajraOrchestrator(
    tracker,
    { current: () => makeWorkflowDefinition() },
    { startRun(): PipelineRunHandle { throw new Error("unexpected run start"); } },
    stubWorkspace(),
  );

  const firstTick = orchestrator.tick();
  await waitForCondition(
    () => candidateCalls === 1,
    "expected the first tick to begin polling candidates",
  );

  await orchestrator.tick();
  assert.equal(candidateCalls, 1);

  releaseFirstPoll.resolve();
  await firstTick;

  await waitForCondition(
    () => candidateCalls === 2,
    "expected an overlapping tick request to trigger one deferred rerun",
  );

  assert.equal(maxCandidateInFlight, 1);
});

test("orchestrator does not redispatch issues that are already running or claimed", async () => {
  const started: string[] = [];
  const pending = deferred<PipelineRunResult>();

  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return [makeIssue()];
    },
    async fetchIssueStatesByIds(issueIds: string[]) {
      return [makeIssue()].filter((issue) => issueIds.includes(issue.id));
    },
    async fetchTerminalIssues() {
      return [];
    },
    transitionIssue: noopTransitionIssue,
  };

  const orchestrator = new VajraOrchestrator(
    tracker,
    { current: () => makeWorkflowDefinition() },
    {
      startRun({ issue }): PipelineRunHandle {
        started.push(issue.id);
        return {
          promise: pending.promise,
          async cancel() {
            pending.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
          },
        };
      },
    },
    stubWorkspace(),
  );

  await orchestrator.tick();
  await orchestrator.tick();

  assert.deepEqual(started, ["1"]);
  assert.equal(orchestrator.state.running.size, 1);

  pending.resolve({ status: "success", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
  await pending.promise;
});

test("orchestrator safely retries a rate-limited single-issue revalidation request", async () => {
  const started: string[] = [];
  const requests: Array<{ query: string; ids?: string[] }> = [];
  const pendingRuns: Array<ReturnType<typeof deferred<PipelineRunResult>>> = [];

  const fetchImpl: typeof fetch = async (_input, init) => {
    const payload = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
    requests.push({
      query: payload.query,
      ids: Array.isArray(payload.variables.ids) ? [...payload.variables.ids as string[]] : undefined,
    });

    if (payload.query.includes("CandidateIssues")) {
      return new Response(JSON.stringify({
        data: {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "1",
                identifier: "ENG-1",
                title: "Todo 1",
                description: null,
                priority: 1,
                createdAt: "2026-03-10T00:00:00.000Z",
                updatedAt: null,
                url: null,
                state: { name: "Todo" },
                assignee: { id: "vajra-uuid" },
                creator: { id: "creator-1" },
                labels: { nodes: [] },
                relations: { nodes: [] },
              },
              {
                id: "2",
                identifier: "ENG-2",
                title: "Todo 2",
                description: null,
                priority: 2,
                createdAt: "2026-03-10T00:00:01.000Z",
                updatedAt: null,
                url: null,
                state: { name: "Todo" },
                assignee: { id: "vajra-uuid" },
                creator: { id: "creator-2" },
                labels: { nodes: [] },
                relations: { nodes: [] },
              },
              {
                id: "3",
                identifier: "ENG-3",
                title: "Todo 3",
                description: null,
                priority: 3,
                createdAt: "2026-03-10T00:00:02.000Z",
                updatedAt: null,
                url: null,
                state: { name: "Todo" },
                assignee: { id: "vajra-uuid" },
                creator: { id: "creator-3" },
                labels: { nodes: [] },
                relations: { nodes: [] },
              },
            ],
          },
        },
      }), { status: 200 });
    }

    if (payload.query.includes("IssueStates") && requests.filter((request) => request.query.includes("IssueStates")).length === 1) {
      return new Response(JSON.stringify({
        errors: [{ message: "Rate limited", extensions: { code: "RATELIMITED" } }],
      }), {
        status: 400,
        headers: { "retry-after": "0" },
      });
    }

    if (payload.query.includes("IssueStates")) {
      const requestedIds = new Set((payload.variables.ids as string[]) ?? []);
      return new Response(JSON.stringify({
        data: {
          issues: {
            nodes: [
              {
                id: "1",
                identifier: "ENG-1",
                title: "Todo 1",
                description: null,
                priority: 1,
                createdAt: "2026-03-10T00:00:00.000Z",
                updatedAt: null,
                url: null,
                state: { name: "Todo" },
                assignee: { id: "vajra-uuid" },
                creator: { id: "creator-1" },
                labels: { nodes: [] },
                relations: { nodes: [] },
              },
              {
                id: "2",
                identifier: "ENG-2",
                title: "Todo 2",
                description: null,
                priority: 2,
                createdAt: "2026-03-10T00:00:01.000Z",
                updatedAt: null,
                url: null,
                state: { name: "Done" },
                assignee: { id: "vajra-uuid" },
                creator: { id: "creator-2" },
                labels: { nodes: [] },
                relations: { nodes: [] },
              },
              {
                id: "3",
                identifier: "ENG-3",
                title: "Todo 3",
                description: null,
                priority: 3,
                createdAt: "2026-03-10T00:00:02.000Z",
                updatedAt: null,
                url: null,
                state: { name: "Todo" },
                assignee: { id: "vajra-uuid" },
                creator: { id: "creator-3" },
                labels: { nodes: [] },
                relations: { nodes: [] },
              },
            ].filter((issue) => requestedIds.has(issue.id)),
          },
        },
      }), { status: 200 });
    }

    if (payload.query.includes("IssueTeamStates")) {
      return new Response(JSON.stringify({
        data: {
          issue: {
            team: {
              states: {
                nodes: [
                  { id: "todo", name: "Todo" },
                  { id: "in-progress", name: "In Progress" },
                  { id: "done", name: "Done" },
                ],
              },
            },
          },
        },
      }), { status: 200 });
    }

    if (payload.query.includes("TransitionIssue")) {
      return new Response(JSON.stringify({
        data: {
          issueUpdate: { success: true },
        },
      }), { status: 200 });
    }

    throw new Error(`unexpected query: ${payload.query}`);
  };

  const tracker = new LinearTrackerClient({
    kind: "linear",
    endpoint: "https://api.linear.app/graphql",
    apiKey: "token",
    assigneeId: "vajra-uuid",
    activeStates: ["Todo"],
    terminalStates: ["Done"],
  }, fetchImpl);

  const orchestrator = new VajraOrchestrator(
    tracker,
    { current: () => makeWorkflowDefinition({ maxConcurrentAgents: 3 }) },
    {
      startRun({ issue }): PipelineRunHandle {
        started.push(issue.id);
        const pending = deferred<PipelineRunResult>();
        pendingRuns.push(pending);
        return {
          promise: pending.promise,
          async cancel() {
            pending.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
          },
        };
      },
    },
    stubWorkspace(),
  );

  await orchestrator.tick();
  await flushAsyncWork();

  assert.deepEqual(started, ["1", "3"]);
  const issueStateRequests = requests.filter((request) => request.query.includes("IssueStates"));
  assert.equal(issueStateRequests.length, 4);
  assert.deepEqual(issueStateRequests.map((request) => request.ids), [["1"], ["1"], ["2"], ["3"]]);

  for (const pending of pendingRuns) {
    pending.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
    await pending.promise;
  }
});

test("orchestrator schedules retry when a run fails", async () => {
  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return [{
        id: "1",
        identifier: "ENG-1",
        title: "Retry me",
        description: null,
        state: "Todo",
        priority: 1,
        labels: [],
        assigneeId: "vajra-uuid",
        creatorId: null,
        createdAt: "2026-03-10T00:00:00.000Z",
        updatedAt: null,
        url: null,
        blockedBy: [],
      }];
    },
    async fetchIssueStatesByIds(issueIds: string[]) {
      return (await this.fetchCandidateIssues()).filter((issue) => issueIds.includes(issue.id));
    },
    async fetchTerminalIssues() {
      return [];
    },
    async transitionIssue() {},
  };

  const workflow: WorkflowDefinition = {
    path: "/tmp/WORKFLOW.md",
    config: {
      tracker: {
        kind: "linear",
        endpoint: "https://api.linear.app/graphql",
        apiKey: "token",
        assigneeId: "vajra-uuid",
        activeStates: ["Todo"],
        terminalStates: ["Done"],
      },
      polling: { intervalMs: 30_000 },
      workspace: { root: "/tmp/vajra-workspaces" },
      artifacts: { root: "/tmp/vajra-plans", workspaceDir: ".vajra" },
      hooks: { timeoutMs: 60_000 },
      execution: {
        maxConcurrentAgents: 1,
        maxRetryAttempts: 3,
        maxRetryBackoffMs: 60_000,
        maxConcurrentAgentsByState: {},
      },
      workflows: {
        default: { dotFile: "/tmp/default.dot" },
      },
      workflowRouting: {
        defaultWorkflow: "default",
        byLabel: {},
      },
      slack: null,
      backends: {},
      agents: {},
    },
  };

  const orchestrator = new VajraOrchestrator(
    tracker,
    { current: () => workflow },
    {
      startRun(): PipelineRunHandle {
        return {
          promise: Promise.resolve({
            status: "failure",
            completedNodes: [],
            checkpointPath: "/tmp/checkpoint.json",
            error: "boom",
          }),
          async cancel() {},
        };
      },
    },
    () => ({
      async prepareWorkspace(identifier: string) {
        return { path: `/tmp/${identifier}`, workspaceKey: identifier, createdNow: true };
      },
      async runBeforeRunHook() {},
      async runAfterRunHook() {},
      async cleanupWorkspace() {},
      workspacePathForIssue(identifier: string) { return `/tmp/${identifier}`; },
      validateWorkspacePath: async () => undefined,
    } as never),
    () => 1_000,
  );

  await orchestrator.tick();
  await new Promise((resolve) => setImmediate(resolve));

  const retry = orchestrator.state.retryAttempts.get("1");
  assert.ok(retry);
  assert.equal(retry?.attempt, 1);
  assert.equal(retry?.dueAtMs, 11_000);
});

test("orchestrator dispatches a scheduled retry on a later tick with the retry attempt", async () => {
  let nowMs = 1_000;
  const startedAttempts: number[] = [];
  const retryPending = deferred<PipelineRunResult>();
  let runCount = 0;

  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return [{
        id: "1",
        identifier: "ENG-1",
        title: "Retry later",
        description: null,
        state: "Todo",
        priority: 1,
        labels: [],
        assigneeId: "vajra-uuid",
        creatorId: null,
        createdAt: "2026-03-10T00:00:00.000Z",
        updatedAt: null,
        url: null,
        blockedBy: [],
      }];
    },
    async fetchIssueStatesByIds(issueIds: string[]) {
      return (await this.fetchCandidateIssues()).filter((issue) => issueIds.includes(issue.id));
    },
    async fetchTerminalIssues() {
      return [];
    },
    transitionIssue: noopTransitionIssue,
  };

  const workflow: WorkflowDefinition = {
    path: "/tmp/WORKFLOW.md",
    config: {
      tracker: {
        kind: "linear",
        endpoint: "https://api.linear.app/graphql",
        apiKey: "token",
        assigneeId: "vajra-uuid",
        activeStates: ["Todo"],
        terminalStates: ["Done"],
      },
      polling: { intervalMs: 30_000 },
      workspace: { root: "/tmp/vajra-workspaces" },
      artifacts: { root: "/tmp/vajra-plans", workspaceDir: ".vajra" },
      hooks: { timeoutMs: 60_000 },
      execution: {
        maxConcurrentAgents: 1,
        maxRetryAttempts: 3,
        maxRetryBackoffMs: 60_000,
        maxConcurrentAgentsByState: {},
      },
      workflows: {
        default: { dotFile: "/tmp/default.dot" },
      },
      workflowRouting: {
        defaultWorkflow: "default",
        byLabel: {},
      },
      slack: null,
      backends: {},
      agents: {},
    },
  };

  const orchestrator = new VajraOrchestrator(
    tracker,
    { current: () => workflow },
    {
      startRun({ attempt }): PipelineRunHandle {
        startedAttempts.push(attempt);
        runCount += 1;
        if (runCount === 1) {
          return {
            promise: Promise.resolve({
              status: "failure",
              completedNodes: [],
              checkpointPath: "/tmp/checkpoint.json",
              error: "boom",
            }),
            async cancel() {},
          };
        }

        return {
          promise: retryPending.promise,
          async cancel() {
            retryPending.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
          },
        };
      },
    },
    stubWorkspace(),
    () => nowMs,
  );

  await orchestrator.tick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(startedAttempts, [0]);
  assert.equal(orchestrator.state.retryAttempts.get("1")?.attempt, 1);

  nowMs = 11_000;
  await orchestrator.tick();

  assert.deepEqual(startedAttempts, [0, 1]);
  assert.equal(orchestrator.state.running.get("1")?.attempt, 1);

  retryPending.resolve({ status: "success", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
  await retryPending.promise;
});

test("orchestrator preserves retry state when single-issue retry revalidation fails transiently", async () => {
  let nowMs = 1_000;
  let failRetryRevalidation = false;
  const startedAttempts: number[] = [];
  const retryPending = deferred<PipelineRunResult>();
  let runCount = 0;

  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return [{
        id: "1",
        identifier: "ENG-1",
        title: "Retry with transient refresh failure",
        description: null,
        state: "Todo",
        priority: 1,
        labels: [],
        assigneeId: "vajra-uuid",
        creatorId: null,
        createdAt: "2026-03-10T00:00:00.000Z",
        updatedAt: null,
        url: null,
        blockedBy: [],
      }];
    },
    async fetchIssueStatesByIds(issueIds: string[]) {
      if (failRetryRevalidation && issueIds.includes("1")) {
        failRetryRevalidation = false;
        throw new Error("linear revalidation unavailable");
      }
      return (await this.fetchCandidateIssues()).filter((issue) => issueIds.includes(issue.id));
    },
    async fetchTerminalIssues() {
      return [];
    },
    transitionIssue: noopTransitionIssue,
  };

  const orchestrator = new VajraOrchestrator(
    tracker,
    { current: () => makeWorkflowDefinition({ maxRetryAttempts: 3 }) },
    {
      startRun({ attempt }): PipelineRunHandle {
        startedAttempts.push(attempt);
        runCount += 1;
        if (runCount === 1) {
          return {
            promise: Promise.resolve({
              status: "failure",
              completedNodes: [],
              checkpointPath: "/tmp/checkpoint.json",
              error: "boom",
            }),
            async cancel() {},
          };
        }

        return {
          promise: retryPending.promise,
          async cancel() {
            retryPending.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
          },
        };
      },
    },
    stubWorkspace(),
    () => nowMs,
  );

  await orchestrator.tick();
  await flushAsyncWork();

  assert.deepEqual(startedAttempts, [0]);
  assert.equal(orchestrator.state.retryAttempts.get("1")?.attempt, 1);

  nowMs = 11_000;
  failRetryRevalidation = true;
  await orchestrator.tick();

  assert.deepEqual(startedAttempts, [0]);
  assert.equal(orchestrator.state.retryAttempts.get("1")?.attempt, 1);

  await orchestrator.tick();

  assert.deepEqual(startedAttempts, [0, 1]);
  assert.equal(orchestrator.state.running.get("1")?.attempt, 1);

  retryPending.resolve({ status: "success", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
  await retryPending.promise;
});

test("orchestrator requests clarification, blocks redispatch, and reruns triage after the issue changes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-triage-barrier-"));
  const triageOutputPath = path.join(tempDir, "triage-output.json");
  await writeFile(
    triageOutputPath,
    "{\"action\":\"request-clarification\",\"comment\":\"Please clarify the expected outcome\",\"reasoning\":\"Missing expected outcome\"}",
    "utf8",
  );

  let updatedAt = "2026-03-10T00:00:00.000Z";
  const comments: string[] = [];
  const started: string[] = [];

  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return [makeIssue({ updatedAt, description: "" })];
    },
    async fetchIssueStatesByIds(issueIds: string[]) {
      return (await this.fetchCandidateIssues()).filter((issue) => issueIds.includes(issue.id));
    },
    async fetchTerminalIssues() {
      return [];
    },
    async commentOnIssue(_issueId: string, body: string) {
      comments.push(body);
    },
    transitionIssue: noopTransitionIssue,
  };

  const workflow = makeWorkflowDefinition({
    triage: {
      enabled: true,
      backend: "triage",
      model: "triage-model",
      timeoutMs: 1_000,
    },
    backends: {
      triage: {
        command: `sh -lc 'cat ${triageOutputPath}'`,
      },
    },
  });

  const orchestrator = new VajraOrchestrator(
    tracker,
    { current: () => workflow },
    {
      startRun({ issue }): PipelineRunHandle {
        started.push(issue.id);
        return {
          promise: Promise.resolve({
            status: "success",
            completedNodes: [],
            checkpointPath: "/tmp/checkpoint.json",
          }),
          async cancel() {},
        };
      },
    },
    stubWorkspace(),
  );

  await orchestrator.tick();
  await flushAsyncWork();

  assert.deepEqual(started, []);
  assert.deepEqual(comments, ["Please clarify the expected outcome"]);
  assert.equal(orchestrator.state.clarificationRequested.get("1"), updatedAt);

  await orchestrator.tick();
  await flushAsyncWork();
  assert.deepEqual(started, []);
  assert.deepEqual(comments, ["Please clarify the expected outcome"]);

  updatedAt = "2026-03-10T01:00:00.000Z";
  await writeFile(
    triageOutputPath,
    "{\"action\":\"dispatch\",\"workflowName\":\"default\",\"baseBranch\":\"dev\",\"targetBranch\":\"dev\",\"mergeStrategy\":\"pr-only\",\"labels\":[\"document\"],\"reasoning\":\"Issue is now clear\"}",
    "utf8",
  );

  await orchestrator.tick();
  await flushAsyncWork();

  assert.deepEqual(started, ["1"]);
  assert.equal(orchestrator.state.clarificationRequested.has("1"), false);
  assert.equal(comments.length, 2);
  assert.match(comments[1] ?? "", /\*\*Vajra triage\*\*/);
  assert.match(comments[1] ?? "", /`dev`/);
});

test("orchestrator claims a pre-run failure, schedules retry, and does not repeat triage side effects before retry is due", async () => {
  const comments: string[] = [];
  const labels: string[] = [];
  const beforeRunCalls: string[] = [];

  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return [makeIssue({ updatedAt: "2026-03-30T00:00:00.000Z" })];
    },
    async fetchIssueStatesByIds(issueIds: string[]) {
      return (await this.fetchCandidateIssues()).filter((issue) => issueIds.includes(issue.id));
    },
    async fetchTerminalIssues() {
      return [];
    },
    async transitionIssue() {},
    async addIssueLabel(_issueId, labelName) {
      labels.push(labelName);
    },
    async commentOnIssue(_issueId, body) {
      comments.push(body);
    },
  };

  const orchestrator = new VajraOrchestrator(
    tracker,
    {
      current: () => makeWorkflowDefinition({
        maxRetryAttempts: 1,
        triage: {
          enabled: true,
          backend: "triage",
          model: "gpt-5.4",
          reasoningEffort: "medium",
          timeoutMs: 5_000,
        },
        backends: {
          triage: {
            command: "node -p \"JSON.stringify({ action: 'dispatch', workflowName: 'default', labels: ['document'], reasoning: 'triage ok' })\"",
          },
        },
      }),
    },
    {
      startRun(): PipelineRunHandle {
        assert.fail("pipeline run should not start when pre-run setup fails");
      },
    },
    () => ({
      async prepareWorkspace(identifier: string) {
        return { path: `/tmp/${identifier}`, workspaceKey: identifier, createdNow: true };
      },
      async runBeforeRunHook(workspacePath: string) {
        beforeRunCalls.push(workspacePath);
        throw new Error("before-run failed");
      },
      async runAfterRunHook() {},
      async cleanupWorkspace() {},
      workspacePathForIssue(identifier: string) { return `/tmp/${identifier}`; },
      validateWorkspacePath: async () => undefined,
    } as never),
    () => 1_000,
  );

  await orchestrator.tick();

  assert.equal(comments.length, 1);
  assert.equal(labels.length, 1);
  assert.equal(beforeRunCalls.length, 1);
  const retry = orchestrator.state.retryAttempts.get("1");
  assert.equal(retry?.attempt, 1);
  assert.equal(retry?.dispatchPlan?.workflowName, "default");
  assert.equal(orchestrator.state.claimed.has("1"), true);

  await orchestrator.tick();

  assert.equal(comments.length, 1);
  assert.equal(labels.length, 1);
  assert.equal(beforeRunCalls.length, 1);
});

test("orchestrator reuses the original dispatch plan across retries without re-triaging", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-triage-retry-"));
  const triageOutputPath = path.join(tempDir, "triage-output.json");
  const triageHitsPath = path.join(tempDir, "triage-hits.log");
  await writeFile(
    triageOutputPath,
    "{\"action\":\"dispatch\",\"workflowName\":\"default\",\"baseBranch\":\"dev\",\"targetBranch\":\"dev\",\"mergeStrategy\":\"pr-only\",\"labels\":[\"document\"],\"reasoning\":\"Initial triage\"}",
    "utf8",
  );

  let nowMs = 1_000;
  const startedPlans: Array<{ attempt: number; dispatchPlan: Record<string, unknown> | undefined }> = [];
  const retryPending = deferred<PipelineRunResult>();

  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return [makeIssue()];
    },
    async fetchIssueStatesByIds(issueIds: string[]) {
      return (await this.fetchCandidateIssues()).filter((issue) => issueIds.includes(issue.id));
    },
    async fetchTerminalIssues() {
      return [];
    },
    transitionIssue: noopTransitionIssue,
  };

  const workflow = makeWorkflowDefinition({
    triage: {
      enabled: true,
      backend: "triage",
      model: "triage-model",
      timeoutMs: 1_000,
    },
    backends: {
      triage: {
        command: `sh -lc 'echo hit >> ${triageHitsPath}; cat ${triageOutputPath}'`,
      },
    },
  });

  const orchestrator = new VajraOrchestrator(
    tracker,
    { current: () => workflow },
    {
      startRun({ attempt, dispatchPlan }): PipelineRunHandle {
        startedPlans.push({
          attempt,
          dispatchPlan: dispatchPlan ? structuredClone(dispatchPlan) as Record<string, unknown> : undefined,
        });
        if (attempt === 0) {
          return {
            promise: Promise.resolve({
              status: "failure",
              completedNodes: [],
              checkpointPath: "/tmp/checkpoint.json",
              error: "boom",
            }),
            async cancel() {},
          };
        }

        return {
          promise: retryPending.promise,
          async cancel() {
            retryPending.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
          },
        };
      },
    },
    stubWorkspace(),
    () => nowMs,
  );

  await orchestrator.tick();
  await flushAsyncWork();

  await writeFile(
    triageOutputPath,
    "{\"action\":\"dispatch\",\"workflowName\":\"default\",\"baseBranch\":\"main\",\"targetBranch\":\"main\",\"mergeStrategy\":\"auto-merge\",\"labels\":[],\"reasoning\":\"This should not be used\"}",
    "utf8",
  );

  nowMs = 11_000;
  await orchestrator.tick();
  await flushAsyncWork();

  const triageHits = (await readFile(triageHitsPath, "utf8")).trim().split("\n").filter(Boolean);
  assert.deepEqual(triageHits, ["hit"]);
  assert.deepEqual(startedPlans.map((entry) => entry.attempt), [0, 1]);
  assert.deepEqual(startedPlans[1]?.dispatchPlan, startedPlans[0]?.dispatchPlan);

  retryPending.resolve({ status: "success", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
  await retryPending.promise;
});

test("orchestrator enables GitHub auto-merge when triage requests it and a PR exists", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-triage-automerge-"));
  const triageOutputPath = path.join(tempDir, "triage-output.json");
  await writeFile(
    triageOutputPath,
    "{\"action\":\"dispatch\",\"workflowName\":\"default\",\"baseBranch\":\"dev\",\"targetBranch\":\"dev\",\"mergeStrategy\":\"auto-merge\",\"labels\":[],\"reasoning\":\"Safe to auto-merge\"}",
    "utf8",
  );

  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return [makeIssue()];
    },
    async fetchIssueStatesByIds(issueIds: string[]) {
      return (await this.fetchCandidateIssues()).filter((issue) => issueIds.includes(issue.id));
    },
    async fetchTerminalIssues() {
      return [];
    },
    transitionIssue: noopTransitionIssue,
  };

  const workflow = makeWorkflowDefinition({
    triage: {
      enabled: true,
      backend: "triage",
      model: "triage-model",
      timeoutMs: 1_000,
    },
    backends: {
      triage: {
        command: `sh -lc 'cat ${triageOutputPath}'`,
      },
    },
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
  });

  const requests: Array<{ url: string; body: string | null }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({
      url,
      body: typeof init?.body === "string" ? init.body : null,
    });

    if (url.includes("/branches")) {
      return new Response(JSON.stringify([{ name: "main" }, { name: "dev" }]), { status: 200 });
    }
    if (url.includes("/pulls?state=open")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (url.endsWith("/pulls/123")) {
      return new Response(JSON.stringify({ node_id: "PR_node_123" }), { status: 200 });
    }
    if (url === "https://api.github.com/graphql") {
      return new Response(JSON.stringify({
        data: {
          enablePullRequestAutoMerge: { clientMutationId: null },
        },
      }), { status: 200 });
    }

    return originalFetch(input, init);
  };

  try {
    const orchestrator = new VajraOrchestrator(
      tracker,
      { current: () => workflow },
      {
        startRun(): PipelineRunHandle {
          return {
            promise: Promise.resolve({
              status: "success",
              completedNodes: [],
              checkpointPath: "/tmp/checkpoint.json",
              pr: {
                number: 123,
                url: "https://github.com/acme-corp/acme-app/pull/123",
              },
              prUrl: "https://github.com/acme-corp/acme-app/pull/123",
            }),
            async cancel() {},
          };
        },
      },
      stubWorkspace(),
    );

    await orchestrator.tick();
    await waitForCondition(
      () => requests.some((request) => request.url === "https://api.github.com/graphql"),
      "expected GitHub auto-merge to be enabled",
    );

    assert.ok(requests.some((request) => request.url.includes("/repos/acme-corp/acme-app/branches")));
    assert.ok(requests.some((request) => request.url.includes("/repos/acme-corp/acme-app/pulls?state=open")));
    assert.ok(requests.some((request) => request.url.endsWith("/repos/acme-corp/acme-app/pulls/123")));
    assert.ok(requests.some((request) => request.url === "https://api.github.com/graphql" && /PR_node_123/.test(String(request.body ?? ""))));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("orchestrator enables GitHub auto-merge from persisted PR records when the run result omits PR data", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-triage-automerge-persisted-"));
  const triageOutputPath = path.join(tempDir, "triage-output.json");
  await writeFile(
    triageOutputPath,
    "{\"action\":\"dispatch\",\"workflowName\":\"default\",\"baseBranch\":\"dev\",\"targetBranch\":\"dev\",\"mergeStrategy\":\"auto-merge\",\"labels\":[],\"reasoning\":\"Safe to auto-merge\"}",
    "utf8",
  );

  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return [makeIssue({ identifier: "ENG-PR", id: "1" })];
    },
    async fetchIssueStatesByIds(issueIds: string[]) {
      return (await this.fetchCandidateIssues()).filter((issue) => issueIds.includes(issue.id));
    },
    async fetchTerminalIssues() {
      return [];
    },
    transitionIssue: noopTransitionIssue,
  };

  const workflow = makeWorkflowDefinition({
    triage: {
      enabled: true,
      backend: "triage",
      model: "triage-model",
      timeoutMs: 1_000,
    },
    backends: {
      triage: {
        command: `sh -lc 'cat ${triageOutputPath}'`,
      },
    },
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
  });
  workflow.config.artifacts.root = path.join(tempDir, "plans");

  await new ReviewArtifactStore(workflow.config.artifacts, "ENG-PR").savePrRecord({
    issueIdentifier: "ENG-PR",
    repository: "acme-corp/acme-app",
    number: 456,
    url: "https://github.com/acme-corp/acme-app/pull/456",
    title: "Existing PR",
    headRefName: "eng-pr",
    headSha: "abc123",
    state: "open",
    updatedAt: new Date().toISOString(),
  });

  const requests: Array<{ url: string; body: string | null }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({
      url,
      body: typeof init?.body === "string" ? init.body : null,
    });

    if (url.includes("/branches")) {
      return new Response(JSON.stringify([{ name: "main" }, { name: "dev" }]), { status: 200 });
    }
    if (url.includes("/pulls?state=open")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (url.endsWith("/pulls/456")) {
      return new Response(JSON.stringify({ node_id: "PR_node_456" }), { status: 200 });
    }
    if (url === "https://api.github.com/graphql") {
      return new Response(JSON.stringify({
        data: {
          enablePullRequestAutoMerge: { clientMutationId: null },
        },
      }), { status: 200 });
    }

    return originalFetch(input, init);
  };

  try {
    const orchestrator = new VajraOrchestrator(
      tracker,
      { current: () => workflow },
      {
        startRun(): PipelineRunHandle {
          return {
            promise: Promise.resolve({
              status: "success",
              completedNodes: [],
              checkpointPath: "/tmp/checkpoint.json",
              pr: null,
              prUrl: null,
            }),
            async cancel() {},
          };
        },
      },
      stubWorkspace(),
    );

    await orchestrator.tick();
    await waitForCondition(
      () => requests.some((request) => request.url === "https://api.github.com/graphql"),
      "expected GitHub auto-merge to be enabled from persisted PR state",
    );

    assert.ok(requests.some((request) => request.url.endsWith("/repos/acme-corp/acme-app/pulls/456")));
    assert.ok(requests.some((request) => request.url === "https://api.github.com/graphql" && /PR_node_456/.test(String(request.body ?? ""))));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("orchestrator emits the persisted PR URL when a successful run omits immediate PR metadata", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-completed-pr-event-"));
  const issue = makeIssue({ id: "1", identifier: "ENG-PR-EVENT", url: "https://linear.app/acme/issue/ENG-PR-EVENT" });
  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return [issue];
    },
    async fetchIssueStatesByIds(issueIds: string[]) {
      return (await this.fetchCandidateIssues()).filter((entry) => issueIds.includes(entry.id));
    },
    async fetchTerminalIssues() {
      return [];
    },
    transitionIssue: noopTransitionIssue,
  };

  const workflow = makeWorkflowDefinition();
  workflow.config.artifacts.root = path.join(tempDir, "plans");

  await new ReviewArtifactStore(workflow.config.artifacts, issue.identifier).savePrRecord({
    issueIdentifier: issue.identifier,
    repository: "acme-corp/acme-app",
    number: 789,
    url: "https://github.com/acme-corp/acme-app/pull/789",
    title: "Existing PR",
    headRefName: "eng-pr-event",
    headSha: "def456",
    state: "open",
    updatedAt: new Date().toISOString(),
  });

  const bus = new VajraEventBus();
  const completedEvents: Array<{ prUrl: string | null }> = [];
  bus.on("issue:completed", (event) => {
    completedEvents.push({ prUrl: event.prUrl });
  });

  const orchestrator = new VajraOrchestrator(
    tracker,
    { current: () => workflow },
    {
      startRun(): PipelineRunHandle {
        return {
          promise: Promise.resolve({
            status: "success",
            completedNodes: ["publish_pr"],
            checkpointPath: "/tmp/checkpoint.json",
            pr: null,
            prUrl: null,
          }),
          async cancel() {},
        };
      },
    },
    stubWorkspace(),
    undefined,
    bus,
  );

  await orchestrator.tick();
  await waitForCondition(
    () => completedEvents.length === 1,
    "expected issue:completed event with persisted PR URL",
  );

  assert.deepEqual(completedEvents, [{
    prUrl: "https://github.com/acme-corp/acme-app/pull/789",
  }]);
});

test("orchestrator caches GitHub branch info across triaged issues in the same tick", async () => {
  const pendingById = new Map<string, ReturnType<typeof deferred<PipelineRunResult>>>();
  const started: string[] = [];
  const candidates = [
    makeIssue({ id: "1", identifier: "ENG-1", priority: 1 }),
    makeIssue({ id: "2", identifier: "ENG-2", priority: 2 }),
  ];
  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return candidates;
    },
    async fetchIssueStatesByIds(issueIds: string[]) {
      return (await this.fetchCandidateIssues()).filter((issue) => issueIds.includes(issue.id));
    },
    async fetchTerminalIssues() {
      return [];
    },
    transitionIssue: noopTransitionIssue,
  };

  const workflow = makeWorkflowDefinition({
    maxConcurrentAgents: 2,
    triage: {
      enabled: true,
      backend: "triage",
      model: "gpt-5.4",
      reasoningEffort: "medium",
      timeoutMs: 5_000,
    },
    backends: {
      triage: {
        command: "node -p \"JSON.stringify({ action: 'dispatch', workflowName: 'default', reasoning: 'cached branch info' })\"",
      },
    },
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
  });

  let branchRequests = 0;
  let pullRequests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/branches")) {
      branchRequests += 1;
      return new Response(JSON.stringify([{ name: "main" }, { name: "dev" }]), { status: 200 });
    }
    if (url.includes("/pulls?state=open")) {
      pullRequests += 1;
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const orchestrator = new VajraOrchestrator(
      tracker,
      { current: () => workflow },
      {
        startRun({ issue }): PipelineRunHandle {
          started.push(issue.id);
          const pending = deferred<PipelineRunResult>();
          pendingById.set(issue.id, pending);
          return {
            promise: pending.promise,
            async cancel() {
              pending.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
            },
          };
        },
      },
      stubWorkspace(),
    );

    await orchestrator.tick();

    assert.deepEqual(started, ["1", "2"]);
    assert.equal(branchRequests, 1);
    assert.equal(pullRequests, 1);

    candidates.splice(0, candidates.length);
    for (const pending of pendingById.values()) {
      pending.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
      await pending.promise;
    }
    await flushAsyncWork();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("orchestrator emits terminal failure only after retries are exhausted and stops redispatching in the same state", async () => {
  let nowMs = 1_000;
  const startedAttempts: number[] = [];
  const failedEvents: Array<{ attempt: number; error: string }> = [];

  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return [makeIssue({ id: "1", identifier: "ENG-1", title: "Retry budget", state: "Todo" })];
    },
    async fetchIssueStatesByIds(issueIds: string[]) {
      return (await this.fetchCandidateIssues()).filter((issue) => issueIds.includes(issue.id));
    },
    async fetchTerminalIssues() {
      return [];
    },
    transitionIssue: noopTransitionIssue,
  };

  const bus = new VajraEventBus();
  bus.on("issue:failed", (event) => {
    failedEvents.push({ attempt: event.attempt, error: event.error });
  });

  const orchestrator = new VajraOrchestrator(
    tracker,
    { current: () => makeWorkflowDefinition({ maxRetryAttempts: 2 }) },
    {
      startRun({ attempt }): PipelineRunHandle {
        startedAttempts.push(attempt);
        return {
          promise: Promise.resolve({
            status: "failure",
            completedNodes: [],
            checkpointPath: "/tmp/checkpoint.json",
            error: `boom-${attempt}`,
            failedStageId: "code",
          }),
          async cancel() {},
        };
      },
    },
    stubWorkspace(),
    () => nowMs,
    bus,
  );

  await orchestrator.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(startedAttempts, [0]);
  assert.equal(failedEvents.length, 0);
  assert.equal(orchestrator.state.retryAttempts.get("1")?.attempt, 1);

  nowMs = 11_000;
  await orchestrator.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(startedAttempts, [0, 1]);
  assert.equal(failedEvents.length, 0);
  assert.equal(orchestrator.state.retryAttempts.get("1")?.attempt, 2);

  nowMs = 31_000;
  await orchestrator.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(startedAttempts, [0, 1, 2]);
  assert.deepEqual(failedEvents, [{ attempt: 2, error: "boom-2" }]);
  assert.equal(orchestrator.state.retryAttempts.has("1"), false);
  assert.equal(orchestrator.state.failed.get("1"), "Todo");

  nowMs = 61_000;
  await orchestrator.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(startedAttempts, [0, 1, 2]);
  assert.deepEqual(failedEvents, [{ attempt: 2, error: "boom-2" }]);
});

test("orchestrator skips blocked issues and respects per-state concurrency", async () => {
  const started: string[] = [];
  const pending = deferred<PipelineRunResult>();

  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return [
        {
          id: "blocked",
          identifier: "ENG-3",
          title: "Blocked",
          description: null,
          state: "Todo",
          priority: 1,
          labels: [],
          assigneeId: "vajra-uuid",
          creatorId: null,
          createdAt: "2026-03-10T00:00:00.000Z",
          updatedAt: null,
          url: null,
          blockedBy: [{ id: "x", identifier: "ENG-0", state: "In Progress" }],
        },
        {
          id: "todo-1",
          identifier: "ENG-4",
          title: "Todo 1",
          description: null,
          state: "Todo",
          priority: 2,
          labels: [],
          assigneeId: "vajra-uuid",
          creatorId: null,
          createdAt: "2026-03-10T00:00:01.000Z",
          updatedAt: null,
          url: null,
          blockedBy: [],
        },
        {
          id: "todo-2",
          identifier: "ENG-5",
          title: "Todo 2",
          description: null,
          state: "Todo",
          priority: 3,
          labels: [],
          assigneeId: "vajra-uuid",
          creatorId: null,
          createdAt: "2026-03-10T00:00:02.000Z",
          updatedAt: null,
          url: null,
          blockedBy: [],
        },
      ];
    },
    async fetchIssueStatesByIds(issueIds: string[]) {
      return (await this.fetchCandidateIssues()).filter((issue) => issueIds.includes(issue.id));
    },
    async fetchTerminalIssues() {
      return [];
    },
    async transitionIssue() {},
  };

  const workflow: WorkflowDefinition = {
    path: "/tmp/WORKFLOW.md",
    config: {
      tracker: {
        kind: "linear",
        endpoint: "https://api.linear.app/graphql",
        apiKey: "token",
        assigneeId: "vajra-uuid",
        activeStates: ["Todo"],
        terminalStates: ["Done"],
      },
      polling: { intervalMs: 30_000 },
      workspace: { root: "/tmp/vajra-workspaces" },
      artifacts: { root: "/tmp/vajra-plans", workspaceDir: ".vajra" },
      hooks: { timeoutMs: 60_000 },
      execution: {
        maxConcurrentAgents: 3,
        maxRetryAttempts: 3,
        maxRetryBackoffMs: 60_000,
        maxConcurrentAgentsByState: { todo: 1 },
      },
      workflows: {
        default: { dotFile: "/tmp/default.dot" },
      },
      workflowRouting: {
        defaultWorkflow: "default",
        byLabel: {},
      },
      slack: null,
      backends: {},
      agents: {},
    },
  };

  const orchestrator = new VajraOrchestrator(
    tracker,
    { current: () => workflow },
    {
      startRun({ issue }): PipelineRunHandle {
        started.push(issue.id);
        return {
          promise: pending.promise,
          async cancel() {
            pending.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
          },
        };
      },
    },
    () => ({
      async prepareWorkspace(identifier: string) {
        return { path: `/tmp/${identifier}`, workspaceKey: identifier, createdNow: true };
      },
      async runBeforeRunHook() {},
      async runAfterRunHook() {},
      async cleanupWorkspace() {},
      workspacePathForIssue(identifier: string) { return `/tmp/${identifier}`; },
      validateWorkspacePath: async () => undefined,
    } as never),
  );

  await orchestrator.tick();
  assert.deepEqual(started, ["todo-1"]);
  pending.resolve({ status: "success", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
  await pending.promise;
});

test("retryBackoffMs grows exponentially and caps at the configured maximum", () => {
  assert.equal(retryBackoffMs(1, 300_000), 10_000);
  assert.equal(retryBackoffMs(2, 300_000), 20_000);
  assert.equal(retryBackoffMs(10, 60_000), 60_000);
});

test("orchestrator skips dispatch when the refreshed issue is no longer assigned to vajra", async () => {
  const started: string[] = [];

  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return [{
        id: "1",
        identifier: "ENG-1",
        title: "Reassigned before dispatch",
        description: null,
        state: "Todo",
        priority: 1,
        labels: [],
        assigneeId: "vajra-uuid",
        creatorId: null,
        createdAt: "2026-03-10T00:00:00.000Z",
        updatedAt: null,
        url: null,
        blockedBy: [],
      }];
    },
    async fetchIssueStatesByIds() {
      return [{
        id: "1",
        identifier: "ENG-1",
        title: "Reassigned before dispatch",
        description: null,
        state: "Todo",
        priority: 1,
        labels: [],
        assigneeId: "other-user",
        creatorId: null,
        createdAt: "2026-03-10T00:00:00.000Z",
        updatedAt: null,
        url: null,
        blockedBy: [],
      }];
    },
    async fetchTerminalIssues() {
      return [];
    },
    transitionIssue: noopTransitionIssue,
  };

  const workflow: WorkflowDefinition = {
    path: "/tmp/WORKFLOW.md",
    config: {
      tracker: {
        kind: "linear",
        endpoint: "https://api.linear.app/graphql",
        apiKey: "token",
        assigneeId: "vajra-uuid",
        activeStates: ["Todo"],
        terminalStates: ["Done"],
      },
      polling: { intervalMs: 30_000 },
      workspace: { root: "/tmp/vajra-workspaces" },
      artifacts: { root: "/tmp/vajra-plans", workspaceDir: ".vajra" },
      hooks: { timeoutMs: 60_000 },
      execution: {
        maxConcurrentAgents: 1,
        maxRetryAttempts: 3,
        maxRetryBackoffMs: 60_000,
        maxConcurrentAgentsByState: {},
      },
      workflows: {
        default: { dotFile: "/tmp/default.dot" },
      },
      workflowRouting: {
        defaultWorkflow: "default",
        byLabel: {},
      },
      slack: null,
      backends: {},
      agents: {},
    },
  };

  const orchestrator = new VajraOrchestrator(
    tracker,
    { current: () => workflow },
    {
      startRun({ issue }): PipelineRunHandle {
        started.push(issue.id);
        return {
          promise: Promise.resolve({ status: "success", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" }),
          cancel: noopTransitionIssue,
        };
      },
    },
    stubWorkspace(),
  );

  await orchestrator.tick();
  assert.deepEqual(started, []);
});

test("orchestrator cancels a running issue when it is reassigned away from vajra", async () => {
  const pending = deferred<PipelineRunResult>();
  const cancelledReasons: string[] = [];
  let refreshCount = 0;

  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return [{
        id: "1",
        identifier: "ENG-1",
        title: "Running reassignment",
        description: null,
        state: "Todo",
        priority: 1,
        labels: [],
        assigneeId: "vajra-uuid",
        creatorId: null,
        createdAt: "2026-03-10T00:00:00.000Z",
        updatedAt: null,
        url: null,
        blockedBy: [],
      }];
    },
    async fetchIssueStatesByIds() {
      refreshCount += 1;
      return [{
        id: "1",
        identifier: "ENG-1",
        title: "Running reassignment",
        description: null,
        state: "Todo",
        priority: 1,
        labels: [],
        assigneeId: refreshCount === 1 ? "vajra-uuid" : "other-user",
        creatorId: null,
        createdAt: "2026-03-10T00:00:00.000Z",
        updatedAt: null,
        url: null,
        blockedBy: [],
      }];
    },
    async fetchTerminalIssues() {
      return [];
    },
    transitionIssue: noopTransitionIssue,
  };

  const workflow: WorkflowDefinition = {
    path: "/tmp/WORKFLOW.md",
    config: {
      tracker: {
        kind: "linear",
        endpoint: "https://api.linear.app/graphql",
        apiKey: "token",
        assigneeId: "vajra-uuid",
        activeStates: ["Todo"],
        terminalStates: ["Done"],
      },
      polling: { intervalMs: 30_000 },
      workspace: { root: "/tmp/vajra-workspaces" },
      artifacts: { root: "/tmp/vajra-plans", workspaceDir: ".vajra" },
      hooks: { timeoutMs: 60_000 },
      execution: {
        maxConcurrentAgents: 1,
        maxRetryAttempts: 3,
        maxRetryBackoffMs: 60_000,
        maxConcurrentAgentsByState: {},
      },
      workflows: {
        default: { dotFile: "/tmp/default.dot" },
      },
      workflowRouting: {
        defaultWorkflow: "default",
        byLabel: {},
      },
      slack: null,
      backends: {},
      agents: {},
    },
  };

  const orchestrator = new VajraOrchestrator(
    tracker,
    { current: () => workflow },
    {
      startRun(): PipelineRunHandle {
        return {
          promise: pending.promise,
          async cancel(reason?: string) {
            cancelledReasons.push(reason ?? "");
            pending.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
          },
        };
      },
    },
    stubWorkspace(),
  );

  await orchestrator.tick();
  await orchestrator.tick();
  await pending.promise;

  assert.equal(cancelledReasons.length, 1);
  assert.match(cancelledReasons[0], /no longer assigned to vajra/);
});

test("orchestrator cancels a running issue that reaches a terminal state and cleans up its workspace", async () => {
  const pending = deferred<PipelineRunResult>();
  const cancelledReasons: string[] = [];
  const cleaned: string[] = [];
  let stateRefreshCount = 0;
  let candidatePollCount = 0;

  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      candidatePollCount += 1;
      if (candidatePollCount > 1) {
        return [];
      }

      return [{
        id: "1",
        identifier: "ENG-1",
        title: "Terminal cleanup",
        description: null,
        state: "Todo",
        priority: 1,
        labels: [],
        assigneeId: "vajra-uuid",
        creatorId: null,
        createdAt: "2026-03-10T00:00:00.000Z",
        updatedAt: null,
        url: null,
        blockedBy: [],
      }];
    },
    async fetchIssueStatesByIds() {
      stateRefreshCount += 1;
      return [{
        id: "1",
        identifier: "ENG-1",
        title: "Terminal cleanup",
        description: null,
        state: stateRefreshCount === 1 ? "Todo" : "Done",
        priority: 1,
        labels: [],
        assigneeId: "vajra-uuid",
        creatorId: null,
        createdAt: "2026-03-10T00:00:00.000Z",
        updatedAt: null,
        url: null,
        blockedBy: [],
      }];
    },
    async fetchTerminalIssues() {
      return [];
    },
    transitionIssue: noopTransitionIssue,
  };

  const workflow: WorkflowDefinition = {
    path: "/tmp/WORKFLOW.md",
    config: {
      tracker: {
        kind: "linear",
        endpoint: "https://api.linear.app/graphql",
        apiKey: "token",
        assigneeId: "vajra-uuid",
        activeStates: ["Todo"],
        terminalStates: ["Done"],
      },
      polling: { intervalMs: 30_000 },
      workspace: { root: "/tmp/vajra-workspaces" },
      artifacts: { root: "/tmp/vajra-plans", workspaceDir: ".vajra" },
      hooks: { timeoutMs: 60_000 },
      execution: {
        maxConcurrentAgents: 1,
        maxRetryAttempts: 3,
        maxRetryBackoffMs: 60_000,
        maxConcurrentAgentsByState: {},
      },
      workflows: {
        default: { dotFile: "/tmp/default.dot" },
      },
      workflowRouting: {
        defaultWorkflow: "default",
        byLabel: {},
      },
      slack: null,
      backends: {},
      agents: {},
    },
  };

  const orchestrator = new VajraOrchestrator(
    tracker,
    { current: () => workflow },
    {
      startRun(): PipelineRunHandle {
        return {
          promise: pending.promise,
          async cancel(reason?: string) {
            cancelledReasons.push(reason ?? "");
            pending.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
          },
        };
      },
    },
    () => ({
      async prepareWorkspace(identifier: string) {
        return { path: `/tmp/${identifier}`, workspaceKey: identifier, createdNow: true };
      },
      async runBeforeRunHook() {},
      async runAfterRunHook() {},
      async cleanupWorkspace(identifier: string) {
        cleaned.push(identifier);
      },
      workspacePathForIssue(identifier: string) { return `/tmp/${identifier}`; },
      validateWorkspacePath: async () => undefined,
    } as never),
  );

  await orchestrator.tick();
  await orchestrator.tick();
  await pending.promise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(cancelledReasons, [RUN_STOP_REASONS.terminal]);
  assert.deepEqual(cleaned, ["ENG-1"]);
});

test("orchestrator keeps ticking while a terminal cancellation is still draining", async () => {
  const pending = deferred<PipelineRunResult>();
  const cancelDrain = deferred<void>();
  const cancelledReasons: string[] = [];
  let candidatePollCount = 0;
  let stateRefreshCount = 0;

  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      candidatePollCount += 1;
      if (candidatePollCount > 1) {
        return [];
      }

      return [{
        id: "1",
        identifier: "ENG-1",
        title: "Terminal cancellation",
        description: null,
        state: "Todo",
        priority: 1,
        labels: [],
        assigneeId: "vajra-uuid",
        creatorId: null,
        createdAt: "2026-03-10T00:00:00.000Z",
        updatedAt: null,
        url: null,
        blockedBy: [],
      }];
    },
    async fetchIssueStatesByIds() {
      stateRefreshCount += 1;
      return [{
        id: "1",
        identifier: "ENG-1",
        title: "Terminal cancellation",
        description: null,
        state: stateRefreshCount === 1 ? "Todo" : "Done",
        priority: 1,
        labels: [],
        assigneeId: "vajra-uuid",
        creatorId: null,
        createdAt: "2026-03-10T00:00:00.000Z",
        updatedAt: null,
        url: null,
        blockedBy: [],
      }];
    },
    async fetchTerminalIssues() {
      return [];
    },
    transitionIssue: noopTransitionIssue,
  };

  const workflow: WorkflowDefinition = {
    path: "/tmp/WORKFLOW.md",
    config: {
      tracker: {
        kind: "linear",
        endpoint: "https://api.linear.app/graphql",
        apiKey: "token",
        assigneeId: "vajra-uuid",
        activeStates: ["Todo"],
        terminalStates: ["Done"],
      },
      polling: { intervalMs: 30_000 },
      workspace: { root: "/tmp/vajra-workspaces" },
      artifacts: { root: "/tmp/vajra-plans", workspaceDir: ".vajra" },
      hooks: { timeoutMs: 60_000 },
      execution: {
        maxConcurrentAgents: 1,
        maxRetryAttempts: 3,
        maxRetryBackoffMs: 60_000,
        maxConcurrentAgentsByState: {},
      },
      workflows: {
        default: { dotFile: "/tmp/default.dot" },
      },
      workflowRouting: {
        defaultWorkflow: "default",
        byLabel: {},
      },
      slack: null,
      backends: {},
      agents: {},
    },
  };

  const orchestrator = new VajraOrchestrator(
    tracker,
    { current: () => workflow },
    {
      startRun(): PipelineRunHandle {
        return {
          promise: pending.promise,
          async cancel(reason?: string) {
            cancelledReasons.push(reason ?? "");
            await cancelDrain.promise;
            pending.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
          },
        };
      },
    },
    stubWorkspace(),
  );

  await orchestrator.tick();
  await orchestrator.tick();
  await orchestrator.tick();

  assert.deepEqual(cancelledReasons, [RUN_STOP_REASONS.terminal]);
  assert.equal(stateRefreshCount, 3);
  assert.equal(orchestrator.state.running.size, 1);

  cancelDrain.resolve();
  await pending.promise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(orchestrator.state.running.size, 0);
});

test("orchestrator moves fresh dispatches to In Progress before Done", async () => {
  const transitions: Array<{ issueId: string; stateName: string }> = [];
  let issueState = "Todo";
  const pending = deferred<PipelineRunResult>();

  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return [makeIssue({ state: issueState, title: "Done transition" })];
    },
    async fetchIssueStatesByIds(issueIds: string[]) {
      return (await this.fetchCandidateIssues()).filter((issue) => issueIds.includes(issue.id));
    },
    async fetchTerminalIssues() {
      return [];
    },
    async transitionIssue(issueId: string, stateName: string) {
      transitions.push({ issueId, stateName });
      issueState = stateName;
    },
  };

  const workflow = makeWorkflowDefinition({ activeStates: ["Todo", "In Progress"] });

  const orchestrator = new VajraOrchestrator(
    tracker,
    { current: () => workflow },
    {
      startRun(): PipelineRunHandle {
        return {
          promise: pending.promise,
          async cancel() {
            pending.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
          },
        };
      },
    },
    stubWorkspace(),
  );

  await orchestrator.tick();
  assert.deepEqual(transitions, [{ issueId: "1", stateName: "In Progress" }]);
  assert.equal(orchestrator.state.running.get("1")?.attempt, 0);

  pending.resolve({ status: "success", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
  await pending.promise;
  await flushAsyncWork();

  assert.deepEqual(transitions, [
    { issueId: "1", stateName: "In Progress" },
    { issueId: "1", stateName: "Done" },
  ]);
});

test("orchestrator uses the resolved workflow success state on completion", async () => {
  const transitions: Array<{ issueId: string; stateName: string }> = [];

  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return [makeIssue({ id: "1", identifier: "ENG-1", labels: ["check"] })];
    },
    async fetchIssueStatesByIds(issueIds: string[]) {
      return (await this.fetchCandidateIssues()).filter((issue) => issueIds.includes(issue.id));
    },
    async fetchTerminalIssues() {
      return [];
    },
    async transitionIssue(issueId: string, stateName: string) {
      transitions.push({ issueId, stateName });
    },
  };

  const workflow = makeWorkflowDefinition();
  workflow.config.workflows = {
    check: { dotFile: "/tmp/check.dot", successState: "Verified" },
    default: { dotFile: "/tmp/default.dot" },
  };
  workflow.config.workflowRouting = {
    defaultWorkflow: "default",
    byLabel: { check: "check" },
  };

  const orchestrator = new VajraOrchestrator(
    tracker,
    { current: () => workflow },
    {
      startRun(): PipelineRunHandle {
        return {
          promise: Promise.resolve({ status: "success", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" }),
          cancel: noopTransitionIssue,
        };
      },
    },
    stubWorkspace(),
  );

  await orchestrator.tick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(transitions, [
    { issueId: "1", stateName: "In Progress" },
    { issueId: "1", stateName: "Verified" },
  ]);
});

test("orchestrator does not re-transition retries to In Progress", async () => {
  let nowMs = 1_000;
  let issueState = "Todo";
  const transitions: Array<{ issueId: string; stateName: string }> = [];
  const retryPending = deferred<PipelineRunResult>();

  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return [makeIssue({ state: issueState, title: "Retry transition" })];
    },
    async fetchIssueStatesByIds(issueIds: string[]) {
      return (await this.fetchCandidateIssues()).filter((issue) => issueIds.includes(issue.id));
    },
    async fetchTerminalIssues() {
      return [];
    },
    async transitionIssue(issueId: string, stateName: string) {
      transitions.push({ issueId, stateName });
      issueState = stateName;
    },
  };

  const workflow = makeWorkflowDefinition({ activeStates: ["Todo", "In Progress"] });

  const orchestrator = new VajraOrchestrator(
    tracker,
    { current: () => workflow },
    {
      startRun({ attempt }): PipelineRunHandle {
        if (attempt === 0) {
          return {
            promise: Promise.resolve({
              status: "failure",
              completedNodes: [],
              checkpointPath: "/tmp/checkpoint.json",
              error: "boom",
            }),
            async cancel() {},
          };
        }

        return {
          promise: retryPending.promise,
          async cancel() {
            retryPending.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
          },
        };
      },
    },
    stubWorkspace(),
    () => nowMs,
  );

  await orchestrator.tick();
  await flushAsyncWork();

  assert.deepEqual(transitions, [{ issueId: "1", stateName: "In Progress" }]);
  assert.equal(orchestrator.state.retryAttempts.get("1")?.attempt, 1);

  nowMs = 11_000;
  await orchestrator.tick();

  assert.deepEqual(transitions, [{ issueId: "1", stateName: "In Progress" }]);
  assert.equal(orchestrator.state.running.get("1")?.attempt, 1);

  retryPending.resolve({ status: "success", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
  await retryPending.promise;
  await flushAsyncWork();

  assert.deepEqual(transitions, [
    { issueId: "1", stateName: "In Progress" },
    { issueId: "1", stateName: "Done" },
  ]);
});

test("orchestrator keeps running when the In Progress transition fails", async () => {
  const transitions: Array<{ issueId: string; stateName: string }> = [];
  const loggedErrors: string[] = [];
  const pending = deferred<PipelineRunResult>();
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [makeIssue({ title: "Transition failure" })];
      },
      async fetchIssueStatesByIds(issueIds: string[]) {
        return (await this.fetchCandidateIssues()).filter((issue) => issueIds.includes(issue.id));
      },
      async fetchTerminalIssues() {
        return [];
      },
      async transitionIssue(issueId: string, stateName: string) {
        transitions.push({ issueId, stateName });
        if (stateName === "In Progress") {
          throw new Error("transition failed");
        }
      },
    };

    const orchestrator = new VajraOrchestrator(
      tracker,
      { current: () => makeWorkflowDefinition() },
      {
        startRun(): PipelineRunHandle {
          return {
            promise: pending.promise,
            async cancel() {
              pending.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
            },
          };
        },
      },
      stubWorkspace(),
    );

    await orchestrator.tick();

    assert.equal(orchestrator.state.running.size, 1);
    assert.deepEqual(transitions, [{ issueId: "1", stateName: "In Progress" }]);
    assert.match(loggedErrors[0] ?? "", /failed to transition issue to In Progress/);

    pending.resolve({ status: "success", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
    await pending.promise;
    await flushAsyncWork();

    assert.equal(orchestrator.state.running.size, 0);
    assert.deepEqual(transitions, [
      { issueId: "1", stateName: "In Progress" },
      { issueId: "1", stateName: "Done" },
    ]);
  } finally {
    console.error = originalConsoleError;
  }
});

test("orchestrator does not redispatch a completed issue until its active state changes", async () => {
  const startedStates: string[] = [];
  let issueState = "Todo";

  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return [{
        id: "1",
        identifier: "ENG-1",
        title: "Completed barrier",
        description: null,
        state: issueState,
        priority: 1,
        labels: [],
        assigneeId: "vajra-uuid",
        creatorId: null,
        createdAt: "2026-03-10T00:00:00.000Z",
        updatedAt: null,
        url: null,
        blockedBy: [],
      }];
    },
    async fetchIssueStatesByIds(issueIds: string[]) {
      return (await this.fetchCandidateIssues()).filter((issue) => issueIds.includes(issue.id));
    },
    async fetchTerminalIssues() {
      return [];
    },
    transitionIssue: noopTransitionIssue,
  };

  const workflow: WorkflowDefinition = {
    path: "/tmp/WORKFLOW.md",
    config: {
      tracker: {
        kind: "linear",
        endpoint: "https://api.linear.app/graphql",
        apiKey: "token",
        assigneeId: "vajra-uuid",
        activeStates: ["Todo", "In Progress"],
        terminalStates: ["Done"],
      },
      polling: { intervalMs: 30_000 },
      workspace: { root: "/tmp/vajra-workspaces" },
      artifacts: { root: "/tmp/vajra-plans", workspaceDir: ".vajra" },
      hooks: { timeoutMs: 60_000 },
      execution: {
        maxConcurrentAgents: 1,
        maxRetryAttempts: 3,
        maxRetryBackoffMs: 60_000,
        maxConcurrentAgentsByState: {},
      },
      workflows: {
        default: { dotFile: "/tmp/default.dot" },
      },
      workflowRouting: {
        defaultWorkflow: "default",
        byLabel: {},
      },
      slack: null,
      backends: {},
      agents: {},
    },
  };

  const orchestrator = new VajraOrchestrator(
    tracker,
    { current: () => workflow },
    {
      startRun({ issue }): PipelineRunHandle {
        startedStates.push(issue.state);
        return {
          promise: Promise.resolve({ status: "success", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" }),
          cancel: noopTransitionIssue,
        };
      },
    },
    stubWorkspace(),
  );

  await orchestrator.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(startedStates, ["Todo"]);
  assert.equal(orchestrator.state.completed.get("1"), "Todo");

  await orchestrator.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(startedStates, ["Todo"]);

  issueState = "In Progress";
  await orchestrator.tick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(startedStates, ["Todo", "In Progress"]);
  assert.equal(orchestrator.state.completed.get("1"), "In Progress");
});

test("orchestrator records terminal failure barriers from the latest tracked issue state", async () => {
  let issueState = "Todo";
  const pending = deferred<PipelineRunResult>();

  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return [makeIssue({ state: issueState, title: "Failure barrier freshness" })];
    },
    async fetchIssueStatesByIds(issueIds: string[]) {
      return (await this.fetchCandidateIssues()).filter((issue) => issueIds.includes(issue.id));
    },
    async fetchTerminalIssues() {
      return [];
    },
    async transitionIssue(_issueId: string, stateName: string) {
      issueState = stateName;
    },
  };

  const orchestrator = new VajraOrchestrator(
    tracker,
    { current: () => makeWorkflowDefinition({ activeStates: ["Todo", "In Progress"], maxRetryAttempts: 0 }) },
    {
      startRun(): PipelineRunHandle {
        return {
          promise: pending.promise,
          async cancel() {
            pending.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
          },
        };
      },
    },
    stubWorkspace(),
  );

  await orchestrator.tick();
  await orchestrator.tick();

  pending.resolve({
    status: "failure",
    completedNodes: [],
    checkpointPath: "/tmp/checkpoint.json",
    error: "tests failed",
    failedStageId: "code",
  });
  await pending.promise;
  await flushAsyncWork();

  assert.equal(orchestrator.state.failed.get("1"), "In Progress");
});

test("orchestrator clears the completed barrier when the success transition fails", async () => {
  const started: string[] = [];
  let issueState = "Todo";
  let issueAvailable = true;
  const retryPending = deferred<PipelineRunResult>();
  let runCount = 0;

  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return issueAvailable
        ? [makeIssue({ state: issueState, title: "Retry after transition failure" })]
        : [];
    },
    async fetchIssueStatesByIds(issueIds: string[]) {
      return (await this.fetchCandidateIssues()).filter((issue) => issueIds.includes(issue.id));
    },
    async fetchTerminalIssues() {
      return [];
    },
    async transitionIssue(_issueId: string, stateName: string) {
      if (stateName === "In Progress") {
        issueState = stateName;
        return;
      }

      throw new Error("done transition failed");
    },
  };

  const orchestrator = new VajraOrchestrator(
    tracker,
    { current: () => makeWorkflowDefinition({ activeStates: ["Todo", "In Progress"], maxConcurrentAgents: 1 }) },
    {
      startRun({ issue }): PipelineRunHandle {
        started.push(issue.state);
        runCount += 1;
        if (runCount === 1) {
          return {
            promise: Promise.resolve({ status: "success", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" }),
            async cancel() {},
          };
        }

        return {
          promise: retryPending.promise,
          async cancel() {
            retryPending.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
          },
        };
      },
    },
    stubWorkspace(),
  );

  await orchestrator.tick();
  await waitForCondition(
    () => started.length === 2,
    "expected the issue to redispatch after the completion transition failed",
  );

  assert.equal(orchestrator.state.completed.has("1"), false);
  assert.deepEqual(started, ["Todo", "In Progress"]);

  issueAvailable = false;
  retryPending.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
  await retryPending.promise;
  await flushAsyncWork();
});

test("orchestrator shutdown waits for monitor cleanup and removes shutdown-cancelled workspaces", async () => {
  const pending = deferred<PipelineRunResult>();
  const cleanupStarted = deferred<void>();
  const cleanupRelease = deferred<void>();
  const cleaned: string[] = [];

  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return [makeIssue({ title: "Shutdown cleanup" })];
    },
    async fetchIssueStatesByIds(issueIds: string[]) {
      return (await this.fetchCandidateIssues()).filter((issue) => issueIds.includes(issue.id));
    },
    async fetchTerminalIssues() {
      return [];
    },
    transitionIssue: noopTransitionIssue,
  };

  const orchestrator = new VajraOrchestrator(
    tracker,
    { current: () => makeWorkflowDefinition() },
    {
      startRun(): PipelineRunHandle {
        return {
          promise: pending.promise,
          async cancel(reason?: string) {
            assert.equal(reason, RUN_STOP_REASONS.shutdown);
            pending.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
          },
        };
      },
    },
    () => ({
      async prepareWorkspace(identifier: string) {
        return { path: `/tmp/${identifier}`, workspaceKey: identifier, createdNow: true };
      },
      async runBeforeRunHook() {},
      async runAfterRunHook() {},
      async cleanupWorkspace(identifier: string) {
        cleaned.push(identifier);
        cleanupStarted.resolve();
        await cleanupRelease.promise;
      },
      workspacePathForIssue(identifier: string) { return `/tmp/${identifier}`; },
      validateWorkspacePath: async () => undefined,
    } as never),
  );

  await orchestrator.tick();

  let shutdownResolved = false;
  const shutdownPromise = orchestrator.shutdown().then(() => {
    shutdownResolved = true;
  });

  await cleanupStarted.promise;
  await flushAsyncWork();

  assert.equal(shutdownResolved, false);
  assert.deepEqual(cleaned, ["ENG-1"]);

  cleanupRelease.resolve();
  await shutdownPromise;
});

test("orchestrator treats auth failure as terminal and does not retry", async () => {
  const startedAttempts: number[] = [];
  const failedEvents: Array<{ error: string; failureClass?: string | null }> = [];
  const bus = new VajraEventBus();
  bus.on("issue:failed", (event) => {
    failedEvents.push({ error: event.error, failureClass: event.failureClass });
  });

  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return [makeIssue()];
    },
    async fetchIssueStatesByIds(issueIds: string[]) {
      return (await this.fetchCandidateIssues()).filter((issue) => issueIds.includes(issue.id));
    },
    async fetchTerminalIssues() { return []; },
    transitionIssue: noopTransitionIssue,
  };

  const orchestrator = new VajraOrchestrator(
    tracker,
    { current: () => makeWorkflowDefinition({ maxRetryAttempts: 3 }) },
    {
      startRun({ attempt }): PipelineRunHandle {
        startedAttempts.push(attempt);
        return {
          promise: Promise.resolve({
            status: "failure",
            completedNodes: [],
            checkpointPath: "/tmp/checkpoint.json",
            error: "[auth] Codex refresh token expired",
            failureClass: "auth" as const,
            failedStageId: "plan",
          }),
          async cancel() {},
        };
      },
    },
    stubWorkspace(),
    undefined,
    bus,
  );

  await orchestrator.tick();
  await flushAsyncWork();

  assert.deepEqual(startedAttempts, [0]);
  assert.equal(orchestrator.state.retryAttempts.size, 0);
  assert.equal(orchestrator.state.failed.has("1"), true);
  assert.equal(failedEvents.length, 1);
  assert.equal(failedEvents[0]?.failureClass, "auth");
  assert.match(failedEvents[0]?.error ?? "", /auth/);
});

test("orchestrator treats rate-limit failure as terminal and does not retry", async () => {
  const startedAttempts: number[] = [];
  const failedEvents: Array<{ error: string; failureClass?: string | null }> = [];
  const bus = new VajraEventBus();
  bus.on("issue:failed", (event) => {
    failedEvents.push({ error: event.error, failureClass: event.failureClass });
  });

  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return [makeIssue()];
    },
    async fetchIssueStatesByIds(issueIds: string[]) {
      return (await this.fetchCandidateIssues()).filter((issue) => issueIds.includes(issue.id));
    },
    async fetchTerminalIssues() { return []; },
    transitionIssue: noopTransitionIssue,
  };

  const orchestrator = new VajraOrchestrator(
    tracker,
    { current: () => makeWorkflowDefinition({ maxRetryAttempts: 3 }) },
    {
      startRun({ attempt }): PipelineRunHandle {
        startedAttempts.push(attempt);
        return {
          promise: Promise.resolve({
            status: "failure",
            completedNodes: [],
            checkpointPath: "/tmp/checkpoint.json",
            error: "[rate-limit] Provider usage limit reached (resets 6pm Europe/Berlin)",
            failureClass: "rate-limit" as const,
            failedStageId: "write_knowledge",
          }),
          async cancel() {},
        };
      },
    },
    stubWorkspace(),
    undefined,
    bus,
  );

  await orchestrator.tick();
  await flushAsyncWork();

  assert.deepEqual(startedAttempts, [0]);
  assert.equal(orchestrator.state.retryAttempts.size, 0);
  assert.equal(orchestrator.state.failed.has("1"), true);
  assert.equal(failedEvents.length, 1);
  assert.equal(failedEvents[0]?.failureClass, "rate-limit");
});

function makeSlackWorkflow(slackConfig: SlackConfig | null, maxRetryAttempts = 3): WorkflowDefinition {
  return {
    path: "/tmp/WORKFLOW.md",
    config: {
      tracker: {
        kind: "linear",
        endpoint: "https://api.linear.app/graphql",
        apiKey: "token",
        assigneeId: "vajra-uuid",
        activeStates: ["Todo"],
        terminalStates: ["Done"],
      },
      polling: { intervalMs: 30_000 },
      workspace: { root: "/tmp/vajra-workspaces" },
      artifacts: { root: "/tmp/vajra-plans", workspaceDir: ".vajra" },
      hooks: { timeoutMs: 60_000 },
      execution: {
        maxConcurrentAgents: 1,
        maxRetryAttempts,
        maxRetryBackoffMs: 60_000,
        maxConcurrentAgentsByState: {},
      },
      workflows: {
        default: { dotFile: "/tmp/default.dot" },
      },
      workflowRouting: {
        defaultWorkflow: "default",
        byLabel: {},
      },
      backends: {},
      agents: {},
      slack: slackConfig,
    },
  };
}

function makeSingleIssueTracker(creatorId: string): TrackerClient {
  return {
    async fetchCandidateIssues() {
      return [{
        id: "1",
        identifier: "ENG-1",
        title: "Test issue",
        description: null,
        state: "Todo",
        priority: 1,
        labels: [],
        assigneeId: "vajra-uuid",
        creatorId,
        createdAt: "2026-03-10T00:00:00.000Z",
        updatedAt: null,
        url: "https://linear.app/acme/issue/ENG-1",
        blockedBy: [],
      }];
    },
    async fetchIssueStatesByIds(issueIds: string[]) {
      return (await this.fetchCandidateIssues()).filter((issue) => issueIds.includes(issue.id));
    },
    async fetchTerminalIssues() {
      return [];
    },
    transitionIssue: noopTransitionIssue,
  };
}

function stubWorkspace() {
  return () => ({
    async prepareWorkspace(identifier: string) {
      return { path: `/tmp/${identifier}`, workspaceKey: identifier, createdNow: true };
    },
    async runBeforeRunHook() {},
    async runAfterRunHook() {},
    async cleanupWorkspace() {},
    workspacePathForIssue(identifier: string) { return `/tmp/${identifier}`; },
    validateWorkspacePath: async () => undefined,
  } as never);
}

test("orchestrator sends Slack notification on pipeline success with PR URL", async () => {
  const slackRequests: Array<{ text: string }> = [];

  // Monkey-patch global fetch to capture Slack calls
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("slack.com")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text: string };
      slackRequests.push(body);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const bus = new VajraEventBus();
    const workflow = makeSlackWorkflow({
      botToken: "xoxb-test",
      channelId: "C06TEST",
      userMap: { "creator-1": "U06SLACK1" },
      notifyOnSuccess: true,
      notifyOnFailure: true,
    });
    const subscriber = new SlackEventSubscriber(bus, { current: () => workflow });

    const orchestrator = new VajraOrchestrator(
      makeSingleIssueTracker("creator-1"),
      { current: () => workflow },
      {
        startRun(): PipelineRunHandle {
          return {
            promise: Promise.resolve({
              status: "success",
              completedNodes: ["plan", "push"],
              checkpointPath: "/tmp/checkpoint.json",
              prUrl: "https://github.com/acme-corp/acme-app/pull/200",
            }),
            async cancel() {},
          };
        },
      },
      stubWorkspace(),
      () => 1_000,
      bus,
    );

    await orchestrator.tick();
    // Wait for the async monitorRunCompletion to fire
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(slackRequests.length, 1);
    assert.match(slackRequests[0].text, /<@U06SLACK1>/);
    assert.match(slackRequests[0].text, /pull\/200/);
    assert.match(slackRequests[0].text, /ENG-1/);
    subscriber.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("orchestrator sends Slack failure notification on pipeline failure", async () => {
  const slackRequests: Array<{ text: string }> = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("slack.com")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text: string };
      slackRequests.push(body);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const bus = new VajraEventBus();
    const workflow = makeSlackWorkflow({
      botToken: "xoxb-test",
      channelId: "C06TEST",
      userMap: { "creator-1": "U06SLACK1" },
      notifyOnSuccess: true,
      notifyOnFailure: true,
    }, 0);
    const subscriber = new SlackEventSubscriber(bus, { current: () => workflow });

    const orchestrator = new VajraOrchestrator(
      makeSingleIssueTracker("creator-1"),
      { current: () => workflow },
      {
        startRun(): PipelineRunHandle {
          return {
            promise: Promise.resolve({
              status: "failure",
              completedNodes: ["plan"],
              checkpointPath: "/tmp/checkpoint.json",
              error: "tests failed",
              failedStageId: "code",
            }),
            async cancel() {},
          };
        },
      },
      stubWorkspace(),
      () => 1_000,
      bus,
    );

    await orchestrator.tick();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(slackRequests.length, 1);
    assert.match(slackRequests[0].text, /<@U06SLACK1>/);
    assert.match(slackRequests[0].text, /tests failed/);
    assert.match(slackRequests[0].text, /stage `code`/);
    subscriber.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("orchestrator sends Slack failure notification on handle.promise rejection (catch branch)", async () => {
  const slackRequests: Array<{ text: string }> = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("slack.com")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text: string };
      slackRequests.push(body);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const bus = new VajraEventBus();
    const workflow = makeSlackWorkflow({
      botToken: "xoxb-test",
      channelId: "C06TEST",
      userMap: { "creator-1": "U06SLACK1" },
      notifyOnSuccess: true,
      notifyOnFailure: true,
    }, 0);
    const subscriber = new SlackEventSubscriber(bus, { current: () => workflow });

    const orchestrator = new VajraOrchestrator(
      makeSingleIssueTracker("creator-1"),
      { current: () => workflow },
      {
        startRun(): PipelineRunHandle {
          return {
            promise: Promise.reject(new Error("workspace hook exploded")),
            async cancel() {},
          };
        },
      },
      stubWorkspace(),
      () => 1_000,
      bus,
    );

    await orchestrator.tick();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(slackRequests.length, 1);
    assert.match(slackRequests[0].text, /workspace hook exploded/);
    assert.match(slackRequests[0].text, /<@U06SLACK1>/);
    subscriber.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("orchestrator skips Slack when slack config is null", async () => {
  const slackRequests: Array<unknown> = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("slack.com")) {
      slackRequests.push({});
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const bus = new VajraEventBus();
    const workflow = makeSlackWorkflow(null);
    const subscriber = new SlackEventSubscriber(bus, { current: () => workflow });

    const orchestrator = new VajraOrchestrator(
      makeSingleIssueTracker("creator-1"),
      { current: () => workflow },
      {
        startRun(): PipelineRunHandle {
          return {
            promise: Promise.resolve({
              status: "success",
              completedNodes: [],
              checkpointPath: "/tmp/checkpoint.json",
            }),
            async cancel() {},
          };
        },
      },
      stubWorkspace(),
      () => 1_000,
      bus,
    );

    await orchestrator.tick();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(slackRequests.length, 0);
    subscriber.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("orchestrator and pipeline emit a coherent event sequence through the bus", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-events-integration-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspaceRoot = path.join(tempDir, "workspaces");
  const pipelinesDir = path.join(tempDir, "pipelines");
  const artifactsRoot = path.join(tempDir, "plans", "issues");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(pipelinesDir, { recursive: true });
  await mkdir(artifactsRoot, { recursive: true });

  const dotFile = path.join(pipelinesDir, "default.dot");
  await writeFile(
    dotFile,
    `
      digraph Example {
        start [shape=Mdiamond];
        exit [shape=Msquare];
        plan [label="Plan", agent="integration-backend", artifact_path=".vajra/plan.md"];
        start -> plan -> exit;
      }
    `,
    "utf8",
  );

  const workflow: WorkflowDefinition = {
    path: path.join(tempDir, "WORKFLOW.md"),
    config: {
      tracker: {
        kind: "linear",
        endpoint: "https://api.linear.app/graphql",
        apiKey: "token",
        assigneeId: "vajra-uuid",
        activeStates: ["Todo"],
        terminalStates: ["Done"],
      },
      polling: { intervalMs: 30_000 },
      workspace: { root: workspaceRoot },
      artifacts: { root: artifactsRoot, workspaceDir: ".vajra" },
      hooks: { timeoutMs: 60_000 },
      execution: {
        maxConcurrentAgents: 1,
        maxRetryAttempts: 3,
        maxRetryBackoffMs: 60_000,
        maxConcurrentAgentsByState: {},
      },
      workflows: {
        default: { dotFile },
      },
      workflowRouting: {
        defaultWorkflow: "default",
        byLabel: {},
      },
      backends: { "integration-backend": { command: "unused" } },
      agents: {
        "integration-backend": {
          backend: "integration-backend",
          model: "gpt-5.4",
          prompt: "Plan {{ issue.identifier }}",
        },
      },
      slack: null,
    },
  };

  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return [{
        id: "1",
        identifier: "ENG-1",
        title: "Event sequence",
        description: null,
        state: "Todo",
        priority: 1,
        labels: [],
        assigneeId: "vajra-uuid",
        creatorId: null,
        createdAt: "2026-03-10T00:00:00.000Z",
        updatedAt: null,
        url: null,
        blockedBy: [],
      }];
    },
    async fetchIssueStatesByIds(issueIds: string[]) {
      return (await this.fetchCandidateIssues()).filter((issue) => issueIds.includes(issue.id));
    },
    async fetchTerminalIssues() {
      return [];
    },
    transitionIssue: noopTransitionIssue,
  };

  const bus = new VajraEventBus();
  const seen: string[] = [];
  const listener = (event: { type: string }) => {
    seen.push(event.type);
  };
  bus.onAny(listener);

  const pipelineRunner = new LocalPipelineRunner(
    logsRoot,
    () => new Map([["integration-backend", new IntegrationBackend()]]),
    undefined,
    bus,
  );
  const orchestrator = new VajraOrchestrator(
    tracker,
    { current: () => workflow },
    pipelineRunner,
    () => new WorkspaceManager(workflow.config.workspace, workflow.config.hooks, undefined, bus),
    () => 1_000,
    bus,
    { logsRoot },
  );

  await orchestrator.startup();
  await orchestrator.tick();
  for (let attempt = 0; attempt < 20 && !seen.includes("issue:completed"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const startupIndex = seen.indexOf("orchestrator:started");
  const tickIndex = seen.indexOf("orchestrator:tick");
  const createdIndex = seen.indexOf("workspace:created");
  const dispatchedIndex = seen.indexOf("issue:dispatched");
  const stageStartIndex = seen.indexOf("pipeline:stage:start");
  const stageCompleteIndex = seen.indexOf("pipeline:stage:complete");
  const completedIndex = seen.indexOf("issue:completed");

  assert.ok(startupIndex >= 0);
  assert.ok(tickIndex > startupIndex);
  assert.ok(createdIndex > tickIndex);
  assert.ok(dispatchedIndex > createdIndex);
  assert.ok(stageStartIndex > dispatchedIndex);
  assert.ok(stageCompleteIndex > stageStartIndex);
  assert.ok(completedIndex > stageCompleteIndex);

  bus.offAny(listener);
});

test("orchestrator escalates wait_human runs to the configured human-review state", async () => {
  const pending = deferred<PipelineRunResult>();
  const transitions: Array<{ issueId: string; state: string }> = [];
  const comments: string[] = [];
  const escalatedReasons: string[] = [];

  const issue = makeIssue({ id: "1", identifier: "ENG-ESC", state: "Todo" });
  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return [issue];
    },
    async fetchIssueStatesByIds() {
      return [issue];
    },
    async fetchTerminalIssues() {
      return [];
    },
    async transitionIssue(issueId: string, stateName: string) {
      transitions.push({ issueId, state: stateName });
    },
    async commentOnIssue(_issueId: string, body: string) {
      comments.push(body);
    },
  };

  const bus = new VajraEventBus();
  bus.on("issue:escalated", (event) => {
    escalatedReasons.push(event.reason);
  });

  const orchestrator = new VajraOrchestrator(
    tracker,
    {
      current: () => makeWorkflowDefinition({
        successState: "In Review",
        escalation: {
          linearState: "Needs Human Review",
          comment: true,
          slackNotify: true,
        },
      }),
    },
    {
      startRun(): PipelineRunHandle {
        return {
          promise: pending.promise,
          async cancel() {
            pending.resolve({ status: "cancelled", completedNodes: [], checkpointPath: "/tmp/checkpoint.json" });
          },
        };
      },
    },
    () => ({
      async prepareWorkspace(identifier: string) {
        return { path: `/tmp/${identifier}`, workspaceKey: identifier, createdNow: true };
      },
      async runBeforeRunHook() {},
      async runAfterRunHook() {},
      async cleanupWorkspace() {},
      workspacePathForIssue(identifier: string) { return `/tmp/${identifier}`; },
      validateWorkspacePath: async () => undefined,
    } as never),
    () => 1_000,
    bus,
  );

  await orchestrator.tick();
  pending.resolve({
    status: "wait_human",
    completedNodes: ["plan", "review_plan"],
    checkpointPath: "/tmp/checkpoint.json",
    error: "Planner is blocked on a product decision.",
  });
  await pending.promise;
  await waitForCondition(() => transitions.length > 1, "expected escalation transition");

  assert.deepEqual(transitions, [
    { issueId: "1", state: "In Progress" },
    { issueId: "1", state: "Needs Human Review" },
  ]);
  assert.equal(comments.length, 1);
  assert.match(comments[0], /human review/i);
  assert.deepEqual(escalatedReasons, ["Planner is blocked on a product decision."]);
});

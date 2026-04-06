import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";

import { createApiServer, resolveEventReplayCursor } from "../src/api/server";
import { eventLogPath, listRunSummaries, readLoggedEvents } from "../src/api/run-history";
import { VajraEventBus } from "../src/events";
import { EventLogSubscriber } from "../src/subscribers/event-log";
import { Issue, MutableWorkflowStore, PipelineRunResult, RunningEntry, WorkflowDefinition } from "../src/types";
import { WorkflowFileStore } from "../src/workflow-store";
import { workflowDefinitionFromConfig } from "./helpers/workflow-definition";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "1",
    identifier: "ENG-1",
    title: "Example issue",
    description: null,
    state: "Todo",
    priority: 1,
    labels: [],
    assigneeId: "vajra-uuid",
    creatorId: null,
    createdAt: null,
    updatedAt: null,
    url: "https://linear.app/acme/issue/ENG-1",
    blockedBy: [],
    ...overrides,
  };
}

async function makeWorkflowStore(tempDir: string): Promise<MutableWorkflowStore> {
  const pipelinesDir = path.join(tempDir, "pipelines");
  await mkdir(pipelinesDir, { recursive: true });
  const dotFile = path.join(pipelinesDir, "default.dot");
  await writeFile(
    dotFile,
    `
      digraph Example {
        start [shape=Mdiamond];
        exit [shape=Msquare];
        plan [label="Plan", agent="planner"];
        code [label="Code", agent="coder"];
        start -> plan -> code -> exit;
      }
    `,
    "utf8",
  );

  const workflowPath = path.join(tempDir, "WORKFLOW.md");
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
      workspace: { root: path.join(tempDir, "workspaces") },
      artifacts: { root: path.join(tempDir, "plans"), workspaceDir: ".vajra" },
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
      backends: {
        claude: { command: "claude {{ prompt }}" },
      },
      agents: {
        planner: {
          backend: "claude",
          model: "model-a",
          prompt: "Plan it",
        },
        coder: {
          backend: "claude",
          model: "model-b",
          prompt: "Code it",
        },
      },
      slack: null,
    };
  const definition: WorkflowDefinition = {
    ...workflowDefinitionFromConfig(workflowPath, config),
  };

  return {
    async load() {
      return definition;
    },
    current() {
      return definition;
    },
  };
}

async function makePersistedWorkflowStore(tempDir: string): Promise<WorkflowFileStore> {
  const pipelinesDir = path.join(tempDir, "pipelines");
  await mkdir(pipelinesDir, { recursive: true });
  await writeFile(
    path.join(pipelinesDir, "default.dot"),
    `digraph DefaultPipeline {
      start [shape=Mdiamond];
      exit [shape=Msquare];
      plan [label="Plan", agent="planner", artifact_path=".vajra/plan.md"];
      code [label="Code", agent="coder", artifact_path=".vajra/implementation-summary.md"];
      start -> plan -> code -> exit;
    }`,
    "utf8",
  );
  await writeFile(
    path.join(tempDir, "WORKFLOW.md"),
    `---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  assignee_id: vajra-uuid
triage:
  enabled: true
  backend: claude
  model: model-a
  reasoning_effort: high
  timeout_ms: 15000
execution:
  max_concurrent_agents: 1
  max_retry_attempts: 3
  max_retry_backoff_ms: 60000
workflows:
  default:
    dot_file: ./pipelines/default.dot
workflow_routing:
  default_workflow: default
backends:
  claude:
    command: "claude {{ prompt }}"
agents:
  planner:
    backend: claude
    model: model-a
    prompt: "Plan {{ issue.identifier }}"
  coder:
    backend: claude
    model: model-b
    prompt: "Code {{ issue.identifier }}"
---
`,
    "utf8",
  );

  const workflowStore = new WorkflowFileStore(path.join(tempDir, "WORKFLOW.md"));
  await workflowStore.load();
  return workflowStore;
}

function runningEntry(issue: Issue): RunningEntry {
  return {
    issue,
    attempt: 0,
    workspacePath: `/tmp/${issue.identifier}`,
    handle: {
      promise: Promise.resolve({
        status: "success",
        completedNodes: [],
        checkpointPath: "/tmp/checkpoint.json",
      } satisfies PipelineRunResult),
      async cancel() {},
    },
  };
}

test("EventLogSubscriber writes only tracked lifecycle events", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-event-log-"));
  const logsRoot = path.join(tempDir, "logs");
  const bus = new VajraEventBus();
  const subscriber = await EventLogSubscriber.create(bus, logsRoot);

  bus.emit({
    type: "orchestrator:tick",
    timestamp: "2026-03-11T09:00:00.000Z",
    running: 0,
    claimed: 0,
    retrying: 0,
    completed: 0,
  });
  bus.emit({
    type: "issue:dispatched",
    timestamp: "2026-03-11T09:01:00.000Z",
    issueId: "1",
    issueIdentifier: "ENG-1",
    issueTitle: "Example issue",
    issueUrl: "https://linear.app/acme/issue/ENG-1",
    issueCreatorId: null,
    state: "Todo",
    attempt: 0,
    workspacePath: "/tmp/ENG-1",
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

  await subscriber.close();

  const lines = (await readFile(eventLogPath(logsRoot), "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]) as { type: string; workflowName: string };
  assert.equal(typeof (JSON.parse(lines[0]) as { _sequence?: number })._sequence, "number");
  assert.equal(parsed.type, "issue:dispatched");
  assert.equal(parsed.workflowName, "default");
});

test("listRunSummaries reconstructs retried and successful attempts from the event log", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-run-history-"));
  const logsRoot = path.join(tempDir, "logs");
  const workflowStore = await makeWorkflowStore(tempDir);
  await mkdir(logsRoot, { recursive: true });
  await writeFile(
    eventLogPath(logsRoot),
    [
      JSON.stringify({
        type: "issue:dispatched",
        timestamp: "2026-03-11T10:00:00.000Z",
        issueId: "1",
        issueIdentifier: "ENG-1",
        issueTitle: "Example issue",
        issueUrl: "https://linear.app/acme/issue/ENG-1",
        issueCreatorId: null,
        state: "Todo",
        attempt: 0,
        workspacePath: "/tmp/ENG-1",
        workflowName: "default",
        successState: "Done",
        baseBranch: "dev",
        targetBranch: "dev",
        mergeStrategy: "auto-merge",
        labelsToAdd: ["document"],
        triaged: true,
        triageReasoning: "Documentation issue",
        triageFallback: false,
      }),
      JSON.stringify({
        type: "pipeline:stage:start",
        timestamp: "2026-03-11T10:00:05.000Z",
        issueId: "1",
        issueIdentifier: "ENG-1",
        stageId: "plan",
        stageLabel: "Plan",
        stageType: "agent",
        visit: 1,
        backend: "claude",
      }),
      JSON.stringify({
        type: "pipeline:stage:complete",
        timestamp: "2026-03-11T10:00:10.000Z",
        issueId: "1",
        issueIdentifier: "ENG-1",
        stageId: "plan",
        exitCode: 0,
        durationMs: 5_000,
        visit: 1,
        status: "success",
      }),
      JSON.stringify({
        type: "issue:retry:scheduled",
        timestamp: "2026-03-11T10:00:15.000Z",
        issueId: "1",
        issueIdentifier: "ENG-1",
        issueTitle: "Example issue",
        issueUrl: "https://linear.app/acme/issue/ENG-1",
        issueCreatorId: null,
        attempt: 1,
        dueAtMs: Date.parse("2026-03-11T10:01:15.000Z"),
        error: "backend failed",
      }),
      JSON.stringify({
        type: "issue:dispatched",
        timestamp: "2026-03-11T10:01:15.000Z",
        issueId: "1",
        issueIdentifier: "ENG-1",
        issueTitle: "Example issue",
        issueUrl: "https://linear.app/acme/issue/ENG-1",
        issueCreatorId: null,
        state: "Todo",
        attempt: 1,
        workspacePath: "/tmp/ENG-1",
        workflowName: "default",
        successState: "Done",
        baseBranch: "dev",
        targetBranch: "dev",
        mergeStrategy: "auto-merge",
        labelsToAdd: ["document"],
        triaged: true,
        triageReasoning: "Documentation issue",
        triageFallback: false,
      }),
      JSON.stringify({
        type: "pipeline:stage:start",
        timestamp: "2026-03-11T10:01:20.000Z",
        issueId: "1",
        issueIdentifier: "ENG-1",
        stageId: "plan",
        stageLabel: "Plan",
        stageType: "agent",
        visit: 1,
        backend: "claude",
      }),
      JSON.stringify({
        type: "pipeline:stage:complete",
        timestamp: "2026-03-11T10:01:25.000Z",
        issueId: "1",
        issueIdentifier: "ENG-1",
        stageId: "plan",
        exitCode: 0,
        durationMs: 5_000,
        visit: 1,
        status: "success",
      }),
      JSON.stringify({
        type: "issue:completed",
        timestamp: "2026-03-11T10:01:40.000Z",
        issueId: "1",
        issueIdentifier: "ENG-1",
        issueTitle: "Example issue",
        issueUrl: "https://linear.app/acme/issue/ENG-1",
        issueCreatorId: null,
        completedNodes: ["plan", "code"],
        prUrl: "https://github.com/acme-corp/acme-app/pull/123",
      }),
    ].join("\n"),
    "utf8",
  );

  const response = await listRunSummaries({
    logsRoot,
    workflowStore,
  });

  assert.equal(response.total, 2);
  assert.deepEqual(response.counts, {
    running: 0,
    success: 1,
    failure: 1,
    cancelled: 0,
    waitHuman: 0,
  });
  assert.equal(response.runs[0].attempt, 1);
  assert.equal(response.runs[0].status, "success");
  assert.equal(response.runs[0].prUrl, "https://github.com/acme-corp/acme-app/pull/123");
  assert.deepEqual(response.runs[0].dispatchPlan, {
    workflowName: "default",
    successState: "Done",
    baseBranch: "dev",
    targetBranch: "dev",
    mergeStrategy: "auto-merge",
    labelsToAdd: ["document"],
    triage: {
      action: "dispatch",
      workflowName: "default",
      baseBranch: "dev",
      targetBranch: "dev",
      mergeStrategy: "auto-merge",
      labels: ["document"],
      reasoning: "Documentation issue",
      wasFallback: false,
    },
  });
  assert.deepEqual(response.runs[0].stages.map((stage) => stage.id), ["plan", "code"]);
  assert.equal(response.runs[1].attempt, 0);
  assert.equal(response.runs[1].status, "failure");
  assert.equal(response.runs[1].error, "backend failed");
});

test("createApiServer enforces bearer auth and serves state and runs", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-api-server-"));
  const logsRoot = path.join(tempDir, "logs");
  const baseWorkflowStore = await makeWorkflowStore(tempDir);
  const workflowStore = {
    ...baseWorkflowStore,
    reloadStatus() {
      return { lastReloadError: "reload failed" };
    },
  };
  await mkdir(logsRoot, { recursive: true });
  await writeFile(
    eventLogPath(logsRoot),
    `${JSON.stringify({
      type: "issue:dispatched",
      timestamp: "2026-03-11T11:00:00.000Z",
      issueId: "1",
      issueIdentifier: "ENG-1",
      issueTitle: "Example issue",
      issueUrl: "https://linear.app/acme/issue/ENG-1",
      issueCreatorId: null,
      state: "Todo",
      attempt: 0,
      workspacePath: "/tmp/ENG-1",
      workflowName: "default",
      successState: "Done",
      baseBranch: "main",
      targetBranch: "main",
      mergeStrategy: "pr-only",
      labelsToAdd: [],
      triaged: false,
      triageReasoning: null,
      triageFallback: false,
    })}\n${JSON.stringify({
      type: "issue:completed",
      timestamp: "2026-03-11T11:02:00.000Z",
      issueId: "1",
      issueIdentifier: "ENG-1",
      issueTitle: "Example issue",
      issueUrl: "https://linear.app/acme/issue/ENG-1",
      issueCreatorId: null,
      completedNodes: ["plan", "code"],
      prUrl: null,
    })}\n`,
    "utf8",
  );

  const bus = new VajraEventBus();
  const issue = makeIssue();
  const orchestrator = {
    state: {
      running: new Map<string, RunningEntry>([["1", runningEntry(issue)]]),
      claimed: new Set<string>(["1"]),
      retryAttempts: new Map([
        ["1", {
          issueId: "1",
          identifier: "ENG-1",
          attempt: 1,
          dueAtMs: Date.parse("2026-03-11T11:05:00.000Z"),
          error: "retry me",
        }],
      ]),
      completed: new Map([["2", "Done"]]),
      failed: new Map([["3", "Todo"]]),
    },
  };
  const app = createApiServer({
    eventBus: bus,
    orchestrator: orchestrator as never,
    workflowStore,
    logsRoot,
    apiKey: "secret",
    now: () => Date.parse("2026-03-11T11:04:00.000Z"),
  });
  bus.emit({
    type: "orchestrator:started",
    timestamp: "2026-03-11T11:00:00.000Z",
    workflowPath: "/tmp/WORKFLOW.md",
    logsRoot,
    pollingMs: 30_000,
  });
  bus.emit({
    type: "orchestrator:tick",
    timestamp: "2026-03-11T11:04:00.000Z",
    running: 1,
    claimed: 1,
    retrying: 1,
    completed: 1,
  });

  try {
    const unauthorized = await app.inject({
      method: "GET",
      url: "/state",
    });
    assert.equal(unauthorized.statusCode, 401);

    const stateResponse = await app.inject({
      method: "GET",
      url: "/state",
      headers: {
        authorization: "Bearer secret",
      },
    });
    assert.equal(stateResponse.statusCode, 200);
    const statePayload = stateResponse.json() as {
      activeCount: number;
      retryingCount: number;
      waitingCount: number;
      startedAt: string;
      workflowReloadError: string | null;
    };
    assert.equal(statePayload.activeCount, 1);
    assert.equal(statePayload.retryingCount, 1);
    assert.equal(statePayload.waitingCount, 1);
    assert.equal(statePayload.startedAt, "2026-03-11T11:00:00.000Z");
    assert.equal(statePayload.workflowReloadError, "reload failed");

    const runsResponse = await app.inject({
      method: "GET",
      url: "/runs?status=success&since=24h",
      headers: {
        authorization: "Bearer secret",
      },
    });
    assert.equal(runsResponse.statusCode, 200);
    const runsPayload = runsResponse.json() as {
      total: number;
      counts: { running: number; success: number; failure: number; cancelled: number; waitHuman: number };
      runs: Array<{ status: string }>;
    };
    assert.equal(runsPayload.total, 1);
    assert.deepEqual(runsPayload.counts, {
      running: 0,
      success: 1,
      failure: 0,
      cancelled: 0,
      waitHuman: 0,
    });
    assert.equal(runsPayload.runs[0].status, "success");
  } finally {
    await app.close();
  }
});

test("createApiServer responds to CORS preflight with POST in the allow-methods header", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-api-cors-"));
  const logsRoot = path.join(tempDir, "logs");
  const workflowStore = await makeWorkflowStore(tempDir);
  const bus = new VajraEventBus();
  const app = createApiServer({
    eventBus: bus,
    orchestrator: {
      state: {
        running: new Map(),
        claimed: new Set(),
        retryAttempts: new Map(),
        completed: new Map(),
        failed: new Map(),
      },
    } as never,
    workflowStore,
    logsRoot,
    apiKey: "secret",
    corsOrigin: "https://dashboard.example.com",
  });

  try {
    const response = await app.inject({
      method: "OPTIONS",
      url: "/state",
    });

    assert.equal(response.statusCode, 204);
    assert.equal(response.headers["access-control-allow-origin"], "https://dashboard.example.com");
    assert.match(String(response.headers["access-control-allow-methods"] ?? ""), /POST/);
  } finally {
    await app.close();
  }
});

test("createApiServer returns run detail with persisted stage prompt, output, artifacts, and metadata", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-run-detail-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace", "ENG-1");
  const workflowStore = await makePersistedWorkflowStore(tempDir);
  await mkdir(path.join(logsRoot, "ENG-1", "attempt-0", "plan"), { recursive: true });
  await mkdir(path.join(workspacePath, ".vajra", "collections", "plan_candidates"), { recursive: true });
  await writeFile(
    path.join(workspacePath, ".vajra", "collections.json"),
    JSON.stringify(["plan_candidates"], null, 2),
    "utf8",
  );
  await writeFile(
    path.join(workspacePath, ".vajra", "collections", "plan_candidates", "manifest.json"),
    JSON.stringify({
      id: "plan_candidates",
      stageId: "plan_fanout",
      selectedCandidateId: "aggressive",
      candidates: [
        {
          id: "conservative",
          status: "success",
          artifacts: { primary: ".vajra/run/collections/plan_candidates/conservative/primary.md" },
          facts: { score: 7 },
          variantConfig: { id: "conservative", instructions: "Low-risk plan" },
        },
        {
          id: "aggressive",
          status: "success",
          artifacts: { primary: ".vajra/run/collections/plan_candidates/aggressive/primary.md" },
          facts: { score: 9 },
          variantConfig: { id: "aggressive", model: "model-b" },
        },
      ],
    }, null, 2),
    "utf8",
  );
  await writeFile(
    path.join(logsRoot, "events.jsonl"),
    [
      JSON.stringify({
        type: "issue:dispatched",
        timestamp: "2026-03-11T12:00:00.000Z",
        issueId: "1",
        issueIdentifier: "ENG-1",
        issueTitle: "Example issue",
        issueUrl: "https://linear.app/acme/issue/ENG-1",
        issueCreatorId: null,
        state: "Todo",
        attempt: 0,
        workspacePath,
        workflowName: "default",
      }),
      JSON.stringify({
        type: "pipeline:stage:start",
        timestamp: "2026-03-11T12:00:05.000Z",
        issueId: "1",
        issueIdentifier: "ENG-1",
        stageId: "plan",
        stageLabel: "Plan",
        stageType: "agent",
        visit: 1,
        backend: "claude",
      }),
      JSON.stringify({
        type: "pipeline:stage:complete",
        timestamp: "2026-03-11T12:00:15.000Z",
        issueId: "1",
        issueIdentifier: "ENG-1",
        stageId: "plan",
        exitCode: 0,
        durationMs: 10_000,
        visit: 1,
        status: "success",
      }),
      JSON.stringify({
        type: "issue:completed",
        timestamp: "2026-03-11T12:01:00.000Z",
        issueId: "1",
        issueIdentifier: "ENG-1",
        issueTitle: "Example issue",
        issueUrl: "https://linear.app/acme/issue/ENG-1",
        issueCreatorId: null,
        completedNodes: ["plan", "code"],
        prUrl: "https://github.com/acme-corp/acme-app/pull/123",
      }),
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(logsRoot, "ENG-1", "attempt-0", "run.json"),
    JSON.stringify({
      issueId: "1",
      issueIdentifier: "ENG-1",
      issueTitle: "Example issue",
      issueUrl: "https://linear.app/acme/issue/ENG-1",
      attempt: 0,
      workflowName: "default",
      graphId: "DefaultPipeline",
      dotFile: path.join(tempDir, "pipelines", "default.dot"),
      workspacePath,
      artifactsPath: path.join(workspacePath, ".vajra"),
      dispatchPlan: {
        workflowName: "default",
        successState: "Done",
        baseBranch: "dev",
        targetBranch: "dev",
        mergeStrategy: "auto-merge",
        labelsToAdd: ["document"],
        triage: {
          action: "dispatch",
          workflowName: "default",
          baseBranch: "dev",
          targetBranch: "dev",
          mergeStrategy: "auto-merge",
          labels: ["document"],
          reasoning: "Documentation issue",
          wasFallback: false,
        },
      },
      startedAt: "2026-03-11T12:00:00.000Z",
      finishedAt: "2026-03-11T12:01:00.000Z",
      status: "success",
      error: null,
      prUrl: "https://github.com/acme-corp/acme-app/pull/123",
    }, null, 2),
    "utf8",
  );
  await writeFile(
    path.join(logsRoot, "ENG-1", "attempt-0", "checkpoint.json"),
    JSON.stringify({
      issueId: "1",
      issueIdentifier: "ENG-1",
      attempt: 0,
      workspacePath,
      graphId: "DefaultPipeline",
      startedAt: "2026-03-11T12:00:00.000Z",
      finishedAt: "2026-03-11T12:01:00.000Z",
      completedNodes: ["plan", "code"],
      nextNodeId: null,
      status: "success",
      error: null,
    }, null, 2),
    "utf8",
  );
  await writeFile(path.join(logsRoot, "ENG-1", "attempt-0", "plan", "prompt.txt"), "Plan ENG-1", "utf8");
  await writeFile(path.join(logsRoot, "ENG-1", "attempt-0", "plan", "output.txt"), "Plan complete", "utf8");
  await writeFile(
    path.join(logsRoot, "ENG-1", "attempt-0", "plan", "meta.json"),
    JSON.stringify({
      agentName: "planner",
      backend: "claude",
      model: "model-a",
      durationMs: 10_000,
      exitCode: 0,
      type: "agent",
      visit: 1,
      status: "success",
      artifacts: {
        primary: ".vajra/plan.md",
        output: ".vajra/run/stages/plan/output.txt",
      },
      resultMetadata: {
        pr: { url: "https://github.com/acme-corp/acme-app/pull/123" },
        checks: ["lint", "tests"],
      },
    }, null, 2),
    "utf8",
  );

  const app = createApiServer({
    eventBus: new VajraEventBus(),
    orchestrator: {
      state: {
        running: new Map(),
        claimed: new Set(),
        retryAttempts: new Map(),
        completed: new Map(),
        failed: new Map(),
      },
    } as never,
    workflowStore,
    logsRoot,
  });

  try {
    const response = await app.inject({
      method: "GET",
      url: "/runs/ENG-1/0",
    });
    assert.equal(response.statusCode, 200);
    const payload = response.json() as {
      graphId: string;
      dispatchPlan: {
        workflowName: string;
        baseBranch: string;
        targetBranch: string;
        mergeStrategy: string;
        labelsToAdd: string[];
      } | null;
      graph: {
        nodes: Array<{ id: string; type: string }>;
        edges: Array<{ from: string; to: string }>;
      } | null;
      collections: Array<{
        id: string;
        stageId: string;
        selectedCandidateId: string | null;
        candidates: Array<{ id: string; status: string; facts: Record<string, unknown> }>;
      }>;
      stageDetails: Array<{
        id: string;
        model: string;
        backend: string;
        prompt: string;
        output: string;
        artifacts: Array<{ name: string; path: string }>;
        meta: Record<string, unknown>;
      }>;
    };
    assert.equal(payload.graphId, "DefaultPipeline");
    assert.deepEqual(payload.dispatchPlan, {
      workflowName: "default",
      successState: "Done",
      baseBranch: "dev",
      targetBranch: "dev",
      mergeStrategy: "auto-merge",
      labelsToAdd: ["document"],
      triage: {
        action: "dispatch",
        workflowName: "default",
        baseBranch: "dev",
        targetBranch: "dev",
        mergeStrategy: "auto-merge",
        labels: ["document"],
        reasoning: "Documentation issue",
        wasFallback: false,
      },
    });
    assert.deepEqual(
      [...(payload.graph?.nodes.map((node) => node.id) ?? [])].sort(),
      ["code", "exit", "plan", "start"],
    );
    assert.deepEqual(payload.graph?.edges.map((edge) => `${edge.from}->${edge.to}`), [
      "start->plan",
      "plan->code",
      "code->exit",
    ]);
    assert.deepEqual(payload.collections, [{
      id: "plan_candidates",
      stageId: "plan_fanout",
      selectedCandidateId: "aggressive",
      synthesizedArtifact: null,
      candidates: [
        {
          id: "conservative",
          status: "success",
          artifacts: { primary: ".vajra/run/collections/plan_candidates/conservative/primary.md" },
          facts: { score: 7 },
          variantConfig: { id: "conservative", instructions: "Low-risk plan" },
        },
        {
          id: "aggressive",
          status: "success",
          artifacts: { primary: ".vajra/run/collections/plan_candidates/aggressive/primary.md" },
          facts: { score: 9 },
          variantConfig: { id: "aggressive", model: "model-b" },
        },
      ],
    }]);
    assert.equal(payload.stageDetails[0].id, "plan");
    assert.equal(payload.stageDetails[0].model, "model-a");
    assert.equal(payload.stageDetails[0].backend, "claude");
    assert.equal(payload.stageDetails[0].prompt, "Plan ENG-1");
    assert.equal(payload.stageDetails[0].output, "Plan complete");
    assert.deepEqual(payload.stageDetails[0].artifacts, [
      { name: "primary", path: ".vajra/plan.md" },
      { name: "output", path: ".vajra/run/stages/plan/output.txt" },
    ]);
    assert.deepEqual(payload.stageDetails[0].meta, {
      visit: 1,
      type: "agent",
      status: "success",
      result: {
        pr: { url: "https://github.com/acme-corp/acme-app/pull/123" },
        checks: ["lint", "tests"],
      },
    });
  } finally {
    await app.close();
  }
});

test("readLoggedEvents replays only entries after the requested cursor", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-event-replay-"));
  const logsRoot = path.join(tempDir, "logs");
  await mkdir(logsRoot, { recursive: true });
  await writeFile(
    eventLogPath(logsRoot),
    [
      JSON.stringify({
        _sequence: 1,
        type: "issue:dispatched",
        timestamp: "2026-03-11T13:00:00.000Z",
        issueId: "1",
        issueIdentifier: "ENG-1",
        issueTitle: "Example issue",
        issueUrl: "https://linear.app/acme/issue/ENG-1",
        issueCreatorId: null,
        state: "Todo",
        attempt: 0,
        workspacePath: "/tmp/ENG-1",
        workflowName: "default",
        successState: "Done",
        baseBranch: "main",
        targetBranch: "main",
        mergeStrategy: "pr-only",
        labelsToAdd: [],
        triaged: false,
        triageReasoning: null,
        triageFallback: false,
      }),
      JSON.stringify({
        _sequence: 2,
        type: "pipeline:stage:start",
        timestamp: "2026-03-11T13:00:05.000Z",
        issueId: "1",
        issueIdentifier: "ENG-1",
        stageId: "plan",
        stageLabel: "Plan",
        stageType: "agent",
        visit: 1,
        backend: "claude",
      }),
      JSON.stringify({
        _sequence: 3,
        type: "pipeline:stage:complete",
        timestamp: "2026-03-11T13:00:15.000Z",
        issueId: "1",
        issueIdentifier: "ENG-1",
        stageId: "plan",
        exitCode: 0,
        durationMs: 10_000,
        visit: 1,
        status: "success",
      }),
    ].join("\n"),
    "utf8",
  );

  const replayed = await readLoggedEvents({
    logsRoot,
    afterSequence: 1,
  });

  assert.deepEqual(replayed.map((entry) => entry.sequence), [2, 3]);
  assert.deepEqual(replayed.map((entry) => entry.event.type), [
    "pipeline:stage:start",
    "pipeline:stage:complete",
  ]);
});

test("resolveEventReplayCursor prefers Last-Event-ID over query cursors", () => {
  assert.equal(
    resolveEventReplayCursor({
      lastEventId: "7",
      after: "3",
    }),
    7,
  );
  assert.equal(
    resolveEventReplayCursor({
      lastEventId: undefined,
      after: "3",
    }),
    3,
  );
});

test("createApiServer supports structured config endpoints and preserves env-backed workflow secrets", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-config-api-"));
  const logsRoot = path.join(tempDir, "logs");
  const skillsRoot = path.join(tempDir, "skills");
  await mkdir(path.join(skillsRoot, "vajra-plan"), { recursive: true });
  await writeFile(path.join(skillsRoot, "vajra-plan", "SKILL.md"), "# Plan\n", "utf8");
  const workflowStore = await makePersistedWorkflowStore(tempDir);
  const app = createApiServer({
    eventBus: new VajraEventBus(),
    orchestrator: {
      state: {
        running: new Map(),
        claimed: new Set(),
        retryAttempts: new Map(),
        completed: new Map(),
        failed: new Map(),
      },
    } as never,
    workflowStore,
    logsRoot,
    skillsRoot,
  });

  try {
    const configResponse = await app.inject({
      method: "GET",
      url: "/config",
    });
    assert.equal(configResponse.statusCode, 200);
    const configPayload = configResponse.json() as {
      tracker: { apiKeyConfigured: boolean };
      triage: { enabled: boolean; backend: string; model: string; timeoutMs: number } | null;
      slack: null;
    };
    assert.equal(configPayload.tracker.apiKeyConfigured, true);
    assert.deepEqual(configPayload.triage, {
      enabled: true,
      backend: "claude",
      model: "model-a",
      reasoningEffort: "high",
      timeoutMs: 15_000,
    });
    assert.equal(configPayload.slack, null);

    const updatedConfig = await app.inject({
      method: "PUT",
      url: "/config",
      payload: {
        triage: {
          enabled: true,
          backend: "claude",
          model: "model-b",
          reasoningEffort: "max",
          timeoutMs: 9_000,
        },
      },
    });
    assert.equal(updatedConfig.statusCode, 200);
    assert.deepEqual((updatedConfig.json() as {
      triage: { enabled: boolean; backend: string; model: string; reasoningEffort?: string; timeoutMs: number } | null;
    }).triage, {
      enabled: true,
      backend: "claude",
      model: "model-b",
      reasoningEffort: "max",
      timeoutMs: 9_000,
    });

    const backendsResponse = await app.inject({
      method: "GET",
      url: "/config/backends",
    });
    assert.equal(backendsResponse.statusCode, 200);
    const backendsPayload = backendsResponse.json() as {
      presets: Record<string, { defaultModel: string; defaultReasoningEffort: string }>;
    };
    assert.equal(backendsPayload.presets.claude.defaultModel, "claude-opus-4-6");
    assert.equal(backendsPayload.presets.claude.defaultReasoningEffort, "high");

    const addAgent = await app.inject({
      method: "PUT",
      url: "/config/agents/reviewer",
      payload: {
        backend: "claude",
        model: "model-review",
        prompt: "Review {{ issue.identifier }}",
      },
    });
    assert.equal(addAgent.statusCode, 200);
    const agentsPayload = addAgent.json() as {
      agents: Record<string, { model: string; reasoningEffort?: string }>;
    };
    assert.equal(agentsPayload.agents.reviewer.model, "model-review");
    assert.equal(agentsPayload.agents.reviewer.reasoningEffort, "high");

    const addCodexBackend = await app.inject({
      method: "PUT",
      url: "/config/backends/codex",
      payload: {
        command: "codex exec --model {{ model }} -c reasoning_effort={{ reasoning_effort }} {{ prompt }}",
      },
    });
    assert.equal(addCodexBackend.statusCode, 200);

    const addCodexAgent = await app.inject({
      method: "PUT",
      url: "/config/agents/planning-reviewer",
      payload: {
        backend: "codex",
        prompt: "Review plan",
      },
    });
    assert.equal(addCodexAgent.statusCode, 200);
    const codexAgentsPayload = addCodexAgent.json() as {
      agents: Record<string, { model: string; reasoningEffort?: string }>;
    };
    assert.equal(codexAgentsPayload.agents["planning-reviewer"].model, "gpt-5.4");
    assert.equal(codexAgentsPayload.agents["planning-reviewer"].reasoningEffort, "xhigh");

    const deletePlanner = await app.inject({
      method: "DELETE",
      url: "/config/agents/planner",
    });
    assert.equal(deletePlanner.statusCode, 400);
    assert.match(deletePlanner.json().error, /referenced by workflows/i);

    const saveWorkflow = await app.inject({
      method: "PUT",
      url: "/config/workflows/hotfix",
      payload: {
        rawDot: `digraph Hotfix {
          start [shape=Mdiamond];
          exit [shape=Msquare];
          review [label="Review", agent="reviewer", artifact_path=".vajra/review.md"];
          start -> review -> exit;
        }`,
        successState: "Done",
        inspectPr: true,
        labels: ["urgent"],
      },
    });
    assert.equal(saveWorkflow.statusCode, 200);
    assert.equal(saveWorkflow.json().name, "hotfix");

    const previewWorkflow = await app.inject({
      method: "POST",
      url: "/config/workflows/preview",
      payload: {
        name: "preview",
        rawDot: `digraph Preview {
          start [shape=Mdiamond];
          exit [shape=Msquare];
          review [label="Review", agent="reviewer", timeout="5000"];
          start -> review -> exit;
        }`,
        successState: "Done",
        inspectPr: true,
        labels: ["preview"],
      },
    });
    assert.equal(previewWorkflow.statusCode, 200);
    const previewPayload = previewWorkflow.json() as {
      name: string;
      labels: string[];
      nodes: Array<{ id: string; attrs: Record<string, string> }>;
    };
    assert.equal(previewPayload.name, "preview");
    assert.deepEqual(previewPayload.labels, ["preview"]);
    assert.equal(
      previewPayload.nodes.find((node) => node.id === "review")?.attrs.timeout,
      "5000",
    );

    const invalidPreview = await app.inject({
      method: "POST",
      url: "/config/workflows/preview",
      payload: {
        name: "broken",
        rawDot: `digraph Broken {
          review [label="Review", agent="reviewer"];
          exit [shape=Msquare];
          review -> exit;
        }`,
        successState: "Done",
        inspectPr: true,
        labels: ["broken"],
      },
    });
    assert.equal(invalidPreview.statusCode, 400);
    assert.match(invalidPreview.json().error, /expected exactly one start node/);

    const listWorkflows = await app.inject({
      method: "GET",
      url: "/config/workflows",
    });
    assert.equal(listWorkflows.statusCode, 200);
    const workflowsPayload = listWorkflows.json() as {
      workflows: Array<{ name: string; labels: string[] }>;
      defaultWorkflow: string;
    };
    assert.equal(workflowsPayload.defaultWorkflow, "default");
    const hotfix = workflowsPayload.workflows.find((workflow) => workflow.name === "hotfix");
    assert.deepEqual(hotfix?.labels, ["urgent"]);

    const saveSkill = await app.inject({
      method: "PUT",
      url: "/config/skills/vajra-review",
      payload: {
        content: "# Review\n",
      },
    });
    assert.equal(saveSkill.statusCode, 200);
    assert.equal(saveSkill.json().name, "vajra-review");

    const listSkills = await app.inject({
      method: "GET",
      url: "/config/skills",
    });
    assert.equal(listSkills.statusCode, 200);
    const skillsPayload = listSkills.json() as {
      skills: Array<{ name: string }>;
    };
    assert.deepEqual(skillsPayload.skills.map((skill) => skill.name), ["vajra-plan", "vajra-review"]);

    const deleteSkill = await app.inject({
      method: "DELETE",
      url: "/config/skills/vajra-review",
    });
    assert.equal(deleteSkill.statusCode, 200);
    const deletePayload = deleteSkill.json() as {
      skills: Array<{ name: string }>;
    };
    assert.deepEqual(deletePayload.skills.map((skill) => skill.name), ["vajra-plan"]);

    const rawWorkflow = await readFile(path.join(tempDir, "WORKFLOW.md"), "utf8");
    assert.match(rawWorkflow, /api_key: \$LINEAR_API_KEY/);
    assert.match(rawWorkflow, /triage:/);
    assert.match(rawWorkflow, /triage:[\s\S]*reasoning_effort: max[\s\S]*timeout_ms: 9000/);
    assert.match(rawWorkflow, /reviewer:/);
    assert.match(rawWorkflow, /hotfix:/);
  } finally {
    await app.close();
  }
});

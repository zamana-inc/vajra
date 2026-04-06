import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";

import { VajraEvent, VajraEventBus } from "../src/events";
import { LocalPipelineRunner } from "../src/pipeline";
import { AgentBackend, WorkflowDefinition } from "../src/types";
import { workflowDefinitionFromConfig } from "./helpers/workflow-definition";

class EventBackend implements AgentBackend {
  constructor(
    public readonly name: string,
    private readonly onExecute?: (workspace: string) => Promise<void> | void,
  ) {}

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
    await this.onExecute?.(opts.workspace);
    return {
      output: "ok",
      exitCode: 0,
      durationMs: 1,
    };
  }
}

async function makeWorkflow(tempDir: string, graphSource: string): Promise<{
  workflow: WorkflowDefinition;
  workspacePath: string;
  logsRoot: string;
}> {
  const workspacePath = path.join(tempDir, "workspace");
  const logsRoot = path.join(tempDir, "logs");
  const artifactsRoot = path.join(tempDir, "plans", "issues");
  const graphPath = path.join(tempDir, "default.dot");
  await mkdir(workspacePath, { recursive: true });
  await mkdir(artifactsRoot, { recursive: true });
  await writeFile(graphPath, graphSource, "utf8");

  return {
    workspacePath,
    logsRoot,
    workflow: (() => {
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
        artifacts: { root: artifactsRoot, workspaceDir: ".vajra" },
        hooks: { timeoutMs: 60_000 },
        execution: {
          maxConcurrentAgents: 1,
          maxRetryAttempts: 3,
          maxRetryBackoffMs: 30_000,
          maxConcurrentAgentsByState: {},
        },
        workflows: {
          default: { dotFile: graphPath },
        },
        workflowRouting: {
          defaultWorkflow: "default",
          byLabel: {},
        },
        backends: { backend: { command: "unused" } },
        agents: {
          backend: {
            backend: "backend",
            model: "gpt-5.4",
            prompt: "Run {{ issue.identifier }}",
          },
        },
        slack: null,
      };
      return workflowDefinitionFromConfig(workflowPath, config);
    })(),
  };
}

function makeIssue() {
  return {
    id: "1",
    identifier: "ENG-42",
    title: "Pipeline events",
    description: null,
    state: "Todo",
    priority: 1,
    labels: [],
    assigneeId: "vajra-uuid",
    creatorId: null,
    createdAt: null,
    updatedAt: null,
    url: null,
    blockedBy: [],
  };
}

test("LocalPipelineRunner emits stage lifecycle and edge selection events", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-events-"));
  const { workflow, workspacePath, logsRoot } = await makeWorkflow(
    tempDir,
    `
      digraph Example {
        start [shape=Mdiamond];
        exit [shape=Msquare];
        plan [label="Plan", agent="backend", artifact_path=".vajra/plan.md"];
        start -> plan -> exit;
      }
    `,
  );

  const bus = new VajraEventBus();
  const events: VajraEvent[] = [];
  const listener = (event: VajraEvent) => {
    events.push(event);
  };
  bus.onAny(listener);

  const runner = new LocalPipelineRunner(
    logsRoot,
    () => new Map([["backend", new EventBackend("backend", async (workspace) => {
      await writeFile(path.join(workspace, ".vajra", "plan.md"), "plan", "utf8");
    })]]),
    undefined,
    bus,
  );

  const result = await runner.startRun({
    issue: makeIssue(),
    attempt: 0,
    workflow,
    workspacePath,
  }).promise;

  assert.equal(result.status, "success");
  assert.ok(events.some((event) => event.type === "pipeline:stage:start"));
  assert.ok(events.some((event) => event.type === "pipeline:stage:complete"));
  assert.ok(events.some((event) => event.type === "pipeline:edge:selected"));

  bus.offAny(listener);
});

test("LocalPipelineRunner emits conditional edge evaluation events", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-edge-events-"));
  const { workflow, workspacePath, logsRoot } = await makeWorkflow(
    tempDir,
    `
      digraph Example {
        start [shape=Mdiamond];
        approved [shape=Msquare];
        fallback [shape=Msquare];
        review [label="Review", agent="backend", artifact_path=".vajra/review.md"];
        start -> review;
        review -> approved [condition="{{ stages.review.metadata.route == 'approved' }}"];
        review -> fallback;
      }
    `,
  );

  const bus = new VajraEventBus();
  const events: VajraEvent[] = [];
  const listener = (event: VajraEvent) => {
    events.push(event);
  };
  bus.onAny(listener);

  const runner = new LocalPipelineRunner(
    logsRoot,
    () => new Map([["backend", new EventBackend("backend", async (workspace) => {
      await writeFile(path.join(workspace, ".vajra", "review.md"), "review", "utf8");
      await mkdir(path.join(workspace, ".vajra", "run", "stages", "review"), { recursive: true });
      await writeFile(
        path.join(workspace, ".vajra", "run", "stages", "review", "result.json"),
        JSON.stringify({ route: "approved" }),
        "utf8",
      );
    })]]),
    undefined,
    bus,
  );

  const result = await runner.startRun({
    issue: makeIssue(),
    attempt: 0,
    workflow,
    workspacePath,
  }).promise;

  assert.equal(result.status, "success");
  const evaluated = events.find((event) => event.type === "pipeline:edge:evaluated");
  const selected = events.find((event) => event.type === "pipeline:edge:selected" && event.fromNodeId === "review");
  assert.ok(evaluated && evaluated.type === "pipeline:edge:evaluated");
  assert.equal(evaluated.result.trim().toLowerCase(), "true");
  assert.ok(selected && selected.type === "pipeline:edge:selected");
  assert.equal(selected.toNodeId, "approved");
  assert.equal(selected.isDefault, false);

  bus.offAny(listener);
});

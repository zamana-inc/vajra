import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";

import { LocalPipelineRunner } from "../src/pipeline";
import { CommandResult, CommandRunner } from "../src/process";
import { AgentBackend, DispatchPlan, IssueContext, WorkflowDefinition } from "../src/types";
import { workflowDefinitionFromConfig } from "./helpers/workflow-definition";

class MockBackend implements AgentBackend {
  readonly calls: string[] = [];
  readonly sessionIds: Array<string | undefined> = [];
  readonly createSessionFlags: boolean[] = [];
  readonly supportsNativeSessions?: boolean;

  constructor(
    public readonly name: string,
    private readonly artifactPath: string,
    private readonly opts: {
      exitCode?: number;
      writeArtifact?: boolean;
      delayMs?: number;
      output?: string;
      supportsNativeSessions?: boolean;
      sessionIdForCall?: (opts: {
        workspace: string;
        prompt: string;
        callIndex: number;
        createSession?: boolean;
        sessionId?: string;
      }) => string | undefined;
      invalidateSessionForCall?: (opts: {
        workspace: string;
        prompt: string;
        callIndex: number;
        createSession?: boolean;
        sessionId?: string;
      }) => boolean;
      onExecute?: (opts: {
        workspace: string;
        prompt: string;
        callIndex: number;
        createSession?: boolean;
        sessionId?: string;
      }) => Promise<void> | void;
    } = {},
  ) {
    this.supportsNativeSessions = this.opts.supportsNativeSessions;
  }

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
  }): Promise<{ output: string; exitCode: number; durationMs: number; sessionId?: string; invalidateSession?: boolean }> {
    const callIndex = this.calls.push(opts.prompt);
    this.sessionIds.push(opts.sessionId);
    this.createSessionFlags.push(Boolean(opts.createSession));
    if (this.opts.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, this.opts.delayMs);
        opts.signal?.addEventListener("abort", () => {
          clearTimeout(timeout);
          reject(new Error("aborted"));
        }, { once: true });
      });
    }

    if (this.opts.writeArtifact !== false) {
      await writeFile(path.join(opts.workspace, this.artifactPath), `${this.name} artifact`, "utf8");
    }

    await this.opts.onExecute?.({
      workspace: opts.workspace,
      prompt: opts.prompt,
      callIndex,
      createSession: opts.createSession,
      sessionId: opts.sessionId,
    });

    return {
      output: this.opts.output ?? `${this.name} ok`,
      exitCode: this.opts.exitCode ?? 0,
      durationMs: this.opts.delayMs ?? 1,
      sessionId: this.opts.sessionIdForCall?.({
        workspace: opts.workspace,
        prompt: opts.prompt,
        callIndex,
        createSession: opts.createSession,
        sessionId: opts.sessionId,
      }),
      invalidateSession: this.opts.invalidateSessionForCall?.({
        workspace: opts.workspace,
        prompt: opts.prompt,
        callIndex,
        createSession: opts.createSession,
        sessionId: opts.sessionId,
      }),
    };
  }
}

class RecordingCommandRunner implements CommandRunner {
  readonly commands: string[] = [];

  constructor(private readonly result: CommandResult = { stdout: "{}", stderr: "", exitCode: 0, durationMs: 1 }) {}

  async run(command: string, _opts: {
    cwd: string;
    timeoutMs?: number;
    killGraceMs?: number;
    env?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<CommandResult> {
    this.commands.push(command);
    return this.result;
  }
}

async function createWorkflow(opts: {
  tempDir: string;
  graphSource: string;
  workflows?: Record<string, {
    dotFileName: string;
    successState?: string;
    inspectPr?: boolean;
  }>;
  workflowLabelsByName?: Record<string, string[]>;
  defaultWorkflow?: string;
  extraGraphs?: Record<string, string>;
  backends?: Record<string, { command: string }>;
  fanOut?: WorkflowDefinition["config"]["fanOut"];
  escalation?: WorkflowDefinition["config"]["escalation"];
  agentDefinitions?: Record<string, {
    backend: string;
    model: string;
    prompt: string;
    reasoningEffort?: string;
    timeoutMs?: number;
  }>;
}): Promise<{ workflow: WorkflowDefinition; graphPath: string; artifactsRoot: string }> {
  const pipelinesDir = path.join(opts.tempDir, "pipelines");
  const plansDir = path.join(opts.tempDir, "plans", "issues");
  await mkdir(pipelinesDir, { recursive: true });
  await mkdir(plansDir, { recursive: true });

  const graphPath = path.join(pipelinesDir, "default.dot");
  await writeFile(graphPath, opts.graphSource, "utf8");

  for (const [name, source] of Object.entries(opts.extraGraphs ?? {})) {
    await writeFile(path.join(pipelinesDir, name), source, "utf8");
  }

  return {
    graphPath,
    artifactsRoot: plansDir,
    workflow: (() => {
      const workflowPath = path.join(opts.tempDir, "WORKFLOW.md");
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
        workspace: { root: path.join(opts.tempDir, "workspaces") },
        artifacts: { root: plansDir, workspaceDir: ".vajra" },
        hooks: { timeoutMs: 60_000 },
        execution: {
          maxConcurrentAgents: 1,
          maxRetryAttempts: 3,
          maxRetryBackoffMs: 30_000,
          maxConcurrentAgentsByState: {},
          maxAgentInvocationsPerRun: 20,
        },
        escalation: opts.escalation ?? null,
        fanOut: opts.fanOut ?? {},
        workflows: Object.fromEntries(
          Object.entries(opts.workflows ?? {
            default: { dotFileName: "default.dot" },
          }).map(([name, workflow]) => [
            name.toLowerCase(),
            {
              dotFile: path.join(pipelinesDir, workflow.dotFileName),
              ...(workflow.successState ? { successState: workflow.successState } : {}),
              ...(workflow.inspectPr === false ? { inspectPr: false } : {}),
            },
          ]),
        ),
        workflowRouting: {
          defaultWorkflow: (opts.defaultWorkflow ?? "default").toLowerCase(),
          byLabel: Object.fromEntries(
            Object.entries(opts.workflowLabelsByName ?? {}).flatMap(([workflowName, labels]) =>
              labels.map((label) => [label.toLowerCase(), workflowName.toLowerCase()] as const),
            ),
          ),
        },
        backends: opts.backends ?? {
          "plan-backend": { command: "unused" },
          "review-backend": { command: "unused" },
          "code-backend": { command: "unused" },
          "review-code-backend": { command: "unused" },
          "default-backend": { command: "unused" },
          "bug-backend": { command: "unused" },
        },
        agents: opts.agentDefinitions ?? {
          "plan-backend": {
            backend: "plan-backend",
            model: "gpt-5.4",
            prompt: "Issue {{ issue.identifier }} stage {{ stage.id }}. Artifacts live in {{ workspace.artifacts_dir }}.",
          },
          "review-backend": {
            backend: "review-backend",
            model: "gpt-5.4",
            prompt: "Issue {{ issue.identifier }} stage {{ stage.id }}. Artifacts live in {{ workspace.artifacts_dir }}.",
          },
          "code-backend": {
            backend: "code-backend",
            model: "gpt-5.4",
            prompt: "Issue {{ issue.identifier }} stage {{ stage.id }}. Artifacts live in {{ workspace.artifacts_dir }}.",
          },
          "review-code-backend": {
            backend: "review-code-backend",
            model: "gpt-5.4",
            prompt: "Issue {{ issue.identifier }} stage {{ stage.id }}. Artifacts live in {{ workspace.artifacts_dir }}.",
          },
          "default-backend": {
            backend: "default-backend",
            model: "gpt-5.4",
            prompt: "Issue {{ issue.identifier }} stage {{ stage.id }}. Artifacts live in {{ workspace.artifacts_dir }}.",
          },
          "bug-backend": {
            backend: "bug-backend",
            model: "gpt-5.4",
            prompt: "Issue {{ issue.identifier }} stage {{ stage.id }}. Artifacts live in {{ workspace.artifacts_dir }}.",
          },
        },
        slack: null,
        github: null,
      };
      return workflowDefinitionFromConfig(workflowPath, config);
    })(),
  };
}

function makeIssue(identifier: string, labels: string[] = []) {
  return {
    id: "1",
    identifier,
    title: "Example",
    description: "Example description",
    state: "Todo",
    priority: 1,
    labels,
    assigneeId: "vajra-uuid",
    creatorId: null,
    createdAt: null,
    updatedAt: null,
    url: null,
    blockedBy: [],
  };
}

test("pipeline persists stage context and exposes prior stage artifact paths to later prompts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-context-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const { workflow, artifactsRoot } = await createWorkflow({
    tempDir,
    agentDefinitions: {
      "plan-backend": {
        backend: "plan-backend",
        model: "gpt-5.4",
        prompt: "Write a plan into .vajra/plan.md.",
      },
      "code-backend": {
        backend: "code-backend",
        model: "gpt-5.4",
        prompt: "Plan output artifact: {{ stages.plan.artifacts.output }}. Plan artifact: {{ stages.plan.artifacts.primary }}.",
      },
    },
    graphSource: `
      digraph Example {
        start [shape=Mdiamond];
        exit [shape=Msquare];
        plan [label="Plan", agent="plan-backend", artifact_path=".vajra/plan.md"];
        code [label="Code", agent="code-backend", artifact_path=".vajra/code.md"];
        start -> plan -> code -> exit;
      }
    `,
  });

  const planBackend = new MockBackend("plan-backend", ".vajra/plan.md", { output: "plan stage output" });
  const codeBackend = new MockBackend("code-backend", ".vajra/code.md");
  const runner = new LocalPipelineRunner(logsRoot, () => new Map([
    ["plan-backend", planBackend],
    ["code-backend", codeBackend],
  ]));

  const result = await runner.startRun({
    issue: makeIssue("ENG-42"),
    attempt: 0,
    workflow,
    workspacePath,
  }).promise;

  assert.equal(result.status, "success");
  assert.equal(codeBackend.calls.length, 1);
  assert.doesNotMatch(codeBackend.calls[0], /plan stage output/);
  assert.match(codeBackend.calls[0], /\.vajra\/plan\.md/);
  assert.match(codeBackend.calls[0], /\.vajra\/run\/stages\/plan\/output\.txt/);

  const durableContext = JSON.parse(
    await readFile(path.join(artifactsRoot, "ENG-42", "run", "context.json"), "utf8"),
  ) as IssueContext;
  assert.deepEqual(durableContext.completedNodes, ["plan", "code"]);
  assert.equal(durableContext.stages.plan.artifacts.primary, ".vajra/plan.md");
  assert.equal(durableContext.stages.plan.artifacts.output, ".vajra/run/stages/plan/output.txt");
  assert.ok(!("output" in durableContext.stages.plan));
  assert.equal(await readFile(path.join(artifactsRoot, "ENG-42", "plan.md"), "utf8"), "plan-backend artifact");
  assert.equal(
    await readFile(path.join(artifactsRoot, "ENG-42", "run", "stages", "plan", "output.txt"), "utf8"),
    "plan stage output",
  );

  const runMetadata = JSON.parse(
    await readFile(path.join(logsRoot, "ENG-42", "attempt-0", "run.json"), "utf8"),
  ) as {
    status: string;
    startedAt: string;
    finishedAt: string | null;
  };
  const checkpoint = JSON.parse(
    await readFile(path.join(logsRoot, "ENG-42", "attempt-0", "checkpoint.json"), "utf8"),
  ) as {
    status: string;
    startedAt: string;
    finishedAt: string | null;
  };
  assert.equal(runMetadata.status, "success");
  assert.match(runMetadata.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(runMetadata.finishedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(checkpoint.status, "success");
  assert.equal(checkpoint.startedAt, runMetadata.startedAt);
  assert.equal(checkpoint.finishedAt, runMetadata.finishedAt);
});

test("pipeline renders only the resolved agent prompt for agent stages", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-overlay-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const { workflow } = await createWorkflow({
    tempDir,
    agentDefinitions: {
      "plan-backend": {
        backend: "plan-backend",
        model: "gpt-5.4",
        prompt: "AGENT {{ issue.identifier }} {{ stage.id }}",
      },
    },
    graphSource: `
      digraph Example {
        start [shape=Mdiamond];
        exit [shape=Msquare];
        plan [label="Plan", agent="plan-backend", artifact_path=".vajra/plan.md"];
        start -> plan -> exit;
      }
    `,
  });

  const planBackend = new MockBackend("plan-backend", ".vajra/plan.md");
  const runner = new LocalPipelineRunner(logsRoot, () => new Map([
    ["plan-backend", planBackend],
  ]));

  const result = await runner.startRun({
    issue: makeIssue("ENG-43"),
    attempt: 0,
    workflow,
    workspacePath,
  }).promise;

  assert.equal(result.status, "success");
  assert.equal(planBackend.calls[0], "AGENT ENG-43 plan");
});

test("pipeline injects dispatch-plan branch fields into agent prompt scope", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-branches-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const dispatchPlan: DispatchPlan = {
    workflowName: "default",
    successState: "Done",
    baseBranch: "dev",
    targetBranch: "release",
    mergeStrategy: "auto-merge",
    labelsToAdd: ["document"],
    triage: {
      action: "dispatch",
      workflowName: "default",
      baseBranch: "dev",
      targetBranch: "release",
      mergeStrategy: "auto-merge",
      labels: ["document"],
      reasoning: "Docs change targets release",
      wasFallback: false,
    },
  };

  const { workflow } = await createWorkflow({
    tempDir,
    agentDefinitions: {
      "plan-backend": {
        backend: "plan-backend",
        model: "gpt-5.4",
        prompt: "BASE {{ base_branch }} TARGET {{ target_branch }} MERGE {{ merge_strategy }}",
      },
    },
    graphSource: `
      digraph Example {
        start [shape=Mdiamond];
        exit [shape=Msquare];
        plan [label="Plan", agent="plan-backend", artifact_path=".vajra/plan.md"];
        start -> plan -> exit;
      }
    `,
  });

  const planBackend = new MockBackend("plan-backend", ".vajra/plan.md");
  const runner = new LocalPipelineRunner(logsRoot, () => new Map([
    ["plan-backend", planBackend],
  ]));

  const result = await runner.startRun({
    issue: makeIssue("ENG-43"),
    attempt: 0,
    workflow,
    workspacePath,
    dispatchPlan,
  }).promise;

  assert.equal(result.status, "success");
  assert.equal(planBackend.calls[0], "BASE dev TARGET release MERGE auto-merge");
});

test("pipeline writes checkpoints and resumes from the next unfinished node using persisted context", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-resume-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const { workflow, artifactsRoot } = await createWorkflow({
    tempDir,
    agentDefinitions: {
      "plan-backend": {
        backend: "plan-backend",
        model: "gpt-5.4",
        prompt: "Plan prompt",
      },
      "review-backend": {
        backend: "review-backend",
        model: "gpt-5.4",
        prompt: "Review prompt",
      },
      "code-backend": {
        backend: "code-backend",
        model: "gpt-5.4",
        prompt: "Code prompt {{ stages.plan.artifacts.output }}",
      },
      "review-code-backend": {
        backend: "review-code-backend",
        model: "gpt-5.4",
        prompt: "Review code prompt",
      },
    },
    graphSource: `
      digraph Example {
        start [shape=Mdiamond];
        exit [shape=Msquare];
        plan [label="Plan", agent="plan-backend", artifact_path=".vajra/plan.md"];
        review_plan [label="Review Plan", agent="review-backend", artifact_path=".vajra/plan.md"];
        code [label="Code", agent="code-backend", artifact_path=".vajra/code.md"];
        review_code [label="Review Code", agent="review-code-backend", artifact_path=".vajra/review.md"];
        start -> plan -> review_plan -> code -> review_code -> exit;
      }
    `,
  });

  const durableIssueDir = path.join(artifactsRoot, "ENG-42");
  await mkdir(durableIssueDir, { recursive: true });
  await writeFile(path.join(durableIssueDir, "plan.md"), "persisted plan", "utf8");
  await mkdir(path.join(durableIssueDir, "run", "stages", "plan"), { recursive: true });
  await writeFile(path.join(durableIssueDir, "run", "stages", "plan", "output.txt"), "persisted plan output", "utf8");
  await writeFile(
    path.join(durableIssueDir, "run", "context.json"),
    JSON.stringify({
      issue: {
        id: "1",
        identifier: "ENG-42",
        title: "Example",
        description: "Example description",
        state: "Todo",
        labels: [],
        url: "",
      },
      attempt: 0,
      workspacePath,
      workspaceArtifactsDir: ".vajra/run",
      completedNodes: ["plan", "review_plan"],
      stages: {
        plan: {
          id: "plan",
          label: "Plan",
          type: "agent",
          status: "success",
          artifacts: { primary: ".vajra/plan.md", output: ".vajra/run/stages/plan/output.txt" },
          metadata: {},
          backend: "plan-backend",
          command: null,
          promptPath: null,
          outputPath: null,
          exitCode: 0,
          durationMs: 1,
          updatedAt: new Date().toISOString(),
        },
      },
      updatedAt: new Date().toISOString(),
    } satisfies IssueContext),
    "utf8",
  );

  const checkpointPath = path.join(logsRoot, "ENG-42", "attempt-0", "checkpoint.json");
  await mkdir(path.dirname(checkpointPath), { recursive: true });
  await writeFile(
    checkpointPath,
    JSON.stringify({
      issueId: "1",
      issueIdentifier: "ENG-42",
      attempt: 0,
      workspacePath,
      graphId: "Example",
      completedNodes: ["plan", "review_plan"],
      nextNodeId: "code",
      status: "running",
      error: null,
    }),
    "utf8",
  );

  const planBackend = new MockBackend("plan-backend", ".vajra/plan.md");
  const reviewBackend = new MockBackend("review-backend", ".vajra/plan.md");
  const codeBackend = new MockBackend("code-backend", ".vajra/code.md");
  const reviewCodeBackend = new MockBackend("review-code-backend", ".vajra/review.md");

  const runner = new LocalPipelineRunner(logsRoot, () => new Map([
    ["plan-backend", planBackend],
    ["review-backend", reviewBackend],
    ["code-backend", codeBackend],
    ["review-code-backend", reviewCodeBackend],
  ]));

  const result = await runner.startRun({
    issue: makeIssue("ENG-42"),
    attempt: 0,
    workflow,
    workspacePath,
  }).promise;

  assert.equal(result.status, "success");
  assert.equal(planBackend.calls.length, 0);
  assert.equal(reviewBackend.calls.length, 0);
  assert.equal(codeBackend.calls.length, 1);
  assert.match(codeBackend.calls[0], /\.vajra\/run\/stages\/plan\/output\.txt/);
  assert.equal(reviewCodeBackend.calls.length, 1);
});

test("pipeline persists tool output into workspace artifacts and injects only the artifact path into later prompts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-tool-output-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const { workflow, artifactsRoot } = await createWorkflow({
    tempDir,
    agentDefinitions: {
      "code-backend": {
        backend: "code-backend",
        model: "gpt-5.4",
        prompt: "Lint output artifact: {{ stages.lint.artifacts.output }}.",
      },
    },
    graphSource: `
      digraph Example {
        start [shape=Mdiamond];
        exit [shape=Msquare];
        lint [type="tool", command="printf 'lint transcript'"];
        fix [label="Fix", agent="code-backend", artifact_path=".vajra/fix.md"];
        start -> lint -> fix -> exit;
      }
    `,
  });

  const codeBackend = new MockBackend("code-backend", ".vajra/fix.md");
  const runner = new LocalPipelineRunner(logsRoot, () => new Map([
    ["code-backend", codeBackend],
  ]));

  const result = await runner.startRun({
    issue: makeIssue("ENG-55"),
    attempt: 0,
    workflow,
    workspacePath,
  }).promise;

  assert.equal(result.status, "success");
  assert.equal(codeBackend.calls.length, 1);
  assert.match(codeBackend.calls[0], /\.vajra\/run\/stages\/lint\/output\.txt/);
  assert.doesNotMatch(codeBackend.calls[0], /lint transcript/);
  assert.equal(
    await readFile(path.join(workspacePath, ".vajra", "run", "stages", "lint", "output.txt"), "utf8"),
    "lint transcript",
  );
  assert.equal(
    await readFile(path.join(artifactsRoot, "ENG-55", "run", "stages", "lint", "output.txt"), "utf8"),
    "lint transcript",
  );
});

test("pipeline loads structured stage metadata from result.json for later stages and persisted context", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-result-json-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const { workflow, artifactsRoot } = await createWorkflow({
    tempDir,
    agentDefinitions: {
      "plan-backend": {
        backend: "plan-backend",
        model: "gpt-5.4",
        prompt: "Plan",
      },
      "review-backend": {
        backend: "review-backend",
        model: "gpt-5.4",
        prompt: "Branch {{ stages.plan.metadata.branch }} severity {{ stages.plan.metadata.severity }} tests_failed {{ stages.plan.metadata.tests_failed }}.",
      },
    },
    graphSource: `
      digraph Example {
        start [shape=Mdiamond];
        exit [shape=Msquare];
        plan [label="Plan", agent="plan-backend", artifact_path=".vajra/plan.md"];
        review [label="Review", agent="review-backend", artifact_path=".vajra/review.md"];
        start -> plan -> review -> exit;
      }
    `,
  });

  const planBackend = new MockBackend("plan-backend", ".vajra/plan.md", {
    onExecute: async ({ workspace }) => {
      const resultDir = path.join(workspace, ".vajra", "run", "stages", "plan");
      await mkdir(resultDir, { recursive: true });
      await writeFile(
        path.join(resultDir, "result.json"),
        JSON.stringify({
          branch: "feature/ENG-77",
          severity: "critical",
          tests_failed: 0,
        }),
        "utf8",
      );
    },
  });
  const reviewBackend = new MockBackend("review-backend", ".vajra/review.md");
  const runner = new LocalPipelineRunner(logsRoot, () => new Map([
    ["plan-backend", planBackend],
    ["review-backend", reviewBackend],
  ]));

  const result = await runner.startRun({
    issue: makeIssue("ENG-77"),
    attempt: 0,
    workflow,
    workspacePath,
  }).promise;

  assert.equal(result.status, "success");
  assert.equal(reviewBackend.calls.length, 1);
  assert.match(reviewBackend.calls[0], /feature\/ENG-77/);
  assert.match(reviewBackend.calls[0], /severity critical/);
  assert.match(reviewBackend.calls[0], /tests_failed 0/);

  const durableContext = JSON.parse(
    await readFile(path.join(artifactsRoot, "ENG-77", "run", "context.json"), "utf8"),
  ) as IssueContext;
  assert.equal(durableContext.stages.plan.metadata.branch, "feature/ENG-77");
  assert.equal(durableContext.stages.plan.metadata.severity, "critical");
  assert.equal(durableContext.stages.plan.metadata.tests_failed, 0);
});

test("pipeline warns on invalid result.json and captures the final PR only after pipeline success", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-result-json-invalid-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const binDir = path.join(tempDir, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(
    path.join(binDir, "gh"),
    "#!/bin/sh\nprintf '{\"url\":\"https://github.com/acme-corp/acme-app/pull/301\",\"title\":\"ENG-78 PR\",\"number\":301,\"headRefName\":\"eng-78\",\"additions\":12,\"deletions\":3,\"state\":\"OPEN\"}'\n",
    { encoding: "utf8", mode: 0o755 },
  );

  const { workflow, artifactsRoot } = await createWorkflow({
    tempDir,
    agentDefinitions: {
      "plan-backend": {
        backend: "plan-backend",
        model: "gpt-5.4",
        prompt: "Push changes",
      },
      "review-backend": {
        backend: "review-backend",
        model: "gpt-5.4",
        prompt: "PR {{ stages.push.metadata.pr.url }}.",
      },
    },
    graphSource: `
      digraph Example {
        start [shape=Mdiamond];
        exit [shape=Msquare];
        push [label="Push", agent="plan-backend", artifact_path=".vajra/push.md"];
        review [label="Review", agent="review-backend", artifact_path=".vajra/review.md"];
        start -> push -> review -> exit;
      }
    `,
  });

  const warnings: string[] = [];
  const originalConsoleError = console.error;
  console.error = (message?: unknown, ...args: unknown[]) => {
    warnings.push([message, ...args].map((value) => String(value)).join(" "));
  };

  const originalPath = process.env.PATH ?? "";
  process.env.PATH = `${binDir}:${originalPath}`;
  try {
    const pushBackend = new MockBackend("plan-backend", ".vajra/push.md", {
      output: "push complete",
      onExecute: async ({ workspace }) => {
        const resultDir = path.join(workspace, ".vajra", "run", "stages", "push");
        await mkdir(resultDir, { recursive: true });
        await writeFile(path.join(resultDir, "result.json"), "{not valid json", "utf8");
      },
    });
    const reviewBackend = new MockBackend("review-backend", ".vajra/review.md");
    const runner = new LocalPipelineRunner(logsRoot, () => new Map([
      ["plan-backend", pushBackend],
      ["review-backend", reviewBackend],
    ]));

    const result = await runner.startRun({
      issue: makeIssue("ENG-78"),
      attempt: 0,
      workflow,
      workspacePath,
    }).promise;

    assert.equal(result.status, "success");
    assert.equal(reviewBackend.calls.length, 1);
    assert.doesNotMatch(reviewBackend.calls[0], /pull\/301/);
    assert.ok(warnings.some((entry) => entry.includes("stage result metadata ignored")));
    assert.equal(result.prUrl, "https://github.com/acme-corp/acme-app/pull/301");
    assert.deepEqual(result.pr, {
      url: "https://github.com/acme-corp/acme-app/pull/301",
      title: "ENG-78 PR",
      number: 301,
      headRefName: "eng-78",
      additions: 12,
      deletions: 3,
      state: "OPEN",
    });

    const durableContext = JSON.parse(
      await readFile(path.join(artifactsRoot, "ENG-78", "run", "context.json"), "utf8"),
    ) as IssueContext;
    assert.deepEqual(durableContext.stages.push.metadata, {});
  } finally {
    process.env.PATH = originalPath;
    console.error = originalConsoleError;
  }
});

test("pipeline skips final PR inspection for workflows that opt out", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-no-pr-workflow-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const { workflow } = await createWorkflow({
    tempDir,
    workflows: {
      default: {
        dotFileName: "default.dot",
        inspectPr: false,
      },
    },
    graphSource: `
      digraph Example {
        start [shape=Mdiamond];
        exit [shape=Msquare];
        check [label="Check", agent="plan-backend", artifact_path=".vajra/check.md"];
        start -> check -> exit;
      }
    `,
  });

  const commandRunner = new RecordingCommandRunner();
  const runner = new LocalPipelineRunner(
    logsRoot,
    () => new Map([["plan-backend", new MockBackend("plan-backend", ".vajra/check.md")]]),
    commandRunner,
  );

  const result = await runner.startRun({
    issue: makeIssue("ENG-79"),
    attempt: 0,
    workflow,
    workspacePath,
  }).promise;

  assert.equal(result.status, "success");
  assert.equal(result.prUrl, null);
  assert.deepEqual(commandRunner.commands, []);
});

test("pipeline follows conditional edges, loops on tool failure, and writes visit-specific run directories", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-conditional-loop-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const { workflow } = await createWorkflow({
    tempDir,
    agentDefinitions: {
      "code-backend": {
        backend: "code-backend",
        model: "gpt-5.4",
        prompt: "Implement using latest test failures {{ stages.test.metadata.tests_failed }}.",
      },
    },
    graphSource: `
      digraph Example {
        start [shape=Mdiamond];
        exit [shape=Msquare];
        implement [label="Implement", agent="code-backend", artifact_path=".vajra/implement.md", max_visits="3"];
        test [label="Test", type="tool", command="mkdir -p .vajra/run/stages/test && if [ ! -f .vajra/test-attempt ]; then touch .vajra/test-attempt && printf '{\\\"tests_failed\\\":1}' > .vajra/run/stages/test/result.json && printf 'tests failed' && exit 1; else printf '{\\\"tests_failed\\\":0}' > .vajra/run/stages/test/result.json && printf 'tests passed' && exit 0; fi"];
        submit [label="Submit", type="tool", command="printf 'submitted'"];
        start -> implement;
        implement -> test;
        test -> submit [condition="{{ stages.test.exitCode == 0 }}"];
        test -> implement [condition="{{ stages.test.exitCode != 0 }}"];
        submit -> exit;
      }
    `,
  });

  const implementBackend = new MockBackend("code-backend", ".vajra/implement.md");
  const runner = new LocalPipelineRunner(logsRoot, () => new Map([
    ["code-backend", implementBackend],
  ]));

  const result = await runner.startRun({
    issue: makeIssue("ENG-200"),
    attempt: 0,
    workflow,
    workspacePath,
  }).promise;

  assert.equal(result.status, "success");
  assert.equal(implementBackend.calls.length, 2);
  assert.match(implementBackend.calls[1], /latest test failures 1/);
  assert.deepEqual(result.completedNodes, ["implement", "test", "implement", "test", "submit"]);
  assert.equal(
    await readFile(path.join(logsRoot, "ENG-200", "attempt-0", "implement", "prompt.txt"), "utf8"),
    implementBackend.calls[0],
  );
  assert.equal(
    await readFile(path.join(logsRoot, "ENG-200", "attempt-0", "implement_2", "prompt.txt"), "utf8"),
    implementBackend.calls[1],
  );
  assert.equal(
    await readFile(path.join(logsRoot, "ENG-200", "attempt-0", "test_2", "output.txt"), "utf8"),
    "tests passed",
  );
});

test("pipeline fails when a looping node exceeds max_visits", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-max-visits-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const { workflow } = await createWorkflow({
    tempDir,
    graphSource: `
      digraph Example {
        start [shape=Mdiamond];
        exit [shape=Msquare];
        implement [label="Implement", agent="code-backend", artifact_path=".vajra/implement.md", max_visits="2"];
        test [label="Test", type="tool", command="mkdir -p .vajra/run/stages/test && printf '{\\\"tests_failed\\\":1}' > .vajra/run/stages/test/result.json && printf 'tests failed' && exit 1"];
        submit [label="Submit", type="tool", command="printf 'submitted'"];
        start -> implement;
        implement -> test;
        test -> submit [condition="{{ stages.test.exitCode == 0 }}"];
        test -> implement [condition="{{ stages.test.exitCode != 0 }}"];
        submit -> exit;
      }
    `,
  });

  const implementBackend = new MockBackend("code-backend", ".vajra/implement.md");
  const runner = new LocalPipelineRunner(logsRoot, () => new Map([
    ["code-backend", implementBackend],
  ]));

  const result = await runner.startRun({
    issue: makeIssue("ENG-201"),
    attempt: 0,
    workflow,
    workspacePath,
  }).promise;

  assert.equal(result.status, "failure");
  assert.equal(result.failedStageId, "implement");
  assert.match(result.error ?? "", /exceeded max_visits 2 \(visit 3\)/);
  assert.deepEqual(result.completedNodes, ["implement", "test", "implement", "test"]);
  assert.equal(implementBackend.calls.length, 2);
});

test("pipeline routes to on_exhaustion target when a looping node exceeds max_visits", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-on-exhaustion-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const { workflow } = await createWorkflow({
    tempDir,
    graphSource: `
      digraph Example {
        start [shape=Mdiamond];
        exit [shape=Msquare];
        escalate [shape=Msquare];
        implement [label="Implement", agent="code-backend", artifact_path=".vajra/implement.md", max_visits="2", on_exhaustion="escalate"];
        test [label="Test", type="tool", command="mkdir -p .vajra/run/stages/test && printf '{\\\"tests_failed\\\":1}' > .vajra/run/stages/test/result.json && printf 'tests failed' && exit 1"];
        start -> implement;
        implement -> test;
        test -> implement [condition="{{ stages.test.exitCode != 0 }}"];
        test -> exit [condition="{{ stages.test.exitCode == 0 }}"];
      }
    `,
  });

  const implementBackend = new MockBackend("code-backend", ".vajra/implement.md");
  const runner = new LocalPipelineRunner(logsRoot, () => new Map([
    ["code-backend", implementBackend],
  ]));

  const result = await runner.startRun({
    issue: makeIssue("ENG-201A"),
    attempt: 0,
    workflow,
    workspacePath,
  }).promise;

  assert.equal(result.status, "success");
  assert.deepEqual(result.completedNodes, ["implement", "test", "implement", "test"]);
  assert.equal(implementBackend.calls.length, 2);
});

test("pipeline treats a retry without a checkpoint as a fresh traversal even when durable context exists", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-fresh-retry-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const { workflow, artifactsRoot } = await createWorkflow({
    tempDir,
    graphSource: `
      digraph Example {
        start [shape=Mdiamond];
        exit [shape=Msquare];
        plan [label="Plan", agent="plan-backend", artifact_path=".vajra/plan.md", max_visits="1"];
        start -> plan -> exit;
      }
    `,
  });

  const durableIssueDir = path.join(artifactsRoot, "ENG-204");
  await mkdir(path.join(durableIssueDir, "run"), { recursive: true });
  await writeFile(
    path.join(durableIssueDir, "run", "context.json"),
    JSON.stringify({
      issue: {
        id: "1",
        identifier: "ENG-204",
        title: "Example",
        description: "Example description",
        state: "Todo",
        labels: [],
        url: "",
      },
      attempt: 0,
      workspacePath: "/stale/workspace",
      workspaceArtifactsDir: ".vajra/run",
      completedNodes: ["plan"],
      stages: {},
      updatedAt: "2026-03-30T00:00:00.000Z",
    }),
    "utf8",
  );

  const planBackend = new MockBackend("plan-backend", ".vajra/plan.md");
  const runner = new LocalPipelineRunner(logsRoot, () => new Map([
    ["plan-backend", planBackend],
  ]));

  const result = await runner.startRun({
    issue: makeIssue("ENG-204"),
    attempt: 1,
    workflow,
    workspacePath,
  }).promise;

  assert.equal(result.status, "success");
  assert.equal(planBackend.calls.length, 1);
  assert.deepEqual(result.completedNodes, ["plan"]);
});

test("pipeline fails when no edge condition matches and there is no default edge", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-no-match-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const { workflow } = await createWorkflow({
    tempDir,
    graphSource: `
      digraph Example {
        start [shape=Mdiamond];
        success [shape=Msquare];
        reject [shape=Msquare];
        review [label="Review", agent="review-backend", artifact_path=".vajra/review.md"];
        start -> review;
        review -> success [condition="{{ stages.review.metadata.route == 'success' }}"];
        review -> reject [condition="{{ stages.review.metadata.route == 'reject' }}"];
      }
    `,
  });

  const reviewBackend = new MockBackend("review-backend", ".vajra/review.md");
  const runner = new LocalPipelineRunner(logsRoot, () => new Map([
    ["review-backend", reviewBackend],
  ]));

  const result = await runner.startRun({
    issue: makeIssue("ENG-202"),
    attempt: 0,
    workflow,
    workspacePath,
  }).promise;

  assert.equal(result.status, "failure");
  assert.equal(result.failedStageId, "review");
  assert.match(result.error ?? "", /no outgoing edge matched for node review/);
  assert.deepEqual(result.completedNodes, ["review"]);
});

test("pipeline succeeds when a conditional branch routes to an alternate exit", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-multi-exit-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const { workflow } = await createWorkflow({
    tempDir,
    graphSource: `
      digraph Example {
        start [shape=Mdiamond];
        success [shape=Msquare];
        reject [shape=Msquare];
        review [label="Review", agent="review-backend", artifact_path=".vajra/review.md"];
        start -> review;
        review -> success [condition="{{ stages.review.metadata.route == 'success' }}"];
        review -> reject [condition="{{ stages.review.metadata.route == 'reject' }}"];
      }
    `,
  });

  const reviewBackend = new MockBackend("review-backend", ".vajra/review.md", {
    onExecute: async ({ workspace }) => {
      const resultDir = path.join(workspace, ".vajra", "run", "stages", "review");
      await mkdir(resultDir, { recursive: true });
      await writeFile(
        path.join(resultDir, "result.json"),
        JSON.stringify({ route: "reject" }),
        "utf8",
      );
    },
  });
  const runner = new LocalPipelineRunner(logsRoot, () => new Map([
    ["review-backend", reviewBackend],
  ]));

  const result = await runner.startRun({
    issue: makeIssue("ENG-202"),
    attempt: 0,
    workflow,
    workspacePath,
  }).promise;

  assert.equal(result.status, "success");
  assert.deepEqual(result.completedNodes, ["review"]);
  assert.equal(result.context?.stages.review.metadata.route, "reject");
});

test("pipeline routes by on_label when a stage emits a label", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-on-label-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const { workflow } = await createWorkflow({
    tempDir,
    graphSource: `
      digraph Example {
        start [shape=Mdiamond];
        approve [shape=Msquare];
        reject [shape=Msquare];
        review [label="Review", agent="review-backend", artifact_path=".vajra/review.md"];
        start -> review;
        review -> approve [on_label="lgtm"];
        review -> reject [on_label="revise"];
      }
    `,
  });

  const reviewBackend = new MockBackend("review-backend", ".vajra/review.md", {
    onExecute: async ({ workspace }) => {
      const resultDir = path.join(workspace, ".vajra", "run", "stages", "review");
      await mkdir(resultDir, { recursive: true });
      await writeFile(
        path.join(resultDir, "result.json"),
        JSON.stringify({
          label: "revise",
          facts: {
            blocker_count: 2,
          },
        }),
        "utf8",
      );
    },
  });
  const runner = new LocalPipelineRunner(logsRoot, () => new Map([
    ["review-backend", reviewBackend],
  ]));

  const result = await runner.startRun({
    issue: makeIssue("ENG-202A"),
    attempt: 0,
    workflow,
    workspacePath,
  }).promise;

  assert.equal(result.status, "success");
  assert.deepEqual(result.completedNodes, ["review"]);
  assert.equal(result.context?.stages.review.metadata.blocker_count, 2);
});

test("pipeline falls through to the default edge when a stage emits no label", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-on-label-default-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const { workflow } = await createWorkflow({
    tempDir,
    graphSource: `
      digraph Example {
        start [shape=Mdiamond];
        approve [shape=Msquare];
        reject [shape=Msquare];
        review [label="Review", agent="review-backend", artifact_path=".vajra/review.md"];
        start -> review;
        review -> reject [on_label="revise"];
        review -> approve;
      }
    `,
  });

  const reviewBackend = new MockBackend("review-backend", ".vajra/review.md");
  const runner = new LocalPipelineRunner(logsRoot, () => new Map([
    ["review-backend", reviewBackend],
  ]));

  const result = await runner.startRun({
    issue: makeIssue("ENG-202B"),
    attempt: 0,
    workflow,
    workspacePath,
  }).promise;

  assert.equal(result.status, "success");
  assert.deepEqual(result.completedNodes, ["review"]);
});

test("pipeline fails when a stage emits an unknown label for its on_label edges", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-on-label-miss-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const { workflow } = await createWorkflow({
    tempDir,
    graphSource: `
      digraph Example {
        start [shape=Mdiamond];
        approve [shape=Msquare];
        reject [shape=Msquare];
        review [label="Review", agent="review-backend", artifact_path=".vajra/review.md"];
        start -> review;
        review -> approve [on_label="lgtm"];
        review -> reject [on_label="revise"];
      }
    `,
  });

  const reviewBackend = new MockBackend("review-backend", ".vajra/review.md", {
    onExecute: async ({ workspace }) => {
      const resultDir = path.join(workspace, ".vajra", "run", "stages", "review");
      await mkdir(resultDir, { recursive: true });
      await writeFile(
        path.join(resultDir, "result.json"),
        JSON.stringify({ label: "escalate" }),
        "utf8",
      );
    },
  });
  const runner = new LocalPipelineRunner(logsRoot, () => new Map([
    ["review-backend", reviewBackend],
  ]));

  const result = await runner.startRun({
    issue: makeIssue("ENG-202C"),
    attempt: 0,
    workflow,
    workspacePath,
  }).promise;

  assert.equal(result.status, "failure");
  assert.equal(result.failedStageId, "review");
  assert.match(result.error ?? "", /no outgoing edge matched label "escalate" for node review/);
});

test("pipeline resumes a conditional graph using visit counts reconstructed from completedNodes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-resume-loop-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const { workflow, artifactsRoot } = await createWorkflow({
    tempDir,
    agentDefinitions: {
      "code-backend": {
        backend: "code-backend",
        model: "gpt-5.4",
        prompt: "Retry count {{ stages.test.metadata.tests_failed }}.",
      },
    },
    graphSource: `
      digraph Example {
        start [shape=Mdiamond];
        exit [shape=Msquare];
        implement [label="Implement", agent="code-backend", artifact_path=".vajra/implement.md", max_visits="3"];
        test [label="Test", type="tool", command="mkdir -p .vajra/run/stages/test && printf '{\\\"tests_failed\\\":0}' > .vajra/run/stages/test/result.json && printf 'tests passed' && exit 0"];
        submit [label="Submit", type="tool", command="printf 'submitted'"];
        start -> implement;
        implement -> test;
        test -> submit [condition="{{ stages.test.exitCode == 0 }}"];
        test -> implement [condition="{{ stages.test.exitCode != 0 }}"];
        submit -> exit;
      }
    `,
  });

  const durableIssueDir = path.join(artifactsRoot, "ENG-203");
  await mkdir(path.join(durableIssueDir, "run", "stages", "implement"), { recursive: true });
  await mkdir(path.join(durableIssueDir, "run", "stages", "test"), { recursive: true });
  await writeFile(path.join(durableIssueDir, "implement.md"), "existing implement artifact", "utf8");
  await writeFile(path.join(durableIssueDir, "run", "stages", "implement", "output.txt"), "previous implement output", "utf8");
  await writeFile(path.join(durableIssueDir, "run", "stages", "test", "output.txt"), "previous test output", "utf8");
  await writeFile(
    path.join(durableIssueDir, "run", "context.json"),
    JSON.stringify({
      issue: {
        id: "1",
        identifier: "ENG-203",
        title: "Example",
        description: "Example description",
        state: "Todo",
        labels: [],
        url: "",
      },
      attempt: 0,
      workspacePath,
      workspaceArtifactsDir: ".vajra/run",
      completedNodes: ["implement", "test", "implement", "test"],
      stages: {
        implement: {
          id: "implement",
          label: "Implement",
          type: "agent",
          status: "success",
          artifacts: { primary: ".vajra/implement.md", output: ".vajra/run/stages/implement/output.txt" },
          metadata: {},
          backend: "code-backend",
          command: null,
          promptPath: null,
          outputPath: null,
          exitCode: 0,
          durationMs: 1,
          updatedAt: new Date().toISOString(),
        },
        test: {
          id: "test",
          label: "Test",
          type: "tool",
          status: "failure",
          artifacts: { primary: "", output: ".vajra/run/stages/test/output.txt" },
          metadata: { tests_failed: "1" },
          backend: null,
          command: "npm test",
          promptPath: null,
          outputPath: null,
          exitCode: 1,
          durationMs: 1,
          updatedAt: new Date().toISOString(),
        },
      },
      updatedAt: new Date().toISOString(),
    } satisfies IssueContext),
    "utf8",
  );

  const checkpointPath = path.join(logsRoot, "ENG-203", "attempt-0", "checkpoint.json");
  await mkdir(path.dirname(checkpointPath), { recursive: true });
  await writeFile(
    checkpointPath,
    JSON.stringify({
      issueId: "1",
      issueIdentifier: "ENG-203",
      attempt: 0,
      workspacePath,
      graphId: "Example",
      completedNodes: ["implement", "test", "implement", "test"],
      nextNodeId: "implement",
      status: "running",
      error: null,
    }),
    "utf8",
  );

  const implementBackend = new MockBackend("code-backend", ".vajra/implement.md");
  const runner = new LocalPipelineRunner(logsRoot, () => new Map([
    ["code-backend", implementBackend],
  ]));

  const result = await runner.startRun({
    issue: makeIssue("ENG-203"),
    attempt: 0,
    workflow,
    workspacePath,
  }).promise;

  assert.equal(result.status, "success");
  assert.equal(implementBackend.calls.length, 1);
  assert.equal(
    await readFile(path.join(logsRoot, "ENG-203", "attempt-0", "implement_3", "prompt.txt"), "utf8"),
    implementBackend.calls[0],
  );
  assert.deepEqual(result.completedNodes, ["implement", "test", "implement", "test", "implement", "test", "submit"]);
});

test("pipeline selects a workflow-specific DOT file based on a matching issue label", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-routing-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const { workflow } = await createWorkflow({
    tempDir,
    graphSource: `
      digraph DefaultPipeline {
        start [shape=Mdiamond];
        exit [shape=Msquare];
        default_stage [label="Default", agent="default-backend", artifact_path=".vajra/default.md"];
        start -> default_stage -> exit;
      }
    `,
    workflows: {
      bug: { dotFileName: "bug.dot" },
      default: { dotFileName: "default.dot" },
    },
    workflowLabelsByName: {
      bug: ["bug"],
    },
    extraGraphs: {
      "bug.dot": `
        digraph BugPipeline {
          start [shape=Mdiamond];
          exit [shape=Msquare];
          bug_stage [label="Bug", agent="bug-backend", artifact_path=".vajra/bug.md"];
          start -> bug_stage -> exit;
        }
      `,
    },
  });

  const defaultBackend = new MockBackend("default-backend", ".vajra/default.md");
  const bugBackend = new MockBackend("bug-backend", ".vajra/bug.md");
  const runner = new LocalPipelineRunner(logsRoot, () => new Map([
    ["default-backend", defaultBackend],
    ["bug-backend", bugBackend],
  ]));

  const result = await runner.startRun({
    issue: makeIssue("ENG-7", ["bug"]),
    attempt: 0,
    workflow,
    workspacePath,
  }).promise;

  assert.equal(result.status, "success");
  assert.equal(defaultBackend.calls.length, 0);
  assert.equal(bugBackend.calls.length, 1);
});

test("pipeline executes tool stages via shell commands", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-tool-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(path.join(workspacePath, ".vajra"), { recursive: true });

  const { workflow } = await createWorkflow({
    tempDir,
    graphSource: `
      digraph Example {
        start [shape=Mdiamond];
        exit [shape=Msquare];
        notify [type="tool", command="printf 'sent' > .vajra/notify.txt", artifact_path=".vajra/notify.txt"];
        start -> notify -> exit;
      }
    `,
  });

  const runner = new LocalPipelineRunner(logsRoot, () => new Map());
  const result = await runner.startRun({
    issue: makeIssue("ENG-88"),
    attempt: 0,
    workflow,
    workspacePath,
  }).promise;

  assert.equal(result.status, "success");
  assert.equal(await readFile(path.join(workspacePath, ".vajra", "notify.txt"), "utf8"), "sent");
});

test("pipeline returns failure when a linear stage exits non-zero or misses its artifact", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-failure-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const { workflow } = await createWorkflow({
    tempDir,
    graphSource: `
      digraph Example {
        start [shape=Mdiamond];
        exit [shape=Msquare];
        plan [label="Plan", agent="plan-backend", artifact_path=".vajra/plan.md"];
        code [label="Code", agent="code-backend", artifact_path=".vajra/code.md"];
        start -> plan -> code -> exit;
      }
    `,
  });

  const failureRunner = new LocalPipelineRunner(logsRoot, () => new Map([
    ["plan-backend", new MockBackend("plan-backend", ".vajra/plan.md")],
    ["code-backend", new MockBackend("code-backend", ".vajra/code.md", { exitCode: 1 })],
  ]));

  const failureResult = await failureRunner.startRun({
    issue: makeIssue("ENG-99"),
    attempt: 0,
    workflow,
    workspacePath,
  }).promise;

  assert.equal(failureResult.status, "failure");
  assert.deepEqual(failureResult.completedNodes, ["plan", "code"]);

  const missingArtifactRunner = new LocalPipelineRunner(logsRoot, () => new Map([
    ["plan-backend", new MockBackend("plan-backend", ".vajra/plan.md", { writeArtifact: false })],
    ["code-backend", new MockBackend("code-backend", ".vajra/code.md")],
  ]));

  const missingArtifactResult = await missingArtifactRunner.startRun({
    issue: makeIssue("ENG-100"),
    attempt: 1,
    workflow,
    workspacePath,
  }).promise;

  assert.equal(missingArtifactResult.status, "failure");
  assert.deepEqual(missingArtifactResult.completedNodes, ["plan"]);
  assert.match(missingArtifactResult.error ?? "", /did not produce artifact/);
});

test("pipeline can be cancelled mid-stage", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-cancel-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const { workflow } = await createWorkflow({
    tempDir,
    graphSource: `
      digraph Example {
        start [shape=Mdiamond];
        exit [shape=Msquare];
        plan [label="Plan", agent="plan-backend", artifact_path=".vajra/plan.md"];
        review [label="Review", agent="review-backend", artifact_path=".vajra/review.md"];
        start -> plan -> review -> exit;
      }
    `,
  });

  const runner = new LocalPipelineRunner(logsRoot, () => new Map([
    ["plan-backend", new MockBackend("plan-backend", ".vajra/plan.md", { delayMs: 100 })],
    ["review-backend", new MockBackend("review-backend", ".vajra/review.md")],
  ]));

  const handle = runner.startRun({
    issue: makeIssue("ENG-101"),
    attempt: 0,
    workflow,
    workspacePath,
  });

  setTimeout(() => {
    void handle.cancel("cancel requested");
  }, 10);

  const result = await handle.promise;
  assert.equal(result.status, "cancelled");
});

test("pipeline tags auth failures with failureClass when the agent output matches an auth pattern", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-auth-fail-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const { workflow } = await createWorkflow({
    tempDir,
    graphSource: `
      digraph AuthFail {
        start [shape=Mdiamond];
        exit [shape=Msquare];
        plan [label="Plan", agent="plan-backend", artifact_path=".vajra/plan.md"];
        start -> plan -> exit;
      }
    `,
    backends: {
      codex: { command: "unused" },
    },
    agentDefinitions: {
      "plan-backend": {
        backend: "codex",
        model: "gpt-5.4",
        prompt: "Issue {{ issue.identifier }} stage {{ stage.id }}. Artifacts live in {{ workspace.artifacts_dir }}.",
      },
    },
  });

  const authErrorOutput = `[2026-03-30T17:27:02] ERROR: exceeded retry limit, last status: 401 Unauthorized`;

  const planBackend = new MockBackend("codex", ".vajra/plan.md", {
    exitCode: 1,
    writeArtifact: false,
    output: authErrorOutput,
  });

  const runner = new LocalPipelineRunner(logsRoot, () => new Map([
    ["codex", planBackend],
  ]));

  const result = await runner.startRun({
    issue: makeIssue("ENG-401"),
    attempt: 0,
    workflow,
    workspacePath,
  }).promise;

  assert.equal(result.status, "failure");
  assert.equal(result.failureClass, "auth");
  assert.match(result.error ?? "", /auth/);
  assert.match(result.error ?? "", /401 Unauthorized/);
});

test("pipeline tags rate-limit failures with failureClass and includes the reset hint", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-ratelimit-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const { workflow } = await createWorkflow({
    tempDir,
    graphSource: `
      digraph RateLimit {
        start [shape=Mdiamond];
        exit [shape=Msquare];
        write [label="Write", agent="plan-backend", artifact_path=".vajra/output.md"];
        start -> write -> exit;
      }
    `,
    backends: {
      claude: { command: "unused" },
    },
    agentDefinitions: {
      "plan-backend": {
        backend: "claude",
        model: "claude-sonnet-4-6",
        prompt: "Issue {{ issue.identifier }} stage {{ stage.id }}. Artifacts live in {{ workspace.artifacts_dir }}.",
      },
    },
  });

  const rateLimitOutput = '{"type":"result","subtype":"success","is_error":true,"result":"You\'ve hit your limit · resets 6pm (Europe/Berlin)"}';

  const writeBackend = new MockBackend("claude", ".vajra/output.md", {
    exitCode: 1,
    writeArtifact: false,
    output: rateLimitOutput,
  });

  const runner = new LocalPipelineRunner(logsRoot, () => new Map([
    ["claude", writeBackend],
  ]));

  const result = await runner.startRun({
    issue: makeIssue("ENG-402"),
    attempt: 0,
    workflow,
    workspacePath,
  }).promise;

  assert.equal(result.status, "failure");
  assert.equal(result.failureClass, "rate-limit");
  assert.match(result.error ?? "", /rate-limit/);
  assert.match(result.error ?? "", /6pm/);
});

test("pipeline does not set failureClass for normal stage failures", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-normal-fail-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const { workflow } = await createWorkflow({
    tempDir,
    graphSource: `
      digraph NormalFail {
        start [shape=Mdiamond];
        exit [shape=Msquare];
        code [label="Code", agent="code-backend", artifact_path=".vajra/code.md"];
        start -> code -> exit;
      }
    `,
    backends: {
      codex: { command: "unused" },
    },
    agentDefinitions: {
      "code-backend": {
        backend: "codex",
        model: "gpt-5.4",
        prompt: "Issue {{ issue.identifier }} stage {{ stage.id }}. Artifacts live in {{ workspace.artifacts_dir }}.",
      },
    },
  });

  const codeBackend = new MockBackend("codex", ".vajra/code.md", {
    exitCode: 1,
    writeArtifact: false,
    output: "npm ERR! Tests failed: 3 assertions",
  });

  const runner = new LocalPipelineRunner(logsRoot, () => new Map([
    ["codex", codeBackend],
  ]));

  const result = await runner.startRun({
    issue: makeIssue("ENG-403"),
    attempt: 0,
    workflow,
    workspacePath,
  }).promise;

  assert.equal(result.status, "failure");
  assert.equal(result.failureClass, undefined);
});

test("pipeline does not classify quoted auth text from a custom backend as terminal auth", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-auth-false-positive-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const { workflow } = await createWorkflow({
    tempDir,
    graphSource: `
      digraph FalsePositiveFail {
        start [shape=Mdiamond];
        exit [shape=Msquare];
        review [label="Review", agent="review-backend", artifact_path=".vajra/review.md"];
        start -> review -> exit;
      }
    `,
  });

  const reviewBackend = new MockBackend("review-backend", ".vajra/review.md", {
    exitCode: 1,
    writeArtifact: false,
    output: `Please update the test fixture to include "refresh_token_reused" in the example error payload.`,
  });

  const runner = new LocalPipelineRunner(logsRoot, () => new Map([
    ["review-backend", reviewBackend],
  ]));

  const result = await runner.startRun({
    issue: makeIssue("ENG-404"),
    attempt: 0,
    workflow,
    workspacePath,
  }).promise;

  assert.equal(result.status, "failure");
  assert.equal(result.failureClass, undefined);
});

test("thread-bound stages require a native-session backend", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-threads-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const { workflow } = await createWorkflow({
    tempDir,
    graphSource: `
      digraph Threaded {
        start [shape=Mdiamond];
        exit [shape=Msquare];
        plan [label="Plan", agent="plan-backend", thread="planning", artifact_path=".vajra/run/plan.md"];
        start -> plan -> exit;
      }
    `,
    agentDefinitions: {
      "plan-backend": {
        backend: "plan-backend",
        model: "gpt-5.4",
        prompt: "Write the plan at .vajra/run/plan.md.",
      },
    },
  });

  const planBackend = new MockBackend("plan-backend", ".vajra/run/plan.md");
  const runner = new LocalPipelineRunner(logsRoot, () => new Map([["plan-backend", planBackend]]));

  const result = await runner.startRun({
    issue: makeIssue("ENG-THREAD"),
    attempt: 0,
    workflow,
    workspacePath,
  }).promise;

  assert.equal(result.status, "failure");
  assert.match(result.error ?? "", /requires a native-session backend/i);
  assert.equal(planBackend.calls.length, 0);
});

test("thread-bound stages start and resume native sessions when the backend supports them", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-native-session-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const { workflow } = await createWorkflow({
    tempDir,
    graphSource: `
      digraph NativeThreaded {
        start [shape=Mdiamond];
        exit [shape=Msquare];
        plan [label="Plan", agent="plan-backend", thread="planning", artifact_path=".vajra/run/plan.md"];
        review [label="Review", agent="review-backend", artifact_path=".vajra/run/plan-review.md"];
        start -> plan -> review;
        review -> plan [on_label="revise"];
        review -> exit [on_label="lgtm"];
      }
    `,
    agentDefinitions: {
      "plan-backend": {
        backend: "claude",
        model: "claude-opus-4-6",
        prompt: "Write or revise the plan at .vajra/run/plan.md.",
      },
      "review-backend": {
        backend: "review-backend",
        model: "gpt-5.4",
        prompt: "Review .vajra/run/plan.md and write .vajra/run/plan-review.md.",
      },
    },
  });

  const planBackend = new MockBackend("claude", ".vajra/run/plan.md", {
    supportsNativeSessions: true,
    writeArtifact: false,
    sessionIdForCall: ({ createSession, sessionId }) => createSession ? "planning-session" : sessionId,
    onExecute: async ({ workspace, callIndex }) => {
      await mkdir(path.join(workspace, ".vajra", "run"), { recursive: true });
      await writeFile(
        path.join(workspace, ".vajra", "run", "plan.md"),
        `plan version ${callIndex}`,
        "utf8",
      );
    },
  });
  const reviewBackend = new MockBackend("review-backend", ".vajra/run/plan-review.md", {
    writeArtifact: false,
    onExecute: async ({ workspace, callIndex }) => {
      await mkdir(path.join(workspace, ".vajra", "run", "stages", "review"), { recursive: true });
      await writeFile(path.join(workspace, ".vajra", "run", "plan-review.md"), callIndex === 1 ? "Revise." : "LGTM.", "utf8");
      await writeFile(
        path.join(workspace, ".vajra", "run", "stages", "review", "result.json"),
        JSON.stringify({ label: callIndex === 1 ? "revise" : "lgtm" }),
        "utf8",
      );
    },
  });

  const runner = new LocalPipelineRunner(logsRoot, () => new Map([
    ["claude", planBackend],
    ["review-backend", reviewBackend],
  ]));

  const result = await runner.startRun({
    issue: makeIssue("ENG-NATIVE"),
    attempt: 0,
    workflow,
    workspacePath,
  }).promise;

  assert.equal(result.status, "success");
  assert.equal(planBackend.calls.length, 2);
  assert.deepEqual(planBackend.createSessionFlags, [true, false]);
  assert.deepEqual(planBackend.sessionIds, [undefined, "planning-session"]);
  assert.doesNotMatch(planBackend.calls[1], /Thread Continuation/);

  const session = JSON.parse(
    await readFile(path.join(workspacePath, ".vajra", "run", "threads", "planning", "session.json"), "utf8"),
  ) as { sessionId: string; backend: string; model: string };
  assert.deepEqual(session, {
    sessionId: "planning-session",
    backend: "claude",
    model: "claude-opus-4-6",
    createdAt: session.createdAt,
  });
});

test("threaded native sessions start a fresh session when the saved model no longer matches", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-native-mismatch-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace");
  const { workflow, artifactsRoot } = await createWorkflow({
    tempDir,
    graphSource: `
      digraph Mismatch {
        start [shape=Mdiamond];
        exit [shape=Msquare];
        plan [label="Plan", agent="plan-backend", thread="planning", artifact_path=".vajra/run/plan.md"];
        start -> plan -> exit;
      }
    `,
    agentDefinitions: {
      "plan-backend": {
        backend: "claude",
        model: "claude-sonnet-4-6",
        prompt: "Write or revise the plan at .vajra/run/plan.md.",
      },
    },
  });
  const threadDir = path.join(artifactsRoot, "ENG-MISMATCH", "run", "threads", "planning");
  await mkdir(threadDir, { recursive: true });
  await writeFile(
    path.join(threadDir, "session.json"),
    JSON.stringify({
      sessionId: "stale-session",
      backend: "claude",
      model: "claude-opus-4-6",
      createdAt: "2026-03-30T10:00:00Z",
    }),
    "utf8",
  );

  const planBackend = new MockBackend("claude", ".vajra/run/plan.md", {
    supportsNativeSessions: true,
    writeArtifact: false,
    sessionIdForCall: ({ createSession }) => createSession ? "fresh-session" : undefined,
    onExecute: async ({ workspace }) => {
      await mkdir(path.join(workspace, ".vajra", "run"), { recursive: true });
      await writeFile(path.join(workspace, ".vajra", "run", "plan.md"), "fresh plan", "utf8");
    },
  });

  const runner = new LocalPipelineRunner(logsRoot, () => new Map([["claude", planBackend]]));
  const result = await runner.startRun({
    issue: makeIssue("ENG-MISMATCH"),
    attempt: 0,
    workflow,
    workspacePath,
  }).promise;

  assert.equal(result.status, "success");
  assert.deepEqual(planBackend.createSessionFlags, [true]);
  assert.doesNotMatch(planBackend.calls[0], /Thread Continuation/);

  const session = JSON.parse(
    await readFile(path.join(threadDir, "session.json"), "utf8"),
  ) as { sessionId: string; model: string };
  assert.equal(session.sessionId, "fresh-session");
  assert.equal(session.model, "claude-sonnet-4-6");
});

test("invalid native sessions are cleared before the stage failure is finalized", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-native-invalid-session-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace");
  const { workflow, artifactsRoot } = await createWorkflow({
    tempDir,
    graphSource: `
      digraph InvalidSession {
        start [shape=Mdiamond];
        exit [shape=Msquare];
        plan [label="Plan", agent="plan-backend", thread="planning", artifact_path=".vajra/run/plan.md"];
        start -> plan -> exit;
      }
    `,
    agentDefinitions: {
      "plan-backend": {
        backend: "claude",
        model: "claude-opus-4-6",
        prompt: "Write or revise the plan at .vajra/run/plan.md.",
      },
    },
  });
  const threadDir = path.join(artifactsRoot, "ENG-INVALID", "run", "threads", "planning");
  await mkdir(threadDir, { recursive: true });
  await writeFile(
    path.join(threadDir, "session.json"),
    JSON.stringify({
      sessionId: "missing-session",
      backend: "claude",
      model: "claude-opus-4-6",
      createdAt: "2026-03-30T10:00:00Z",
    }),
    "utf8",
  );

  const planBackend = new MockBackend("claude", ".vajra/run/plan.md", {
    supportsNativeSessions: true,
    exitCode: 1,
    writeArtifact: false,
    output: "No conversation found with session ID: missing-session",
    invalidateSessionForCall: () => true,
  });

  const runner = new LocalPipelineRunner(logsRoot, () => new Map([["claude", planBackend]]));
  const result = await runner.startRun({
    issue: makeIssue("ENG-INVALID"),
    attempt: 0,
    workflow,
    workspacePath,
  }).promise;

  assert.equal(result.status, "failure");
  assert.deepEqual(planBackend.createSessionFlags, [false]);
  assert.deepEqual(planBackend.sessionIds, ["missing-session"]);
  await assert.rejects(
    readFile(path.join(threadDir, "session.json"), "utf8"),
    /ENOENT/,
  );
});

test("pipeline exits with wait_human when routed to a human-review exit node", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-wait-human-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const { workflow } = await createWorkflow({
    tempDir,
    graphSource: `
      digraph Escalation {
        start [shape=Mdiamond];
        exit [shape=Msquare];
        escalate [shape=Msquare, exit_reason="human_review"];
        plan [label="Plan", agent="plan-backend", artifact_path=".vajra/run/plan.md"];
        review [label="Review", agent="review-backend", artifact_path=".vajra/run/plan-review.md"];
        start -> plan -> review;
        review -> exit [on_label="lgtm"];
        review -> escalate [on_label="escalate"];
      }
    `,
  });

  const planBackend = new MockBackend("plan-backend", ".vajra/run/plan.md", {
    writeArtifact: false,
    onExecute: async ({ workspace }) => {
      await mkdir(path.join(workspace, ".vajra", "run"), { recursive: true });
      await writeFile(path.join(workspace, ".vajra", "run", "plan.md"), "plan", "utf8");
    },
  });
  const reviewBackend = new MockBackend("review-backend", ".vajra/run/plan-review.md", {
    writeArtifact: false,
    onExecute: async ({ workspace }) => {
      await mkdir(path.join(workspace, ".vajra", "run"), { recursive: true });
      await writeFile(path.join(workspace, ".vajra", "run", "plan-review.md"), "Escalate this.", "utf8");
      await mkdir(path.join(workspace, ".vajra", "run", "stages", "review"), { recursive: true });
      await writeFile(
        path.join(workspace, ".vajra", "run", "stages", "review", "result.json"),
        JSON.stringify({ label: "escalate" }),
        "utf8",
      );
    },
  });

  const runner = new LocalPipelineRunner(logsRoot, () => new Map([
    ["plan-backend", planBackend],
    ["review-backend", reviewBackend],
  ]));

  const result = await runner.startRun({
    issue: makeIssue("ENG-HUMAN"),
    attempt: 0,
    workflow,
    workspacePath,
  }).promise;

  assert.equal(result.status, "wait_human");
  assert.match(result.error ?? "", /human review/i);
});

test("pipeline executes fan_out collections and fan_in selection", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-pipeline-fanout-"));
  const logsRoot = path.join(tempDir, "logs");
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const { workflow } = await createWorkflow({
    tempDir,
    graphSource: `
      digraph FanOut {
        start [shape=Mdiamond];
        exit [shape=Msquare];
        brainstorm [type="fan_out", label="Brainstorm", collection="plan_candidates", artifact_path=".vajra/run/plan.md"];
        select [type="fan_in", label="Select", agent="review-backend", collection="plan_candidates", artifact_path=".vajra/run/selected-plan.md"];
        start -> brainstorm -> select;
        select -> exit [on_label="best_candidate"];
      }
    `,
    fanOut: {
      plan_candidates: {
        stage: "brainstorm",
        maxParallel: 2,
        completionPolicy: "wait_all",
        variants: [
          { id: "conservative", agent: "plan-backend", instructions: "Produce a conservative plan." },
          { id: "aggressive", agent: "plan-backend", instructions: "Produce a fast-shipping plan." },
        ],
      },
    },
    agentDefinitions: {
      "plan-backend": {
        backend: "plan-backend",
        model: "gpt-5.4",
        prompt: "Collection {{ collection.id }} candidate {{ collection.candidate_id }} artifact {{ collection.primary_artifact }}",
      },
      "review-backend": {
        backend: "review-backend",
        model: "gpt-5.4",
        prompt: "Review {{ collection.id }} candidates {{ collection.candidates[0].id }} and {{ collection.candidates[1].id }}.",
      },
    },
  });

  const planBackend = new MockBackend("plan-backend", ".unused", {
    writeArtifact: false,
    onExecute: async ({ workspace, prompt }) => {
      const artifactMatch = prompt.match(/artifact\s+([^\s]+)/);
      assert.ok(artifactMatch?.[1]);
      const artifactPath = path.join(workspace, artifactMatch[1]);
      await mkdir(path.dirname(artifactPath), { recursive: true });
      await writeFile(artifactPath, prompt.includes("aggressive") ? "aggressive plan" : "conservative plan", "utf8");
    },
  });
  const reviewBackend = new MockBackend("review-backend", ".vajra/run/selected-plan.md", {
    onExecute: async ({ workspace, prompt }) => {
      assert.match(prompt, /conservative/);
      assert.match(prompt, /aggressive/);
      await writeFile(path.join(workspace, ".vajra", "run", "selected-plan.md"), "selected conservative", "utf8");
      await mkdir(path.join(workspace, ".vajra", "run", "stages", "select"), { recursive: true });
      await writeFile(
        path.join(workspace, ".vajra", "run", "stages", "select", "result.json"),
        JSON.stringify({
          label: "best_candidate",
          facts: { chosen_candidate_id: "conservative" },
        }),
        "utf8",
      );
    },
  });

  const runner = new LocalPipelineRunner(logsRoot, () => new Map([
    ["plan-backend", planBackend],
    ["review-backend", reviewBackend],
  ]));

  const result = await runner.startRun({
    issue: makeIssue("ENG-FANOUT"),
    attempt: 0,
    workflow,
    workspacePath,
  }).promise;

  assert.equal(result.status, "success");
  const manifest = JSON.parse(
    await readFile(path.join(workspacePath, ".vajra", "run", "collections", "plan_candidates", "manifest.json"), "utf8"),
  ) as {
    candidates: Array<{ id: string; status: string; artifacts: Record<string, string> }>;
  };
  assert.deepEqual(manifest.candidates.map((candidate) => candidate.id).sort(), ["aggressive", "conservative"]);
  assert.ok(manifest.candidates.every((candidate) => candidate.status === "success"));
});

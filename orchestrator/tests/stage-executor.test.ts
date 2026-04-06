import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";

import { CommandResult, CommandRunner } from "../src/process";
import { PipelineStageExecutor } from "../src/stage-executor";
import { AgentBackend, GraphNode } from "../src/types";

class StubCommandRunner implements CommandRunner {
  readonly commands: string[] = [];
  readonly opts: Array<{
    cwd: string;
    timeoutMs?: number;
    killGraceMs?: number;
    env?: Record<string, string>;
    signal?: AbortSignal;
  }> = [];

  constructor(private readonly onRun: (command: string) => Promise<CommandResult> | CommandResult) {}

  async run(command: string, opts: {
    cwd: string;
    timeoutMs?: number;
    killGraceMs?: number;
    env?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<CommandResult> {
    this.commands.push(command);
    this.opts.push(opts);
    return this.onRun(command);
  }
}

class StubBackend implements AgentBackend {
  readonly name = "stub-backend";
  lastExecuteOpts: {
    workspace: string;
    prompt: string;
    model?: string;
    reasoningEffort?: string;
    createSession?: boolean;
    sessionId?: string;
    timeoutMs?: number;
  } | null = null;

  constructor(private readonly onExecute?: (workspace: string) => Promise<void> | void) {}

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
    this.lastExecuteOpts = {
      workspace: opts.workspace,
      prompt: opts.prompt,
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
      createSession: opts.createSession,
      sessionId: opts.sessionId,
      timeoutMs: opts.timeoutMs,
    };
    await this.onExecute?.(opts.workspace);
    return {
      output: "stage ok",
      exitCode: 0,
      durationMs: 1,
    };
  }
}

function stageNode(id = "plan"): GraphNode {
  return {
    id,
    type: "agent",
    attrs: {
      label: "Plan",
      agent: "stub-backend",
      artifact_path: ".vajra/plan.md",
    },
  };
}

function toolNode(id: string, command: string): GraphNode {
  return {
    id,
    type: "tool",
    attrs: {
      label: id,
      command,
    },
  };
}

async function withGlobalFetch<T>(fetchImpl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("inspectWorkspacePullRequest returns PR metadata when gh reports an open PR", async () => {
  const commandRunner = new StubCommandRunner(async (command) => {
    assert.match(command, /gh pr view --json url,title,number,headRefName,headRefOid,additions,deletions,state/);
    return {
      stdout: JSON.stringify({
        url: "https://github.com/acme-corp/acme-app/pull/301",
        title: "ENG-1 PR",
        number: 301,
        headRefName: "eng-1",
        headRefOid: "abc123",
        additions: 12,
        deletions: 4,
        state: "OPEN",
      }),
      stderr: "",
      exitCode: 0,
      durationMs: 1,
    };
  });
  const executor = new PipelineStageExecutor(commandRunner);

  const pr = await executor.inspectWorkspacePullRequest("/tmp/workspace");

  assert.deepEqual(pr, {
    url: "https://github.com/acme-corp/acme-app/pull/301",
    title: "ENG-1 PR",
    number: 301,
    headRefName: "eng-1",
    headSha: "abc123",
    additions: 12,
    deletions: 4,
    state: "OPEN",
  });
  assert.equal(commandRunner.opts[0]?.timeoutMs, 10_000);
});

test("inspectWorkspacePullRequest returns null when no PR exists", async () => {
  const executor = new PipelineStageExecutor(new StubCommandRunner(async () => ({
    stdout: "{}",
    stderr: "",
    exitCode: 0,
    durationMs: 1,
  })));

  const pr = await executor.inspectWorkspacePullRequest("/tmp/workspace");

  assert.equal(pr, null);
});

test("inspectWorkspacePullRequest is a graceful no-op when gh is unavailable", async () => {
  const warnings: string[] = [];
  const originalConsoleError = console.error;
  console.error = (message?: unknown) => {
    warnings.push(String(message ?? ""));
  };

  try {
    const executor = new PipelineStageExecutor(new StubCommandRunner(async () => {
      throw new Error("spawn gh ENOENT");
    }));

    const pr = await executor.inspectWorkspacePullRequest("/tmp/workspace");

    assert.equal(pr, null);
    assert.ok(warnings.some((entry) => entry.includes("workspace pull request inspection failed")));
  } finally {
    console.error = originalConsoleError;
  }
});

test("executeStage does not run workspace PR inspection during stage execution", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-stage-executor-stage-only-"));
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const commandRunner = new StubCommandRunner(async () => {
    throw new Error("unexpected command");
  });
  const executor = new PipelineStageExecutor(commandRunner);
  const backends = new Map<string, AgentBackend>([
    ["stub-backend", new StubBackend(async (workspace) => {
      await mkdir(path.join(workspace, ".vajra"), { recursive: true });
      await writeFile(path.join(workspace, ".vajra", "plan.md"), "plan", "utf8");
      await mkdir(path.join(workspace, ".vajra", "run", "stages", "plan"), { recursive: true });
      await writeFile(
        path.join(workspace, ".vajra", "run", "stages", "plan", "result.json"),
        JSON.stringify({ branch: "feature/ENG-1" }),
        "utf8",
      );
    })],
  ]);

  const result = await executor.executeStage({
    stage: stageNode(),
    prompt: "Prompt",
    workspacePath,
    signal: new AbortController().signal,
    backends,
    scope: {},
    resolvedAgent: {
      backendName: "stub-backend",
      model: "gpt-5.4",
    },
  });

  const metadata = await executor.loadStageMetadata({
    stageId: "plan",
    workspacePath,
    workspaceArtifactsDir: ".vajra/run",
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(commandRunner.commands, []);
  assert.deepEqual(metadata, { branch: "feature/ENG-1" });
});

test("loadStageResult extracts label and facts while preserving prompt-friendly metadata", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-stage-executor-outcome-"));
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(path.join(workspacePath, ".vajra", "run", "stages", "review"), { recursive: true });
  await writeFile(
    path.join(workspacePath, ".vajra", "run", "stages", "review", "result.json"),
    JSON.stringify({
      label: "revise",
      notes: "Needs another pass.",
      facts: {
        score: 2,
        blocker_count: 1,
      },
      branch: "feature/ENG-9",
      artifacts: {
        findings: path.join(workspacePath, ".vajra", "review-findings.md"),
      },
    }),
    "utf8",
  );

  const executor = new PipelineStageExecutor(new StubCommandRunner(async () => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
    durationMs: 1,
  })));

  const result = await executor.loadStageResult({
    stageId: "review",
    workspacePath,
    workspaceArtifactsDir: ".vajra/run",
    exitCode: 0,
  });

  assert.deepEqual(result.metadata, {
    branch: "feature/ENG-9",
    score: 2,
    blocker_count: 1,
  });
  assert.equal(result.outcome.label, "revise");
  assert.equal(result.outcome.status, "success");
  assert.equal(result.outcome.notes, "Needs another pass.");
  assert.deepEqual(result.outcome.facts, {
    branch: "feature/ENG-9",
    score: 2,
    blocker_count: 1,
  });
  assert.deepEqual(result.outcome.artifacts, {
    findings: ".vajra/review-findings.md",
  });
});

test("executeStage forwards resolved reasoning effort to the backend", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-stage-executor-reasoning-"));
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const backend = new StubBackend();
  const executor = new PipelineStageExecutor(new StubCommandRunner(async () => {
    throw new Error("unexpected tool command");
  }));

  await executor.executeStage({
    stage: stageNode(),
    prompt: "Prompt",
    workspacePath,
    signal: new AbortController().signal,
    backends: new Map<string, AgentBackend>([["stub-backend", backend]]),
    scope: {},
    resolvedAgent: {
      backendName: "stub-backend",
      model: "claude-opus-4-6",
      reasoningEffort: "high",
    },
  });

  assert.equal(backend.lastExecuteOpts?.model, "claude-opus-4-6");
  assert.equal(backend.lastExecuteOpts?.reasoningEffort, "high");
});

test("executeStage forwards native session start and resume options to the backend", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-stage-executor-session-"));
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath, { recursive: true });

  const backend = new StubBackend();
  const executor = new PipelineStageExecutor(new StubCommandRunner(async () => {
    throw new Error("unexpected tool command");
  }));

  await executor.executeStage({
    stage: stageNode(),
    prompt: "Prompt",
    workspacePath,
    workspaceArtifactsDir: ".vajra/run",
    signal: new AbortController().signal,
    backends: new Map<string, AgentBackend>([["stub-backend", backend]]),
    scope: {},
    resolvedAgent: {
      backendName: "stub-backend",
      model: "claude-opus-4-6",
    },
    createSession: true,
  });
  assert.equal(backend.lastExecuteOpts?.createSession, true);
  assert.equal(backend.lastExecuteOpts?.sessionId, undefined);

  await executor.executeStage({
    stage: stageNode(),
    prompt: "Prompt again",
    workspacePath,
    workspaceArtifactsDir: ".vajra/run",
    signal: new AbortController().signal,
    backends: new Map<string, AgentBackend>([["stub-backend", backend]]),
    scope: {},
    resolvedAgent: {
      backendName: "stub-backend",
      model: "claude-opus-4-6",
    },
    sessionId: "session-123",
  });
  assert.equal(backend.lastExecuteOpts?.createSession, undefined);
  assert.equal(backend.lastExecuteOpts?.sessionId, "session-123");
});

test("executeStage can publish a PR through the built-in vajra publish-pr tool", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-stage-executor-publish-pr-"));
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(path.join(workspacePath, ".vajra", "run"), { recursive: true });
  await writeFile(path.join(workspacePath, ".vajra", "pr-title.txt"), "ENG-1: Ship it", "utf8");
  await writeFile(path.join(workspacePath, ".vajra", "run", "pr-body.md"), "Summary", "utf8");

  const commandRunner = new StubCommandRunner(async (command) => {
    assert.match(command, /git branch --show-current/);
    return {
      stdout: "vajra/eng-1\n",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
    };
  });
  const executor = new PipelineStageExecutor(commandRunner);

  await withGlobalFetch(async (input, init) => {
    const url = String(input);
    if (url.includes("/pulls?state=open")) {
      return new Response("[]", { status: 200 });
    }
    if (url.endsWith("/pulls") && init?.method === "POST") {
      return new Response(JSON.stringify({
        html_url: "https://github.com/acme-corp/acme-app/pull/321",
        title: "ENG-1: Ship it",
        number: 321,
        head: {
          ref: "vajra/eng-1",
          sha: "abc123",
        },
        state: "open",
      }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await executor.executeStage({
      stage: toolNode("publish_pr", "vajra publish-pr --title-file .vajra/pr-title.txt --body-file .vajra/run/pr-body.md --base main"),
      prompt: "",
      workspacePath,
      workspaceArtifactsDir: ".vajra/run",
      signal: new AbortController().signal,
      backends: new Map(),
      scope: {},
      githubConfig: {
        repository: "acme-corp/acme-app",
        apiKey: "token",
        webhookSecret: "secret",
        revisionLabel: "vajra-revision",
        revisionCommand: "/vajra revise",
        revisionState: "In Progress",
        mergedState: "Done",
        closedState: null,
      },
    });

    assert.equal(result.exitCode, 0);
  });

  const loaded = await executor.loadStageResult({
    stageId: "publish_pr",
    workspacePath,
    workspaceArtifactsDir: ".vajra/run",
    exitCode: 0,
  });
  assert.equal(loaded.outcome.status, "success");
  assert.deepEqual(loaded.outcome.facts, {
    pr: {
      url: "https://github.com/acme-corp/acme-app/pull/321",
      title: "ENG-1: Ship it",
      number: 321,
      headRefName: "vajra/eng-1",
      state: "open",
    },
    pr_number: 321,
    pr_url: "https://github.com/acme-corp/acme-app/pull/321",
    pr_action: "created",
  });
});

test("executeStage reuses an existing PR through the built-in vajra publish-pr tool", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-stage-executor-reuse-pr-"));
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(path.join(workspacePath, ".vajra", "run"), { recursive: true });
  await writeFile(path.join(workspacePath, ".vajra", "pr-title.txt"), "ENG-2: Reuse it", "utf8");
  await writeFile(path.join(workspacePath, ".vajra", "run", "pr-body.md"), "Summary", "utf8");

  const commandRunner = new StubCommandRunner(async () => ({
    stdout: "vajra/eng-2\n",
    stderr: "",
    exitCode: 0,
    durationMs: 1,
  }));
  const executor = new PipelineStageExecutor(commandRunner);

  await withGlobalFetch(async (input, init) => {
    const url = String(input);
    if (url.includes("/pulls?state=open")) {
      return new Response(JSON.stringify([{
        number: 654,
        html_url: "https://github.com/acme-corp/acme-app/pull/654",
        head: { ref: "vajra/eng-2" },
        base: { ref: "main" },
      }]), { status: 200 });
    }
    if (url.endsWith("/pulls/654") && init?.method === "PATCH") {
      return new Response(JSON.stringify({
        html_url: "https://github.com/acme-corp/acme-app/pull/654",
        title: "ENG-2: Reuse it",
        number: 654,
        head: {
          ref: "vajra/eng-2",
          sha: "def456",
        },
        state: "open",
      }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async () => {
    const result = await executor.executeStage({
      stage: toolNode("publish_pr", "vajra publish-pr --title-file .vajra/pr-title.txt --body-file .vajra/run/pr-body.md --base main"),
      prompt: "",
      workspacePath,
      workspaceArtifactsDir: ".vajra/run",
      signal: new AbortController().signal,
      backends: new Map(),
      scope: {},
      githubConfig: {
        repository: "acme-corp/acme-app",
        apiKey: "token",
        webhookSecret: "secret",
        revisionLabel: "vajra-revision",
        revisionCommand: "/vajra revise",
        revisionState: "In Progress",
        mergedState: "Done",
        closedState: null,
      },
    });

    assert.equal(result.exitCode, 0);
  });

  const loaded = await executor.loadStageResult({
    stageId: "publish_pr",
    workspacePath,
    workspaceArtifactsDir: ".vajra/run",
    exitCode: 0,
  });
  assert.equal(loaded.outcome.facts.pr_action, "reused");
  assert.equal(loaded.outcome.facts.pr_number, 654);
});

test("collectArtifacts ignores zero-byte primary artifacts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-stage-executor-empty-artifact-"));
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(path.join(workspacePath, ".vajra"), { recursive: true });
  await writeFile(path.join(workspacePath, ".vajra", "plan.md"), "", "utf8");

  const executor = new PipelineStageExecutor(new StubCommandRunner(async () => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
    durationMs: 1,
  })));

  const artifacts = await executor.collectArtifacts(stageNode(), workspacePath, ".vajra/run/stages/plan/output.txt");

  assert.deepEqual(artifacts, {
    primary: "",
    output: ".vajra/run/stages/plan/output.txt",
  });
});

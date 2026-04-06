import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  loadWorkflowFile,
} from "../src/workflow";
import {
  renderCommandTemplate,
  renderConditionTemplate,
  renderPromptTemplate,
} from "../src/template";
import { resolveIssueWorkflow } from "../src/workflow-routing";
import { Issue } from "../src/types";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "1",
    identifier: "ENG-42",
    title: "Example",
    description: "Example description",
    state: "Todo",
    priority: 1,
    labels: [],
    assigneeId: "vajra-uuid",
    creatorId: null,
    createdAt: null,
    updatedAt: null,
    url: null,
    blockedBy: [],
    ...overrides,
  };
}

async function writeDotFiles(tempDir: string, files: Record<string, string>): Promise<void> {
  const pipelinesDir = path.join(tempDir, "pipelines");
  await mkdir(pipelinesDir, { recursive: true });

  await Promise.all(
    Object.entries(files).map(async ([name, source]) => {
      await writeFile(path.join(pipelinesDir, name), source, "utf8");
    }),
  );
}

function singleAgentGraph(agent = "planner"): string {
  return `digraph Example {
    start [shape=Mdiamond];
    exit [shape=Msquare];
    plan [label="Plan", agent="${agent}", artifact_path=".vajra/plan.md"];
    start -> plan -> exit;
  }`;
}

test("loadWorkflowFile parses backends, agents, workflows, and routing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-workflow-"));
  await writeDotFiles(tempDir, {
    "default.dot": singleAgentGraph("planner"),
    "bug.dot": singleAgentGraph("bug-planner"),
    "check.dot": singleAgentGraph("planner"),
  });

  const workflowPath = path.join(tempDir, "WORKFLOW.md");
  await writeFile(
    workflowPath,
    `---
tracker:
  kind: linear
  api_key: test-token
  assignee_id: vajra-uuid
execution:
  max_concurrent_agents: 2
  max_retry_attempts: 4
  max_retry_backoff_ms: 45000
  max_concurrent_agents_by_state:
    todo: 2
workflows:
  bug:
    dot_file: ./pipelines/bug.dot
    success_state: "Ready for QA"
    inspect_pr: false
  check:
    dot_file: ./pipelines/check.dot
  default:
    dot_file: ./pipelines/default.dot
workflow_routing:
  default_workflow: default
  by_label:
    workflow:check: check
artifacts:
  root: ./plans/issues
  workspace_dir: .vajra
github:
  repository: acme-corp/acme-app
  api_key: github-test-token
  webhook_secret: github-test-secret
  revision_label: vajra-revision
  revision_command: /vajra revise
  revision_state: Review Changes
  merged_state: Done
  closed_state: Todo
backends:
  claude:
    command: "claude -p {{ prompt | shellquote }}"
  codex:
    command: "codex exec {{ prompt | shellquote }}"
agents:
  planner:
    backend: claude
    model: claude-opus-4-6
    reasoning_effort: max
    prompt: "Plan {{ issue.identifier }}"
    timeout_ms: 2000
  bug-planner:
    backend: codex
    model: gpt-5.4
    reasoning_effort: high
    prompt: "Handle bug {{ issue.identifier }}"
---
`,
    "utf8",
  );

  const workflow = await loadWorkflowFile(workflowPath);

  assert.equal(workflow.config.workflows.default.dotFile, path.join(tempDir, "pipelines", "default.dot"));
  assert.equal(workflow.config.workflows.bug.dotFile, path.join(tempDir, "pipelines", "bug.dot"));
  assert.equal(workflow.config.workflows.bug.successState, "Ready for QA");
  assert.equal(workflow.config.workflows.bug.inspectPr, false);
  assert.equal(workflow.config.workflows.default.successState, "Done");
  assert.equal(workflow.config.workflows.default.inspectPr, true);
  assert.equal(workflow.config.workflowRouting.defaultWorkflow, "default");
  assert.equal(workflow.config.workflowRouting.byLabel["workflow:check"], "check");
  assert.equal(workflow.config.execution.maxConcurrentAgents, 2);
  assert.equal(workflow.config.execution.maxRetryAttempts, 4);
  assert.equal(workflow.config.execution.maxRetryBackoffMs, 45_000);
  assert.equal(workflow.config.execution.maxConcurrentAgentsByState.todo, 2);
  assert.equal(workflow.config.artifacts.root, path.join(tempDir, "plans", "issues"));
  assert.equal(workflow.config.artifacts.workspaceDir, ".vajra");
  assert.equal(workflow.config.github?.repository, "acme-corp/acme-app");
  assert.equal(workflow.config.github?.apiKey, "github-test-token");
  assert.equal(workflow.config.github?.webhookSecret, "github-test-secret");
  assert.equal(workflow.config.github?.revisionLabel, "vajra-revision");
  assert.equal(workflow.config.github?.revisionCommand, "/vajra revise");
  assert.equal(workflow.config.github?.revisionState, "Review Changes");
  assert.equal(workflow.config.github?.mergedState, "Done");
  assert.equal(workflow.config.github?.closedState, "Todo");
  assert.equal(workflow.config.backends.claude.command, "claude -p {{ prompt | shellquote }}");
  assert.equal(workflow.config.agents.planner.backend, "claude");
  assert.equal(workflow.config.agents.planner.model, "claude-opus-4-6");
  assert.equal(workflow.config.agents.planner.reasoningEffort, "max");
  assert.equal(workflow.config.agents.planner.timeoutMs, 2000);
  assert.equal(
    await renderPromptTemplate(workflow.config.agents.planner.prompt, {
      issue: { identifier: "ENG-42" },
    }),
    "Plan ENG-42",
  );
});

// Removed: "repository WORKFLOW config" test — repo-specific, references private WORKFLOW.md

test("loadWorkflowFile applies backend-specific model and effort defaults for agents", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-workflow-agent-defaults-"));
  await writeDotFiles(tempDir, {
    "default.dot": singleAgentGraph("planner"),
  });

  const workflowPath = path.join(tempDir, "WORKFLOW.md");
  await writeFile(
    workflowPath,
    `---
tracker:
  kind: linear
  api_key: test-token
  assignee_id: vajra-uuid
workflows:
  default:
    dot_file: ./pipelines/default.dot
workflow_routing:
  default_workflow: default
backends:
  claude:
    command: "claude --model {{ model }} --effort {{ reasoning_effort }} -p {{ prompt | shellquote }}"
  codex:
    command: "codex exec --model {{ model }} -c reasoning_effort={{ reasoning_effort }} {{ prompt | shellquote }}"
agents:
  planner:
    backend: claude
    prompt: "Plan"
  reviewer:
    backend: codex
    prompt: "Review"
---
`,
    "utf8",
  );

  const workflow = await loadWorkflowFile(workflowPath);

  assert.equal(workflow.config.agents.planner.model, "claude-opus-4-6");
  assert.equal(workflow.config.agents.planner.reasoningEffort, "high");
  assert.equal(workflow.config.agents.reviewer.model, "gpt-5.4");
  assert.equal(workflow.config.agents.reviewer.reasoningEffort, "xhigh");
});

test("loadWorkflowFile parses triage config against configured backends", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-workflow-triage-"));
  await writeDotFiles(tempDir, {
    "default.dot": singleAgentGraph("planner"),
  });

  const workflowPath = path.join(tempDir, "WORKFLOW.md");
  await writeFile(
    workflowPath,
    `---
tracker:
  kind: linear
  api_key: test-token
  assignee_id: vajra-uuid
triage:
  enabled: true
  backend: claude
  model: claude-opus-4-6
  reasoning_effort: high
  timeout_ms: 15000
workflows:
  default:
    dot_file: ./pipelines/default.dot
workflow_routing:
  default_workflow: default
backends:
  claude:
    command: "claude --model {{ model }} --effort {{ reasoning_effort }} -p {{ prompt | shellquote }}"
agents:
  planner:
    backend: claude
    prompt: "Plan"
---
`,
    "utf8",
  );

  const workflow = await loadWorkflowFile(workflowPath);
  assert.deepEqual(workflow.config.triage, {
    enabled: true,
    backend: "claude",
    model: "claude-opus-4-6",
    reasoningEffort: "high",
    timeoutMs: 15_000,
  });
});

test("loadWorkflowFile rejects unsupported reasoning effort for a known backend", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-workflow-effort-validation-"));
  await writeDotFiles(tempDir, {
    "default.dot": singleAgentGraph("planner"),
  });

  const workflowPath = path.join(tempDir, "WORKFLOW.md");
  await writeFile(
    workflowPath,
    `---
tracker:
  kind: linear
  api_key: test-token
  assignee_id: vajra-uuid
workflows:
  default:
    dot_file: ./pipelines/default.dot
workflow_routing:
  default_workflow: default
backends:
  claude:
    command: "claude --model {{ model }} --effort {{ reasoning_effort }} -p {{ prompt | shellquote }}"
agents:
  planner:
    backend: claude
    prompt: "Plan"
    reasoning_effort: turbo
---
`,
    "utf8",
  );

  await assert.rejects(
    loadWorkflowFile(workflowPath),
    /reasoning_effort must be one of low, medium, high, max/,
  );
});

test("renderPromptTemplate stays lenient while command and condition templates stay strict", async () => {
  assert.equal(
    await renderPromptTemplate("Plan {{ issue.identifier }} {{ issue.missing_field }}", {
      issue: { identifier: "ENG-42" },
    }),
    "Plan ENG-42 ",
  );

  await assert.rejects(
    renderCommandTemplate("{{ issue.missing_field }}", {
      issue: { identifier: "ENG-42" },
    }),
    /missing_field/,
  );

  await assert.rejects(
    renderConditionTemplate("{{ issue.missing_field }}", {
      issue: { identifier: "ENG-42" },
    }),
    /missing_field/,
  );
});

test("resolveIssueWorkflow uses explicit label routes and otherwise falls back to the default workflow", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-workflow-routing-"));
  await writeDotFiles(tempDir, {
    "default.dot": singleAgentGraph(),
    "bug.dot": singleAgentGraph("bug-planner"),
    "check.dot": singleAgentGraph(),
  });

  const workflowPath = path.join(tempDir, "WORKFLOW.md");
  await writeFile(
    workflowPath,
    `---
tracker:
  kind: linear
  api_key: test-token
  assignee_id: vajra-uuid
workflows:
  bug:
    dot_file: ./pipelines/bug.dot
  check:
    dot_file: ./pipelines/check.dot
  default:
    dot_file: ./pipelines/default.dot
workflow_routing:
  default_workflow: default
  by_label:
    workflow:check: check
    bug: bug
backends:
  claude:
    command: "claude -p {{ prompt | shellquote }}"
agents:
  planner:
    backend: claude
    model: claude-opus-4-6
    prompt: "Plan"
  bug-planner:
    backend: claude
    model: claude-opus-4-6
    prompt: "Handle bug"
---
`,
    "utf8",
  );

  const workflow = await loadWorkflowFile(workflowPath);

  assert.equal(
    resolveIssueWorkflow(makeIssue({ labels: ["workflow:check"] }), workflow.config).workflowName,
    "check",
  );
  assert.equal(
    resolveIssueWorkflow(makeIssue({ labels: ["workflow:check"] }), workflow.config).workflow.dotFile,
    path.join(tempDir, "pipelines", "check.dot"),
  );
  assert.equal(resolveIssueWorkflow(makeIssue({ labels: ["bug"] }), workflow.config).workflowName, "bug");
  assert.equal(resolveIssueWorkflow(makeIssue({ labels: ["unknown"] }), workflow.config).workflowName, "default");
});

test("resolveIssueWorkflow rejects multiple labels routed to different workflows", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-workflow-conflict-"));
  await writeDotFiles(tempDir, {
    "default.dot": singleAgentGraph(),
    "bug.dot": singleAgentGraph("bug-planner"),
    "check.dot": singleAgentGraph(),
  });

  const workflowPath = path.join(tempDir, "WORKFLOW.md");
  await writeFile(
    workflowPath,
    `---
tracker:
  kind: linear
  api_key: test-token
  assignee_id: vajra-uuid
workflows:
  bug:
    dot_file: ./pipelines/bug.dot
  check:
    dot_file: ./pipelines/check.dot
  default:
    dot_file: ./pipelines/default.dot
workflow_routing:
  default_workflow: default
  by_label:
    workflow:bug: bug
    workflow:check: check
backends:
  claude:
    command: "claude -p {{ prompt | shellquote }}"
agents:
  planner:
    backend: claude
    model: claude-opus-4-6
    prompt: "Plan"
  bug-planner:
    backend: claude
    model: claude-opus-4-6
    prompt: "Handle bug"
---
`,
    "utf8",
  );

  const workflow = await loadWorkflowFile(workflowPath);

  assert.throws(
    () => resolveIssueWorkflow(makeIssue({ labels: ["workflow:bug", "workflow:check"] }), workflow.config),
    /matches multiple workflow routing labels/,
  );
});

test("loadWorkflowFile rejects missing workflow dot files", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-workflow-missing-dot-"));
  const workflowPath = path.join(tempDir, "WORKFLOW.md");
  await writeFile(
    workflowPath,
    `---
tracker:
  kind: linear
  api_key: test-token
  assignee_id: vajra-uuid
workflows:
  default:
    dot_file: ./pipelines/missing.dot
workflow_routing:
  default_workflow: default
backends: {}
agents: {}
---
`,
    "utf8",
  );
  await writeDotFiles(tempDir, {
    "bug.dot": singleAgentGraph(),
  });

  await assert.rejects(loadWorkflowFile(workflowPath), /workflows\.default\.dot_file does not exist/);
});

test("loadWorkflowFile rejects structurally invalid workflow graphs", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-workflow-invalid-graph-"));
  await writeDotFiles(tempDir, {
    "default.dot": `digraph Broken {
      plan [label="Plan", agent="planner", artifact_path=".vajra/plan.md"];
      exit [shape=Msquare];
      plan -> exit;
    }`,
  });

  const workflowPath = path.join(tempDir, "WORKFLOW.md");
  await writeFile(
    workflowPath,
    `---
tracker:
  kind: linear
  api_key: test-token
  assignee_id: vajra-uuid
workflows:
  default:
    dot_file: ./pipelines/default.dot
workflow_routing:
  default_workflow: default
backends:
  claude:
    command: "claude -p {{ prompt | shellquote }}"
agents:
  planner:
    backend: claude
    model: claude-opus-4-6
    prompt: "Plan"
---
`,
    "utf8",
  );

  await assert.rejects(loadWorkflowFile(workflowPath), /expected exactly one start node/);
});

test("loadWorkflowFile expands env-backed values and tilde paths", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-workflow-env-"));
  process.env.VAJRA_LINEAR_API_KEY = "env-token";
  await writeDotFiles(tempDir, {
    "default.dot": singleAgentGraph(),
  });

  const workflowPath = path.join(tempDir, "WORKFLOW.md");
  await writeFile(
    workflowPath,
    `---
tracker:
  kind: linear
  api_key: $VAJRA_LINEAR_API_KEY
  assignee_id: vajra-uuid
workspace:
  root: ~/vajra-workspaces
workflows:
  default:
    dot_file: ./pipelines/default.dot
workflow_routing:
  default_workflow: default
artifacts:
  root: ./plans/issues
backends:
  claude:
    command: "claude -p {{ prompt | shellquote }}"
agents:
  planner:
    backend: claude
    model: claude-opus-4-6
    prompt: "Plan"
---
`,
    "utf8",
  );

  const workflow = await loadWorkflowFile(workflowPath);
  assert.equal(workflow.config.tracker.apiKey, "env-token");
  assert.ok(workflow.config.workspace.root.includes("vajra-workspaces"));
  assert.equal(workflow.config.artifacts.root, path.join(tempDir, "plans", "issues"));
  assert.equal(workflow.config.slack, null);
});

test("loadWorkflowFile parses slack config with env-backed bot token and user map", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-workflow-slack-"));
  process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
  await writeDotFiles(tempDir, {
    "default.dot": singleAgentGraph(),
  });

  const workflowPath = path.join(tempDir, "WORKFLOW.md");
  await writeFile(
    workflowPath,
    `---
tracker:
  kind: linear
  api_key: test-token
  assignee_id: vajra-uuid
workflows:
  default:
    dot_file: ./pipelines/default.dot
workflow_routing:
  default_workflow: default
slack:
  bot_token: $SLACK_BOT_TOKEN
  channel_id: "C06ABCDEF12"
  notify_on_failure: false
  user_map:
    abc-123-linear-uuid: U06XYZABC
    def-456-linear-uuid: U07QRSTUV
backends:
  claude:
    command: "claude -p {{ prompt | shellquote }}"
agents:
  planner:
    backend: claude
    model: claude-opus-4-6
    prompt: "Plan"
---
`,
    "utf8",
  );

  const workflow = await loadWorkflowFile(workflowPath);
  assert.ok(workflow.config.slack);
  assert.equal(workflow.config.slack!.botToken, "xoxb-test-token");
  assert.equal(workflow.config.slack!.channelId, "C06ABCDEF12");
  assert.equal(workflow.config.slack!.userMap["abc-123-linear-uuid"], "U06XYZABC");
  assert.equal(workflow.config.slack!.userMap["def-456-linear-uuid"], "U07QRSTUV");
  assert.equal(workflow.config.slack!.notifyOnSuccess, true);
  assert.equal(workflow.config.slack!.notifyOnFailure, false);
});

test("loadWorkflowFile rejects a markdown prompt body", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-workflow-body-"));
  await writeDotFiles(tempDir, {
    "default.dot": singleAgentGraph(),
  });

  const workflowPath = path.join(tempDir, "WORKFLOW.md");
  await writeFile(
    workflowPath,
    `---
tracker:
  kind: linear
  api_key: test-token
  assignee_id: vajra-uuid
workflows:
  default:
    dot_file: ./pipelines/default.dot
workflow_routing:
  default_workflow: default
backends: {}
agents: {}
---
You should not see this.
`,
    "utf8",
  );

  await assert.rejects(loadWorkflowFile(workflowPath), /no longer supports a markdown prompt body/);
});

test("loadWorkflowFile rejects inline stage prompts and models in graph nodes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-workflow-removed-"));
  await writeDotFiles(tempDir, {
    "default.dot": `digraph Example {
      start [shape=Mdiamond];
      exit [shape=Msquare];
      plan [label="Plan", agent="planner", model="gpt-5.4", prompt="Do work"];
      start -> plan -> exit;
    }`,
  });

  const workflowPath = path.join(tempDir, "WORKFLOW.md");
  await writeFile(
    workflowPath,
    `---
tracker:
  kind: linear
  api_key: test-token
  assignee_id: vajra-uuid
agent:
  max_concurrent_agents: 1
workflows:
  default:
    dot_file: ./pipelines/default.dot
    prompt_overlay: "legacy"
workflow_routing:
  default_workflow: default
backends:
  claude:
    command: "claude -p {{ prompt | shellquote }}"
agents:
  planner:
    backend: claude
    model: claude-opus-4-6
    prompt: "Plan"
---
`,
    "utf8",
  );

  await assert.rejects(loadWorkflowFile(workflowPath), /uses removed prompt attribute/);
});

test("loadWorkflowFile rejects threaded stages on non-native backends", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-workflow-thread-backend-"));
  await writeDotFiles(tempDir, {
    "default.dot": `digraph Example {
      start [shape=Mdiamond];
      exit [shape=Msquare];
      plan [label="Plan", agent="planner", thread="planning"];
      start -> plan -> exit;
    }`,
  });

  const workflowPath = path.join(tempDir, "WORKFLOW.md");
  await writeFile(
    workflowPath,
    `---
tracker:
  kind: linear
  api_key: test-token
  assignee_id: vajra-uuid
workflows:
  default:
    dot_file: ./pipelines/default.dot
workflow_routing:
  default_workflow: default
backends:
  custom:
    command: "custom-cli {{ prompt | shellquote }}"
agents:
  planner:
    backend: custom
    model: custom-model
    prompt: "Plan"
---
`,
    "utf8",
  );

  await assert.rejects(loadWorkflowFile(workflowPath), /uses thread but agent backend custom does not support native sessions/);
});

test("loadWorkflowFile ignores unrelated tracker keys outside the current schema", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-workflow-project-slug-"));
  await writeDotFiles(tempDir, {
    "default.dot": singleAgentGraph(),
  });

  const workflowPath = path.join(tempDir, "WORKFLOW.md");
  await writeFile(
    workflowPath,
    `---
tracker:
  kind: linear
  api_key: test-token
  project_slug: test-project
  assignee_id: vajra-uuid
workflows:
  default:
    dot_file: ./pipelines/default.dot
workflow_routing:
  default_workflow: default
backends:
  claude:
    command: "claude -p {{ prompt | shellquote }}"
agents:
  planner:
    backend: claude
    model: claude-opus-4-6
    prompt: "Plan"
---
`,
    "utf8",
  );

  const definition = await loadWorkflowFile(workflowPath);
  assert.equal(definition.config.tracker.assigneeId, "vajra-uuid");
  assert.deepEqual(definition.config.tracker.activeStates, ["Todo", "In Progress"]);
});

test("loadWorkflowFile rejects old backend-shaped agents and unknown graph agents", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-workflow-agents-"));
  await writeDotFiles(tempDir, {
    "default.dot": singleAgentGraph("missing-agent"),
  });

  const legacyWorkflowPath = path.join(tempDir, "WORKFLOW-legacy.md");
  await writeFile(
    legacyWorkflowPath,
    `---
tracker:
  kind: linear
  api_key: test-token
  assignee_id: vajra-uuid
workflows:
  default:
    dot_file: ./pipelines/default.dot
workflow_routing:
  default_workflow: default
backends: {}
agents:
  claude:
    command: "claude -p {{ prompt | shellquote }}"
---
`,
    "utf8",
  );
  await assert.rejects(loadWorkflowFile(legacyWorkflowPath), /agents\.claude\.backend is required/);

  const unknownAgentWorkflowPath = path.join(tempDir, "WORKFLOW-unknown-agent.md");
  await writeFile(
    unknownAgentWorkflowPath,
    `---
tracker:
  kind: linear
  api_key: test-token
  assignee_id: vajra-uuid
workflows:
  default:
    dot_file: ./pipelines/default.dot
workflow_routing:
  default_workflow: default
backends:
  claude:
    command: "claude -p {{ prompt | shellquote }}"
agents:
  planner:
    backend: claude
    model: claude-opus-4-6
    prompt: "Plan"
---
`,
    "utf8",
  );
  await assert.rejects(loadWorkflowFile(unknownAgentWorkflowPath), /references unknown agent missing-agent/);
});

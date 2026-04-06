import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";

import { triageIssue } from "../src/triage";
import { Issue, WorkflowDefinition } from "../src/types";
import { workflowDefinitionFromConfig } from "./helpers/workflow-definition";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "1",
    identifier: "ENG-1",
    title: "Example issue",
    description: "Fix the bug",
    state: "Todo",
    priority: 1,
    labels: [],
    assigneeId: "vajra-uuid",
    creatorId: null,
    createdAt: "2026-03-17T00:00:00.000Z",
    updatedAt: "2026-03-17T00:00:00.000Z",
    url: null,
    blockedBy: [],
    ...overrides,
  };
}

async function makeWorkflow(tempDir: string): Promise<WorkflowDefinition> {
  const pipelinesDir = path.join(tempDir, "pipelines");
  await mkdir(pipelinesDir, { recursive: true });
  await writeFile(path.join(pipelinesDir, "default.dot"), `digraph Default { graph [goal="Default workflow"]; start [shape=Mdiamond]; exit [shape=Msquare]; plan [agent="planner"]; start -> plan -> exit; }`, "utf8");
  await writeFile(path.join(pipelinesDir, "document.dot"), `digraph Document { graph [goal="Documentation workflow"]; start [shape=Mdiamond]; exit [shape=Msquare]; doc [agent="planner"]; start -> doc -> exit; }`, "utf8");

  return workflowDefinitionFromConfig(path.join(tempDir, "WORKFLOW.md"), {
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
      maxRetryAttempts: 1,
      maxRetryBackoffMs: 60_000,
      maxConcurrentAgentsByState: {},
    },
    triage: {
      enabled: true,
      backend: "triage",
      model: "triage-model",
      timeoutMs: 1_000,
    },
    workflows: {
      default: { dotFile: path.join(pipelinesDir, "default.dot") },
      document: { dotFile: path.join(pipelinesDir, "document.dot") },
    },
    workflowRouting: {
      defaultWorkflow: "default",
      byLabel: {
        document: "document",
      },
    },
    backends: {
      triage: { command: "printf 'unused'" },
    },
    agents: {
      planner: {
        backend: "triage",
        model: "planner-model",
        prompt: "Plan",
      },
    },
    github: null,
    slack: null,
  });
}

test("triageIssue parses a structured dispatch decision from backend output", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-triage-"));
  const skillsRoot = path.join(tempDir, "skills");
  await mkdir(path.join(skillsRoot, "vajra-triage"), { recursive: true });
  await writeFile(path.join(skillsRoot, "vajra-triage", "SKILL.md"), "Issue {{ issue.identifier }}", "utf8");

  const workflow = await makeWorkflow(tempDir);
  const seenPrompts: string[] = [];
  const decision = await triageIssue({
    issue: makeIssue(),
    workflow,
    skillsRoot,
    backendFactory: () => new Map([
      ["triage", {
        name: "triage",
        async isAvailable() { return true; },
        async execute(opts) {
          seenPrompts.push(opts.prompt);
          return {
            output: JSON.stringify({
              result: "```json\n{\"action\":\"dispatch\",\"workflowName\":\"document\",\"baseBranch\":\"dev\",\"targetBranch\":\"dev\",\"mergeStrategy\":\"auto-merge\",\"labels\":[\"Documentation\"],\"reasoning\":\"Issue asks for docs\"}\n```",
            }),
            exitCode: 0,
            durationMs: 1,
          };
        },
      }],
    ]),
  });

  assert.deepEqual(decision, {
    action: "dispatch",
    workflowName: "document",
    baseBranch: "dev",
    targetBranch: "dev",
    mergeStrategy: "auto-merge",
    labels: ["documentation"],
    reasoning: "Issue asks for docs",
    wasFallback: false,
  });
  assert.equal(seenPrompts[0], "Issue ENG-1");
});

test("triageIssue falls back to default routing when backend output is invalid", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-triage-fallback-"));
  const skillsRoot = path.join(tempDir, "skills");
  await mkdir(path.join(skillsRoot, "vajra-triage"), { recursive: true });
  await writeFile(path.join(skillsRoot, "vajra-triage", "SKILL.md"), "Issue {{ issue.identifier }}", "utf8");

  const workflow = await makeWorkflow(tempDir);
  const decision = await triageIssue({
    issue: makeIssue({ labels: ["document"] }),
    workflow,
    skillsRoot,
    backendFactory: () => new Map([
      ["triage", {
        name: "triage",
        async isAvailable() { return true; },
        async execute() {
          return {
            output: "not json",
            exitCode: 0,
            durationMs: 1,
          };
        },
      }],
    ]),
  });

  assert.equal(decision.action, "dispatch");
  assert.equal(decision.workflowName, "document");
  assert.equal(decision.baseBranch, "main");
  assert.equal(decision.targetBranch, "main");
  assert.equal(decision.mergeStrategy, "pr-only");
  assert.equal(decision.wasFallback, true);
});

test("triageIssue returns request-clarification decisions verbatim", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-triage-clarify-"));
  const skillsRoot = path.join(tempDir, "skills");
  await mkdir(path.join(skillsRoot, "vajra-triage"), { recursive: true });
  await writeFile(path.join(skillsRoot, "vajra-triage", "SKILL.md"), "Issue {{ issue.identifier }}", "utf8");

  const workflow = await makeWorkflow(tempDir);
  const decision = await triageIssue({
    issue: makeIssue({ description: "" }),
    workflow,
    skillsRoot,
    backendFactory: () => new Map([
      ["triage", {
        name: "triage",
        async isAvailable() { return true; },
        async execute() {
          return {
            output: "{\"action\":\"request-clarification\",\"comment\":\"Please add acceptance criteria\",\"reasoning\":\"Missing expected outcome\"}",
            exitCode: 0,
            durationMs: 1,
          };
        },
      }],
    ]),
  });

  assert.deepEqual(decision, {
    action: "request-clarification",
    comment: "Please add acceptance criteria",
    reasoning: "Missing expected outcome",
    wasFallback: false,
  });
});

test("triageIssue includes fetched branch information in the prompt", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-triage-branches-"));
  const skillsRoot = path.join(tempDir, "skills");
  await mkdir(path.join(skillsRoot, "vajra-triage"), { recursive: true });
  await writeFile(path.join(skillsRoot, "vajra-triage", "SKILL.md"), "{{ branch_info.branches | join: ', ' }} | {% for pr in branch_info.openPullRequests %}#{{ pr.number }} {{ pr.headRefName }} -> {{ pr.baseRefName }} {{ pr.url }}{% endfor %}", "utf8");

  const workflow = await makeWorkflow(tempDir);
  const prompts: string[] = [];
  await triageIssue({
    issue: makeIssue(),
    workflow,
    skillsRoot,
    fetchBranchInfo: async () => ({
      branches: ["main", "dev"],
      openPullRequests: [
        {
          number: 42,
          headRefName: "eng-1-docs",
          baseRefName: "dev",
          url: "https://github.com/acme-corp/acme-app/pull/42",
        },
      ],
    }),
    backendFactory: () => new Map([
      ["triage", {
        name: "triage",
        async isAvailable() { return true; },
        async execute(opts) {
          prompts.push(opts.prompt);
          return {
            output: "{\"action\":\"dispatch\",\"workflowName\":\"default\",\"baseBranch\":\"main\",\"targetBranch\":\"main\",\"mergeStrategy\":\"pr-only\",\"labels\":[],\"reasoning\":\"default\"}",
            exitCode: 0,
            durationMs: 1,
          };
        },
      }],
    ]),
  });

  assert.match(prompts[0], /main, dev/);
  assert.match(prompts[0], /#42 eng-1-docs -> dev https:\/\/github.com\/acme-corp\/acme-app\/pull\/42/);
});

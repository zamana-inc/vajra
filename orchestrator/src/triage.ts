import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseDotGraph } from "./dot-parser";
import { buildBackends } from "./backends";
import { builtInSkillsRoot } from "./skills";
import { normalizeLowercase } from "./string-utils";
import { renderPromptTemplate } from "./template";
import {
  AgentBackend,
  Issue,
  TriageDecision,
  WorkflowDefinition,
} from "./types";
import { resolveIssueWorkflow } from "./workflow-routing";

export interface BranchInfo {
  branches: string[];
  openPullRequests: Array<{
    number: number;
    headRefName: string | null;
    baseRefName: string | null;
    url: string | null;
  }>;
}

type WorkflowPromptEntry = {
  name: string;
  goal: string;
  labels: string[];
  successState: string;
};

function dedupeNormalized(values: string[]): string[] {
  return [...new Set(values.map((value) => normalizeLowercase(value)).filter(Boolean))].sort();
}

function fallbackDispatchDecision(workflow: WorkflowDefinition, issue: Issue, reason: string, wasFallback = true): TriageDecision {
  const resolvedWorkflow = resolveIssueWorkflow(issue, workflow.config);
  return {
    action: "dispatch",
    workflowName: resolvedWorkflow.workflowName,
    baseBranch: "main",
    targetBranch: "main",
    mergeStrategy: "pr-only",
    labels: [],
    reasoning: reason,
    wasFallback,
  };
}

async function workflowPromptEntries(workflow: WorkflowDefinition): Promise<WorkflowPromptEntry[]> {
  const entries = await Promise.all(
    Object.entries(workflow.config.workflows).map(async ([name, entry]) => {
      let goal = "";
      try {
        const rawDot = await readFile(entry.dotFile, "utf8");
        goal = String(parseDotGraph(rawDot).graphAttrs.goal ?? "").trim();
      } catch {
        goal = "";
      }

      const labels = Object.entries(workflow.config.workflowRouting.byLabel)
        .filter(([, workflowName]) => workflowName === name)
        .map(([label]) => label)
        .sort();

      return {
        name,
        goal,
        labels,
        successState: entry.successState ?? "Done",
      };
    }),
  );

  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

function extractTextFromUnknown(value: unknown): string | null {
  // Claude's JSON mode usually returns { result: "..." }, while other backends may surface
  // the model text directly or under different wrapper keys. Keep this tolerant on purpose.
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const text = value
      .map((entry) => extractTextFromUnknown(entry))
      .filter((entry): entry is string => Boolean(entry))
      .join("\n")
      .trim();
    return text || null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of ["result", "text", "output_text"]) {
    if (typeof record[key] === "string" && String(record[key]).trim()) {
      return String(record[key]);
    }
  }

  for (const key of ["content", "message"]) {
    const nested = extractTextFromUnknown(record[key]);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const candidates = [
    trimmed,
    ...(trimmed.match(/```(?:json)?\s*([\s\S]*?)```/gi) ?? []).map((match) =>
      match.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim()),
  ];

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function normalizedDecision(parsed: Record<string, unknown>, workflow: WorkflowDefinition, issue: Issue): TriageDecision {
  const action = String(parsed.action ?? "").trim();
  if (action !== "dispatch" && action !== "request-clarification") {
    return fallbackDispatchDecision(workflow, issue, "triage fallback: action was missing or invalid");
  }

  if (action === "request-clarification") {
    const comment = String(parsed.comment ?? "").trim()
      || "Vajra needs more detail before it can start this work. Please clarify the expected change, affected area, and any branch or rollout constraints.";
    return {
      action,
      comment,
      reasoning: String(parsed.reasoning ?? "").trim() || "triage requested clarification",
      wasFallback: parsed.wasFallback === true,
    };
  }

  const resolvedWorkflow = resolveIssueWorkflow(issue, workflow.config);
  const workflowName = normalizeLowercase(String(parsed.workflowName ?? resolvedWorkflow.workflowName));
  const selectedWorkflowName = workflow.config.workflows[workflowName]
    ? workflowName
    : resolvedWorkflow.workflowName;
  const mergeStrategy = parsed.mergeStrategy === "auto-merge" ? "auto-merge" : "pr-only";

  return {
    action,
    workflowName: selectedWorkflowName,
    baseBranch: String(parsed.baseBranch ?? "").trim() || "main",
    targetBranch: String(parsed.targetBranch ?? "").trim() || "main",
    mergeStrategy,
    labels: dedupeNormalized(Array.isArray(parsed.labels) ? parsed.labels.map((entry) => String(entry ?? "")) : []),
    reasoning: String(parsed.reasoning ?? "").trim() || undefined,
    wasFallback: parsed.wasFallback === true,
  };
}

export async function triageIssue(opts: {
  issue: Issue;
  workflow: WorkflowDefinition;
  skillsRoot?: string;
  backendFactory?: (workflow: WorkflowDefinition) => Map<string, AgentBackend>;
  fetchBranchInfo?: () => Promise<BranchInfo | null>;
}): Promise<TriageDecision> {
  if (!opts.workflow.config.triage) {
    return fallbackDispatchDecision(opts.workflow, opts.issue, "triage disabled", false);
  }

  const triageConfig = opts.workflow.config.triage;
  const backends = (opts.backendFactory ?? ((workflow) => buildBackends(workflow.config.backends)))(opts.workflow);
  const backend = backends.get(triageConfig.backend);
  if (!backend) {
    return fallbackDispatchDecision(opts.workflow, opts.issue, `triage fallback: backend ${triageConfig.backend} is not configured`);
  }

  const skillPath = path.join(opts.skillsRoot ?? builtInSkillsRoot(), "vajra-triage", "SKILL.md");
  const [rawTemplate, workflows, branchInfo] = await Promise.all([
    readFile(skillPath, "utf8"),
    workflowPromptEntries(opts.workflow),
    opts.fetchBranchInfo ? opts.fetchBranchInfo() : Promise.resolve(null),
  ]);

  // Strip YAML frontmatter — the `---` delimiter at the start of the prompt
  // causes the Claude CLI to misparse it as a CLI option flag.
  const template = rawTemplate.replace(/^---[\s\S]*?---\s*/, "");

  const defaultWorkflow = resolveIssueWorkflow(opts.issue, opts.workflow.config);
  const prompt = await renderPromptTemplate(template, {
    issue: {
      identifier: opts.issue.identifier,
      title: opts.issue.title,
      description: opts.issue.description ?? "",
      state: opts.issue.state,
      labels: opts.issue.labels,
      priority: opts.issue.priority,
      url: opts.issue.url ?? "",
    },
    triage: {
      default_workflow: defaultWorkflow.workflowName,
      default_success_state: defaultWorkflow.workflow.successState ?? "Done",
      default_base_branch: "main",
      default_target_branch: "main",
      default_merge_strategy: "pr-only",
    },
    workflows,
    branch_info: branchInfo,
  });

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-triage-"));
  try {
    const available = await backend.isAvailable();
    if (!available) {
      return fallbackDispatchDecision(opts.workflow, opts.issue, `triage fallback: backend ${triageConfig.backend} is not available`);
    }

    const result = await backend.execute({
      workspace: tempDir,
      prompt,
      model: triageConfig.model,
      reasoningEffort: triageConfig.reasoningEffort,
      timeoutMs: triageConfig.timeoutMs,
    });

    if (result.exitCode !== 0) {
      return fallbackDispatchDecision(opts.workflow, opts.issue, `triage fallback: backend exited with ${result.exitCode}`);
    }

    const parsedOutput = (() => {
      try {
        return JSON.parse(result.output) as unknown;
      } catch {
        return result.output;
      }
    })();
    const extractedText = extractTextFromUnknown(parsedOutput) ?? result.output;
    const parsedDecision = extractJsonObject(extractedText);
    if (!parsedDecision) {
      return fallbackDispatchDecision(opts.workflow, opts.issue, "triage fallback: output did not contain valid JSON");
    }

    return normalizedDecision(parsedDecision, opts.workflow, opts.issue);
  } catch (error) {
    return fallbackDispatchDecision(
      opts.workflow,
      opts.issue,
      `triage fallback: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

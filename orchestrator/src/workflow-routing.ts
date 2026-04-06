import { Issue, WorkflowConfig, WorkflowEntry } from "./types";
import { normalizeLowercase } from "./string-utils";

export function resolveIssueWorkflow(
  issue: Issue,
  config: Pick<WorkflowConfig, "workflows" | "workflowRouting">,
): { workflowName: string; workflow: WorkflowEntry } {
  const normalizedLabels = issue.labels
    .map((entry) => normalizeLowercase(entry))
    .filter(Boolean);
  const matchedRoutes = normalizedLabels
    .flatMap((label) => config.workflowRouting.byLabel[label]
      ? [{ label, workflowName: config.workflowRouting.byLabel[label] }]
      : []);
  const matchedWorkflowNames = [...new Set(matchedRoutes.map((entry) => entry.workflowName))];

  if (matchedWorkflowNames.length > 1) {
    throw new Error(
      `issue ${issue.identifier} matches multiple workflow routing labels: ${matchedRoutes
        .map((entry) => `${entry.label}->${entry.workflowName}`)
        .join(", ")}`,
    );
  }

  const workflowName = matchedWorkflowNames[0] ?? config.workflowRouting.defaultWorkflow;
  const workflow = config.workflows[workflowName];
  if (!workflow) {
    throw new Error(`workflow ${workflowName} is not configured`);
  }

  return {
    workflowName,
    workflow,
  };
}

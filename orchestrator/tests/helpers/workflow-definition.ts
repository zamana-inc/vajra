import { WorkflowDefinition } from "../../src/types";
import { workflowRelativePath } from "../../src/workflow";

export function workflowDefinitionFromConfig(
  path: string,
  config: WorkflowDefinition["config"],
): WorkflowDefinition {
  const document = structuredClone(config) as WorkflowDefinition["document"];
  document.workflows = Object.fromEntries(
    Object.entries(config.workflows).map(([name, entry]) => [
      name,
      {
        ...entry,
        dotFile: workflowRelativePath(path, entry.dotFile),
      },
    ]),
  );

  return {
    path,
    config,
    document,
  };
}

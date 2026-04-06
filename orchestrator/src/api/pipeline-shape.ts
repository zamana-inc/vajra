import { PipelineGraph } from "../types";
import { ApiWorkflowDefinition } from "./types";

export function apiPipelineShapeFromGraph(
  graph: PipelineGraph,
): Pick<ApiWorkflowDefinition, "goal" | "nodes" | "edges"> {
  return {
    goal: graph.graphAttrs.goal ?? null,
    nodes: [...graph.nodes.values()].map((node) => ({
      id: node.id,
      label: node.attrs.label ?? node.id,
      type: node.type,
      agentName: node.attrs.agent ?? null,
      artifactPath: node.attrs.artifact_path ?? null,
      maxVisits: node.attrs.max_visits ? Number.parseInt(node.attrs.max_visits, 10) || null : null,
      command: node.attrs.command ?? null,
      attrs: { ...node.attrs },
    })),
    edges: graph.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      onLabel: edge.attrs.on_label ?? null,
      condition: edge.attrs.condition ?? null,
      isDefault: !("condition" in edge.attrs) && !("on_label" in edge.attrs),
      attrs: { ...edge.attrs },
    })),
  };
}

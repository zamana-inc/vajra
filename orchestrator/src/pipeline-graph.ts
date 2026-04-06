import { VajraEventBus } from "./events";
import { GraphEdge, GraphNode, Issue, PipelineGraph } from "./types";
import { renderConditionTemplate } from "./template";

export type TraversalGraph = {
  startNode: GraphNode;
  exitNodeIds: Set<string>;
  stageNodes: GraphNode[];
  stageById: Map<string, GraphNode>;
  outgoing: Map<string, GraphEdge[]>;
};

function buildEdgeIndexes(graph: PipelineGraph): {
  outgoing: Map<string, GraphEdge[]>;
  incoming: Map<string, GraphEdge[]>;
} {
  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();

  for (const edge of graph.edges) {
    const fromEdges = outgoing.get(edge.from) ?? [];
    fromEdges.push(edge);
    outgoing.set(edge.from, fromEdges);

    const toEdges = incoming.get(edge.to) ?? [];
    toEdges.push(edge);
    incoming.set(edge.to, toEdges);
  }

  return { outgoing, incoming };
}

function buildExhaustionIncomingCounts(graph: PipelineGraph): Map<string, number> {
  const counts = new Map<string, number>();

  for (const node of graph.nodes.values()) {
    const exhaustionTarget = String(node.attrs.on_exhaustion ?? "").trim();
    if (!exhaustionTarget) {
      continue;
    }

    counts.set(exhaustionTarget, (counts.get(exhaustionTarget) ?? 0) + 1);
  }

  return counts;
}

export function buildTraversalGraph(graph: PipelineGraph): TraversalGraph {
  const { outgoing, incoming } = buildEdgeIndexes(graph);
  const exhaustionIncomingCounts = buildExhaustionIncomingCounts(graph);
  const startNodes = [...graph.nodes.values()].filter((node) => node.type === "start");
  const exitNodes = [...graph.nodes.values()].filter((node) => node.type === "exit");
  const stageNodes = [...graph.nodes.values()].filter((node) => node.type !== "start" && node.type !== "exit");
  const errors: string[] = [];

  if (startNodes.length !== 1) {
    errors.push(`expected exactly one start node, found ${startNodes.length}`);
  }

  if (exitNodes.length === 0) {
    errors.push("expected at least one exit node");
  }

  for (const node of graph.nodes.values()) {
    const inCount = (incoming.get(node.id) ?? []).length + (exhaustionIncomingCounts.get(node.id) ?? 0);
    const outCount = (outgoing.get(node.id) ?? []).length;

    if (node.type === "start") {
      if (inCount !== 0 || outCount < 1) {
        errors.push(`start node ${node.id} must have 0 incoming and at least 1 outgoing edge`);
      }
      continue;
    }

    if (node.type === "exit") {
      if (inCount < 1 || outCount !== 0) {
        errors.push(`exit node ${node.id} must have at least 1 incoming and 0 outgoing edges`);
      }
      continue;
    }

    if (inCount < 1 || outCount < 1) {
      errors.push(`stage node ${node.id} must have at least 1 incoming and 1 outgoing edge`);
    }

    const exhaustionTarget = String(node.attrs.on_exhaustion ?? "").trim();
    if (exhaustionTarget && !graph.nodes.has(exhaustionTarget)) {
      errors.push(`node ${node.id} references unknown on_exhaustion target ${exhaustionTarget}`);
    }
  }

  for (const [fromNodeId, edges] of outgoing.entries()) {
    const labelTargets = new Map<string, string>();

    for (const edge of edges) {
      const onLabel = String(edge.attrs.on_label ?? "").trim();
      const condition = String(edge.attrs.condition ?? "").trim();

      if (onLabel && condition) {
        errors.push(`edge ${fromNodeId} -> ${edge.to} must not define both on_label and condition`);
      }

      if (!onLabel) {
        continue;
      }

      const existingTarget = labelTargets.get(onLabel);
      if (existingTarget) {
        errors.push(`node ${fromNodeId} defines duplicate on_label ${onLabel} for edges to ${existingTarget} and ${edge.to}`);
        continue;
      }

      labelTargets.set(onLabel, edge.to);
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }

  return {
    startNode: startNodes[0],
    exitNodeIds: new Set(exitNodes.map((node) => node.id)),
    stageNodes,
    stageById: new Map(stageNodes.map((stage) => [stage.id, stage])),
    outgoing,
  };
}

export function countCompletedNodeVisits(completedNodes: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const nodeId of completedNodes) {
    counts.set(nodeId, (counts.get(nodeId) ?? 0) + 1);
  }
  return counts;
}

export function parseMaxVisits(node: GraphNode): number {
  const parsed = Number.parseInt(node.attrs.max_visits ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
}

export class PipelineGraphNavigator {
  constructor(private readonly eventBus?: VajraEventBus) {}

  async selectNextNode(opts: {
    issue: Issue;
    fromNode: GraphNode;
    outgoingEdges: GraphEdge[];
    scope: Record<string, unknown>;
    label?: string | null;
  }): Promise<string> {
    const defaultEdges: GraphEdge[] = [];
    const labelEdges = opts.outgoingEdges.filter((edge) => String(edge.attrs.on_label ?? "").trim());

    if (opts.label) {
      if (labelEdges.length > 0) {
        const matchingEdge = labelEdges.find((edge) => String(edge.attrs.on_label ?? "").trim() === opts.label);
        if (!matchingEdge) {
          throw new Error(`no outgoing edge matched label ${JSON.stringify(opts.label)} for node ${opts.fromNode.id}`);
        }

        this.eventBus?.emit({
          type: "pipeline:edge:selected",
          timestamp: new Date().toISOString(),
          issueId: opts.issue.id,
          issueIdentifier: opts.issue.identifier,
          fromNodeId: opts.fromNode.id,
          toNodeId: matchingEdge.to,
          isDefault: false,
        });
        return matchingEdge.to;
      }
    }

    for (const edge of opts.outgoingEdges) {
      if (String(edge.attrs.on_label ?? "").trim()) {
        continue;
      }

      if (!("condition" in edge.attrs)) {
        defaultEdges.push(edge);
        continue;
      }

      let rendered: string;
      try {
        rendered = await renderConditionTemplate(edge.attrs.condition, opts.scope);
      } catch (error) {
        throw new Error(
          `failed to evaluate condition on edge ${opts.fromNode.id} -> ${edge.to}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      this.eventBus?.emit({
        type: "pipeline:edge:evaluated",
        timestamp: new Date().toISOString(),
        issueId: opts.issue.id,
        issueIdentifier: opts.issue.identifier,
        fromNodeId: opts.fromNode.id,
        toNodeId: edge.to,
        condition: edge.attrs.condition,
        result: rendered,
      });

      if (rendered.trim().toLowerCase() === "true") {
        this.eventBus?.emit({
          type: "pipeline:edge:selected",
          timestamp: new Date().toISOString(),
          issueId: opts.issue.id,
          issueIdentifier: opts.issue.identifier,
          fromNodeId: opts.fromNode.id,
          toNodeId: edge.to,
          isDefault: false,
        });
        return edge.to;
      }
    }

    if (defaultEdges.length > 0) {
      this.eventBus?.emit({
        type: "pipeline:edge:selected",
        timestamp: new Date().toISOString(),
        issueId: opts.issue.id,
        issueIdentifier: opts.issue.identifier,
        fromNodeId: opts.fromNode.id,
        toNodeId: defaultEdges[0].to,
        isDefault: true,
      });
      return defaultEdges[0].to;
    }

    throw new Error(`no outgoing edge matched for node ${opts.fromNode.id}`);
  }
}

import { GraphEdge, GraphNode, PipelineGraph } from "./types";

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

function walkLinearGraph(opts: {
  graph: PipelineGraph;
  startNode: GraphNode;
  outgoing: Map<string, GraphEdge[]>;
}): GraphNode[] {
  const ordered: GraphNode[] = [];
  let current = opts.outgoing.get(opts.startNode.id)?.[0]?.to;

  while (current) {
    const node = opts.graph.nodes.get(current);
    if (!node) {
      throw new Error(`node ${current} not found`);
    }

    if (node.type === "exit") {
      break;
    }

    ordered.push(node);
    current = opts.outgoing.get(node.id)?.[0]?.to;
  }

  return ordered;
}

export function validateLinearStageOrder(graph: PipelineGraph): string[] {
  const errors: string[] = [];
  const startNodes = [...graph.nodes.values()].filter((node) => node.type === "start");
  const exitNodes = [...graph.nodes.values()].filter((node) => node.type === "exit");

  if (startNodes.length !== 1) {
    errors.push(`expected exactly one start node, found ${startNodes.length}`);
  }

  if (exitNodes.length !== 1) {
    errors.push(`expected exactly one exit node, found ${exitNodes.length}`);
  }

  if (errors.length > 0) {
    return errors;
  }

  const { outgoing, incoming } = buildEdgeIndexes(graph);

  for (const node of graph.nodes.values()) {
    const outCount = (outgoing.get(node.id) ?? []).length;
    const inCount = (incoming.get(node.id) ?? []).length;

    if (node.type === "start") {
      if (inCount !== 0 || outCount !== 1) {
        errors.push(`start node ${node.id} must have 0 incoming and 1 outgoing edge`);
      }
      continue;
    }

    if (node.type === "exit") {
      if (inCount !== 1 || outCount !== 0) {
        errors.push(`exit node ${node.id} must have 1 incoming and 0 outgoing edges`);
      }
      continue;
    }

    if (inCount !== 1 || outCount !== 1) {
      errors.push(`stage node ${node.id} must have 1 incoming and 1 outgoing edge in the linear display mode`);
    }
  }

  if (errors.length > 0) {
    return errors;
  }

  const visited = new Set<string>();
  let current = startNodes[0].id;

  while (!visited.has(current)) {
    visited.add(current);
    const nextEdges = outgoing.get(current) ?? [];
    if (nextEdges.length === 0) {
      break;
    }
    current = nextEdges[0].to;
  }

  if (visited.size !== graph.nodes.size) {
    errors.push("graph must be a single connected linear chain for linear display ordering");
  }

  return errors;
}

export function orderedDisplayStageNodes(graph: PipelineGraph): GraphNode[] {
  const errors = validateLinearStageOrder(graph);
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }

  const startNode = [...graph.nodes.values()].find((node) => node.type === "start");
  if (!startNode) {
    throw new Error("start node not found");
  }

  return walkLinearGraph({
    graph,
    startNode,
    outgoing: buildEdgeIndexes(graph).outgoing,
  });
}

import type { VajraWorkflowDefinition } from "./types";

export interface StepDraft {
  id: string;
  nodeId: string;
  agent: string;
  label: string;
  artifactPath: string;
  onRejection: "continue" | "exit" | number;
}

export interface WorkflowDraft {
  name: string;
  labels: string[];
  isDefault: boolean;
  goal: string;
  steps: StepDraft[];
  successState: string;
  inspectPr: boolean;
}

const BUILDER_AGENT_NODE_ATTRS = new Set(["type", "label", "agent", "artifact_path"]);
const BUILDER_START_NODE_ATTRS = new Set(["shape", "type"]);
const BUILDER_EXIT_NODE_ATTRS = new Set(["shape", "type"]);
const BUILDER_EDGE_ATTRS = new Set(["condition"]);

let nextStepId = 1;

export function makeStepId(): string {
  return `step-${Date.now()}-${nextStepId++}`;
}

export function emptyWorkflowDraft(agents: string[]): WorkflowDraft {
  return {
    name: "",
    labels: [],
    isDefault: false,
    goal: "",
    steps: [
      {
        id: makeStepId(),
        nodeId: makeNodeId(),
        agent: agents[0] ?? "",
        label: "",
        artifactPath: "",
        onRejection: "continue",
      },
    ],
    successState: "Done",
    inspectPr: true,
  };
}

export function draftToDot(draft: WorkflowDraft): string {
  const graphName = draft.name
    ? draft.name.replace(/[^a-zA-Z0-9]/g, "_").replace(/^_+|_+$/g, "") || "Workflow"
    : "Workflow";

  const lines: string[] = [];
  lines.push(`digraph ${graphName} {`);
  if (draft.goal.trim()) {
    lines.push(`  graph [goal="${escapeDot(draft.goal.trim())}"]`);
    lines.push("");
  }
  lines.push(`  start [shape=Mdiamond]`);
  lines.push(`  exit  [shape=Msquare]`);
  lines.push("");

  const nodeIds: string[] = [];
  const usedNodeIds = new Set<string>();
  for (let i = 0; i < draft.steps.length; i += 1) {
    const step = draft.steps[i];
    const nodeId = uniqueNodeId(sanitizeNodeId(step.nodeId || makeNodeId()), usedNodeIds);
    nodeIds.push(nodeId);
    const label = step.label || step.agent || `Step ${i + 1}`;
    lines.push(`  ${nodeId} [`);
    lines.push(`    type="agent",`);
    lines.push(`    label="${escapeDot(label)}",`);
    lines.push(`    agent="${escapeDot(step.agent)}"${step.artifactPath.trim() ? "," : ""}`);
    if (step.artifactPath.trim()) {
      lines.push(`    artifact_path="${escapeDot(step.artifactPath.trim())}"`);
    }
    lines.push("  ]");
    lines.push("");
  }

  if (nodeIds.length > 0) {
    lines.push(`  start -> ${nodeIds[0]}`);
  } else {
    lines.push("  start -> exit");
  }

  for (let i = 0; i < nodeIds.length; i += 1) {
    const next = i + 1 < nodeIds.length ? nodeIds[i + 1] : "exit";
    lines.push(`  ${nodeIds[i]} -> ${next}`);

    const step = draft.steps[i];
    if (step.onRejection === "exit") {
      lines.push(`  ${nodeIds[i]} -> exit [condition="reject"]`);
    } else if (typeof step.onRejection === "number" && step.onRejection >= 0 && step.onRejection < nodeIds.length) {
      lines.push(`  ${nodeIds[i]} -> ${nodeIds[step.onRejection]} [condition="reject"]`);
    }
  }

  lines.push("}");
  return `${lines.join("\n")}\n`;
}

export function workflowToDraft(workflow: VajraWorkflowDefinition): WorkflowDraft | null {
  if (workflow.parseError) {
    return null;
  }

  const nodes = workflow.nodes;
  const edges = workflow.edges;

  const startNodes = nodes.filter((node) => node.type === "start");
  const exitNodes = nodes.filter((node) => node.type === "exit");
  const agentNodes = nodes.filter((node) => node.type === "agent" || node.type === "tool");

  if (startNodes.length !== 1 || exitNodes.length !== 1) {
    return null;
  }

  for (const node of nodes) {
    if (node.type === "start" && !hasOnlyAllowedAttrs(node.attrs, BUILDER_START_NODE_ATTRS)) {
      return null;
    }

    if (node.type === "exit" && !hasOnlyAllowedAttrs(node.attrs, BUILDER_EXIT_NODE_ATTRS)) {
      return null;
    }

    if (node.type === "tool") {
      return null;
    }

    if (node.type === "agent") {
      if (node.command || node.maxVisits != null) {
        return null;
      }

      if (!hasOnlyAllowedAttrs(node.attrs, BUILDER_AGENT_NODE_ATTRS)) {
        return null;
      }
    }
  }

  if (edges.some((edge) => !hasOnlyAllowedAttrs(edge.attrs, BUILDER_EDGE_ATTRS))) {
    return null;
  }

  const startId = startNodes[0].id;
  const exitId = exitNodes[0].id;
  const defaultEdges = edges.filter((edge) => !edge.condition && !edge.onLabel);
  const rejectionEdges = edges.filter((edge) => edge.condition === "reject");

  if (edges.some((edge) => edge.condition && edge.condition !== "reject")) {
    return null;
  }

  const chain: typeof agentNodes = [];
  const defaultNext = new Map<string, string>();
  for (const edge of defaultEdges) {
    if (defaultNext.has(edge.from)) {
      return null;
    }
    defaultNext.set(edge.from, edge.to);
  }

  let current = defaultNext.get(startId);
  const visited = new Set<string>();
  while (current && current !== exitId) {
    if (visited.has(current)) {
      return null;
    }
    visited.add(current);
    const node = nodes.find((entry) => entry.id === current);
    if (!node) {
      return null;
    }
    chain.push(node);
    current = defaultNext.get(current);
  }

  if (chain.length !== agentNodes.length) {
    return null;
  }

  if (defaultNext.get(chain[chain.length - 1]?.id ?? startId) !== exitId) {
    return null;
  }

  const rejectionMap = new Map<string, string>();
  for (const edge of rejectionEdges) {
    if (rejectionMap.has(edge.from)) {
      return null;
    }
    rejectionMap.set(edge.from, edge.to);
  }

  const steps: StepDraft[] = chain.map((node) => {
    const rejectionTarget = rejectionMap.get(node.id);
    let onRejection: StepDraft["onRejection"] = "continue";
    if (rejectionTarget === exitId) {
      onRejection = "exit";
    } else if (rejectionTarget) {
      const targetIndex = chain.findIndex((entry) => entry.id === rejectionTarget);
      if (targetIndex < 0) {
        return null as unknown as StepDraft;
      }
      onRejection = targetIndex;
    }

    return {
      id: makeStepId(),
      nodeId: node.id,
      agent: node.agentName ?? "",
      label: node.label ?? "",
      artifactPath: node.artifactPath ?? "",
      onRejection,
    };
  });

  if (steps.some((step) => step === null)) {
    return null;
  }

  return {
    name: workflow.name,
    labels: [...workflow.labels],
    isDefault: workflow.isDefault,
    goal: workflow.goal ?? "",
    steps,
    successState: workflow.successState,
    inspectPr: workflow.inspectPr,
  };
}

function escapeDot(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function makeNodeId(): string {
  return `stage_${nextStepId++}`;
}

function sanitizeNodeId(value: string): string {
  const trimmed = value.trim();
  const normalized = trimmed.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "");
  if (!normalized) {
    return makeNodeId();
  }
  if (/^[0-9]/.test(normalized)) {
    return `stage_${normalized}`;
  }
  return normalized;
}

function uniqueNodeId(value: string, usedNodeIds: Set<string>): string {
  if (!usedNodeIds.has(value)) {
    usedNodeIds.add(value);
    return value;
  }

  let suffix = 2;
  while (usedNodeIds.has(`${value}_${suffix}`)) {
    suffix += 1;
  }

  const unique = `${value}_${suffix}`;
  usedNodeIds.add(unique);
  return unique;
}

function hasOnlyAllowedAttrs(attrs: Record<string, string>, allowedKeys: Set<string>): boolean {
  return Object.keys(attrs).every((key) => allowedKeys.has(key));
}

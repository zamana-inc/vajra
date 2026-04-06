"use client";

import { useMemo } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  ReactFlow,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
  type FitViewOptions,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { cn } from "@/lib/design";
import type {
  VajraWorkflowEdge as VajraPipelineEdge,
  VajraWorkflowNode as VajraPipelineNode,
  VajraRunStageSummary,
} from "@/lib/vajra/types";

type StageStatus = VajraRunStageSummary["status"];

type GraphNodeData = {
  label: string;
  nodeType: VajraPipelineNode["type"];
  agentName: string | null;
  status: StageStatus;
  durationMs: number | null;
  visitCount: number;
  isClickable: boolean;
  threadName: string | null;
  maxVisits: number | null;
  onExhaustion: string | null;
  exitReason: string | null;
};

type GraphFlowNode = Node<GraphNodeData, "stage">;
type GraphFlowEdge = Edge<{ condition: string | null; onLabel: string | null }, "pipeline" | "animated">;

const NODE_WIDTH = 168;
const NODE_HEIGHT = 82;
const NODE_GAP_X = 120;
const NODE_GAP_Y = 108;
const GROUP_GAP_Y = 72;

const STATUS_ACCENTS: Record<StageStatus, { border: string; bg: string; ring: string }> = {
  success: {
    border: "border-[var(--d-text-primary)]",
    bg: "bg-[var(--d-bg-surface)]",
    ring: "",
  },
  running: {
    border: "border-[var(--d-primary)]",
    bg: "bg-[var(--d-bg-surface)]",
    ring: "ring-[3px] ring-[var(--d-primary)]/12",
  },
  failure: {
    border: "border-[var(--d-error)]",
    bg: "bg-[var(--d-error-bg)]",
    ring: "",
  },
  cancelled: {
    border: "border-[var(--d-warning)]",
    bg: "bg-[var(--d-bg-surface)]",
    ring: "",
  },
  wait_human: {
    border: "border-[var(--d-warning)]",
    bg: "bg-[var(--d-warning-bg)]",
    ring: "ring-[3px] ring-[var(--d-warning)]/12",
  },
  pending: {
    border: "border-[var(--d-border-subtle)]",
    bg: "bg-[var(--d-bg-subtle)]",
    ring: "",
  },
};

const STATUS_ICON: Record<StageStatus, { symbol: string; color: string }> = {
  success: { symbol: "✓", color: "text-[var(--d-text-primary)]" },
  running: { symbol: "◉", color: "text-[var(--d-primary)]" },
  failure: { symbol: "✕", color: "text-[var(--d-error)]" },
  cancelled: { symbol: "—", color: "text-[var(--d-warning)]" },
  wait_human: { symbol: "◈", color: "text-[var(--d-warning)]" },
  pending: { symbol: "○", color: "text-[var(--d-text-disabled)]" },
};

function structuralNodeIcon(nodeType: VajraPipelineNode["type"]): { symbol: string; color: string } {
  if (nodeType === "start") {
    return { symbol: "◇", color: "text-[var(--d-text-tertiary)]" };
  }

  if (nodeType === "exit") {
    return { symbol: "■", color: "text-[var(--d-text-tertiary)]" };
  }

  return STATUS_ICON.pending;
}

function formatDuration(durationMs: number | null): string | null {
  if (durationMs == null) {
    return null;
  }

  return durationMs < 60_000
    ? `${Math.round(durationMs / 1_000)}s`
    : `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1_000)}s`;
}

type NodeBadge = "fan_out" | "fan_in" | "tool" | "threaded" | "escalation";

function nodeTypeBadges(data: GraphNodeData): NodeBadge[] {
  const badges: NodeBadge[] = [];
  if (data.nodeType === "fan_out") badges.push("fan_out");
  if (data.nodeType === "fan_in") badges.push("fan_in");
  if (data.nodeType === "tool") badges.push("tool");
  if (data.threadName) badges.push("threaded");
  if (data.exitReason === "human_review") badges.push("escalation");
  return badges;
}

const BADGE_STYLES: Record<NodeBadge, { label: string; bg: string; text: string }> = {
  fan_out: { label: "fan-out", bg: "bg-[var(--d-info-bg)]", text: "text-[var(--d-info-text)]" },
  fan_in: { label: "fan-in", bg: "bg-[var(--d-info-bg)]", text: "text-[var(--d-info-text)]" },
  tool: { label: "tool", bg: "bg-[var(--d-warning-bg)]", text: "text-[var(--d-warning-text)]" },
  threaded: { label: "threaded", bg: "bg-[var(--d-bg-page)]", text: "text-[var(--d-text-secondary)]" },
  escalation: { label: "escalate", bg: "bg-[var(--d-error-bg)]", text: "text-[var(--d-error-text)]" },
};

function StageNodeComponent({ data }: NodeProps<GraphFlowNode>) {
  // Exit nodes that were actually reached get status-based styling, not neutral structural.
  const isStructural = data.nodeType === "start" || (data.nodeType === "exit" && data.status === "pending");
  const accent = STATUS_ACCENTS[data.status];
  const icon = isStructural ? structuralNodeIcon(data.nodeType) : STATUS_ICON[data.status];
  const durationText = formatDuration(data.durationMs);
  const badges = nodeTypeBadges(data);

  return (
    <>
      {data.nodeType !== "start" && (
        <Handle
          type="target"
          position={Position.Left}
          className="!w-0 !h-0 !border-0 !bg-transparent !min-w-0 !min-h-0"
        />
      )}
      {data.nodeType !== "exit" && (
        <Handle
          type="source"
          position={Position.Right}
          className="!w-0 !h-0 !border-0 !bg-transparent !min-w-0 !min-h-0"
        />
      )}

      <div
        className={cn(
          "w-[168px] min-h-[82px] rounded-xl border px-4 py-3 shadow-[var(--d-shadow-sm)] transition-all duration-300 ease-out",
          isStructural
            ? "border-[var(--d-border)] border-dashed bg-[var(--d-bg-page)]"
            : cn(accent.border, accent.bg, accent.ring, data.status === "running" && "animate-pulse"),
          data.isClickable && "cursor-pointer",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <span
            className={cn(
              "text-[13px] font-semibold truncate leading-tight",
              isStructural ? "text-[var(--d-text-tertiary)]" : "text-[var(--d-text-primary)]",
            )}
          >
            {data.label}
          </span>
          <span className={cn("text-[14px] leading-none flex-shrink-0", icon.color)}>
            {icon.symbol}
          </span>
        </div>

        {data.agentName && (
          <p className="text-[11px] text-[var(--d-text-tertiary)] truncate mt-1 font-mono">
            {data.agentName}
          </p>
        )}

        {badges.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {badges.map((badge) => (
              <span
                key={badge}
                className={cn(
                  "inline-flex text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded",
                  BADGE_STYLES[badge].bg,
                  BADGE_STYLES[badge].text,
                )}
              >
                {BADGE_STYLES[badge].label}
              </span>
            ))}
          </div>
        )}

        {data.maxVisits != null && data.maxVisits > 1 && (
          <p className="text-[10px] font-mono text-[var(--d-text-tertiary)] mt-1">
            max {data.maxVisits} visits{data.onExhaustion ? ` → ${data.onExhaustion}` : ""}
          </p>
        )}

        <div className="flex items-center justify-between mt-1.5 min-h-[18px]">
          {durationText ? (
            <span className="text-[11px] font-mono tabular-nums text-[var(--d-text-secondary)]">
              {durationText}
            </span>
          ) : (
            <span />
          )}
          {data.visitCount > 1 && (
            <span className="text-[10px] font-mono text-[var(--d-text-tertiary)] bg-[var(--d-bg-page)] px-1.5 py-0.5 rounded-full">
              ×{data.visitCount}
            </span>
          )}
        </div>
      </div>
    </>
  );
}

function PipelineEdgeComponent(props: EdgeProps<GraphFlowEdge>) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    style,
    data,
  } = props;
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 16,
  });

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={{ strokeWidth: 1.5, ...style }} />
      {data?.condition && (
        <EdgeLabelRenderer>
          <div
            className={cn(
              "absolute text-[10px] font-mono px-1.5 py-0.5 rounded border",
              data.onLabel
                ? "text-[var(--d-info-text)] bg-[var(--d-info-bg)] border-[var(--d-info-text)]/20"
                : "text-[var(--d-text-tertiary)] bg-white/90 border-[var(--d-border-subtle)]",
            )}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "none",
            }}
          >
            {data.condition}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

function AnimatedPipelineEdgeComponent(props: EdgeProps<GraphFlowEdge>) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    data,
  } = props;
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 16,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          strokeWidth: 1.5,
          stroke: "var(--d-primary)",
          strokeDasharray: "6 4",
        }}
        className="vajra-edge-animated"
      />
      <circle r={3} fill="var(--d-primary)" opacity={0.6}>
        <animateMotion dur="1.5s" repeatCount="indefinite" path={edgePath} />
      </circle>
      {data?.condition && (
        <EdgeLabelRenderer>
          <div
            className={cn(
              "absolute text-[10px] font-mono px-1.5 py-0.5 rounded border",
              data.onLabel
                ? "text-[var(--d-info-text)] bg-[var(--d-info-bg)] border-[var(--d-info-text)]/20"
                : "text-[var(--d-text-tertiary)] bg-white/90 border-[var(--d-border-subtle)]",
            )}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "none",
            }}
          >
            {data.condition}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { stage: StageNodeComponent };
const edgeTypes = {
  pipeline: PipelineEdgeComponent,
  animated: AnimatedPipelineEdgeComponent,
};

type NodeAdjacency = {
  outgoing: Map<string, string[]>;
  incoming: Map<string, string[]>;
};

type NodeGroup = {
  id: string;
  nodeIds: string[];
  level: number;
};

function sortNodeIds(nodeIds: string[], nodeById: Map<string, VajraPipelineNode>): string[] {
  const weight = (nodeType: VajraPipelineNode["type"]): number => {
    switch (nodeType) {
      case "start":
        return 0;
      case "agent":
        return 1;
      case "fan_out":
        return 2;
      case "fan_in":
        return 3;
      case "tool":
        return 4;
      case "exit":
        return 5;
    }
  };

  return [...nodeIds].sort((leftId, rightId) => {
    const left = nodeById.get(leftId);
    const right = nodeById.get(rightId);
    if (!left || !right) {
      return leftId.localeCompare(rightId);
    }

    return weight(left.type) - weight(right.type)
      || left.label.localeCompare(right.label)
      || left.id.localeCompare(right.id);
  });
}

function buildNodeAdjacency(
  graphNodes: VajraPipelineNode[],
  graphEdges: VajraPipelineEdge[],
): NodeAdjacency {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();

  for (const node of graphNodes) {
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
  }

  for (const edge of graphEdges) {
    outgoing.get(edge.from)?.push(edge.to);
    incoming.get(edge.to)?.push(edge.from);
  }

  return { outgoing, incoming };
}

function stronglyConnectedGroups(
  graphNodes: VajraPipelineNode[],
  outgoing: Map<string, string[]>,
): string[][] {
  const indexById = new Map<string, number>();
  const lowLinkById = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const groups: string[][] = [];
  let nextIndex = 0;

  const visit = (nodeId: string) => {
    indexById.set(nodeId, nextIndex);
    lowLinkById.set(nodeId, nextIndex);
    nextIndex += 1;
    stack.push(nodeId);
    onStack.add(nodeId);

    for (const nextId of outgoing.get(nodeId) ?? []) {
      if (!indexById.has(nextId)) {
        visit(nextId);
        lowLinkById.set(
          nodeId,
          Math.min(lowLinkById.get(nodeId) ?? 0, lowLinkById.get(nextId) ?? 0),
        );
        continue;
      }

      if (onStack.has(nextId)) {
        lowLinkById.set(
          nodeId,
          Math.min(lowLinkById.get(nodeId) ?? 0, indexById.get(nextId) ?? 0),
        );
      }
    }

    if ((lowLinkById.get(nodeId) ?? -1) !== (indexById.get(nodeId) ?? -1)) {
      return;
    }

    const group: string[] = [];
    while (stack.length > 0) {
      const entry = stack.pop();
      if (!entry) {
        break;
      }

      onStack.delete(entry);
      group.push(entry);
      if (entry === nodeId) {
        break;
      }
    }

    groups.push(group);
  };

  for (const node of graphNodes) {
    if (!indexById.has(node.id)) {
      visit(node.id);
    }
  }

  return groups;
}

function sortGroups(groups: NodeGroup[], nodeById: Map<string, VajraPipelineNode>): NodeGroup[] {
  return [...groups].sort((left, right) => {
    const leftFirst = sortNodeIds(left.nodeIds, nodeById)[0] ?? left.id;
    const rightFirst = sortNodeIds(right.nodeIds, nodeById)[0] ?? right.id;

    return leftFirst.localeCompare(rightFirst) || left.id.localeCompare(right.id);
  });
}

function groupHeight(group: NodeGroup): number {
  if (group.nodeIds.length === 0) {
    return 0;
  }

  return group.nodeIds.length * NODE_HEIGHT + (group.nodeIds.length - 1) * NODE_GAP_Y;
}

function buildNodeGroups(
  graphNodes: VajraPipelineNode[],
  graphEdges: VajraPipelineEdge[],
  nodeById: Map<string, VajraPipelineNode>,
): NodeGroup[] {
  // Collapse cycles into a single column so looped pipelines render as connected structures,
  // not as fabricated linear stage chains.
  const { outgoing, incoming } = buildNodeAdjacency(graphNodes, graphEdges);
  const groupNodeIds = stronglyConnectedGroups(graphNodes, outgoing);
  const groupByNodeId = new Map<string, number>();

  groupNodeIds.forEach((nodeIds, groupIndex) => {
    nodeIds.forEach((nodeId) => groupByNodeId.set(nodeId, groupIndex));
  });

  const groupOutgoing = new Map<number, Set<number>>();
  const groupIncomingCount = new Map<number, number>();
  groupNodeIds.forEach((_, groupIndex) => {
    groupOutgoing.set(groupIndex, new Set());
    groupIncomingCount.set(groupIndex, 0);
  });

  for (const edge of graphEdges) {
    const fromGroup = groupByNodeId.get(edge.from);
    const toGroup = groupByNodeId.get(edge.to);
    if (fromGroup == null || toGroup == null || fromGroup === toGroup) {
      continue;
    }

    const targets = groupOutgoing.get(fromGroup);
    if (!targets?.has(toGroup)) {
      targets?.add(toGroup);
      groupIncomingCount.set(toGroup, (groupIncomingCount.get(toGroup) ?? 0) + 1);
    }
  }

  const groupLevels = new Map<number, number>();
  const queue = sortGroups(
    groupNodeIds
      .map((nodeIds, groupIndex) => ({
        id: `group-${groupIndex}`,
        nodeIds,
        level: 0,
      }))
      .filter((_, groupIndex) => (groupIncomingCount.get(groupIndex) ?? 0) === 0),
    nodeById,
  ).map((group) => Number.parseInt(group.id.slice("group-".length), 10));

  queue.forEach((groupIndex) => {
    groupLevels.set(groupIndex, 0);
  });

  const visitedGroups = new Set<number>();
  while (queue.length > 0) {
    const groupIndex = queue.shift();
    if (groupIndex == null) {
      continue;
    }

    visitedGroups.add(groupIndex);
    const currentLevel = groupLevels.get(groupIndex) ?? 0;
    for (const nextGroup of groupOutgoing.get(groupIndex) ?? []) {
      groupLevels.set(nextGroup, Math.max(groupLevels.get(nextGroup) ?? 0, currentLevel + 1));
      groupIncomingCount.set(nextGroup, (groupIncomingCount.get(nextGroup) ?? 1) - 1);
      if ((groupIncomingCount.get(nextGroup) ?? 0) === 0) {
        queue.push(nextGroup);
      }
    }
  }

  let fallbackLevel = Math.max(0, ...groupLevels.values());
  groupNodeIds.forEach((nodeIds, groupIndex) => {
    if (visitedGroups.has(groupIndex)) {
      return;
    }

    const parentLevels = [...new Set(
      (nodeIds.flatMap((nodeId) => incoming.get(nodeId) ?? []))
        .map((nodeId) => groupLevels.get(groupByNodeId.get(nodeId) ?? -1))
        .filter((level): level is number => level !== undefined),
    )];
    const nextLevel = parentLevels.length > 0
      ? Math.max(...parentLevels) + 1
      : fallbackLevel + 1;
    groupLevels.set(groupIndex, nextLevel);
    fallbackLevel = Math.max(fallbackLevel, nextLevel);
  });

  return groupNodeIds.map((nodeIds, groupIndex) => {
    const sortedNodeIds = sortNodeIds(nodeIds, nodeById);

    return {
      id: `group-${groupIndex}`,
      nodeIds: sortedNodeIds,
      level: groupLevels.get(groupIndex) ?? 0,
    };
  });
}

/**
 * Infer the visual status of an exit node from the terminal run status.
 *
 * Exit nodes never appear in stages[]. We determine which exit was reached
 * by matching the run's terminal status to the exit node's role:
 * - wait_human runs reached the exit_reason="human_review" exit.
 * - successful runs reached a normal exit (no exit_reason, or exit_reason != human_review).
 * - failed/running/cancelled runs did not cleanly reach any exit.
 */
function resolveExitNodeStatus(
  node: VajraPipelineNode,
  runStatus?: StageStatus,
): StageStatus {
  if (!runStatus) return "pending";

  const exitReason = node.attrs.exit_reason?.trim();
  const isHumanReviewExit = exitReason === "human_review";

  if (runStatus === "wait_human" && isHumanReviewExit) return "wait_human";
  if (runStatus === "success" && !isHumanReviewExit) return "success";

  // Failed, running, cancelled, or wrong exit — stay pending.
  return "pending";
}

function buildGraphLayout(
  graphNodes: VajraPipelineNode[],
  graphEdges: VajraPipelineEdge[],
  stages: VajraRunStageSummary[],
  runStatus?: StageStatus,
): { nodes: GraphFlowNode[]; edges: GraphFlowEdge[] } {
  const nodeById = new Map(graphNodes.map((node) => [node.id, node]));
  const summaryById = new Map(stages.map((stage) => [stage.id, stage]));

  // Resolve status for every node (needed before layout for edge coloring).
  const resolvedStatus = new Map<string, StageStatus>();
  for (const node of graphNodes) {
    const stage = summaryById.get(node.id);
    if (stage) {
      resolvedStatus.set(node.id, stage.status);
    } else if (node.type === "exit") {
      resolvedStatus.set(node.id, resolveExitNodeStatus(node, runStatus));
    } else {
      resolvedStatus.set(node.id, "pending");
    }
  }

  const nodeGroups = buildNodeGroups(graphNodes, graphEdges, nodeById);
  const groupsByLevel = new Map<number, NodeGroup[]>();
  for (const group of nodeGroups) {
    const groupsAtLevel = groupsByLevel.get(group.level) ?? [];
    groupsAtLevel.push(group);
    groupsByLevel.set(group.level, groupsAtLevel);
  }

  const flowNodes: GraphFlowNode[] = [];
  for (const [level, groups] of [...groupsByLevel.entries()].sort((left, right) => left[0] - right[0])) {
    const sortedGroups = sortGroups(groups, nodeById);
    const columnHeight = sortedGroups.reduce((height, group, index) => {
      return height + groupHeight(group) + (index > 0 ? GROUP_GAP_Y : 0);
    }, 0);

    let yOffset = -columnHeight / 2;
    for (const group of sortedGroups) {
      group.nodeIds.forEach((nodeId, index) => {
        const node = nodeById.get(nodeId);
        if (!node) {
          return;
        }

        const stage = summaryById.get(nodeId);
        flowNodes.push({
          id: node.id,
          type: "stage",
          position: {
            x: level * (NODE_WIDTH + NODE_GAP_X),
            y: yOffset + index * (NODE_HEIGHT + NODE_GAP_Y),
          },
          data: {
            label: node.label,
            nodeType: node.type,
            agentName: node.agentName,
            status: resolvedStatus.get(nodeId) ?? "pending",
            durationMs: stage?.durationMs ?? null,
            visitCount: stage?.visitCount ?? 0,
            isClickable: stage !== undefined,
            threadName: node.attrs.thread ?? null,
            maxVisits: node.maxVisits,
            onExhaustion: node.attrs.on_exhaustion ?? null,
            exitReason: node.attrs.exit_reason ?? null,
          },
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          draggable: false,
          selectable: false,
          connectable: false,
        });
      });

      yOffset += groupHeight(group) + GROUP_GAP_Y;
    }
  }

  const flowEdges: GraphFlowEdge[] = graphEdges.map((edge) => {
    const sourceStatus = resolvedStatus.get(edge.from) ?? "pending";
    const targetStatus = resolvedStatus.get(edge.to) ?? "pending";

    let edgeColor = "var(--d-border)";
    let edgeType: GraphFlowEdge["type"] = "pipeline";

    if (targetStatus === "running") {
      edgeColor = "var(--d-primary)";
      edgeType = "animated";
    } else if (sourceStatus === "failure" || targetStatus === "failure") {
      edgeColor = "var(--d-error)";
    } else if (sourceStatus === "wait_human" || targetStatus === "wait_human") {
      edgeColor = "var(--d-warning)";
    } else if (sourceStatus === "cancelled" || targetStatus === "cancelled") {
      edgeColor = "var(--d-warning)";
    } else if (sourceStatus === "success" && targetStatus === "success") {
      edgeColor = "var(--d-text-primary)";
    }

    const edgeLabel = edge.onLabel
      ? `☠ ${edge.onLabel}`
      : edge.condition;

    return {
      id: `${edge.from}-${edge.to}-${edge.onLabel ?? edge.condition ?? "default"}`,
      source: edge.from,
      target: edge.to,
      type: edgeType,
      data: { condition: edgeLabel, onLabel: edge.onLabel },
      style: {
        stroke: edgeColor,
        strokeDasharray: edge.isDefault ? undefined : "6 3",
      },
      animated: false,
    };
  });

  return { nodes: flowNodes, edges: flowEdges };
}

const fitViewOptions: FitViewOptions = {
  padding: 0.2,
  minZoom: 0.35,
  maxZoom: 1.2,
  duration: 400,
};

interface PipelineGraphProps {
  graph: {
    nodes: VajraPipelineNode[];
    edges: VajraPipelineEdge[];
  } | null;
  stages: VajraRunStageSummary[];
  runStatus?: StageStatus;
  onStageClick?: (stageId: string) => void;
  className?: string;
  height?: number;
}

export function PipelineGraph({
  graph,
  stages,
  runStatus,
  onStageClick,
  className,
  height = 220,
}: PipelineGraphProps) {
  const layout = useMemo(() => {
    if (!graph) {
      return null;
    }

    return buildGraphLayout(graph.nodes, graph.edges, stages, runStatus);
  }, [graph, stages, runStatus]);

  const proOptions = useMemo(() => ({ hideAttribution: true }), []);

  if (!graph) {
    return (
      <div
        className={cn(
          "rounded-xl border border-[var(--d-border-subtle)] bg-[var(--d-bg-subtle)] flex items-center justify-center",
          className,
        )}
        style={{ height }}
      >
        <span className="text-[13px] text-[var(--d-text-disabled)]">
          Pipeline graph unavailable for this run
        </span>
      </div>
    );
  }

  if (layout === null || layout.nodes.length === 0) {
    return (
      <div
        className={cn(
          "rounded-xl border border-[var(--d-border-subtle)] bg-[var(--d-bg-subtle)] flex items-center justify-center",
          className,
        )}
        style={{ height }}
      >
        <span className="text-[13px] text-[var(--d-text-disabled)]">No stages</span>
      </div>
    );
  }

  return (
    <div
      className={cn("vajra-pipeline rounded-xl border border-[var(--d-border-subtle)] bg-white overflow-hidden", className)}
      style={{ height }}
    >
      <ReactFlow
        nodes={layout.nodes}
        edges={layout.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={fitViewOptions}
        proOptions={proOptions}
        panOnDrag
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        onNodeClick={(_event, node) => {
          if (node.data.isClickable) {
            onStageClick?.(node.id);
          }
        }}
      />
    </div>
  );
}

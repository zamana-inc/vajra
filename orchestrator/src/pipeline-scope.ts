import { Drop } from "liquidjs";

import { defaultStageArtifacts, stageExecutionType } from "./stage-executor";
import {
  DispatchPlan,
  GraphNode,
  Issue,
  IssueContext,
  StageMetadataValue,
  StageContextEntry,
} from "./types";

class MissingLookupDrop extends Drop {
  liquidMethodMissing(): this {
    return this;
  }

  valueOf(): string {
    return "";
  }

  toString(): string {
    return "";
  }
}

const missingLookupDrop = new MissingLookupDrop();

function toLiquidValue(value: StageMetadataValue): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => toLiquidValue(entry));
  }

  if (value && typeof value === "object") {
    return new ObjectLookupDrop(value as Record<string, StageMetadataValue>);
  }

  return value ?? "";
}

class ObjectLookupDrop extends Drop {
  constructor(values: Record<string, StageMetadataValue>) {
    super();
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(this, key, {
        value: toLiquidValue(value),
        enumerable: true,
        configurable: false,
      });
    }
  }

  liquidMethodMissing(): MissingLookupDrop {
    return missingLookupDrop;
  }
}

class StringLookupDrop extends Drop {
  constructor(values: Record<string, string>) {
    super();
    Object.assign(this, values);
  }

  liquidMethodMissing(): string {
    return "";
  }
}

function buildStageScopeEntry(entry: StageContextEntry): Record<string, unknown> {
  return {
    id: entry.id,
    label: entry.label,
    type: entry.type,
    status: entry.status,
    artifacts: new StringLookupDrop({ ...defaultStageArtifacts(), ...entry.artifacts }),
    metadata: new ObjectLookupDrop(entry.metadata),
    exitCode: entry.exitCode,
    durationMs: entry.durationMs,
    updatedAt: entry.updatedAt,
  };
}

export function buildStageContextEntry(opts: {
  node: GraphNode;
  status: StageContextEntry["status"];
  artifacts: Record<string, string>;
  metadata?: StageContextEntry["metadata"];
  backend?: string | null;
  command?: string | null;
  promptPath?: string | null;
  outputPath?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
}): StageContextEntry {
  return {
    id: opts.node.id,
    label: opts.node.attrs.label ?? opts.node.id,
    type: opts.node.type === "fan_out" || opts.node.type === "fan_in"
      ? opts.node.type
      : stageExecutionType(opts.node),
    status: opts.status,
    artifacts: { ...defaultStageArtifacts(), ...opts.artifacts },
    metadata: { ...(opts.metadata ?? {}) },
    backend: opts.backend ?? null,
    command: opts.command ?? null,
    promptPath: opts.promptPath ?? null,
    outputPath: opts.outputPath ?? null,
    exitCode: opts.exitCode ?? null,
    durationMs: opts.durationMs ?? null,
    updatedAt: new Date().toISOString(),
  };
}

export function graphStageScope(opts: {
  issue: Issue;
  attempt: number;
  node: GraphNode;
  allStages: GraphNode[];
  context: IssueContext;
  workspacePath: string;
  dotFile: string;
  completedNodes: string[];
  dispatchPlan?: DispatchPlan | null;
  prompt?: string;
}): Record<string, unknown> {
  // Prompt scope is intentionally artifact-first. Stages expose status and workspace-visible
  // artifact paths, not raw stdout/stderr transcripts from prior stages.
  const stageEntries = Object.fromEntries(
    opts.allStages.map((stage) => [
      stage.id,
      opts.context.stages[stage.id]
        ? buildStageScopeEntry(opts.context.stages[stage.id])
        : buildStageScopeEntry(buildStageContextEntry({
          node: stage,
          status: "pending",
          artifacts: defaultStageArtifacts(),
          metadata: {},
        })),
    ]),
  );

  return {
    issue: {
      identifier: opts.issue.identifier,
      title: opts.issue.title,
      description: opts.issue.description ?? "",
      state: opts.issue.state,
      labels: opts.issue.labels,
      url: opts.issue.url ?? "",
    },
    attempt: opts.attempt,
    stage: {
      id: opts.node.id,
      label: opts.node.attrs.label ?? opts.node.id,
      type: opts.node.type,
    },
    stages: stageEntries,
    context: {
      ...opts.context,
      stages: stageEntries,
    },
    pipeline: {
      dot_file: opts.dotFile,
      completed_nodes: opts.completedNodes,
    },
    workspace: {
      path: opts.workspacePath,
      artifacts_dir: opts.context.workspaceArtifactsDir,
    },
    base_branch: opts.dispatchPlan?.baseBranch ?? "main",
    target_branch: opts.dispatchPlan?.targetBranch ?? "main",
    merge_strategy: opts.dispatchPlan?.mergeStrategy ?? "pr-only",
    prompt: opts.prompt ?? "",
  };
}

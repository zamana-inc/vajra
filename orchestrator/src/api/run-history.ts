import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseDotGraph } from "../dot-parser";
import { VajraEvent } from "../events";
import { orderedDisplayStageNodes } from "../stage-order";
import { WorkflowStore } from "../types";
import {
  ApiRunStageSummary,
  ApiRunsResponse,
  ApiRunStatus,
  ApiRunStatusCounts,
  ApiRunSummary,
} from "./types";

type LoggedEventShape = VajraEvent & {
  _sequence?: number;
};

export interface LoggedVajraEvent {
  sequence: number;
  event: VajraEvent;
}

type RunLifecycleEvent =
  | Extract<VajraEvent, { type: "issue:dispatched" }>
  | Extract<VajraEvent, { type: "issue:completed" }>
  | Extract<VajraEvent, { type: "issue:escalated" }>
  | Extract<VajraEvent, { type: "issue:failed" }>
  | Extract<VajraEvent, { type: "issue:cancelled" }>
  | Extract<VajraEvent, { type: "issue:retry:scheduled" }>
  | Extract<VajraEvent, { type: "pipeline:stage:start" }>
  | Extract<VajraEvent, { type: "pipeline:stage:complete" }>;

type StageBlueprint = {
  id: string;
  label: string;
  agentName: string | null;
};

type RunAccumulator = {
  id: string;
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  issueUrl: string | null;
  attempt: number;
  workflowName: string;
  status: ApiRunStatus;
  startedAt: string;
  finishedAt: string | null;
  lastEventAt: string;
  prUrl: string | null;
  error: string | null;
  dispatchPlan: ApiRunSummary["dispatchPlan"];
  currentStageId: string | null;
  stages: Map<string, ApiRunStageSummary>;
  stageOrder: string[];
};

const RUN_LOG_EVENT_TYPES = new Set<RunLifecycleEvent["type"]>([
  "issue:dispatched",
  "issue:completed",
  "issue:escalated",
  "issue:failed",
  "issue:cancelled",
  "issue:retry:scheduled",
  "pipeline:stage:start",
  "pipeline:stage:complete",
]);

function compareString(left: string, right: string): number {
  return left.localeCompare(right);
}

function compareRunRecency(left: RunAccumulator, right: RunAccumulator): number {
  return Date.parse(right.lastEventAt) - Date.parse(left.lastEventAt)
    || compareString(right.issueIdentifier, left.issueIdentifier)
    || right.attempt - left.attempt;
}

function runKey(issueIdentifier: string, attempt: number): string {
  return `${issueIdentifier}:${attempt}`;
}

function ensureStage(accumulator: RunAccumulator, blueprint: StageBlueprint): ApiRunStageSummary {
  const existing = accumulator.stages.get(blueprint.id);
  if (existing) {
    return existing;
  }

  const created: ApiRunStageSummary = {
    id: blueprint.id,
    label: blueprint.label,
    agentName: blueprint.agentName,
    status: "pending",
    durationMs: null,
    visitCount: 0,
  };
  accumulator.stages.set(blueprint.id, created);
  accumulator.stageOrder.push(blueprint.id);
  return created;
}

function createRunAccumulator(event: Extract<RunLifecycleEvent, { type: "issue:dispatched" }>, blueprint: StageBlueprint[]): RunAccumulator {
  const stages = new Map<string, ApiRunStageSummary>();
  const stageOrder: string[] = [];
  const successState = event.successState ?? "Done";
  const baseBranch = event.baseBranch ?? "main";
  const targetBranch = event.targetBranch ?? "main";
  const mergeStrategy = event.mergeStrategy ?? "pr-only";
  const labelsToAdd = [...(event.labelsToAdd ?? [])];
  const accumulator: RunAccumulator = {
    id: runKey(event.issueIdentifier, event.attempt),
    issueId: event.issueId,
    issueIdentifier: event.issueIdentifier,
    issueTitle: event.issueTitle,
    issueUrl: event.issueUrl,
    attempt: event.attempt,
    workflowName: event.workflowName,
    status: "running",
    startedAt: event.timestamp,
    finishedAt: null,
    lastEventAt: event.timestamp,
    prUrl: null,
    error: null,
    // Summary reconstruction is intentionally lossy because events only carry flattened triage
    // fields. Persisted run metadata remains the full-fidelity source of truth.
    dispatchPlan: {
      workflowName: event.workflowName,
      successState,
      baseBranch,
      targetBranch,
      mergeStrategy,
      labelsToAdd,
      triage: event.triaged
        ? {
            action: "dispatch",
            workflowName: event.workflowName,
            baseBranch,
            targetBranch,
            mergeStrategy,
            labels: labelsToAdd,
            reasoning: event.triageReasoning ?? undefined,
            wasFallback: event.triageFallback === true,
          }
        : null,
    },
    currentStageId: null,
    stages,
    stageOrder,
  };

  for (const stage of blueprint) {
    ensureStage(accumulator, stage);
  }

  return accumulator;
}

function fallbackStageBlueprintFromSummary(stageId: string): StageBlueprint {
  return {
    id: stageId,
    label: stageId,
    agentName: null,
  };
}

function closeRun(accumulator: RunAccumulator, status: ApiRunStatus, timestamp: string, opts?: {
  error?: string | null;
  prUrl?: string | null;
}): void {
  accumulator.status = status;
  accumulator.finishedAt = timestamp;
  accumulator.lastEventAt = timestamp;
  accumulator.currentStageId = null;
  if (opts?.error !== undefined) {
    accumulator.error = opts.error;
  }
  if (opts?.prUrl !== undefined) {
    accumulator.prUrl = opts.prUrl;
  }
}

async function stageBlueprints(workflowStore: WorkflowStore): Promise<Map<string, StageBlueprint[]>> {
  const definitions = workflowStore.current().config.workflows;
  const entries = await Promise.all(
    Object.entries(definitions).map(async ([workflowName, entry]) => {
      try {
        const source = await readFile(entry.dotFile, "utf8");
        const graph = parseDotGraph(source);
        const ordered = (() => {
          try {
            return orderedDisplayStageNodes(graph);
          } catch {
            return [...graph.nodes.values()].filter((node) => node.type !== "start" && node.type !== "exit");
          }
        })();
        return [
          workflowName,
          ordered.map((node) => ({
            id: node.id,
            label: node.attrs.label ?? node.id,
            agentName: node.attrs.agent ?? null,
          })),
        ] as const;
      } catch {
        return [workflowName, [] as StageBlueprint[]] as const;
      }
    }),
  );

  return new Map(entries);
}

export function eventLogPath(logsRoot: string): string {
  return path.join(logsRoot, "events.jsonl");
}

function parseLoggedEventLine(line: string, fallbackSequence: number): LoggedVajraEvent | null {
  try {
    const parsed = JSON.parse(line) as LoggedEventShape;
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
      return null;
    }

    const sequence = Number.isFinite(parsed._sequence) && (parsed._sequence ?? 0) > 0
      ? Number(parsed._sequence)
      : fallbackSequence;
    const event = { ...parsed } as Partial<LoggedEventShape>;
    delete event._sequence;
    return {
      sequence,
      event: event as VajraEvent,
    };
  } catch {
    return null;
  }
}

export async function readLoggedEvents(opts: {
  logsRoot: string;
  afterSequence?: number;
}): Promise<LoggedVajraEvent[]> {
  try {
    const content = await readFile(eventLogPath(opts.logsRoot), "utf8");
    const events: LoggedVajraEvent[] = [];
    let lineIndex = 0;
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      lineIndex += 1;
      const parsed = parseLoggedEventLine(trimmed, lineIndex);
      if (!parsed) {
        continue;
      }
      if (opts.afterSequence && parsed.sequence <= opts.afterSequence) {
        continue;
      }
      events.push(parsed);
    }
    return events;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function readRunLifecycleEvents(logsRoot: string): Promise<RunLifecycleEvent[]> {
  const events = await readLoggedEvents({ logsRoot });
  return events
    .map((entry) => entry.event)
    .filter((event): event is RunLifecycleEvent => RUN_LOG_EVENT_TYPES.has(event.type as RunLifecycleEvent["type"]));
}

function finalizeRunSummary(accumulator: RunAccumulator): ApiRunSummary {
  const stages = accumulator.stageOrder
    .map((stageId) => accumulator.stages.get(stageId))
    .filter((stage): stage is ApiRunStageSummary => !!stage);
  const currentStage = accumulator.currentStageId
    ? accumulator.stages.get(accumulator.currentStageId) ?? null
    : null;
  const finishedAt = accumulator.finishedAt;

  return {
    id: accumulator.id,
    issueId: accumulator.issueId,
    issueIdentifier: accumulator.issueIdentifier,
    issueTitle: accumulator.issueTitle,
    issueUrl: accumulator.issueUrl,
    attempt: accumulator.attempt,
    workflowName: accumulator.workflowName,
    status: accumulator.status,
    startedAt: accumulator.startedAt,
    finishedAt,
    lastEventAt: accumulator.lastEventAt,
    durationMs: Math.max(
      0,
      Date.parse(finishedAt ?? accumulator.lastEventAt) - Date.parse(accumulator.startedAt),
    ),
    prUrl: accumulator.prUrl,
    error: accumulator.error,
    dispatchPlan: accumulator.dispatchPlan,
    currentStageId: currentStage?.id ?? null,
    currentStageLabel: currentStage?.label ?? null,
    stages,
  };
}

function matchesFilters(run: ApiRunSummary, opts: { status?: ApiRunStatus; sinceMs?: number; nowMs: number }): boolean {
  if (opts.status && run.status !== opts.status) {
    return false;
  }

  if (!opts.sinceMs) {
    return true;
  }

  const referenceAt = run.finishedAt ?? run.lastEventAt;
  const referenceMs = Date.parse(referenceAt);
  if (Number.isNaN(referenceMs)) {
    return false;
  }

  return opts.nowMs - referenceMs <= opts.sinceMs;
}

export async function listRunSummaries(opts: {
  logsRoot: string;
  workflowStore: WorkflowStore;
  status?: ApiRunStatus;
  sinceMs?: number;
  limit?: number;
  now?: () => number;
}): Promise<ApiRunsResponse> {
  const blueprintByWorkflow = await stageBlueprints(opts.workflowStore);
  const events = await readRunLifecycleEvents(opts.logsRoot);
  const runs = new Map<string, RunAccumulator>();
  const activeRunByIssueId = new Map<string, string>();

  for (const event of events) {
    if (event.type === "issue:dispatched") {
      const accumulator = createRunAccumulator(event, blueprintByWorkflow.get(event.workflowName) ?? []);
      runs.set(accumulator.id, accumulator);
      activeRunByIssueId.set(event.issueId, accumulator.id);
      continue;
    }

    const activeKey = activeRunByIssueId.get(event.issueId);
    const currentAttemptKey = activeKey
      ?? ("attempt" in event && typeof event.attempt === "number"
        ? runKey(event.issueIdentifier, event.type === "issue:retry:scheduled" ? Math.max(event.attempt - 1, 0) : event.attempt)
        : null);
    const accumulator = currentAttemptKey ? runs.get(currentAttemptKey) : undefined;
    if (!accumulator) {
      continue;
    }

    accumulator.lastEventAt = event.timestamp;

    if (event.type === "pipeline:stage:start") {
      const stage = ensureStage(accumulator, fallbackStageBlueprintFromSummary(event.stageId));
      stage.label = event.stageLabel || stage.label;
      stage.status = "running";
      stage.visitCount += 1;
      accumulator.currentStageId = stage.id;
      continue;
    }

    if (event.type === "pipeline:stage:complete") {
      const stage = ensureStage(accumulator, fallbackStageBlueprintFromSummary(event.stageId));
      stage.status = event.status === "cancelled" ? "cancelled" : event.status;
      stage.durationMs = event.durationMs;
      if (accumulator.currentStageId === stage.id) {
        accumulator.currentStageId = null;
      }
      continue;
    }

    if (event.type === "issue:completed") {
      closeRun(accumulator, "success", event.timestamp, { prUrl: event.prUrl });
      activeRunByIssueId.delete(event.issueId);
      continue;
    }

    if (event.type === "issue:escalated") {
      closeRun(accumulator, "wait_human", event.timestamp, { error: event.reason });
      activeRunByIssueId.delete(event.issueId);
      continue;
    }

    if (event.type === "issue:failed") {
      closeRun(accumulator, "failure", event.timestamp, { error: event.error });
      activeRunByIssueId.delete(event.issueId);
      continue;
    }

    if (event.type === "issue:cancelled") {
      closeRun(accumulator, "cancelled", event.timestamp, { error: event.reason });
      activeRunByIssueId.delete(event.issueId);
      continue;
    }

    if (event.type === "issue:retry:scheduled") {
      closeRun(accumulator, "failure", event.timestamp, { error: event.error });
      activeRunByIssueId.delete(event.issueId);
    }
  }

  const nowMs = opts.now?.() ?? Date.now();
  const filtered = [...runs.values()]
    .sort(compareRunRecency)
    .map((run) => finalizeRunSummary(run))
    .filter((run) => matchesFilters(run, {
      status: opts.status,
      sinceMs: opts.sinceMs,
      nowMs,
    }));
  const counts = filtered.reduce<ApiRunStatusCounts>((accumulator, run) => {
    if (run.status === "wait_human") {
      accumulator.waitHuman += 1;
    } else {
      accumulator[run.status] += 1;
    }
    return accumulator;
  }, {
    running: 0,
    success: 0,
    failure: 0,
    cancelled: 0,
    waitHuman: 0,
  });
  const limited = filtered.slice(0, opts.limit ?? 100);

  return {
    runs: limited,
    total: filtered.length,
    counts,
  };
}

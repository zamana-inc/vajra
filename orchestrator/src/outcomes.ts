import path from "node:path";

import { OutcomeStatus, StageMetadata, StageMetadataValue, StageOutcome } from "./types";
import { workspaceReference } from "./workspace-reference";

const RESERVED_OUTCOME_KEYS = new Set(["status", "label", "facts", "notes", "artifacts"]);
const OUTCOME_STATUSES: ReadonlySet<OutcomeStatus> = new Set(["success", "failure", "wait_human"]);

export function normalizeStageMetadataValue(value: unknown): StageMetadataValue | undefined {
  if (value === null) {
    return null;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeStageMetadataValue(entry))
      .filter((entry): entry is StageMetadataValue => entry !== undefined);
  }

  if (value && typeof value === "object") {
    const normalized: StageMetadata = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = key.trim();
      const normalizedValue = normalizeStageMetadataValue(entry);
      if (normalizedKey && normalizedValue !== undefined) {
        normalized[normalizedKey] = normalizedValue;
      }
    }
    return normalized;
  }

  return undefined;
}

export function normalizeStageMetadataObject(value: unknown): StageMetadata {
  const normalized = normalizeStageMetadataValue(value);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw new Error("result.json must contain a top-level object");
  }
  return normalized;
}

function normalizeFacts(value: unknown): StageMetadata {
  const normalized = normalizeStageMetadataValue(value);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    return {};
  }
  return normalized;
}

function trimString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeArtifacts(value: unknown, workspacePath: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const artifacts: Record<string, string> = {};
  for (const [key, rawPath] of Object.entries(value as Record<string, unknown>)) {
    const name = key.trim();
    const artifactPath = trimString(rawPath);
    if (!name || !artifactPath) {
      continue;
    }

    artifacts[name] = path.isAbsolute(artifactPath)
      ? workspaceReference(workspacePath, artifactPath)
      : artifactPath;
  }

  return artifacts;
}

function normalizeOutcomeStatus(value: unknown, exitCode: number): OutcomeStatus {
  const baseStatus: OutcomeStatus = exitCode === 0 ? "success" : "failure";
  const declared = trimString(value)?.toLowerCase();

  if (!declared || !OUTCOME_STATUSES.has(declared as OutcomeStatus)) {
    return baseStatus;
  }

  if (baseStatus === "failure") {
    return "failure";
  }

  return declared as OutcomeStatus;
}

export function stageMetadataFromResult(result: StageMetadata): StageMetadata {
  const metadata: StageMetadata = {};

  for (const [key, value] of Object.entries(result)) {
    if (RESERVED_OUTCOME_KEYS.has(key)) {
      continue;
    }
    metadata[key] = value;
  }

  return {
    ...metadata,
    ...normalizeFacts(result.facts),
  };
}

export function stageOutcomeFromResult(opts: {
  result: StageMetadata;
  exitCode: number;
  workspacePath: string;
}): StageOutcome {
  const facts = stageMetadataFromResult(opts.result);

  return {
    status: normalizeOutcomeStatus(opts.result.status, opts.exitCode),
    label: trimString(opts.result.label),
    facts,
    notes: trimString(opts.result.notes),
    artifacts: normalizeArtifacts(opts.result.artifacts, opts.workspacePath),
  };
}

"use client";

/**
 * Stage card — detailed view of a single pipeline stage.
 *
 * Shows prompt, output, artifacts, and metadata in a collapsible card.
 * Uses existing ChartCard as the wrapper for visual consistency.
 */

import { useState } from "react";
import { cn } from "@/lib/design";
import { ChartCard } from "@/components/dashboard/chart-card";
import { Tabs } from "@/components/dashboard/tabs";
import { RunStatusBadge } from "./run-status-badge";
import type { VajraRunStageSummary, VajraStageVisit } from "@/lib/vajra/types";

// =============================================================================
// TYPES
// =============================================================================

export interface StageDetail {
  id: string;
  label: string;
  agentName: string | null;
  status: VajraRunStageSummary["status"];
  durationMs: number | null;
  exitCode: number | null;
  model: string | null;
  backend: string | null;
  prompt: string | null;
  output: string | null;
  artifacts: { name: string; path: string }[];
  meta: Record<string, unknown>;
  previousVisits?: VajraStageVisit[];
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

function Badge({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium",
        "bg-[var(--d-bg-page)] text-[var(--d-text-secondary)] border border-[var(--d-border-subtle)]",
        className,
      )}
    >
      {children}
    </span>
  );
}

function CodeBlock({ content, maxLines = 80 }: { content: string; maxLines?: number }) {
  const [expanded, setExpanded] = useState(false);
  const lines = content.split("\n");
  const truncated = !expanded && lines.length > maxLines;
  const displayContent = truncated ? lines.slice(0, maxLines).join("\n") : content;

  return (
    <div className="relative">
      <pre className="text-[12px] font-mono leading-relaxed text-[var(--d-text-primary)] bg-[var(--d-bg-page)] rounded-lg p-4 overflow-x-auto whitespace-pre-wrap break-words max-h-[500px] overflow-y-auto">
        {displayContent}
      </pre>
      {truncated && (
        <div className="absolute bottom-0 inset-x-0 h-16 bg-gradient-to-t from-[var(--d-bg-page)] to-transparent rounded-b-lg flex items-end justify-center pb-2">
          <button
            onClick={() => setExpanded(true)}
            className="text-[12px] font-medium text-[var(--d-text-link)] hover:text-[var(--d-text-link-hover)] bg-white px-3 py-1 rounded-full shadow-sm border border-[var(--d-border-subtle)]"
          >
            Show all {lines.length} lines
          </button>
        </div>
      )}
    </div>
  );
}

function stringifyMetaValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

function flattenMetaForDisplay(
  value: unknown,
  prefix = "",
  output: Array<{ key: string; value: string }> = [],
): Array<{ key: string; value: string }> {
  if (Array.isArray(value)) {
    output.push({
      key: prefix,
      value: JSON.stringify(value),
    });
    return output;
  }

  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        flattenMetaForDisplay(entry, nextPrefix, output);
        continue;
      }
      output.push({
        key: nextPrefix,
        value: stringifyMetaValue(entry),
      });
    }
    return output;
  }

  if (prefix) {
    output.push({
      key: prefix,
      value: stringifyMetaValue(value),
    });
  }
  return output;
}

function MetaTable({ meta }: { meta: Record<string, unknown> }) {
  const entries = flattenMetaForDisplay(meta);
  if (entries.length === 0) return null;

  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
      {entries.map(({ key, value }) => (
        <div key={key} className="contents">
          <span className="text-[11px] font-mono text-[var(--d-text-tertiary)]">{key}</span>
          <span className="text-[11px] font-mono text-[var(--d-text-secondary)] truncate">{value}</span>
        </div>
      ))}
    </div>
  );
}

function ArtifactPills({ artifacts }: { artifacts: StageDetail["artifacts"] }) {
  if (artifacts.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {artifacts.map((artifact) => (
        <div
          key={artifact.path}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[var(--d-bg-page)] border border-[var(--d-border-subtle)]"
        >
          <span className="text-[12px] font-semibold text-[var(--d-text-primary)]">
            {artifact.name}
          </span>
          <span className="text-[11px] font-mono text-[var(--d-text-tertiary)] truncate">
            {artifact.path}
          </span>
        </div>
      ))}
    </div>
  );
}

// =============================================================================
// STAGE CARD
// =============================================================================

type StageTab = "prompt" | "output" | "artifacts" | "meta";

interface StageCardProps {
  stage: StageDetail;
  /** Ref target for scroll-to */
  id?: string;
}

function VisitTimeline({ visits, currentVisit, onSelectVisit }: {
  visits: VajraStageVisit[];
  currentVisit: number;
  onSelectVisit: (visit: number) => void;
}) {
  const totalVisits = visits.length + 1; // previous visits + current
  return (
    <div className="flex items-center gap-1 mb-4">
      <span className="text-[11px] font-medium text-[var(--d-text-tertiary)] mr-2">Visit</span>
      {Array.from({ length: totalVisits }, (_, i) => {
        const visitNum = i + 1;
        const isSelected = visitNum === currentVisit;
        const visitData = visits.find((v) => v.visit === visitNum);
        const isCurrent = visitNum === totalVisits;
        const visitStatus = isCurrent ? null : (visitData?.status ?? null);
        return (
          <button
            key={visitNum}
            onClick={() => onSelectVisit(visitNum)}
            className={cn(
              "min-w-[32px] h-[28px] rounded-lg text-[12px] font-mono font-semibold transition-all",
              isSelected
                ? "bg-[var(--d-text-primary)] text-white shadow-sm"
                : visitStatus === "failure"
                  ? "bg-[var(--d-error-bg)] text-[var(--d-error-text)] hover:bg-[var(--d-error)]/20"
                  : visitStatus === "success"
                    ? "bg-[var(--d-success-bg)] text-[var(--d-success-text)] hover:bg-[var(--d-success)]/20"
                    : "bg-[var(--d-bg-page)] text-[var(--d-text-secondary)] hover:bg-[var(--d-bg-hover)] border border-[var(--d-border-subtle)]",
            )}
          >
            {visitNum}
          </button>
        );
      })}
    </div>
  );
}

export function StageCard({ stage, id }: StageCardProps) {
  const [activeTab, setActiveTab] = useState<StageTab>("output");
  const totalVisits = (stage.previousVisits?.length ?? 0) + 1;
  const [selectedVisit, setSelectedVisit] = useState(totalVisits);
  const isPending = stage.status === "pending";

  // Resolve which visit's data to show
  const isCurrentVisit = selectedVisit === totalVisits;
  const visitData = isCurrentVisit
    ? null
    : stage.previousVisits?.find((v) => v.visit === selectedVisit) ?? null;
  const displayPrompt = isCurrentVisit ? stage.prompt : visitData?.prompt ?? null;
  const displayOutput = isCurrentVisit ? stage.output : visitData?.output ?? null;
  const displayArtifacts = isCurrentVisit ? stage.artifacts : (visitData?.artifacts ?? []);
  const displayMeta = isCurrentVisit ? stage.meta : (visitData?.meta ?? {});

  const durationText = stage.durationMs != null
    ? stage.durationMs < 60_000
      ? `${Math.round(stage.durationMs / 1_000)}s`
      : `${Math.floor(stage.durationMs / 60_000)}m ${Math.round((stage.durationMs % 60_000) / 1_000)}s`
    : null;

  const tabs = [
    { id: "output" as const, label: "Output", disabled: !displayOutput },
    { id: "prompt" as const, label: "Prompt", disabled: !displayPrompt },
    { id: "artifacts" as const, label: "Artifacts", badge: displayArtifacts.length || undefined, disabled: displayArtifacts.length === 0 },
    { id: "meta" as const, label: "Meta", disabled: Object.keys(displayMeta).length === 0 },
  ];

  // Pending stages are collapsed placeholders
  if (isPending) {
    return (
      <div
        id={id}
        className="bg-[var(--d-bg-subtle)] rounded-xl border border-[var(--d-border-subtle)] px-5 py-4 opacity-50"
      >
        <div className="flex items-center gap-3">
          <span className="text-[13px] font-semibold text-[var(--d-text-disabled)]">{stage.label}</span>
          {stage.agentName && (
            <Badge className="opacity-60">{stage.agentName}</Badge>
          )}
          <span className="text-[11px] text-[var(--d-text-disabled)]">Pending</span>
        </div>
      </div>
    );
  }

  return (
    <div id={id}>
      <ChartCard
        title={stage.label}
        subtitle={[stage.agentName, stage.model, durationText].filter(Boolean).join(" · ")}
        action={
          <div className="flex items-center gap-2">
            {totalVisits > 1 && (
              <Badge className="border-[var(--d-info-text)]/30 text-[var(--d-info-text)]">
                {totalVisits} visits
              </Badge>
            )}
            {stage.exitCode != null && stage.exitCode !== 0 && (
              <Badge className="border-[var(--d-error)]/30 text-[var(--d-error-text)]">
                exit {stage.exitCode}
              </Badge>
            )}
            <RunStatusBadge status={stage.status} />
          </div>
        }
      >
        {totalVisits > 1 && stage.previousVisits && (
          <VisitTimeline
            visits={stage.previousVisits}
            currentVisit={selectedVisit}
            onSelectVisit={setSelectedVisit}
          />
        )}

        <Tabs
          tabs={tabs}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          variant="contained"
          size="sm"
          className="mb-4"
        />

        {activeTab === "output" && displayOutput && (
          <CodeBlock content={displayOutput} />
        )}

        {activeTab === "prompt" && displayPrompt && (
          <CodeBlock content={displayPrompt} />
        )}

        {activeTab === "artifacts" && (
          <ArtifactPills artifacts={displayArtifacts} />
        )}

        {activeTab === "meta" && (
          <MetaTable meta={displayMeta} />
        )}
      </ChartCard>
    </div>
  );
}

// =============================================================================
// SKELETON
// =============================================================================

export function StageCardSkeleton() {
  return (
    <div className="bg-white rounded-xl border border-[var(--d-border-subtle)] p-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="h-4 w-24 bg-[var(--d-bg-active)] rounded" />
        <div className="h-3 w-16 bg-[var(--d-bg-active)] rounded" />
      </div>
      <div className="h-32 bg-[var(--d-bg-page)] rounded-lg" />
    </div>
  );
}

"use client";

/**
 * Vajra run table — the central dashboard element.
 *
 * Each row: issue identifier, title, workflow, pipeline dots, duration, PR link.
 * Click to drill into run detail.
 */

import { cn } from "@/lib/design";
import type { VajraRunSummary } from "@/lib/vajra/types";
import { PipelineDots } from "./pipeline-dots";
import { Duration } from "./duration";
import { RunStatusBadge } from "./run-status-badge";
import { ExternalLinkIcon } from "@/components/ui/icons";

interface RunTableProps {
  runs: VajraRunSummary[];
  loading: boolean;
  onRunClick?: (run: VajraRunSummary) => void;
}

function PrLink({ url }: { url: string | null }) {
  if (!url) {
    return <span className="text-[var(--d-text-disabled)]">—</span>;
  }

  // Extract PR number from GitHub URL
  const match = url.match(/\/pull\/(\d+)/);
  const label = match ? `#${match[1]}` : "PR";

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 text-[var(--d-text-link)] hover:text-[var(--d-text-link-hover)] transition-colors"
    >
      <span>{label}</span>
      <ExternalLinkIcon className="w-3 h-3" />
    </a>
  );
}

function RunTableSkeleton() {
  return (
    <div className="bg-white rounded-xl border border-[var(--d-border-subtle)]">
      <div className="px-5 py-3 border-b border-[var(--d-border-subtle)]">
        <div className="h-3 w-16 bg-[var(--d-bg-active)] rounded" />
      </div>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="px-5 py-4 border-b border-[var(--d-border-subtle)] last:border-0">
          <div className="flex items-center gap-6">
            <div className="h-3 w-14 bg-[var(--d-bg-active)] rounded" />
            <div className="h-3 w-40 bg-[var(--d-bg-active)] rounded" />
            <div className="flex-1" />
            <div className="h-3 w-24 bg-[var(--d-bg-active)] rounded" />
            <div className="h-3 w-12 bg-[var(--d-bg-active)] rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="bg-white rounded-xl border border-[var(--d-border-subtle)] px-5 py-16 text-center">
      <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-[var(--d-bg-page)] flex items-center justify-center">
        <svg viewBox="0 0 24 24" className="w-6 h-6 text-[var(--d-text-disabled)]" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
        </svg>
      </div>
      <p className="text-[14px] font-medium text-[var(--d-text-secondary)]">No runs yet</p>
      <p className="text-[12px] text-[var(--d-text-tertiary)] mt-1">
        Vajra will pick up issues from Linear automatically
      </p>
    </div>
  );
}

export function RunTable({ runs, loading, onRunClick }: RunTableProps) {
  if (loading) return <RunTableSkeleton />;
  if (runs.length === 0) return <EmptyState />;

  return (
    <div className="bg-white rounded-xl border border-[var(--d-border-subtle)] overflow-hidden">
      {/* Header */}
      <div className="grid grid-cols-[100px_1fr_100px_200px_80px_80px_60px] gap-4 px-5 py-2.5 border-b border-[var(--d-border-subtle)] bg-[var(--d-bg-subtle)]">
        <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--d-text-tertiary)]">Issue</span>
        <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--d-text-tertiary)]">Title</span>
        <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--d-text-tertiary)]">Workflow</span>
        <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--d-text-tertiary)]">Pipeline</span>
        <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--d-text-tertiary)]">Duration</span>
        <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--d-text-tertiary)]">Status</span>
        <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--d-text-tertiary)]">PR</span>
      </div>

      {/* Rows */}
      {runs.map((run) => (
        <div
          key={run.id}
          onClick={() => onRunClick?.(run)}
          className={cn(
            "grid grid-cols-[100px_1fr_100px_200px_80px_80px_60px] gap-4 px-5 py-3 items-center",
            "border-b border-[var(--d-border-subtle)] last:border-0",
            "transition-colors duration-100",
            onRunClick && "cursor-pointer hover:bg-[var(--d-bg-hover)]",
          )}
        >
          {/* Issue identifier */}
          <div className="flex items-center gap-2">
            {run.issueUrl ? (
              <a
                href={run.issueUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-[13px] font-mono font-medium text-[var(--d-text-link)] hover:underline"
              >
                {run.issueIdentifier}
              </a>
            ) : (
              <span className="text-[13px] font-mono font-medium text-[var(--d-text-primary)]">
                {run.issueIdentifier}
              </span>
            )}
          </div>

          {/* Title */}
          <span className="text-[13px] text-[var(--d-text-primary)] truncate">
            {run.issueTitle}
          </span>

          {/* Workflow */}
          <span className="text-[12px] text-[var(--d-text-secondary)] font-mono">
            {run.workflowName}
          </span>

          {/* Pipeline dots */}
          <PipelineDots stages={run.stages} />

          {/* Duration */}
          <Duration
            ms={run.durationMs}
            startedAt={run.startedAt}
            live={run.status === "running"}
            className="text-[13px] font-mono tabular-nums text-[var(--d-text-secondary)]"
          />

          {/* Status */}
          <RunStatusBadge status={run.status} />

          {/* PR */}
          <span className="text-[12px] font-mono">
            <PrLink url={run.prUrl} />
          </span>
        </div>
      ))}
    </div>
  );
}

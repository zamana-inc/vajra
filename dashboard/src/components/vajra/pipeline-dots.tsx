"use client";

/**
 * Pipeline progress dots — the signature Vajra visualization.
 *
 * A horizontal sequence of dots representing pipeline stages:
 *   ● done   ◉ running (pulse)   ✕ failed   ○ pending
 *
 * Current stage label displayed to the right.
 */

import { cn } from "@/lib/design";
import type { VajraRunStageSummary } from "@/lib/vajra/types";

type StageStatus = VajraRunStageSummary["status"];

function dotColor(status: StageStatus): string {
  switch (status) {
    case "success":
      return "bg-[var(--d-text-primary)]";
    case "running":
      return "bg-[var(--d-primary)]";
    case "failure":
      return "bg-[var(--d-error)]";
    case "cancelled":
      return "bg-[var(--d-warning)]";
    case "wait_human":
      return "bg-[var(--d-warning)]";
    case "pending":
    default:
      return "bg-[var(--d-border)]";
  }
}

function StageDot({ status }: { status: StageStatus }) {
  const isRunning = status === "running";
  const isFailed = status === "failure";
  const isWaitHuman = status === "wait_human";

  return (
    <span className="relative inline-flex items-center justify-center w-3 h-3">
      {isRunning && (
        <span
          className={cn(
            "absolute inset-0 rounded-full opacity-30 animate-ping",
            dotColor(status),
          )}
        />
      )}
      {isFailed ? (
        <svg viewBox="0 0 12 12" className="w-3 h-3">
          <line x1="2.5" y1="2.5" x2="9.5" y2="9.5" stroke="var(--d-error)" strokeWidth="2" strokeLinecap="round" />
          <line x1="9.5" y1="2.5" x2="2.5" y2="9.5" stroke="var(--d-error)" strokeWidth="2" strokeLinecap="round" />
        </svg>
      ) : (
        <span
          className={cn(
            "w-[7px] h-[7px] rounded-full transition-colors duration-200",
            dotColor(status),
            isRunning && "ring-2 ring-[var(--d-primary)]/20",
            isWaitHuman && "ring-2 ring-[var(--d-warning)]/20",
          )}
        />
      )}
    </span>
  );
}

interface PipelineDotsProps {
  stages: VajraRunStageSummary[];
  className?: string;
}

export function PipelineDots({ stages, className }: PipelineDotsProps) {
  const currentStage = stages.find((s) => s.status === "running") ?? stages.findLast((s) => s.status !== "pending");
  const currentLabel = currentStage?.label ?? "";
  const runStatus = stages.some((s) => s.status === "failure")
    ? "failure"
    : stages.some((s) => s.status === "cancelled")
      ? "cancelled"
    : stages.some((s) => s.status === "wait_human")
      ? "wait_human"
    : stages.every((s) => s.status === "success")
      ? "success"
      : stages.some((s) => s.status === "running")
        ? "running"
        : "pending";

  const statusLabel =
    runStatus === "success"
      ? "done"
    : runStatus === "failure"
      ? "failed"
      : runStatus === "cancelled"
        ? "cancelled"
        : runStatus === "wait_human"
          ? "needs review"
          : currentLabel.toLowerCase();

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <div className="flex items-center gap-[5px]">
        {stages.map((stage) => (
          <StageDot key={stage.id} status={stage.status} />
        ))}
      </div>
      {statusLabel && (
        <span
          className={cn(
            "ml-2 text-[11px] font-medium tracking-wide",
            runStatus === "failure"
              ? "text-[var(--d-error)]"
              : runStatus === "cancelled"
                ? "text-[var(--d-warning-text)]"
              : runStatus === "wait_human"
                ? "text-[var(--d-warning-text)]"
              : runStatus === "success"
                ? "text-[var(--d-text-tertiary)]"
                : "text-[var(--d-text-secondary)]",
          )}
        >
          {statusLabel}
        </span>
      )}
    </div>
  );
}

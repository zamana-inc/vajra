"use client";

/**
 * Status badge for run states.
 * Pill shape, color-coded, minimal.
 */

import { cn } from "@/lib/design";
import type { VajraRunStatus } from "@/lib/vajra/types";

type BadgeStatus = VajraRunStatus | "pending";

const STATUS_STYLES: Record<BadgeStatus, { bg: string; text: string; label: string }> = {
  running: {
    bg: "bg-[var(--d-info-bg)]",
    text: "text-[var(--d-info-text)]",
    label: "Running",
  },
  success: {
    bg: "bg-[var(--d-success-bg)]",
    text: "text-[var(--d-success-text)]",
    label: "Success",
  },
  failure: {
    bg: "bg-[var(--d-error-bg)]",
    text: "text-[var(--d-error-text)]",
    label: "Failed",
  },
  cancelled: {
    bg: "bg-[var(--d-warning-bg)]",
    text: "text-[var(--d-warning-text)]",
    label: "Cancelled",
  },
  wait_human: {
    bg: "bg-[var(--d-warning-bg)]",
    text: "text-[var(--d-warning-text)]",
    label: "Needs Review",
  },
  pending: {
    bg: "bg-[var(--d-bg-page)]",
    text: "text-[var(--d-text-disabled)]",
    label: "Pending",
  },
};

interface RunStatusBadgeProps {
  status: BadgeStatus;
  className?: string;
}

export function RunStatusBadge({ status, className }: RunStatusBadgeProps) {
  const style = STATUS_STYLES[status];

  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold tracking-wide",
        style.bg,
        style.text,
        className,
      )}
    >
      {style.label}
    </span>
  );
}

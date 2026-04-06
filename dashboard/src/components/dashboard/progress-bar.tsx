"use client";

/**
 * Progress Bar Component
 *
 * A minimal, status-aware progress indicator for the dashboard.
 * Reusable across any page that needs to show progress.
 *
 * Color palette: slate tones for sophisticated progress indication
 * - Active/Complete: #64748b (slate-500)
 * - Inactive/Track: #e2e8f0 (slate-200)
 *
 * @example
 * // Basic usage
 * <ProgressBar progress={60} />
 *
 * // With status
 * <ProgressBar progress={100} status="success" />
 *
 * // Compact size
 * <ProgressBar progress={45} size="sm" />
 */

import { cn } from "@/lib/design";

export type ProgressStatus = "default" | "active" | "success" | "error";

export interface ProgressBarProps {
  /** Progress percentage (0-100) */
  progress: number;
  /** Visual status - affects the fill color */
  status?: ProgressStatus;
  /** Size variant */
  size?: "sm" | "md";
  /** Additional class name */
  className?: string;
  /** Show animation for active state */
  animate?: boolean;
}

// Slate-based color palette for sophisticated look
const STATUS_COLORS: Record<ProgressStatus, string> = {
  default: "#94a3b8",   // slate-400 - subtle for default
  active: "#64748b",    // slate-500 - active state
  success: "#64748b",   // slate-500 - consistent with active
  error: "var(--d-error)",
};

const SIZE_CLASSES: Record<"sm" | "md", string> = {
  sm: "h-1",
  md: "h-1.5",
};

export function ProgressBar({
  progress,
  status = "default",
  size = "sm",
  className,
  animate = true,
}: ProgressBarProps) {
  const clampedProgress = Math.min(100, Math.max(0, progress));
  const isActive = status === "active" && animate && clampedProgress < 100;

  return (
    <div
      className={cn(
        "w-full rounded-full overflow-hidden",
        SIZE_CLASSES[size],
        className
      )}
      style={{ backgroundColor: "#e2e8f0" }}  // slate-200 track
    >
      <div
        className={cn(
          "h-full rounded-full transition-all duration-300 ease-out",
          isActive && "animate-pulse"
        )}
        style={{
          width: `${clampedProgress}%`,
          backgroundColor: STATUS_COLORS[status],
        }}
      />
    </div>
  );
}

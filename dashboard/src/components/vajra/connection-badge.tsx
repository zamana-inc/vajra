"use client";

/**
 * Connection indicator for the Vajra SSE stream.
 * Green dot + "Connected" when live, red + "Disconnected" when down.
 */

import { cn } from "@/lib/design";
import { StatusDot } from "./status-dot";

interface ConnectionBadgeProps {
  connected: boolean;
  className?: string;
}

export function ConnectionBadge({ connected, className }: ConnectionBadgeProps) {
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <StatusDot variant={connected ? "active" : "error"} pulse={connected} />
      <span
        className={cn(
          "text-[11px] font-medium tracking-wide",
          connected ? "text-[var(--d-success-text)]" : "text-[var(--d-error-text)]",
        )}
      >
        {connected ? "Connected" : "Disconnected"}
      </span>
    </div>
  );
}

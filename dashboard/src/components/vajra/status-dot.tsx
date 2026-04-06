"use client";

/**
 * Animated status indicator dot.
 * Pulses when "live", solid otherwise.
 */

import { cn } from "@/lib/design";

export type StatusDotVariant = "success" | "error" | "warning" | "active" | "idle" | "pending";

const VARIANT_CLASSES: Record<StatusDotVariant, string> = {
  success: "bg-[var(--d-success)]",
  error: "bg-[var(--d-error)]",
  warning: "bg-[var(--d-warning)]",
  active: "bg-[var(--d-success)]",
  idle: "bg-[var(--d-text-tertiary)]",
  pending: "bg-[var(--d-border)]",
};

interface StatusDotProps {
  variant: StatusDotVariant;
  pulse?: boolean;
  size?: "sm" | "md";
  className?: string;
}

export function StatusDot({ variant, pulse, size = "sm", className }: StatusDotProps) {
  const sizeClass = size === "sm" ? "w-2 h-2" : "w-2.5 h-2.5";

  return (
    <span className={cn("relative inline-flex", className)}>
      {pulse && (
        <span
          className={cn(
            "absolute inset-0 rounded-full opacity-40 animate-ping",
            VARIANT_CLASSES[variant],
          )}
        />
      )}
      <span className={cn("rounded-full", sizeClass, VARIANT_CLASSES[variant])} />
    </span>
  );
}

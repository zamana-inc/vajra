"use client";

/**
 * Dashboard toggle switch.
 * Matches the pattern from settings-panel.tsx, promoted to shared component.
 */

import { cn } from "@/lib/design";

export interface ToggleProps {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  disabled?: boolean;
}

export function Toggle({ enabled, onChange, disabled }: ToggleProps) {
  return (
    <button
      type="button"
      onClick={() => onChange(!enabled)}
      disabled={disabled}
      className={cn(
        "relative w-11 h-6 rounded-full transition-colors",
        enabled
          ? "bg-[var(--d-primary)]"
          : "bg-[var(--d-bg-subtle)] border border-[var(--d-border)]",
        disabled && "opacity-50 cursor-not-allowed"
      )}
    >
      <span
        className={cn(
          "absolute top-1 w-4 h-4 rounded-full transition-all",
          enabled
            ? "left-6 bg-white"
            : "left-1 bg-[var(--d-text-tertiary)]"
        )}
      />
    </button>
  );
}

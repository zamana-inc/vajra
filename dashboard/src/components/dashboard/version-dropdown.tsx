"use client";

/**
 * VersionDropdown - Specialized dropdown for version selection.
 *
 * Provides consistent styling for version selectors across the app.
 * Handles version numbers, timestamps, active states, and metadata.
 */

import { useMemo } from "react";
import { Dropdown, type DropdownOption } from "./dropdown";
import { cn } from "@/lib/design";

// =============================================================================
// TYPES
// =============================================================================

export interface VersionItem {
  /** Unique identifier */
  id: string;
  /** Display label (e.g., "v1", "v2", or formatted date) */
  label: string;
  /** Whether this is the active/current version */
  isActive?: boolean;
  /** Formatted timestamp for display */
  timestamp?: string;
  /** Who edited this version */
  editedBy?: string;
  /** Commit message or description */
  message?: string;
}

export interface VersionDropdownProps {
  /** List of versions */
  versions: VersionItem[];
  /** Currently selected version ID */
  selectedId: string | null;
  /** Called when selection changes */
  onSelect: (id: string) => void;
  /** Called when "New Version" is clicked */
  onCreateNew?: () => void;
  /** Placeholder when nothing selected */
  placeholder?: string;
  /** Loading state */
  loading?: boolean;
  /** Disabled state */
  disabled?: boolean;
  /** Size variant */
  size?: "sm" | "md";
  /** Empty state message */
  emptyMessage?: string;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function VersionDropdown({
  versions,
  selectedId,
  onSelect,
  onCreateNew,
  placeholder = "Select version",
  loading = false,
  disabled = false,
  size = "sm",
  emptyMessage = "No versions",
}: VersionDropdownProps) {
  const CREATE_NEW_ID = "__create_new__";

  // Convert to dropdown options, with "New Version" at the top if callback provided
  const options: DropdownOption<string>[] = useMemo(() => {
    const versionOptions = versions.map((v) => ({
      value: v.id,
      label: v.label,
      description: v.isActive ? "Active" : v.timestamp,
    }));

    if (onCreateNew) {
      return [
        { value: CREATE_NEW_ID, label: "New Version", description: "Create a new version" },
        ...versionOptions,
      ];
    }

    return versionOptions;
  }, [versions, onCreateNew]);

  const selected = versions.find((v) => v.id === selectedId);

  // Handle selection - intercept "create new" action
  const handleChange = (value: string) => {
    if (value === CREATE_NEW_ID) {
      onCreateNew?.();
    } else {
      onSelect(value);
    }
  };

  if (versions.length === 0 && !onCreateNew) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 text-[13px] text-[var(--d-text-tertiary)] bg-[var(--d-bg-subtle)] rounded-lg border border-dashed border-[var(--d-border)]">
        {emptyMessage}
      </div>
    );
  }

  return (
    <Dropdown
      value={selectedId}
      options={options}
      onChange={handleChange}
      placeholder={placeholder}
      loading={loading}
      disabled={disabled}
      size={size}
      renderTrigger={({ open, disabled: isDisabled }) => (
        <button
          type="button"
          disabled={isDisabled}
          className={cn(
            "flex items-center gap-2 px-3 rounded-lg border transition-colors",
            size === "sm" ? "py-1.5 text-[13px]" : "py-2 text-[14px]",
            open
              ? "border-[var(--d-primary)] bg-[var(--d-primary)]/5"
              : "border-[var(--d-border)] bg-[var(--d-bg-surface)] hover:border-[var(--d-border-strong)]",
            isDisabled && "opacity-50 cursor-not-allowed"
          )}
        >
          <span className="font-medium text-[var(--d-text-primary)]">
            {selected?.label ?? placeholder}
          </span>
          {selected?.isActive && (
            <span className="px-1.5 py-0.5 text-[10px] font-medium text-[var(--d-success)] bg-[var(--d-success)]/10 rounded">
              Active
            </span>
          )}
          <svg
            className={cn(
              "w-4 h-4 text-[var(--d-text-tertiary)] transition-transform",
              open && "rotate-180"
            )}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      )}
      renderOption={(option, { selected: isSelected, focused }) => {
        // Special rendering for "New Version" action
        if (option.value === CREATE_NEW_ID) {
          return (
            <div
              className={cn(
                "flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors",
                focused ? "bg-[var(--d-bg-hover)]" : ""
              )}
            >
              <svg
                className="w-3.5 h-3.5 text-[var(--d-text-tertiary)]"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              <span className="text-[12px] text-[var(--d-text-secondary)]">
                New version
              </span>
            </div>
          );
        }

        const version = versions.find((v) => v.id === option.value);
        if (!version) return null;

        return (
          <div
            className={cn(
              "flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors",
              isSelected
                ? "bg-[var(--d-primary)]/8"
                : focused
                ? "bg-[var(--d-bg-hover)]"
                : ""
            )}
          >
            {/* Version label */}
            <span
              className={cn(
                "min-w-[32px] text-[12px] font-semibold tabular-nums",
                version.isActive
                  ? "text-[var(--d-success)]"
                  : isSelected
                  ? "text-[var(--d-primary)]"
                  : "text-[var(--d-text-secondary)]"
              )}
            >
              {version.label}
            </span>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                {version.timestamp && (
                  <span className="text-[12px] text-[var(--d-text-tertiary)]">
                    {version.timestamp}
                  </span>
                )}
                {version.isActive && (
                  <span className="px-1 py-0.5 text-[9px] font-semibold text-[var(--d-success)] bg-[var(--d-success)]/10 rounded uppercase">
                    Active
                  </span>
                )}
              </div>
              {version.message && (
                <div className="text-[11px] text-[var(--d-text-tertiary)] truncate">
                  {version.message}
                </div>
              )}
            </div>

            {/* Check */}
            {isSelected && (
              <svg
                className="w-4 h-4 text-[var(--d-primary)] flex-shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            )}
          </div>
        );
      }}
    />
  );
}

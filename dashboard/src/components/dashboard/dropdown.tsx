"use client";

/**
 * Dashboard Dropdown Component
 *
 * A flexible dropdown/select component for the dashboard.
 * Handles custom trigger content and option rendering.
 *
 * @example
 * // Basic select
 * <Dropdown
 *   value={selectedValue}
 *   options={[
 *     { value: 'opt1', label: 'Option 1' },
 *     { value: 'opt2', label: 'Option 2' },
 *   ]}
 *   onChange={(value) => setSelectedValue(value)}
 *   placeholder="Select option..."
 * />
 *
 * // With custom trigger
 * <Dropdown
 *   value={selected}
 *   options={options}
 *   onChange={setSelected}
 *   renderTrigger={({ value, open }) => (
 *     <CustomButton isOpen={open}>{value?.label}</CustomButton>
 *   )}
 * />
 *
 * // With custom option rendering
 * <Dropdown
 *   value={selected}
 *   options={users}
 *   onChange={setSelected}
 *   renderOption={(option, { selected }) => (
 *     <UserRow user={option} selected={selected} />
 *   )}
 * />
 */

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useId,
  type ReactNode,
} from "react";
import { cn } from "@/lib/design";
import { ChevronDownIcon, CheckIcon } from "@/components/ui/icons";

// =============================================================================
// TYPES
// =============================================================================

export type DropdownOption<T = string> = {
  /** Unique value */
  value: T;
  /** Display label */
  label: string;
  /** Optional description */
  description?: string;
  /** Optional icon */
  icon?: ReactNode;
  /** Disabled state */
  disabled?: boolean;
};

type DropdownSize = "sm" | "md";

export type DropdownProps<T = string> = {
  /** Currently selected value */
  value: T | null;
  /** Available options */
  options: DropdownOption<T>[];
  /** Called when selection changes */
  onChange: (value: T) => void;
  /** Placeholder when no value selected */
  placeholder?: string;
  /** Size variant */
  size?: DropdownSize;
  /** Disabled state */
  disabled?: boolean;
  /** Loading state */
  loading?: boolean;
  /** Error state */
  error?: boolean;
  /** Additional className for trigger */
  className?: string;
  /** Custom trigger renderer */
  renderTrigger?: (props: {
    value: DropdownOption<T> | null;
    open: boolean;
    disabled: boolean;
  }) => ReactNode;
  /** Custom option renderer */
  renderOption?: (
    option: DropdownOption<T>,
    state: { selected: boolean; focused: boolean }
  ) => ReactNode;
  /** Accessible label */
  "aria-label"?: string;
  /** Position of dropdown */
  position?: "bottom" | "top";
  /** Align dropdown */
  align?: "start" | "end";
};

// =============================================================================
// STYLES
// =============================================================================

const triggerStyles = {
  base: [
    "flex items-center justify-between gap-2 w-full",
    "border rounded-lg",
    "transition-all duration-150 ease-out",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--d-border-focus)]",
    "disabled:opacity-50 disabled:cursor-not-allowed",
  ].join(" "),
  sizes: {
    sm: "px-2.5 py-1.5 text-[12px]",
    md: "px-3 py-2 text-[13px]",
  },
  states: {
    default: "bg-[var(--d-bg-surface)] border-[var(--d-border)] hover:border-[var(--d-border-strong)]",
    open: "bg-[var(--d-bg-surface)] border-[var(--d-border-focus)] ring-1 ring-[var(--d-border-focus)]/20",
    error: "bg-[var(--d-bg-surface)] border-[var(--d-error)]",
  },
};

const popoverStyles = [
  "absolute z-50 min-w-[var(--trigger-width)]",
  "bg-[var(--d-bg-surface)] border border-[var(--d-border)]",
  "rounded-lg overflow-hidden",
  "shadow-[var(--d-shadow-dropdown)]",
  "animate-scale-in",
].join(" ");

const optionStyles = {
  base: [
    "w-full px-3 py-2 text-left",
    "flex items-center gap-2",
    "transition-colors duration-100",
    "focus-visible:outline-none",
    "disabled:opacity-50 disabled:cursor-not-allowed",
  ].join(" "),
  states: {
    default: "hover:bg-[var(--d-bg-hover)]",
    focused: "bg-[var(--d-bg-hover)]",
    selected: "bg-[var(--d-bg-selected)] text-[var(--d-primary)]",
  },
};

// =============================================================================
// ICONS
// =============================================================================

function LoadingSpinner() {
  return (
    <svg className="w-4 h-4 animate-spin text-[var(--d-text-tertiary)]" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function Dropdown<T = string>({
  value,
  options,
  onChange,
  placeholder = "Select...",
  size = "md",
  disabled = false,
  loading = false,
  error = false,
  className,
  renderTrigger,
  renderOption,
  "aria-label": ariaLabel,
  position = "bottom",
  align = "start",
}: DropdownProps<T>) {
  const id = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const triggerWrapperRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((opt) => opt.value === value) ?? null;

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const isInsidePopover = popoverRef.current?.contains(target);
      const isInsideTrigger = triggerRef.current?.contains(target) || triggerWrapperRef.current?.contains(target);

      if (!isInsidePopover && !isInsideTrigger) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // Close on escape
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen]);

  // Reset focused index when opening
  useEffect(() => {
    if (isOpen) {
      const selectedIndex = options.findIndex((opt) => opt.value === value);
      setFocusedIndex(selectedIndex >= 0 ? selectedIndex : 0);
    }
  }, [isOpen, options, value]);

  const handleSelect = useCallback(
    (optionValue: T) => {
      onChange(optionValue);
      setIsOpen(false);
      triggerRef.current?.focus();
    },
    [onChange]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const enabledOptions = options.filter((opt) => !opt.disabled);
    const enabledIndices = options
      .map((opt, i) => (!opt.disabled ? i : -1))
      .filter((i) => i !== -1);

    switch (e.key) {
      case "Enter":
      case " ":
        e.preventDefault();
        if (isOpen && focusedIndex >= 0) {
          handleSelect(options[focusedIndex].value);
        } else {
          setIsOpen(true);
        }
        break;
      case "ArrowDown":
        e.preventDefault();
        if (!isOpen) {
          setIsOpen(true);
        } else {
          const currentEnabledIndex = enabledIndices.indexOf(focusedIndex);
          const nextIndex = enabledIndices[
            currentEnabledIndex < enabledIndices.length - 1
              ? currentEnabledIndex + 1
              : 0
          ];
          setFocusedIndex(nextIndex);
        }
        break;
      case "ArrowUp":
        e.preventDefault();
        if (!isOpen) {
          setIsOpen(true);
        } else {
          const currentEnabledIndex = enabledIndices.indexOf(focusedIndex);
          const prevIndex = enabledIndices[
            currentEnabledIndex > 0
              ? currentEnabledIndex - 1
              : enabledIndices.length - 1
          ];
          setFocusedIndex(prevIndex);
        }
        break;
      case "Home":
        e.preventDefault();
        setFocusedIndex(enabledIndices[0]);
        break;
      case "End":
        e.preventDefault();
        setFocusedIndex(enabledIndices[enabledIndices.length - 1]);
        break;
    }
  };

  // Determine trigger state
  const triggerState = error ? "error" : isOpen ? "open" : "default";

  // Position styles
  const positionStyles = {
    bottom: "top-full mt-1",
    top: "bottom-full mb-1",
  }[position];

  const alignStyles = {
    start: "left-0",
    end: "right-0",
  }[align];

  return (
    <div className="relative" style={{ "--trigger-width": "100%" } as React.CSSProperties}>
      {/* Trigger */}
      {renderTrigger ? (
        <div ref={triggerWrapperRef} onClick={() => !disabled && setIsOpen(!isOpen)}>
          {renderTrigger({ value: selectedOption, open: isOpen, disabled })}
        </div>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          id={`${id}-trigger`}
          role="combobox"
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-controls={`${id}-listbox`}
          aria-label={ariaLabel}
          disabled={disabled || loading}
          onClick={() => setIsOpen(!isOpen)}
          onKeyDown={handleKeyDown}
          className={cn(
            triggerStyles.base,
            triggerStyles.sizes[size],
            triggerStyles.states[triggerState],
            className
          )}
        >
          <span
            className={cn(
              "truncate",
              !selectedOption && "text-[var(--d-text-tertiary)]"
            )}
          >
            {selectedOption?.label ?? placeholder}
          </span>
          {loading ? (
            <LoadingSpinner />
          ) : (
            <ChevronDownIcon
              className={cn(
                "w-4 h-4 text-[var(--d-text-tertiary)] transition-transform duration-150",
                isOpen && "rotate-180"
              )}
            />
          )}
        </button>
      )}

      {/* Popover */}
      {isOpen && (
        <div
          ref={popoverRef}
          id={`${id}-listbox`}
          role="listbox"
          aria-labelledby={`${id}-trigger`}
          className={cn(popoverStyles, positionStyles, alignStyles)}
        >
          <div className="max-h-[240px] overflow-y-auto py-1">
            {options.map((option, index) => {
              const isSelected = option.value === value;
              const isFocused = index === focusedIndex;

              if (renderOption) {
                return (
                  <div
                    key={String(option.value)}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => !option.disabled && handleSelect(option.value)}
                    onMouseEnter={() => setFocusedIndex(index)}
                    className={option.disabled ? "opacity-50 cursor-not-allowed" : ""}
                  >
                    {renderOption(option, { selected: isSelected, focused: isFocused })}
                  </div>
                );
              }

              return (
                <button
                  key={String(option.value)}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={option.disabled}
                  onClick={() => handleSelect(option.value)}
                  onMouseEnter={() => setFocusedIndex(index)}
                  className={cn(
                    optionStyles.base,
                    isSelected
                      ? optionStyles.states.selected
                      : isFocused
                      ? optionStyles.states.focused
                      : optionStyles.states.default,
                    "text-[13px]"
                  )}
                >
                  {option.icon && (
                    <span className="[&>svg]:w-4 [&>svg]:h-4 text-[var(--d-text-tertiary)]">
                      {option.icon}
                    </span>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="truncate">{option.label}</div>
                    {option.description && (
                      <div className="text-[11px] text-[var(--d-text-tertiary)] truncate">
                        {option.description}
                      </div>
                    )}
                  </div>
                  {isSelected && (
                    <CheckIcon className="text-[var(--d-primary)] flex-shrink-0" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

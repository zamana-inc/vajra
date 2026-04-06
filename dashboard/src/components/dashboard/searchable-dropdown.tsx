"use client";

/**
 * SearchableDropdown - Dropdown with search input.
 *
 * A polished dropdown component with built-in search, sections,
 * and consistent styling across the dashboard.
 */

import { useState, useEffect, useRef, useMemo, useCallback, type ReactNode } from "react";
import { cn } from "@/lib/design";
import { SearchIcon, ChevronDownIcon, CheckIcon } from "@/components/ui/icons";

// =============================================================================
// TYPES
// =============================================================================

export interface SearchableDropdownOption<T = string> {
  /** Unique value */
  value: T;
  /** Primary display text */
  label: string;
  /** Secondary text (shown below label in smaller text) */
  description?: string;
  /** Whether this option is highlighted/featured */
  highlighted?: boolean;
}

export interface SearchableDropdownSection<T = string> {
  /** Section header text */
  title: string;
  /** Options in this section */
  options: SearchableDropdownOption<T>[];
}

export interface SearchableDropdownProps<T = string> {
  /** Currently selected value */
  value: T | null;
  /** Options - either flat array or sectioned */
  options: SearchableDropdownOption<T>[] | SearchableDropdownSection<T>[];
  /** Called when selection changes */
  onChange: (value: T) => void;
  /** Placeholder for trigger when nothing selected */
  placeholder?: string;
  /** Placeholder for search input */
  searchPlaceholder?: string;
  /** Message when no results found */
  emptyMessage?: string;
  /** Loading state */
  loading?: boolean;
  /** Loading message */
  loadingMessage?: string;
  /** Error message */
  error?: string;
  /** Allow custom value when no match */
  allowCustom?: boolean;
  /** Custom value prompt (shown when allowCustom is true and no results) */
  customPrompt?: (search: string) => string;
  /** Additional className */
  className?: string;
  /** Width of dropdown (default: same as trigger) */
  dropdownWidth?: string;
}

// =============================================================================
// HELPERS
// =============================================================================

function isSectioned<T>(
  options: SearchableDropdownOption<T>[] | SearchableDropdownSection<T>[]
): options is SearchableDropdownSection<T>[] {
  return options.length > 0 && "title" in options[0] && "options" in options[0];
}

function getAllOptions<T>(
  options: SearchableDropdownOption<T>[] | SearchableDropdownSection<T>[]
): SearchableDropdownOption<T>[] {
  if (isSectioned(options)) {
    return options.flatMap((s) => s.options);
  }
  return options;
}

function filterOptions<T>(
  options: SearchableDropdownOption<T>[],
  search: string
): SearchableDropdownOption<T>[] {
  if (!search.trim()) return options;
  const q = search.toLowerCase();
  return options.filter(
    (o) =>
      o.label.toLowerCase().includes(q) ||
      (o.description?.toLowerCase().includes(q) ?? false)
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function SearchableDropdown<T = string>({
  value,
  options,
  onChange,
  placeholder = "Select...",
  searchPlaceholder = "Search...",
  emptyMessage = "No results found",
  loading = false,
  loadingMessage = "Loading...",
  error,
  allowCustom = false,
  customPrompt = (s) => `Use "${s}"`,
  className,
  dropdownWidth,
}: SearchableDropdownProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Get all options flat for finding selected
  const allOptions = useMemo(() => getAllOptions(options), [options]);

  // Find selected option
  const selectedOption = useMemo(
    () => allOptions.find((o) => o.value === value),
    [allOptions, value]
  );

  // Filter options by search
  const filteredOptions = useMemo(() => {
    if (isSectioned(options)) {
      return options
        .map((section) => ({
          ...section,
          options: filterOptions(section.options, search),
        }))
        .filter((section) => section.options.length > 0);
    }
    return filterOptions(options, search);
  }, [options, search]);

  const hasResults = isSectioned(filteredOptions)
    ? filteredOptions.length > 0
    : filteredOptions.length > 0;

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;

    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setSearch("");
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // Focus search input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  const handleSelect = useCallback(
    (optionValue: T) => {
      onChange(optionValue);
      setIsOpen(false);
      setSearch("");
    },
    [onChange]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
        setSearch("");
      } else if (e.key === "Enter" && allowCustom && search.trim() && !hasResults) {
        handleSelect(search.trim() as T);
      }
    },
    [search, hasResults, allowCustom, handleSelect]
  );

  const renderOption = (option: SearchableDropdownOption<T>) => {
    const isSelected = option.value === value;

    return (
      <button
        key={String(option.value)}
        type="button"
        onClick={() => handleSelect(option.value)}
        className={cn(
          "w-full px-3 py-2 text-left flex items-center gap-2 transition-colors",
          isSelected
            ? "bg-[var(--d-primary)]/10 text-[var(--d-primary)]"
            : "hover:bg-[var(--d-bg-hover)] text-[var(--d-text-primary)]"
        )}
      >
        <div className="flex-1 min-w-0">
          <div className={cn("text-[13px] truncate", option.highlighted && "font-medium")}>
            {option.label}
          </div>
          {option.description && (
            <div className="text-[11px] text-[var(--d-text-tertiary)] truncate">
              {option.description}
            </div>
          )}
        </div>
        {isSelected && <CheckIcon className="w-4 h-4 text-[var(--d-primary)] flex-shrink-0" />}
      </button>
    );
  };

  const renderSectionHeader = (title: string) => (
    <div className="px-3 py-1.5 text-[10px] font-semibold text-[var(--d-text-tertiary)] uppercase tracking-wider bg-[var(--d-bg-subtle)]">
      {title}
    </div>
  );

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      {/* Trigger */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "w-full px-3 py-2 text-[13px] border rounded-lg transition-colors",
          "flex items-center gap-2 text-left",
          "focus:outline-none focus:border-[var(--d-border-strong)]",
          isOpen
            ? "border-[var(--d-primary)] bg-[var(--d-primary)]/5"
            : "border-[var(--d-border)] bg-[var(--d-bg-surface)] hover:border-[var(--d-border-strong)]"
        )}
      >
        <span className={cn("flex-1 truncate", !selectedOption && "text-[var(--d-text-tertiary)]")}>
          {selectedOption?.label ?? placeholder}
        </span>
        <ChevronDownIcon
          className={cn(
            "w-4 h-4 text-[var(--d-text-tertiary)] transition-transform flex-shrink-0",
            isOpen && "rotate-180"
          )}
        />
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div
          className="absolute z-50 mt-1 bg-[var(--d-bg-surface)] border border-[var(--d-border)] rounded-lg shadow-[var(--d-shadow-dropdown)] overflow-hidden"
          style={{ width: dropdownWidth ?? "100%", minWidth: "200px" }}
        >
          {/* Search input */}
          <div className="p-2 border-b border-[var(--d-border)]">
            <div className="relative">
              <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--d-text-tertiary)]" />
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={searchPlaceholder}
                className="w-full pl-8 pr-3 py-1.5 text-[13px] border border-[var(--d-border)] rounded bg-[var(--d-bg-surface)] text-[var(--d-text-primary)] placeholder:text-[var(--d-text-tertiary)] focus:outline-none focus:border-[var(--d-border-strong)]"
              />
            </div>
          </div>

          {/* Content */}
          <div className="max-h-[280px] overflow-y-auto">
            {loading && (
              <div className="px-3 py-4 text-[13px] text-[var(--d-text-tertiary)] text-center">
                {loadingMessage}
              </div>
            )}

            {error && (
              <div className="px-3 py-4 text-[13px] text-[var(--d-error)] text-center">
                {error}
              </div>
            )}

            {!loading && !error && (
              <>
                {isSectioned(filteredOptions)
                  ? filteredOptions.map((section) => (
                      <div key={section.title}>
                        {renderSectionHeader(section.title)}
                        {section.options.map(renderOption)}
                      </div>
                    ))
                  : (filteredOptions as SearchableDropdownOption<T>[]).map(renderOption)}

                {/* Empty state */}
                {!hasResults && search.trim() && (
                  <div className="px-3 py-4 text-center">
                    <div className="text-[13px] text-[var(--d-text-tertiary)] mb-2">
                      {emptyMessage}
                    </div>
                    {allowCustom && (
                      <button
                        type="button"
                        onClick={() => handleSelect(search.trim() as T)}
                        className="text-[13px] text-[var(--d-primary)] hover:opacity-80 transition-opacity"
                      >
                        {customPrompt(search)}
                      </button>
                    )}
                  </div>
                )}

                {/* Empty when no search */}
                {!hasResults && !search.trim() && (
                  <div className="px-3 py-4 text-[13px] text-[var(--d-text-tertiary)] text-center">
                    {emptyMessage}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

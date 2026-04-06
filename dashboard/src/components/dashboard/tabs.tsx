"use client";

/**
 * Dashboard Tabs Component
 *
 * A unified tab component for dashboard navigation.
 * Dashboard tab navigation with segment, underline, and contained variants.
 *
 * @example
 * // Segment tabs (default)
 * <Tabs
 *   tabs={[
 *     { id: 'overview', label: 'Overview' },
 *     { id: 'settings', label: 'Settings' },
 *   ]}
 *   activeTab="overview"
 *   onTabChange={(id) => setActiveTab(id)}
 * />
 *
 * // Underline variant
 * <Tabs variant="underline" tabs={...} />
 *
 * // Contained variant (for sidebars)
 * <Tabs variant="contained" size="sm" tabs={...} />
 */

import { useId, useRef, useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/design";

// =============================================================================
// TYPES
// =============================================================================

export type TabItem<T extends string = string> = {
  /** Unique identifier */
  id: T;
  /** Display label */
  label: string;
  /** Optional icon */
  icon?: ReactNode;
  /** Disabled state */
  disabled?: boolean;
  /** Badge content (number or string) */
  badge?: string | number;
};

type TabsVariant = "segment" | "underline" | "contained";
type TabsSize = "sm" | "md";

export type TabsProps<T extends string = string> = {
  /** Tab items */
  tabs: TabItem<T>[];
  /** Currently active tab ID */
  activeTab: T;
  /** Called when tab changes */
  onTabChange: (id: T) => void;
  /** Visual variant */
  variant?: TabsVariant;
  /** Size preset */
  size?: TabsSize;
  /** Full width tabs */
  fullWidth?: boolean;
  /** Additional container className */
  className?: string;
  /** Accessible label for the tablist */
  "aria-label"?: string;
};

// =============================================================================
// STYLES
// =============================================================================

const containerStyles: Record<TabsVariant, string> = {
  segment: "inline-flex gap-1",
  underline: "inline-flex gap-0 border-b border-[var(--d-border-subtle)]",
  contained: "inline-flex gap-0.5 p-0.5 bg-[var(--d-bg-hover)] rounded-lg",
};

const tabBaseStyles = [
  "relative inline-flex items-center justify-center gap-1.5",
  "font-medium whitespace-nowrap",
  "transition-all duration-150 ease-out",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--d-border-focus)] focus-visible:ring-offset-1",
  "disabled:pointer-events-none disabled:opacity-50",
].join(" ");

const variantTabStyles: Record<TabsVariant, { active: string; inactive: string }> = {
  segment: {
    active: "bg-[var(--d-tabs-active-bg)] text-[var(--d-tabs-active)]",
    inactive: "text-[var(--d-tabs-inactive)] hover:text-[var(--d-text-primary)] hover:bg-[var(--d-bg-hover)]",
  },
  underline: {
    active: "text-[var(--d-tabs-active)] border-b-2 border-[var(--d-tabs-active)] -mb-px",
    inactive: "text-[var(--d-tabs-inactive)] hover:text-[var(--d-text-primary)] border-b-2 border-transparent -mb-px",
  },
  contained: {
    active: "bg-[var(--d-bg-surface)] text-[var(--d-text-primary)] shadow-sm",
    inactive: "text-[var(--d-tabs-inactive)] hover:text-[var(--d-text-primary)]",
  },
};

const sizeStyles: Record<TabsSize, { container: string; tab: string }> = {
  sm: {
    container: "",
    tab: "px-2.5 py-1 text-[12px] rounded-md",
  },
  md: {
    container: "",
    tab: "px-3.5 py-1.5 text-[13px] rounded-lg",
  },
};

// Special size adjustments for underline variant
const underlineSizeStyles: Record<TabsSize, string> = {
  sm: "px-3 py-2 text-[12px]",
  md: "px-4 py-2.5 text-[13px]",
};

// =============================================================================
// BADGE
// =============================================================================

function TabBadge({ content }: { content: string | number }) {
  return (
    <span className="ml-1 px-1.5 py-0.5 text-[10px] font-medium bg-[var(--d-bg-active)] text-[var(--d-text-secondary)] rounded-full">
      {content}
    </span>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function Tabs<T extends string = string>({
  tabs,
  activeTab,
  onTabChange,
  variant = "segment",
  size = "md",
  fullWidth = false,
  className,
  "aria-label": ariaLabel,
}: TabsProps<T>) {
  const id = useId();
  const tablistRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);

  // Reset focused index when active tab changes
  useEffect(() => {
    setFocusedIndex(-1);
  }, [activeTab]);

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent, currentIndex: number) => {
    const enabledTabs = tabs.filter((t) => !t.disabled);
    const enabledIndices = tabs
      .map((t, i) => (!t.disabled ? i : -1))
      .filter((i) => i !== -1);
    const currentEnabledIndex = enabledIndices.indexOf(currentIndex);

    let nextIndex: number | null = null;

    switch (e.key) {
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        nextIndex = enabledIndices[
          currentEnabledIndex > 0
            ? currentEnabledIndex - 1
            : enabledIndices.length - 1
        ];
        break;
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        nextIndex = enabledIndices[
          currentEnabledIndex < enabledIndices.length - 1
            ? currentEnabledIndex + 1
            : 0
        ];
        break;
      case "Home":
        e.preventDefault();
        nextIndex = enabledIndices[0];
        break;
      case "End":
        e.preventDefault();
        nextIndex = enabledIndices[enabledIndices.length - 1];
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        onTabChange(tabs[currentIndex].id);
        break;
    }

    if (nextIndex !== null) {
      setFocusedIndex(nextIndex);
      const buttons = tablistRef.current?.querySelectorAll('[role="tab"]');
      (buttons?.[nextIndex] as HTMLButtonElement)?.focus();
    }
  };

  const sizeConfig = sizeStyles[size];
  const variantConfig = variantTabStyles[variant];

  return (
    <div
      ref={tablistRef}
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        containerStyles[variant],
        sizeConfig.container,
        fullWidth && "w-full",
        className
      )}
    >
      {tabs.map((tab, index) => {
        const isActive = tab.id === activeTab;
        const tabId = `${id}-tab-${tab.id}`;
        const panelId = `${id}-panel-${tab.id}`;

        // Use underline-specific sizes if needed
        const tabSizeClass = variant === "underline"
          ? underlineSizeStyles[size]
          : sizeConfig.tab;

        return (
          <button
            key={tab.id}
            id={tabId}
            role="tab"
            type="button"
            tabIndex={isActive ? 0 : -1}
            aria-selected={isActive}
            aria-controls={panelId}
            aria-disabled={tab.disabled}
            disabled={tab.disabled}
            onClick={() => onTabChange(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={cn(
              tabBaseStyles,
              tabSizeClass,
              isActive ? variantConfig.active : variantConfig.inactive,
              fullWidth && "flex-1",
              variant === "underline" && "rounded-none"
            )}
          >
            {tab.icon && <span className="[&>svg]:w-4 [&>svg]:h-4">{tab.icon}</span>}
            <span>{tab.label}</span>
            {tab.badge !== undefined && <TabBadge content={tab.badge} />}
          </button>
        );
      })}
    </div>
  );
}

// =============================================================================
// TAB PANEL (for content association)
// =============================================================================

export type TabPanelProps = {
  /** Tab ID this panel belongs to */
  tabId: string;
  /** Whether this panel is active */
  active: boolean;
  /** Panel content */
  children: ReactNode;
  /** Additional className */
  className?: string;
  /** Whether to unmount when inactive (default: false = hidden) */
  unmountOnHide?: boolean;
};

export function TabPanel({
  tabId,
  active,
  children,
  className,
  unmountOnHide = false,
}: TabPanelProps) {
  if (unmountOnHide && !active) {
    return null;
  }

  return (
    <div
      id={`panel-${tabId}`}
      role="tabpanel"
      aria-labelledby={`tab-${tabId}`}
      hidden={!active}
      className={cn(active ? "block" : "hidden", className)}
    >
      {children}
    </div>
  );
}

// =============================================================================
// COMPOUND COMPONENT PATTERN
// =============================================================================

export type TabsContainerProps<T extends string = string> = TabsProps<T> & {
  /** Tab content as children (must be TabPanel components) */
  children: ReactNode;
  /** Container className for the panels area */
  panelClassName?: string;
};

export function TabsContainer<T extends string = string>({
  children,
  panelClassName,
  ...tabsProps
}: TabsContainerProps<T>) {
  return (
    <div className="flex flex-col">
      <Tabs {...tabsProps} />
      <div className={cn("mt-4", panelClassName)}>
        {children}
      </div>
    </div>
  );
}

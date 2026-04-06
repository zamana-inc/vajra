"use client";

/**
 * Dashboard Sidebar Component
 *
 * A slide-in panel for displaying detail views, debug info, etc.
 * Uses dashboard design tokens for consistent styling.
 *
 * @example
 * // Basic usage
 * <Sidebar
 *   title="Details"
 *   isOpen={isOpen}
 *   onClose={() => setIsOpen(false)}
 * >
 *   <SidebarSection title="Info">
 *     <p>Content here</p>
 *   </SidebarSection>
 * </Sidebar>
 *
 * // With tabs
 * <Sidebar
 *   title="Exploration"
 *   isOpen={isOpen}
 *   onClose={onClose}
 *   tabs={[
 *     { id: 'details', label: 'Details' },
 *     { id: 'raw', label: 'Raw' },
 *   ]}
 *   activeTab={activeTab}
 *   onTabChange={setActiveTab}
 * >
 *   {activeTab === 'details' ? <DetailsContent /> : <RawContent />}
 * </Sidebar>
 */

import {
  useEffect,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn, trapFocus } from "@/lib/design";
import { Tabs, type TabItem } from "./tabs";
import { CloseIcon } from "@/components/ui/icons";

// =============================================================================
// TYPES
// =============================================================================

type SidebarPosition = "right" | "left";
type SidebarSize = "sm" | "md" | "lg";

export type SidebarProps<T extends string = string> = {
  /** Sidebar title */
  title: string;
  /** Whether the sidebar is open */
  isOpen: boolean;
  /** Called when sidebar should close */
  onClose: () => void;
  /** Position of sidebar */
  position?: SidebarPosition;
  /** Width preset */
  size?: SidebarSize;
  /** Tab configuration (optional) */
  tabs?: TabItem<T>[];
  /** Active tab ID (required if tabs provided) */
  activeTab?: T;
  /** Tab change handler (required if tabs provided) */
  onTabChange?: (id: T) => void;
  /** Sidebar content */
  children: ReactNode;
  /** Whether to show backdrop */
  backdrop?: boolean;
  /** Additional className for content area */
  className?: string;
  /** Render in portal (default: true) */
  portal?: boolean;
};

// =============================================================================
// STYLES
// =============================================================================

const sizeStyles: Record<SidebarSize, string> = {
  sm: "w-full sm:max-w-xs", // 320px
  md: "w-full sm:max-w-sm", // 384px
  lg: "w-full sm:max-w-md", // 448px
};

const positionStyles: Record<SidebarPosition, { open: string; closed: string }> = {
  right: {
    open: "translate-x-0",
    closed: "translate-x-full",
  },
  left: {
    open: "translate-x-0",
    closed: "-translate-x-full",
  },
};

// =============================================================================
// COMPONENT
// =============================================================================

export function Sidebar<T extends string = string>({
  title,
  isOpen,
  onClose,
  position = "right",
  size = "md",
  tabs,
  activeTab,
  onTabChange,
  children,
  backdrop = true,
  className,
  portal = true,
}: SidebarProps<T>) {
  const [isVisible, setIsVisible] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);

  // Mount state for portal
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Handle open/close animation
  useEffect(() => {
    if (isOpen) {
      // Small delay to trigger CSS transition
      const timer = setTimeout(() => setIsVisible(true), 10);
      return () => clearTimeout(timer);
    } else {
      setIsVisible(false);
    }
  }, [isOpen]);

  // Handle close animation completion
  const handleClose = useCallback(() => {
    setIsVisible(false);
    // Wait for animation to complete
    setTimeout(onClose, 200);
  }, [onClose]);

  // Close on escape
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
      }
      // Trap focus within sidebar
      if (e.key === "Tab" && sidebarRef.current) {
        trapFocus(sidebarRef.current, e);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleClose]);

  // Prevent body scroll when open
  useEffect(() => {
    if (isOpen) {
      const originalOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = originalOverflow;
      };
    }
  }, [isOpen]);

  // Focus management
  useEffect(() => {
    if (isOpen && sidebarRef.current) {
      const firstFocusable = sidebarRef.current.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      firstFocusable?.focus();
    }
  }, [isOpen]);

  if (!isOpen && !isVisible) return null;

  const positionConfig = positionStyles[position];

  const content = (
    <div
      className={cn(
        "fixed inset-0 z-50",
        position === "right" ? "flex justify-end" : "flex justify-start"
      )}
      role="dialog"
      aria-modal="true"
      aria-labelledby="sidebar-title"
    >
      {/* Backdrop */}
      {backdrop && (
        <div
          className={cn(
            "absolute inset-0 bg-black transition-opacity duration-200",
            isVisible ? "opacity-40" : "opacity-0"
          )}
          onClick={handleClose}
          aria-hidden="true"
        />
      )}

      {/* Sidebar Panel */}
      <div
        ref={sidebarRef}
        className={cn(
          "relative h-full flex flex-col",
          "bg-[var(--d-sidebar-bg)]",
          "shadow-[var(--d-shadow-sidebar)]",
          "transition-transform duration-200 ease-out",
          sizeStyles[size],
          isVisible ? positionConfig.open : positionConfig.closed
        )}
      >
        {/* Header */}
        <div className="flex-shrink-0 bg-[var(--d-bg-surface)] border-b border-[var(--d-border-subtle)]">
          <div className="flex items-center justify-between px-4 py-3">
            <h2
              id="sidebar-title"
              className="text-[16px] font-semibold text-[var(--d-text-primary)]"
            >
              {title}
            </h2>
            <button
              onClick={handleClose}
              className={cn(
                "p-1.5 rounded-lg",
                "text-[var(--d-text-tertiary)]",
                "hover:bg-[var(--d-bg-hover)] hover:text-[var(--d-text-primary)]",
                "transition-colors duration-150"
              )}
              aria-label="Close sidebar"
            >
              <CloseIcon className="w-5 h-5" />
            </button>
          </div>

          {/* Tabs (optional) */}
          {tabs && tabs.length > 0 && activeTab && onTabChange && (
            <div className="px-4 pb-2">
              <Tabs
                tabs={tabs}
                activeTab={activeTab}
                onTabChange={onTabChange}
                variant="contained"
                size="sm"
                fullWidth
              />
            </div>
          )}
        </div>

        {/* Content */}
        <div className={cn("flex-1 overflow-y-auto", className)}>
          {children}
        </div>
      </div>
    </div>
  );

  // Portal to body for proper z-index stacking
  if (portal && isMounted) {
    return createPortal(content, document.body);
  }

  return content;
}

// =============================================================================
// SIDEBAR SECTION
// =============================================================================

export type SidebarSectionProps = {
  /** Section title */
  title?: string;
  /** Whether section is collapsible */
  collapsible?: boolean;
  /** Default collapsed state */
  defaultCollapsed?: boolean;
  /** Section content */
  children: ReactNode;
  /** Additional className */
  className?: string;
};

export function SidebarSection({
  title,
  collapsible = false,
  defaultCollapsed = false,
  children,
  className,
}: SidebarSectionProps) {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);

  return (
    <div className={cn("px-4 py-3", className)}>
      {title && (
        <div className="flex items-center justify-between mb-2">
          {collapsible ? (
            <button
              onClick={() => setIsCollapsed(!isCollapsed)}
              className={cn(
                "flex items-center gap-1.5 w-full",
                "text-[11px] font-semibold uppercase tracking-wide",
                "text-[var(--d-text-tertiary)]",
                "hover:text-[var(--d-text-secondary)]",
                "transition-colors duration-150"
              )}
            >
              <svg
                className={cn(
                  "w-3.5 h-3.5 transition-transform duration-150",
                  isCollapsed ? "-rotate-90" : "rotate-0"
                )}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
              <span>{title}</span>
            </button>
          ) : (
            <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--d-text-tertiary)]">
              {title}
            </span>
          )}
        </div>
      )}
      {(!collapsible || !isCollapsed) && children}
    </div>
  );
}

// =============================================================================
// SIDEBAR CONTENT CARD
// =============================================================================

export type SidebarCardProps = {
  children: ReactNode;
  className?: string;
};

export function SidebarCard({ children, className }: SidebarCardProps) {
  return (
    <div
      className={cn(
        "p-3 rounded-lg",
        "bg-[var(--d-bg-surface)]",
        "border border-[var(--d-border-subtle)]",
        className
      )}
    >
      {children}
    </div>
  );
}

// =============================================================================
// SIDEBAR STAT ROW
// =============================================================================

export type SidebarStatProps = {
  label: string;
  value: ReactNode;
  className?: string;
};

export function SidebarStat({ label, value, className }: SidebarStatProps) {
  return (
    <div className={cn("flex justify-between items-center py-1", className)}>
      <span className="text-[13px] text-[var(--d-text-tertiary)]">{label}</span>
      <span className="text-[13px] text-[var(--d-text-primary)] font-medium">{value}</span>
    </div>
  );
}

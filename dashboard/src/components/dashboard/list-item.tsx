"use client";

/**
 * Dashboard List Item Component
 *
 * A consistent clickable list row for navigation lists in the dashboard.
 * Used in sidebars, config lists, user lists, etc.
 *
 * @example
 * // Basic usage
 * <ListItem
 *   title="User Name"
 *   subtitle="user@example.com"
 *   selected={isSelected}
 *   onClick={() => handleSelect(user)}
 * />
 *
 * // With avatar
 * <ListItem
 *   avatar={{ initials: "JD", color: "#007aff" }}
 *   title="John Doe"
 *   onClick={...}
 * />
 *
 * // With trailing content
 * <ListItem
 *   title="Config v1.0"
 *   trailing={<CheckIcon className="text-green-500" />}
 * />
 *
 * // With actions on hover
 * <ListItem
 *   title="Item"
 *   actions={[
 *     { icon: <TrashIcon />, onClick: handleDelete, label: "Delete" }
 *   ]}
 * />
 */

import { forwardRef, type ReactNode, type ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/design";

// =============================================================================
// TYPES
// =============================================================================

type ListItemVariant = "default" | "compact";

type AvatarConfig = {
  /** Initials to display (1-2 chars) */
  initials: string;
  /** Background color */
  color?: string;
  /** Image URL (takes precedence over initials) */
  imageUrl?: string;
};

type ActionConfig = {
  /** Icon to display */
  icon: ReactNode;
  /** Click handler */
  onClick: (e: React.MouseEvent) => void;
  /** Accessible label */
  label: string;
  /** Destructive action (red color) */
  destructive?: boolean;
};

export type ListItemProps = {
  /** Primary text */
  title: string;
  /** Secondary text */
  subtitle?: string;
  /** Tertiary text (timestamp, etc.) */
  meta?: string;
  /** Avatar configuration */
  avatar?: AvatarConfig;
  /** Leading icon (alternative to avatar) */
  leadingIcon?: ReactNode;
  /** Trailing content (checkmark, badge, etc.) */
  trailing?: ReactNode;
  /** Actions shown on hover */
  actions?: ActionConfig[];
  /** Selected state */
  selected?: boolean;
  /** Disabled state */
  disabled?: boolean;
  /** Visual variant */
  variant?: ListItemVariant;
  /** Additional className */
  className?: string;
} & Omit<ComponentPropsWithoutRef<"div">, "title">;

// =============================================================================
// STYLES
// =============================================================================

const baseStyles = [
  "w-full text-left",
  "flex items-center gap-3",
  "transition-colors duration-150 ease-out",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--d-border-focus)] focus-visible:ring-inset",
  "disabled:opacity-50 disabled:pointer-events-none",
  "group",
].join(" ");

const variantStyles: Record<ListItemVariant, { base: string; selected: string }> = {
  default: {
    base: "px-4 py-2.5 hover:bg-[var(--d-bg-hover)]",
    selected: "bg-[var(--d-bg-selected-strong)] border-l-2 border-[var(--d-primary)]",
  },
  compact: {
    base: "px-3 py-2 hover:bg-[var(--d-bg-hover)]",
    selected: "bg-[var(--d-bg-selected)] border-l-2 border-[var(--d-primary)]",
  },
};

// =============================================================================
// AVATAR
// =============================================================================

function Avatar({ config, size }: { config: AvatarConfig; size: "sm" | "md" }) {
  const sizeClasses = size === "sm" ? "w-8 h-8 text-[12px]" : "w-10 h-10 text-[14px]";

  if (config.imageUrl) {
    return (
      <img
        src={config.imageUrl}
        alt=""
        className={cn(sizeClasses, "rounded-full object-cover flex-shrink-0")}
      />
    );
  }

  return (
    <div
      className={cn(
        sizeClasses,
        "rounded-full flex items-center justify-center flex-shrink-0 font-semibold text-white"
      )}
      style={{ backgroundColor: config.color || "var(--d-primary)" }}
    >
      {config.initials}
    </div>
  );
}

// =============================================================================
// ACTION BUTTON
// =============================================================================

function ActionButton({ action }: { action: ActionConfig }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        action.onClick(e);
      }}
      className={cn(
        "p-1.5 rounded-md transition-all duration-150",
        "opacity-0 group-hover:opacity-100",
        action.destructive
          ? "text-[var(--d-destructive)] hover:bg-[var(--d-destructive-bg)]"
          : "text-[var(--d-text-tertiary)] hover:bg-[var(--d-bg-hover)] hover:text-[var(--d-text-primary)]"
      )}
      aria-label={action.label}
      title={action.label}
    >
      <span className="[&>svg]:w-3.5 [&>svg]:h-3.5">{action.icon}</span>
    </button>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export const ListItem = forwardRef<HTMLDivElement, ListItemProps>(
  function ListItem(props, ref) {
    const {
      title,
      subtitle,
      meta,
      avatar,
      leadingIcon,
      trailing,
      actions,
      selected = false,
      disabled = false,
      variant = "default",
      className,
      onClick,
      ...rest
    } = props;

    const variantConfig = variantStyles[variant];
    const avatarSize = variant === "compact" ? "sm" : "md";

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick?.(e as unknown as React.MouseEvent<HTMLDivElement>);
      }
    };

    return (
      <div
        ref={ref}
        role="option"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        className={cn(
          baseStyles,
          variantConfig.base,
          selected && variantConfig.selected,
          !selected && "border-l-2 border-transparent",
          disabled && "cursor-not-allowed",
          !disabled && "cursor-pointer",
          className
        )}
        aria-selected={selected}
        onClick={disabled ? undefined : onClick}
        onKeyDown={handleKeyDown}
        {...rest}
      >
        {/* Avatar or Leading Icon */}
        {avatar && <Avatar config={avatar} size={avatarSize} />}
        {!avatar && leadingIcon && (
          <span className="flex-shrink-0 [&>svg]:w-5 [&>svg]:h-5 text-[var(--d-text-tertiary)]">
            {leadingIcon}
          </span>
        )}

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span
              className={cn(
                "text-[14px] font-medium truncate",
                selected ? "text-[var(--d-primary)]" : "text-[var(--d-text-primary)]"
              )}
            >
              {title}
            </span>
            {meta && (
              <span className="text-[11px] text-[var(--d-text-tertiary)] flex-shrink-0">
                {meta}
              </span>
            )}
          </div>
          {subtitle && (
            <p className="text-[12px] text-[var(--d-text-tertiary)] truncate mt-0.5">
              {subtitle}
            </p>
          )}
        </div>

        {/* Trailing Content */}
        {trailing && (
          <span className="flex-shrink-0 [&>svg]:w-4 [&>svg]:h-4">
            {trailing}
          </span>
        )}

        {/* Actions */}
        {actions && actions.length > 0 && (
          <div className="flex items-center gap-0.5 flex-shrink-0">
            {actions.map((action, index) => (
              <ActionButton key={index} action={action} />
            ))}
          </div>
        )}
      </div>
    );
  }
);

// =============================================================================
// LIST CONTAINER
// =============================================================================

export type ListProps = {
  children: ReactNode;
  /** Dividers between items */
  dividers?: boolean;
  /** Empty state content */
  emptyState?: ReactNode;
  /** Additional className */
  className?: string;
};

export function List({ children, dividers = false, emptyState, className }: ListProps) {
  // Check if children is empty
  const childArray = Array.isArray(children) ? children : [children];
  const hasContent = childArray.some((child) => child != null && child !== false);

  if (!hasContent && emptyState) {
    return (
      <div className="px-4 py-8 text-center text-[13px] text-[var(--d-text-tertiary)]">
        {emptyState}
      </div>
    );
  }

  return (
    <div
      role="listbox"
      className={cn(
        "flex flex-col",
        dividers && "[&>*:not(:last-child)]:border-b [&>*:not(:last-child)]:border-[var(--d-border-subtle)]",
        className
      )}
    >
      {children}
    </div>
  );
}

// =============================================================================
// LIST SECTION
// =============================================================================

export type ListSectionProps = {
  /** Section title */
  title?: string;
  /** Section content */
  children: ReactNode;
  /** Additional className */
  className?: string;
};

export function ListSection({ title, children, className }: ListSectionProps) {
  return (
    <div className={className}>
      {title && (
        <div className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--d-text-tertiary)]">
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

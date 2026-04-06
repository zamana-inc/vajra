"use client";

/**
 * Dashboard Button Component
 *
 * A polymorphic button primitive with multiple variants and sizes.
 * Dashboard button component with multiple variants and sizes.
 *
 * @example
 * // Primary action
 * <Button>Save Changes</Button>
 *
 * // Secondary outline
 * <Button variant="secondary">Cancel</Button>
 *
 * // Ghost with icon
 * <Button variant="ghost" size="sm" icon={<PlusIcon />}>Add Item</Button>
 *
 * // Destructive
 * <Button variant="destructive">Delete</Button>
 *
 * // As link
 * <Button as="a" href="/settings">Settings</Button>
 */

import { forwardRef, type ReactNode, type ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/design";

// =============================================================================
// TYPES
// =============================================================================

type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive" | "link";
type ButtonSize = "sm" | "md" | "lg";

type ButtonBaseProps = {
  /** Visual variant */
  variant?: ButtonVariant;
  /** Size preset */
  size?: ButtonSize;
  /** Icon to display (left side by default) */
  icon?: ReactNode;
  /** Icon position */
  iconPosition?: "left" | "right";
  /** Loading state - shows spinner and disables interaction */
  loading?: boolean;
  /** Full width */
  fullWidth?: boolean;
  /** Children content */
  children?: ReactNode;
};

type ButtonAsButton = ButtonBaseProps &
  Omit<ComponentPropsWithoutRef<"button">, keyof ButtonBaseProps> & {
    as?: "button";
  };

type ButtonAsAnchor = ButtonBaseProps &
  Omit<ComponentPropsWithoutRef<"a">, keyof ButtonBaseProps> & {
    as: "a";
  };

type ButtonAsSpan = ButtonBaseProps &
  Omit<ComponentPropsWithoutRef<"span">, keyof ButtonBaseProps> & {
    as: "span";
  };

export type ButtonProps = ButtonAsButton | ButtonAsAnchor | ButtonAsSpan;

// =============================================================================
// STYLES
// =============================================================================

const baseStyles = [
  // Layout
  "inline-flex items-center justify-center gap-2",
  // Typography
  "font-medium whitespace-nowrap",
  // Transitions
  "transition-all duration-150 ease-out",
  // Focus
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--d-border-focus)] focus-visible:ring-offset-2",
  // Disabled
  "disabled:pointer-events-none disabled:opacity-50",
].join(" ");

const variantStyles: Record<ButtonVariant, string> = {
  primary: [
    "bg-[var(--d-primary)] text-white",
    "hover:bg-[var(--d-primary-hover)]",
    "active:bg-[var(--d-primary-active)]",
    "shadow-sm",
  ].join(" "),

  secondary: [
    "bg-transparent text-[var(--d-primary)]",
    "border border-[var(--d-primary)]",
    "hover:bg-[var(--d-secondary-hover)]",
    "active:bg-[var(--d-bg-active)]",
  ].join(" "),

  ghost: [
    "bg-transparent text-[var(--d-text-secondary)]",
    "hover:bg-[var(--d-ghost-hover)] hover:text-[var(--d-text-primary)]",
    "active:bg-[var(--d-ghost-active)]",
  ].join(" "),

  destructive: [
    "bg-[var(--d-destructive)] text-white",
    "hover:bg-[var(--d-destructive-hover)]",
    "active:opacity-90",
    "shadow-sm",
  ].join(" "),

  link: [
    "bg-transparent text-[var(--d-text-link)] underline-offset-2",
    "hover:underline hover:text-[var(--d-text-link-hover)]",
    "p-0 h-auto",
  ].join(" "),
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-[12px] rounded-md",
  md: "h-8 px-3 text-[13px] rounded-lg",
  lg: "h-10 px-4 text-[14px] rounded-lg",
};

const iconSizeStyles: Record<ButtonSize, string> = {
  sm: "[&>svg]:w-3.5 [&>svg]:h-3.5",
  md: "[&>svg]:w-4 [&>svg]:h-4",
  lg: "[&>svg]:w-5 [&>svg]:h-5",
};

// =============================================================================
// LOADING SPINNER
// =============================================================================

function LoadingSpinner({ size }: { size: ButtonSize }) {
  const spinnerSize = {
    sm: "w-3 h-3",
    md: "w-3.5 h-3.5",
    lg: "w-4 h-4",
  }[size];

  return (
    <svg
      className={cn(spinnerSize, "animate-spin")}
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export const Button = forwardRef<
  HTMLButtonElement | HTMLAnchorElement | HTMLSpanElement,
  ButtonProps
>(function Button(props, ref) {
  const {
    as = "button",
    variant = "primary",
    size = "md",
    icon,
    iconPosition = "left",
    loading = false,
    fullWidth = false,
    className,
    children,
    ...rest
  } = props;

  // Extract disabled from rest for button elements
  const disabled = as === "button" ? (rest as ComponentPropsWithoutRef<"button">).disabled : false;

  const classes = cn(
    baseStyles,
    variant !== "link" && sizeStyles[size],
    variantStyles[variant],
    iconSizeStyles[size],
    fullWidth && "w-full",
    className
  );

  const content = (
    <>
      {loading ? (
        <LoadingSpinner size={size} />
      ) : (
        icon && iconPosition === "left" && icon
      )}
      {children && <span>{children}</span>}
      {!loading && icon && iconPosition === "right" && icon}
    </>
  );

  // Render as anchor
  if (as === "a") {
    const anchorProps = rest as ComponentPropsWithoutRef<"a">;
    return (
      <a
        ref={ref as React.Ref<HTMLAnchorElement>}
        className={classes}
        {...anchorProps}
      >
        {content}
      </a>
    );
  }

  // Render as span
  if (as === "span") {
    const spanProps = rest as ComponentPropsWithoutRef<"span">;
    return (
      <span
        ref={ref as React.Ref<HTMLSpanElement>}
        className={classes}
        {...spanProps}
      >
        {content}
      </span>
    );
  }

  // Render as button (default)
  const buttonProps = rest as ComponentPropsWithoutRef<"button">;
  return (
    <button
      ref={ref as React.Ref<HTMLButtonElement>}
      type={buttonProps.type ?? "button"}
      disabled={disabled || loading}
      className={classes}
      {...buttonProps}
    >
      {content}
    </button>
  );
});

// =============================================================================
// ICON BUTTON VARIANT
// =============================================================================

type IconButtonProps = Omit<ButtonBaseProps, "icon" | "iconPosition" | "children"> & {
  /** Icon to display */
  icon: ReactNode;
  /** Accessible label */
  "aria-label": string;
} & Omit<ComponentPropsWithoutRef<"button">, keyof ButtonBaseProps | "children">;

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(props, ref) {
    const {
      variant = "ghost",
      size = "md",
      icon,
      className,
      ...rest
    } = props;

    const sizeClasses = {
      sm: "w-7 h-7",
      md: "w-8 h-8",
      lg: "w-10 h-10",
    }[size];

    return (
      <button
        ref={ref}
        type="button"
        className={cn(
          baseStyles,
          variantStyles[variant],
          iconSizeStyles[size],
          sizeClasses,
          "rounded-lg p-0",
          className
        )}
        {...rest}
      >
        {icon}
      </button>
    );
  }
);

// =============================================================================
// BUTTON GROUP
// =============================================================================

type ButtonGroupProps = {
  children: ReactNode;
  /** Orientation */
  orientation?: "horizontal" | "vertical";
  /** Gap between buttons */
  gap?: "none" | "sm" | "md";
  className?: string;
};

export function ButtonGroup({
  children,
  orientation = "horizontal",
  gap = "sm",
  className,
}: ButtonGroupProps) {
  const gapClasses = {
    none: "gap-0",
    sm: "gap-2",
    md: "gap-3",
  }[gap];

  const orientationClasses = {
    horizontal: "flex-row",
    vertical: "flex-col",
  }[orientation];

  // For gap-none, attach buttons with shared borders
  const attachedStyles =
    gap === "none"
      ? [
          "[&>*]:rounded-none",
          orientation === "horizontal"
            ? "[&>*:first-child]:rounded-l-lg [&>*:last-child]:rounded-r-lg [&>*:not(:first-child)]:border-l-0"
            : "[&>*:first-child]:rounded-t-lg [&>*:last-child]:rounded-b-lg [&>*:not(:first-child)]:border-t-0",
        ].join(" ")
      : "";

  return (
    <div
      className={cn(
        "inline-flex",
        orientationClasses,
        gapClasses,
        attachedStyles,
        className
      )}
    >
      {children}
    </div>
  );
}

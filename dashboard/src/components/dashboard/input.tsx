"use client";

/**
 * Dashboard Input Components
 *
 * Reusable form input components with consistent styling.
 */

import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/design";

// =============================================================================
// TYPES
// =============================================================================

type InputSize = "sm" | "md";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  size?: InputSize;
  error?: boolean;
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean;
}

// =============================================================================
// STYLES
// =============================================================================

const baseStyles = [
  "w-full",
  "text-[var(--d-text-primary)]",
  "bg-[var(--d-bg-surface)]",
  "border border-[var(--d-border)]",
  "rounded-lg",
  "placeholder:text-[var(--d-text-tertiary)]",
  "focus:outline-none focus:ring-2 focus:ring-[var(--d-border-focus)] focus:border-[var(--d-primary)]",
  "disabled:opacity-60 disabled:cursor-not-allowed",
  "transition-colors",
].join(" ");

const sizeStyles: Record<InputSize, string> = {
  sm: "px-2.5 py-1.5 text-[13px]",
  md: "px-3 py-2.5 text-[14px]",
};

// =============================================================================
// INPUT
// =============================================================================

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, size = "md", error, ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={cn(
          baseStyles,
          sizeStyles[size],
          error && "border-[var(--d-error)] focus:ring-[var(--d-error)]/20",
          className
        )}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";

// =============================================================================
// TEXTAREA
// =============================================================================

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, error, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={cn(
          baseStyles,
          "px-3 py-2.5 text-[14px] resize-none",
          error && "border-[var(--d-error)] focus:ring-[var(--d-error)]/20",
          className
        )}
        {...props}
      />
    );
  }
);
Textarea.displayName = "Textarea";

// =============================================================================
// FORM FIELD (Label + Input + Error)
// =============================================================================

export interface FormFieldProps {
  label: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}

export function FormField({ label, error, required, children, className }: FormFieldProps) {
  return (
    <div className={className}>
      <label className="block text-[13px] font-medium text-[var(--d-text-secondary)] mb-1.5">
        {label}
        {required && <span className="text-[var(--d-error)] ml-0.5">*</span>}
      </label>
      {children}
      {error && (
        <p className="mt-1.5 text-[12px] text-[var(--d-error)]">{error}</p>
      )}
    </div>
  );
}

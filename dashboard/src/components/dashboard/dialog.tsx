"use client";

/**
 * Dashboard Dialog Component
 *
 * Modal dialogs for the dashboard interface.
 * Uses side-by-side buttons in the footer.
 *
 * @example
 * // Confirmation dialog
 * <ConfirmDialog
 *   isOpen={showConfirm}
 *   onClose={() => setShowConfirm(false)}
 *   title="Delete Item?"
 *   description="This action cannot be undone."
 *   confirmLabel="Delete"
 *   onConfirm={handleDelete}
 *   destructive
 * />
 *
 * // Custom dialog
 * <Dialog isOpen={isOpen} onClose={onClose} title="Settings">
 *   <form onSubmit={handleSubmit}>
 *     <DialogBody>
 *       <input ... />
 *     </DialogBody>
 *     <DialogFooter>
 *       <Button variant="ghost" onClick={onClose}>Cancel</Button>
 *       <Button type="submit">Save</Button>
 *     </DialogFooter>
 *   </form>
 * </Dialog>
 */

import {
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn, trapFocus } from "@/lib/design";
import { Button } from "./button";
import { CloseIcon } from "@/components/ui/icons";

// =============================================================================
// TYPES
// =============================================================================

type DialogSize = "sm" | "md" | "lg" | "xl";

export type DialogProps = {
  /** Whether dialog is open */
  isOpen: boolean;
  /** Called when dialog should close */
  onClose: () => void;
  /** Dialog title */
  title?: string;
  /** Dialog description (for simple dialogs) */
  description?: string;
  /** Dialog content */
  children?: ReactNode;
  /** Size preset */
  size?: DialogSize;
  /** Whether clicking backdrop closes dialog */
  closeOnBackdropClick?: boolean;
  /** Additional className for dialog panel */
  className?: string;
};

// =============================================================================
// STYLES
// =============================================================================

const sizeStyles: Record<DialogSize, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-xl",
};

// =============================================================================
// BASE DIALOG
// =============================================================================

export function Dialog({
  isOpen,
  onClose,
  title,
  description,
  children,
  size = "md",
  closeOnBackdropClick = true,
  className,
}: DialogProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Mount state for portal
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Handle open/close animation
  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => setIsVisible(true), 10);
      return () => clearTimeout(timer);
    } else {
      setIsVisible(false);
    }
  }, [isOpen]);

  // Handle close animation completion
  const handleClose = useCallback(() => {
    setIsVisible(false);
    setTimeout(onClose, 150);
  }, [onClose]);

  // Close on escape
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
      }
      if (e.key === "Tab" && dialogRef.current) {
        trapFocus(dialogRef.current, e);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleClose]);

  // Prevent body scroll
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
    if (isOpen && dialogRef.current) {
      const firstFocusable = dialogRef.current.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      firstFocusable?.focus();
    }
  }, [isOpen]);

  if (!isOpen && !isVisible) return null;

  const content = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? "dialog-title" : undefined}
      aria-describedby={description ? "dialog-description" : undefined}
    >
      {/* Backdrop */}
      <div
        className={cn(
          "absolute inset-0 bg-black transition-opacity duration-150",
          isVisible ? "opacity-50" : "opacity-0"
        )}
        onClick={closeOnBackdropClick ? handleClose : undefined}
        aria-hidden="true"
      />

      {/* Dialog Panel */}
      <div
        ref={dialogRef}
        className={cn(
          "relative w-full",
          "bg-[var(--d-bg-surface)]",
          "rounded-xl",
          "shadow-[var(--d-shadow-modal)]",
          "transition-all duration-150 ease-out",
          isVisible
            ? "opacity-100 scale-100"
            : "opacity-0 scale-95",
          sizeStyles[size],
          className
        )}
      >
        {/* Header */}
        {title && (
          <div className="flex items-start justify-between px-5 pt-5 pb-0">
            <div>
              <h2
                id="dialog-title"
                className="text-[17px] font-semibold text-[var(--d-text-primary)]"
              >
                {title}
              </h2>
              {description && (
                <p
                  id="dialog-description"
                  className="mt-1 text-[14px] text-[var(--d-text-secondary)]"
                >
                  {description}
                </p>
              )}
            </div>
            <button
              onClick={handleClose}
              className={cn(
                "p-1.5 -mt-1 -mr-1 rounded-lg",
                "text-[var(--d-text-tertiary)]",
                "hover:bg-[var(--d-bg-hover)] hover:text-[var(--d-text-primary)]",
                "transition-colors duration-150"
              )}
              aria-label="Close dialog"
            >
              <CloseIcon className="w-5 h-5" />
            </button>
          </div>
        )}

        {/* Content */}
        {children}
      </div>
    </div>
  );

  if (portal && isMounted) {
    return createPortal(content, document.body);
  }

  return content;
}

// Portal flag (always true for Dialog)
const portal = true;

// =============================================================================
// DIALOG PARTS
// =============================================================================

export function DialogBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("px-5 py-4", className)}>{children}</div>;
}

export function DialogFooter({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-end gap-2",
        "px-5 py-4",
        "border-t border-[var(--d-border-subtle)]",
        "bg-[var(--d-bg-subtle)]",
        "rounded-b-xl",
        className
      )}
    >
      {children}
    </div>
  );
}

// =============================================================================
// CONFIRM DIALOG
// =============================================================================

export type ConfirmDialogProps = {
  /** Whether dialog is open */
  isOpen: boolean;
  /** Called when dialog should close */
  onClose: () => void;
  /** Dialog title */
  title: string;
  /** Dialog description */
  description?: string;
  /** Confirm button label */
  confirmLabel?: string;
  /** Cancel button label */
  cancelLabel?: string;
  /** Called when user confirms */
  onConfirm: () => void | Promise<void>;
  /** Whether this is a destructive action */
  destructive?: boolean;
  /** Loading state */
  loading?: boolean;
};

export function ConfirmDialog({
  isOpen,
  onClose,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  destructive = false,
  loading = false,
}: ConfirmDialogProps) {
  const [isLoading, setIsLoading] = useState(false);

  const handleConfirm = async () => {
    setIsLoading(true);
    try {
      await onConfirm();
      onClose();
    } finally {
      setIsLoading(false);
    }
  };

  const isProcessing = loading || isLoading;

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
    >
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={isProcessing}>
          {cancelLabel}
        </Button>
        <Button
          variant={destructive ? "destructive" : "primary"}
          onClick={handleConfirm}
          loading={isProcessing}
        >
          {confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

// =============================================================================
// ALERT DIALOG
// =============================================================================

export type AlertDialogProps = {
  /** Whether dialog is open */
  isOpen: boolean;
  /** Called when dialog should close */
  onClose: () => void;
  /** Dialog title */
  title: string;
  /** Dialog description */
  description?: string;
  /** Button label */
  buttonLabel?: string;
  /** Alert type */
  type?: "info" | "success" | "warning" | "error";
};

export function AlertDialog({
  isOpen,
  onClose,
  title,
  description,
  buttonLabel = "OK",
  type = "info",
}: AlertDialogProps) {
  const iconColor = {
    info: "text-[var(--d-info)]",
    success: "text-[var(--d-success)]",
    warning: "text-[var(--d-warning)]",
    error: "text-[var(--d-error)]",
  }[type];

  const bgColor = {
    info: "bg-[var(--d-info-bg)]",
    success: "bg-[var(--d-success-bg)]",
    warning: "bg-[var(--d-warning-bg)]",
    error: "bg-[var(--d-error-bg)]",
  }[type];

  return (
    <Dialog isOpen={isOpen} onClose={onClose} size="sm">
      <DialogBody className="text-center">
        <div
          className={cn(
            "w-12 h-12 mx-auto mb-3 rounded-full flex items-center justify-center",
            bgColor
          )}
        >
          <svg
            className={cn("w-6 h-6", iconColor)}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            {type === "success" ? (
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            ) : type === "error" ? (
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            ) : type === "warning" ? (
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            )}
          </svg>
        </div>
        <h3 className="text-[17px] font-semibold text-[var(--d-text-primary)] mb-1">
          {title}
        </h3>
        {description && (
          <p className="text-[14px] text-[var(--d-text-secondary)]">
            {description}
          </p>
        )}
      </DialogBody>
      <DialogFooter className="justify-center">
        <Button onClick={onClose}>{buttonLabel}</Button>
      </DialogFooter>
    </Dialog>
  );
}

// =============================================================================
// PROMPT DIALOG
// =============================================================================

export type PromptDialogProps = {
  /** Whether dialog is open */
  isOpen: boolean;
  /** Called when dialog should close */
  onClose: () => void;
  /** Dialog title */
  title: string;
  /** Dialog description */
  description?: string;
  /** Input label */
  inputLabel?: string;
  /** Input placeholder */
  placeholder?: string;
  /** Default value */
  defaultValue?: string;
  /** Confirm button label */
  confirmLabel?: string;
  /** Cancel button label */
  cancelLabel?: string;
  /** Called with input value on confirm */
  onConfirm: (value: string) => void | Promise<void>;
  /** Input validation */
  validate?: (value: string) => string | null;
};

export function PromptDialog({
  isOpen,
  onClose,
  title,
  description,
  inputLabel,
  placeholder,
  defaultValue = "",
  confirmLabel = "Submit",
  cancelLabel = "Cancel",
  onConfirm,
  validate,
}: PromptDialogProps) {
  const [value, setValue] = useState(defaultValue);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setValue(defaultValue);
      setError(null);
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 100);
    }
  }, [isOpen, defaultValue]);

  const handleSubmit = async () => {
    const trimmedValue = value.trim();

    if (validate) {
      const validationError = validate(trimmedValue);
      if (validationError) {
        setError(validationError);
        return;
      }
    }

    setIsLoading(true);
    try {
      await onConfirm(trimmedValue);
      onClose();
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !isLoading) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title={title} description={description} size="sm">
      <DialogBody>
        {inputLabel && (
          <label className="block text-[13px] font-medium text-[var(--d-text-secondary)] mb-1.5">
            {inputLabel}
          </label>
        )}
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className={cn(
            "w-full px-3 py-2 text-[14px]",
            "bg-[var(--d-bg-surface)] text-[var(--d-text-primary)]",
            "border rounded-lg",
            "focus:outline-none focus:ring-2 focus:ring-[var(--d-border-focus)]",
            error
              ? "border-[var(--d-error)]"
              : "border-[var(--d-border)]"
          )}
        />
        {error && (
          <p className="mt-1.5 text-[12px] text-[var(--d-error)]">{error}</p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={isLoading}>
          {cancelLabel}
        </Button>
        <Button onClick={handleSubmit} loading={isLoading}>
          {confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

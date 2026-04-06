/**
 * Design System Utilities
 *
 * Shared utility functions for the design system.
 * These consolidate duplicated logic across the codebase.
 */

// =============================================================================
// CLASS NAME UTILITY
// =============================================================================

/**
 * Merges class names, filtering out falsy values.
 * Lightweight alternative to clsx/classnames.
 *
 * @example
 * cn('base', isActive && 'active', className)
 * // => 'base active custom-class'
 */
export function cn(
  ...classes: (string | undefined | null | false | 0)[]
): string {
  return classes.filter((x): x is string => typeof x === 'string' && x.length > 0).join(' ');
}

// =============================================================================
// TIME FORMATTING
// =============================================================================

/**
 * Formats a date as relative time (e.g., "5m ago", "2d ago").
 * Consolidates duplicate implementations across the codebase.
 *
 * @param dateInput - ISO string or Date object
 * @returns Human-readable relative time string
 *
 * @example
 * formatRelativeTime('2024-01-15T10:30:00Z')
 * // => "5m ago" (if current time is 10:35)
 */
export function formatRelativeTime(dateInput: string | Date): string {
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);

  // Future dates
  if (diffMs < 0) {
    return 'in the future';
  }

  // Just now
  if (diffSecs < 60) {
    return 'just now';
  }

  // Minutes
  if (diffMins < 60) {
    return `${diffMins}m ago`;
  }

  // Hours
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  // Days (up to 7)
  if (diffDays < 7) {
    return `${diffDays}d ago`;
  }

  // Weeks (up to 4)
  if (diffWeeks < 4) {
    return `${diffWeeks}w ago`;
  }

  // Months (up to 12)
  if (diffMonths < 12) {
    return `${diffMonths}mo ago`;
  }

  // Fallback to formatted date
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Formats a date for display in lists/cards.
 * Shows time for today, day name for this week, date for older.
 *
 * @param dateInput - ISO string or Date object
 * @returns Formatted date string
 */
export function formatListDate(dateInput: string | Date): string {
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const dateDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  // Today: show time
  if (dateDay.getTime() === today.getTime()) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  // Yesterday
  if (dateDay.getTime() === yesterday.getTime()) {
    return 'Yesterday';
  }

  // This week: show day name
  const diffDays = Math.floor((today.getTime() - dateDay.getTime()) / 86400000);
  if (diffDays < 7) {
    return date.toLocaleDateString('en-US', { weekday: 'long' });
  }

  // This year: show month and day
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // Older: show full date
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// =============================================================================
// COLOR UTILITIES
// =============================================================================

/**
 * Generates a consistent color for an entity based on its ID.
 * Used for avatars, category indicators, etc.
 *
 * @param id - Unique identifier string
 * @returns Hex color string
 */
export function getEntityColor(id: string): string {
  // Curated palette of distinct, accessible colors
  const palette = [
    '#FF6B6B', // Coral red
    '#4ECDC4', // Teal
    '#45B7D1', // Sky blue
    '#96CEB4', // Sage green
    '#FFEAA7', // Soft yellow
    '#DDA0DD', // Plum
    '#98D8C8', // Mint
    '#F7DC6F', // Golden
    '#BB8FCE', // Lavender
    '#85C1E9', // Light blue
    '#F8B500', // Amber
    '#00CEC9', // Cyan
    '#E17055', // Terracotta
    '#74B9FF', // Periwinkle
    '#A29BFE', // Violet
    '#FD79A8', // Pink
  ];

  // Simple hash function for consistent color selection
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    const char = id.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }

  return palette[Math.abs(hash) % palette.length];
}

/**
 * Gets initials from a name (1-2 characters).
 *
 * @param name - Full name string
 * @returns Uppercase initials
 */
export function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return '?';
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

// =============================================================================
// KEYBOARD UTILITIES
// =============================================================================

/**
 * Checks if a keyboard event matches a shortcut.
 *
 * @param event - Keyboard event
 * @param key - Key to match
 * @param modifiers - Required modifiers
 */
export function matchesShortcut(
  event: KeyboardEvent,
  key: string,
  modifiers: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {}
): boolean {
  const { meta = false, ctrl = false, shift = false, alt = false } = modifiers;

  return (
    event.key.toLowerCase() === key.toLowerCase() &&
    event.metaKey === meta &&
    event.ctrlKey === ctrl &&
    event.shiftKey === shift &&
    event.altKey === alt
  );
}

// =============================================================================
// FOCUS MANAGEMENT
// =============================================================================

/**
 * Traps focus within a container element.
 * Useful for modals and dialogs.
 *
 * @param container - Container element
 * @param event - Keyboard event
 */
export function trapFocus(container: HTMLElement, event: KeyboardEvent): void {
  if (event.key !== 'Tab') return;

  const focusableElements = container.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  );

  const firstElement = focusableElements[0];
  const lastElement = focusableElements[focusableElements.length - 1];

  if (!firstElement || !lastElement) return;

  if (event.shiftKey && document.activeElement === firstElement) {
    event.preventDefault();
    lastElement.focus();
  } else if (!event.shiftKey && document.activeElement === lastElement) {
    event.preventDefault();
    firstElement.focus();
  }
}

// =============================================================================
// SCROLL UTILITIES
// =============================================================================

/**
 * Locks body scroll (for modals).
 * Returns a function to unlock.
 */
export function lockScroll(): () => void {
  const scrollY = window.scrollY;
  const body = document.body;
  const originalStyle = body.style.cssText;

  body.style.position = 'fixed';
  body.style.top = `-${scrollY}px`;
  body.style.left = '0';
  body.style.right = '0';
  body.style.overflow = 'hidden';

  return () => {
    body.style.cssText = originalStyle;
    window.scrollTo(0, scrollY);
  };
}

// =============================================================================
// CLIPBOARD
// =============================================================================

/**
 * Copies text to clipboard with fallback.
 *
 * @param text - Text to copy
 * @returns Promise that resolves when copied
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for older browsers
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      return true;
    } catch {
      return false;
    } finally {
      document.body.removeChild(textarea);
    }
  }
}

// =============================================================================
// DEBOUNCE & THROTTLE
// =============================================================================

/**
 * Creates a debounced function.
 *
 * @param fn - Function to debounce
 * @param delay - Delay in ms
 */
export function debounce<T extends (...args: Parameters<T>) => void>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout>;

  return (...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

/**
 * Creates a throttled function.
 *
 * @param fn - Function to throttle
 * @param limit - Minimum time between calls in ms
 */
export function throttle<T extends (...args: Parameters<T>) => void>(
  fn: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle = false;

  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      fn(...args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

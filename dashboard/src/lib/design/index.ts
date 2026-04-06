/**
 * Design System Entry Point
 *
 * Re-exports all design system utilities and tokens.
 * Import from '@/lib/design' for convenience.
 *
 * @example
 * import { cn, colors, formatRelativeTime } from '@/lib/design';
 */

// Tokens
export {
  colors,
  spacing,
  typography,
  fontFamily,
  fontWeight,
  radii,
  shadows,
  transitions,
  zIndex,
  breakpoints,
  componentSizes,
} from './tokens';

// Types
export type {
  ColorToken,
  SpacingToken,
  TypographyToken,
  RadiiToken,
  ShadowToken,
} from './tokens';

// Utilities
export {
  cn,
  formatRelativeTime,
  formatListDate,
  getEntityColor,
  getInitials,
  matchesShortcut,
  trapFocus,
  lockScroll,
  copyToClipboard,
  debounce,
  throttle,
} from './utils';

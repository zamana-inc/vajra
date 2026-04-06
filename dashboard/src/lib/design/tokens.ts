/**
 * Design Tokens - Single Source of Truth
 *
 * This file defines all design tokens for the Vajra Dashboard.
 *
 * Philosophy:
 * - Semantic naming over arbitrary values
 * - Constraints breed creativity - limited palette, maximum cohesion
 * - Every value has a purpose
 */

// =============================================================================
// COLOR SYSTEM
// =============================================================================

/**
 * Base color palette - raw values, not for direct use in components.
 * Use semantic tokens below instead.
 */
const palette = {
  // Neutrals (cool gray scale)
  gray: {
    50:  '#fbfbfd',
    100: '#f5f5f7',
    150: '#efefef',
    200: '#e8e8ed',
    300: '#d2d2d7',
    400: '#aeaeb2',
    500: '#8e8e93',
    600: '#636366',
    700: '#48484a',
    800: '#3a3a3c',
    900: '#1d1d1f',
  },

  // Brand blues
  blue: {
    50:  '#f0f5ff',
    100: '#e0ebff',
    200: '#b8d4fe',
    300: '#7aafff',
    400: '#3d8eff',
    500: '#0071e3', // Primary - Apple marketing blue
    600: '#0066cc',
    700: '#0055b3',
    800: '#004499',
    900: '#003380',
  },

  // Semantic colors
  green: {
    50:  '#f0fdf4',
    100: '#d1fae5',
    500: '#30d158', // Success
    600: '#28a745',
    700: '#1e7e34',
  },

  red: {
    50:  '#fef2f2',
    100: '#fee2e2',
    500: '#ff453a', // Error/Destructive
    600: '#dc2626',
    700: '#b91c1c',
  },

  amber: {
    50:  '#fffbeb',
    100: '#fef3c7',
    500: '#ff9f0a', // Warning
    600: '#d97706',
    700: '#b45309',
  },
} as const;

/**
 * Semantic color tokens - USE THESE in components.
 * Maps purpose to color, not color to purpose.
 */
export const colors = {
  // ==========================================================================
  // BACKGROUNDS
  // ==========================================================================
  bg: {
    /** Page-level background */
    page: palette.gray[100],
    /** Card/surface background */
    surface: '#ffffff',
    /** Elevated surfaces (modals, dropdowns) */
    elevated: '#ffffff',
    /** Subtle surface for contrast */
    subtle: palette.gray[50],
    /** Hover state background */
    hover: palette.gray[150],
    /** Active/pressed state background */
    active: palette.gray[200],
    /** Selected item background */
    selected: `${palette.blue[500]}0A`, // 4% opacity
    /** Selected item background (stronger) */
    selectedStrong: `${palette.blue[500]}14`, // 8% opacity
  },

  // ==========================================================================
  // TEXT
  // ==========================================================================
  text: {
    /** Primary text - headings, important content */
    primary: palette.gray[900],
    /** Secondary text - descriptions, labels */
    secondary: palette.gray[600],
    /** Tertiary text - timestamps, hints */
    tertiary: palette.gray[500],
    /** Disabled text */
    disabled: palette.gray[400],
    /** Inverted text (on dark backgrounds) */
    inverted: '#ffffff',
    /** Link text */
    link: palette.blue[500],
    /** Link text on hover */
    linkHover: palette.blue[600],
  },

  // ==========================================================================
  // BORDERS
  // ==========================================================================
  border: {
    /** Default border */
    default: palette.gray[300],
    /** Subtle border */
    subtle: palette.gray[200],
    /** Strong border (for emphasis) */
    strong: palette.gray[400],
    /** Focus ring */
    focus: palette.blue[500],
    /** Selected item border */
    selected: palette.blue[500],
  },

  // ==========================================================================
  // INTERACTIVE (Buttons, Links)
  // ==========================================================================
  interactive: {
    /** Primary action */
    primary: palette.blue[500],
    primaryHover: palette.blue[600],
    primaryActive: palette.blue[700],

    /** Secondary action (outline) */
    secondary: palette.blue[500],
    secondaryHover: palette.blue[50],

    /** Ghost action (minimal) */
    ghost: 'transparent',
    ghostHover: palette.gray[150],
    ghostActive: palette.gray[200],

    /** Destructive action */
    destructive: palette.red[500],
    destructiveHover: palette.red[600],
    destructiveBg: palette.red[50],
  },

  // ==========================================================================
  // STATUS
  // ==========================================================================
  status: {
    success: palette.green[500],
    successBg: palette.green[50],
    successText: palette.green[700],

    error: palette.red[500],
    errorBg: palette.red[50],
    errorText: palette.red[700],

    warning: palette.amber[500],
    warningBg: palette.amber[50],
    warningText: palette.amber[700],

    info: palette.blue[500],
    infoBg: palette.blue[50],
    infoText: palette.blue[700],
  },

  // ==========================================================================
  // COMPONENT-SPECIFIC
  // ==========================================================================
  sidebar: {
    bg: palette.gray[50],
    border: palette.gray[300],
    headerBg: '#ffffff',
  },

  toolbar: {
    bg: palette.gray[50],
    border: palette.gray[200],
    itemHover: palette.gray[150],
    itemActive: palette.gray[200],
  },

  tabs: {
    inactive: palette.gray[500],
    inactiveHover: palette.gray[600],
    active: palette.blue[500],
    activeBg: `${palette.blue[500]}14`,
    indicator: palette.blue[500],
  },
} as const;

// =============================================================================
// SPACING SYSTEM
// =============================================================================

/**
 * Spacing scale based on 4px base unit.
 * Use these for all margin, padding, and gap values.
 */
export const spacing = {
  0:    '0px',
  0.5:  '2px',
  1:    '4px',
  1.5:  '6px',
  2:    '8px',
  2.5:  '10px',
  3:    '12px',
  3.5:  '14px',
  4:    '16px',
  5:    '20px',
  6:    '24px',
  7:    '28px',
  8:    '32px',
  9:    '36px',
  10:   '40px',
  11:   '44px',
  12:   '48px',
  14:   '56px',
  16:   '64px',
  20:   '80px',
  24:   '96px',
} as const;

// =============================================================================
// TYPOGRAPHY SYSTEM
// =============================================================================

/**
 * Font family stack.
 * Uses system fonts for performance and native feel.
 */
export const fontFamily = {
  sans: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
  mono: '"SF Mono", SFMono-Regular, ui-monospace, Menlo, Monaco, Consolas, monospace',
} as const;

/**
 * Font size scale with corresponding line heights.
 * Designed for optimal readability.
 */
export const typography = {
  /** 11px - Micro text, timestamps, badges */
  xs: {
    size: '11px',
    lineHeight: '14px',
    letterSpacing: '0.01em',
  },
  /** 12px - Labels, captions */
  sm: {
    size: '12px',
    lineHeight: '16px',
    letterSpacing: '0.01em',
  },
  /** 13px - Body small, secondary content */
  base: {
    size: '13px',
    lineHeight: '18px',
    letterSpacing: '0',
  },
  /** 14px - Body default */
  md: {
    size: '14px',
    lineHeight: '20px',
    letterSpacing: '0',
  },
  /** 15px - Body large */
  lg: {
    size: '15px',
    lineHeight: '22px',
    letterSpacing: '-0.01em',
  },
  /** 17px - Subheading */
  xl: {
    size: '17px',
    lineHeight: '24px',
    letterSpacing: '-0.01em',
  },
  /** 20px - Heading */
  '2xl': {
    size: '20px',
    lineHeight: '28px',
    letterSpacing: '-0.02em',
  },
  /** 24px - Large heading */
  '3xl': {
    size: '24px',
    lineHeight: '32px',
    letterSpacing: '-0.02em',
  },
} as const;

/**
 * Font weight scale.
 */
export const fontWeight = {
  normal: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

// =============================================================================
// BORDER RADIUS
// =============================================================================

/**
 * Border radius scale.
 * Smaller radii for smaller elements, larger for cards/modals.
 */
export const radii = {
  none: '0px',
  sm: '4px',
  md: '6px',
  lg: '8px',
  xl: '12px',
  '2xl': '16px',
  '3xl': '20px',
  full: '9999px',
} as const;

// =============================================================================
// SHADOWS
// =============================================================================

/**
 * Shadow scale for elevation.
 */
export const shadows = {
  none: 'none',
  sm: '0 1px 2px 0 rgb(0 0 0 / 0.03)',
  md: '0 2px 4px -1px rgb(0 0 0 / 0.06), 0 1px 2px -1px rgb(0 0 0 / 0.03)',
  lg: '0 4px 6px -2px rgb(0 0 0 / 0.05), 0 2px 4px -2px rgb(0 0 0 / 0.03)',
  xl: '0 8px 16px -4px rgb(0 0 0 / 0.08), 0 4px 6px -2px rgb(0 0 0 / 0.03)',
  '2xl': '0 16px 32px -8px rgb(0 0 0 / 0.12), 0 8px 16px -4px rgb(0 0 0 / 0.04)',
  /** For dropdowns, popovers */
  dropdown: '0 4px 16px -2px rgb(0 0 0 / 0.12), 0 2px 4px -1px rgb(0 0 0 / 0.04)',
  /** For modals */
  modal: '0 24px 48px -12px rgb(0 0 0 / 0.18), 0 12px 24px -6px rgb(0 0 0 / 0.06)',
  /** For sidebars */
  sidebar: '-4px 0 16px -4px rgb(0 0 0 / 0.08)',
} as const;

// =============================================================================
// TRANSITIONS
// =============================================================================

/**
 * Transition presets for consistent animations.
 */
export const transitions = {
  /** Fast micro-interactions (hover states) */
  fast: '100ms ease-out',
  /** Default transitions */
  normal: '150ms ease-out',
  /** Slower transitions (modals, sidebars) */
  slow: '200ms ease-out',
  /** Spring-like for natural feel */
  spring: '300ms cubic-bezier(0.175, 0.885, 0.32, 1.275)',
} as const;

// =============================================================================
// Z-INDEX SCALE
// =============================================================================

/**
 * Z-index scale to prevent z-index wars.
 */
export const zIndex = {
  base: 0,
  dropdown: 50,
  sticky: 100,
  overlay: 200,
  modal: 300,
  popover: 400,
  tooltip: 500,
  toast: 600,
} as const;

// =============================================================================
// BREAKPOINTS
// =============================================================================

/**
 * Responsive breakpoints.
 */
export const breakpoints = {
  sm: '640px',
  md: '768px',
  lg: '1024px',
  xl: '1280px',
  '2xl': '1536px',
} as const;

// =============================================================================
// COMPONENT SIZES
// =============================================================================

/**
 * Standard component sizes for consistency.
 */
export const componentSizes = {
  /** Button heights */
  button: {
    sm: '28px',
    md: '32px',
    lg: '40px',
  },
  /** Input heights */
  input: {
    sm: '28px',
    md: '32px',
    lg: '40px',
  },
  /** Icon sizes */
  icon: {
    xs: '12px',
    sm: '14px',
    md: '16px',
    lg: '20px',
    xl: '24px',
  },
  /** Avatar sizes */
  avatar: {
    xs: '20px',
    sm: '24px',
    md: '32px',
    lg: '40px',
    xl: '48px',
  },
  /** Sidebar width */
  sidebar: {
    collapsed: '64px',
    expanded: '280px',
    toolbar: '160px',
  },
} as const;

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type ColorToken = typeof colors;
export type SpacingToken = keyof typeof spacing;
export type TypographyToken = keyof typeof typography;
export type RadiiToken = keyof typeof radii;
export type ShadowToken = keyof typeof shadows;

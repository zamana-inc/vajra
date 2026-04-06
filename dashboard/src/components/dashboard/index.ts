/**
 * Dashboard Component Library
 *
 * Unified components for the Vajra dashboard.
 * These components use dashboard design tokens for consistent styling.
 *
 * @example
 * import { Button, Tabs, ListItem, Dropdown, Sidebar, Dialog } from '@/components/dashboard';
 */

// Button
export { Button, IconButton, ButtonGroup } from './button';
export type { ButtonProps } from './button';

// Input
export { Input, Textarea, FormField } from './input';
export type { InputProps, TextareaProps, FormFieldProps } from './input';

// Tabs
export { Tabs, TabPanel, TabsContainer } from './tabs';
export type { TabItem, TabsProps, TabPanelProps, TabsContainerProps } from './tabs';

// List
export { ListItem, List, ListSection } from './list-item';
export type { ListItemProps, ListProps, ListSectionProps } from './list-item';

// Dropdown
export { Dropdown } from './dropdown';
export type { DropdownProps, DropdownOption } from './dropdown';

// Version Dropdown
export { VersionDropdown } from './version-dropdown';
export type { VersionDropdownProps, VersionItem } from './version-dropdown';

// Searchable Dropdown
export { SearchableDropdown } from './searchable-dropdown';
export type {
  SearchableDropdownProps,
  SearchableDropdownOption,
  SearchableDropdownSection,
} from './searchable-dropdown';

// Sidebar
export { Sidebar, SidebarSection, SidebarCard, SidebarStat } from './sidebar';
export type { SidebarProps, SidebarSectionProps, SidebarCardProps, SidebarStatProps } from './sidebar';

// Dialog
export {
  Dialog,
  DialogBody,
  DialogFooter,
  ConfirmDialog,
  AlertDialog,
  PromptDialog,
} from './dialog';
export type {
  DialogProps,
  ConfirmDialogProps,
  AlertDialogProps,
  PromptDialogProps,
} from './dialog';

// Progress Bar
export { ProgressBar } from './progress-bar';
export type { ProgressBarProps, ProgressStatus } from './progress-bar';

// Toggle
export { Toggle } from './toggle';
export type { ToggleProps } from './toggle';

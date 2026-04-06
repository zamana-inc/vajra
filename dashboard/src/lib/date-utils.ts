/**
 * Date formatting utilities.
 */

/**
 * Format ISO date string to readable date/time (e.g., "Dec 4, 2:30 PM")
 */
export function formatDateTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatMessageTime(timestamp: string, lowercase = false): string {
  const date = new Date(timestamp);
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const ampm = hours >= 12 ? (lowercase ? "pm" : "PM") : (lowercase ? "am" : "AM");
  const hour12 = hours % 12 || 12;
  const minuteStr = minutes.toString().padStart(2, "0");
  return `${hour12}:${minuteStr}${lowercase ? "" : " "}${ampm}`;
}

export function getDateLabel(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();

  // Strip time for comparison
  const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const todayOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayOnly = new Date(todayOnly);
  yesterdayOnly.setDate(yesterdayOnly.getDate() - 1);

  if (dateOnly.getTime() === todayOnly.getTime()) {
    return "Today";
  } else if (dateOnly.getTime() === yesterdayOnly.getTime()) {
    return "Yesterday";
  } else {
    // Format: "Monday, December 4"
    return date.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  }
}

export function getDateKey(timestamp: string): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Format a duration in seconds to a human-readable string.
 * Returns empty string for null/undefined/NaN values.
 *
 * @example
 * formatDuration(45) // "45s"
 * formatDuration(125) // "2m 5s"
 * formatDuration(3665) // "1h 1m"
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return "";
  }

  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }

  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  }

  const hours = Math.floor(seconds / 3600);
  const mins = Math.round((seconds % 3600) / 60);
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

/**
 * Format a date to a relative time string (e.g., "now", "5m", "2h", "3d").
 */
export function formatTimeAgo(date: Date): string {
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/**
 * Format a cost in USD to a human-readable string.
 * Returns empty string for zero/null/undefined values.
 *
 * @example
 * formatCost(0.0125) // "$0.0125"
 * formatCost(0.00001) // "<$0.0001"
 * formatCost(0) // ""
 */
export function formatCost(cost: number | null | undefined): string {
  if (cost === null || cost === undefined || !Number.isFinite(cost) || cost === 0) {
    return "";
  }
  if (cost < 0.0001) return "<$0.0001";
  return `$${cost.toFixed(4)}`;
}

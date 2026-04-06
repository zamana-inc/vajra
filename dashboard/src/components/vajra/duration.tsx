"use client";

/**
 * Human-readable duration display.
 * Ticks live when the run is still active.
 */

import { useEffect, useState } from "react";

function formatDuration(ms: number): string {
  if (ms < 1_000) return "<1s";
  const totalSeconds = Math.floor(ms / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function formatUptime(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

interface DurationProps {
  /** Duration in ms (if known) */
  ms?: number | null;
  /** Start time ISO string — used for live ticking when ms is null */
  startedAt?: string | null;
  /** Whether this run is still active (enables live tick) */
  live?: boolean;
  /** Format: compact (4m 02s) or uptime (2h 15m) */
  format?: "compact" | "uptime";
  className?: string;
}

export function Duration({ ms, startedAt, live, format = "compact", className }: DurationProps) {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!live || !startedAt) return;
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, [live, startedAt]);

  let durationMs: number;
  if (ms != null) {
    durationMs = ms;
  } else if (startedAt) {
    durationMs = now - new Date(startedAt).getTime();
  } else {
    return <span className={className}>—</span>;
  }

  const formatter = format === "uptime" ? formatUptime : formatDuration;

  return (
    <span className={className}>
      {formatter(Math.max(0, durationMs))}
    </span>
  );
}

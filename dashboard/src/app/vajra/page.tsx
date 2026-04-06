"use client";

/**
 * Vajra Monitor — the live view.
 *
 * Shows orchestrator vitals (KPIs), active/recent runs (table with pipeline dots),
 * and a live SSE connection for real-time updates.
 *
 * Leave this on a second monitor.
 */

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useVajra, useVajraEventStream } from "@/lib/vajra";
import type {
  VajraStateSnapshot,
  VajraRunsResponse,
  VajraRunSummary,
  VajraEventMessage,
} from "@/lib/vajra";
import { KpiRow } from "@/components/vajra/kpi-row";
import { RunTable } from "@/components/vajra/run-table";
import { ConnectionBadge } from "@/components/vajra/connection-badge";
import { Duration } from "@/components/vajra/duration";
import { RefreshIcon } from "@/components/ui/icons";

export default function VajraMonitorPage() {
  const router = useRouter();
  const [connected, setConnected] = useState(false);
  const lastRefetch = useRef(0);

  const state = useVajra<VajraStateSnapshot>("state");
  const runs = useVajra<VajraRunsResponse>("runs", { since: "24h", limit: 50 });

  const loading = state.loading || runs.loading;

  // Debounced refetch — at most once per 2s on SSE events
  const debouncedRefetch = useCallback(() => {
    const now = Date.now();
    if (now - lastRefetch.current < 2_000) return;
    lastRefetch.current = now;
    state.refetch();
    runs.refetch();
  }, [state.refetch, runs.refetch]);

  // SSE event handler
  const handleEvent = useCallback(
    (event: VajraEventMessage) => {
      const refreshTypes = new Set([
        "issue:dispatched",
        "issue:completed",
        "issue:failed",
        "issue:cancelled",
        "issue:escalated",
        "pipeline:stage:complete",
        "issue:retry:scheduled",
        "issue:retry:dispatched",
      ]);
      if (refreshTypes.has(event.type)) {
        debouncedRefetch();
      }
    },
    [debouncedRefetch],
  );

  useVajraEventStream({
    enabled: true,
    onEvent: handleEvent,
    onOpen: () => setConnected(true),
    onError: () => setConnected(false),
  });

  const handleRunClick = (run: VajraRunSummary) => {
    router.push(`/vajra/runs/${run.issueIdentifier}/${run.attempt}`);
  };

  const handleRefresh = () => {
    state.refetch();
    runs.refetch();
  };

  const error = state.error || runs.error;

  return (
    <div className="min-h-screen bg-[var(--d-bg-page)]">
      {/* Header */}
      <div className="px-8 pt-7 pb-0">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-4">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--d-text-tertiary)]">
                Vajra
              </p>
              <h1 className="text-[20px] font-semibold text-[var(--d-text-primary)] tracking-tight mt-0.5">
                Monitor
              </h1>
            </div>
            <ConnectionBadge connected={connected} className="mt-4" />
          </div>
          <div className="flex items-center gap-4">
            {state.data?.uptimeMs != null && (
              <div className="text-right">
                <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--d-text-tertiary)]">
                  Uptime
                </p>
                <Duration
                  ms={state.data.uptimeMs}
                  live
                  startedAt={state.data.startedAt}
                  format="uptime"
                  className="text-[14px] font-mono tabular-nums text-[var(--d-text-secondary)]"
                />
              </div>
            )}
            <button
              onClick={handleRefresh}
              disabled={loading}
              className="p-2 rounded-lg text-[var(--d-text-tertiary)] hover:text-[var(--d-text-primary)] hover:bg-[var(--d-bg-hover)] transition-colors disabled:opacity-50"
              aria-label="Refresh"
            >
              <RefreshIcon className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        {/* Workflow reload error banner */}
        {state.data?.workflowReloadError && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-[var(--d-warning-bg)] border border-[var(--d-warning)]/20">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--d-warning-text)] mb-1">
              Workflow Reload Error
            </p>
            <p className="text-[13px] text-[var(--d-warning-text)] font-mono">
              {state.data.workflowReloadError}
            </p>
          </div>
        )}

        {/* Error banner */}
        {error && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-[var(--d-error-bg)] border border-[var(--d-error)]/20">
            <p className="text-[13px] text-[var(--d-error-text)]">
              {error}
            </p>
          </div>
        )}

        {/* KPIs */}
        <div className="mb-6">
          <KpiRow state={state.data} runs={runs.data} loading={loading} />
        </div>
      </div>

      {/* Run Table */}
      <div className="px-8 pb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[13px] font-semibold text-[var(--d-text-primary)]">
            Recent Runs
          </h2>
          <span className="text-[11px] text-[var(--d-text-tertiary)]">
            {runs.data
              ? runs.data.total > runs.data.runs.length
                ? `${runs.data.runs.length} of ${runs.data.total} runs`
                : `${runs.data.total} runs`
              : ""}
          </span>
        </div>
        <RunTable
          runs={runs.data?.runs ?? []}
          loading={runs.loading}
          onRunClick={handleRunClick}
        />
      </div>
    </div>
  );
}

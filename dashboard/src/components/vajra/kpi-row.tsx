"use client";

/**
 * Vajra KPI row — five cards showing live orchestrator vitals.
 *
 * Active / Retrying / Waiting — live process state
 * Completed (24h) / Failed (24h) — persisted from event log
 */

import type { VajraStateSnapshot, VajraRunsResponse } from "@/lib/vajra/types";
import { KpiCard, KpiCardSkeleton } from "@/components/dashboard/kpi-card";

interface KpiRowProps {
  state: VajraStateSnapshot | null;
  runs: VajraRunsResponse | null;
  loading: boolean;
}

export function KpiRow({ state, runs, loading }: KpiRowProps) {
  if (loading || !state) {
    return (
      <div className="grid grid-cols-6 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <KpiCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  const successCount = runs?.counts.success ?? 0;
  const failureCount = runs?.counts.failure ?? 0;
  const waitHumanCount = runs?.counts.waitHuman ?? 0;

  return (
    <div className="grid grid-cols-6 gap-3">
      <KpiCard
        label="Active"
        value={String(state.activeCount)}
        change={null}
      />
      <KpiCard
        label="Retrying"
        value={String(state.retryingCount)}
        change={null}
      />
      <KpiCard
        label="Waiting"
        value={String(state.waitingCount)}
        change={null}
      />
      <KpiCard
        label="Needs Review"
        value={String(waitHumanCount)}
        change={null}
      />
      <KpiCard
        label="Completed (24h)"
        value={String(successCount)}
        change={null}
      />
      <KpiCard
        label="Failed (24h)"
        value={String(failureCount)}
        change={null}
        positiveIsGood={false}
      />
    </div>
  );
}

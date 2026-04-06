"use client";

const CHART_COLORS = {
  primary: "#0071e3",
} as const;

interface SparklinePoint {
  date: string;
  value: number;
}

function Sparkline({ data, color = CHART_COLORS.primary }: { data: SparklinePoint[]; color?: string }) {
  if (data.length < 2) return null;

  const values = data.map((d) => d.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const w = 120;
  const h = 32;
  const pad = 1;
  const points = data.map((d, i) => {
    const x = pad + (i / (data.length - 1)) * (w - pad * 2);
    const y = pad + (h - pad * 2) - ((d.value - min) / range) * (h - pad * 2);
    return `${x},${y}`;
  });

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-8 mt-3" preserveAspectRatio="none">
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

interface KpiCardProps {
  label: string;
  value: string;
  change?: number | null;
  positiveIsGood?: boolean;
  sparkline?: SparklinePoint[];
  sparkColor?: string;
}

export function KpiCard({
  label,
  value,
  change,
  positiveIsGood = true,
  sparkline,
  sparkColor,
}: KpiCardProps) {
  const hasChange = change != null;
  const isGood = hasChange && (change > 0) === positiveIsGood;
  const isBad = hasChange && change !== 0 && !isGood;
  const changeColor = isGood
    ? "text-[var(--d-success)]"
    : isBad
      ? "text-[var(--d-error)]"
      : "text-[var(--d-text-tertiary)]";

  const arrow = !hasChange || change === 0 ? "" : change > 0 ? "↑" : "↓";

  return (
    <div className="bg-white rounded-xl border border-[var(--d-border-subtle)] px-5 pt-4 pb-3">
      <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--d-text-tertiary)]">
        {label}
      </p>
      <p className="text-[28px] font-semibold text-[var(--d-text-primary)] leading-tight tracking-tight mt-1">
        {value}
      </p>
      {hasChange && (
        <p className={`text-[11px] font-medium tabular-nums mt-0.5 ${changeColor}`}>
          {arrow} {Math.abs(change)}%
        </p>
      )}
      {sparkline && <Sparkline data={sparkline} color={sparkColor} />}
    </div>
  );
}

export function KpiCardSkeleton() {
  return (
    <div className="bg-white rounded-xl border border-[var(--d-border-subtle)] px-5 pt-4 pb-3">
      <div className="h-3 w-16 bg-[var(--d-bg-active)] rounded" />
      <div className="h-8 w-20 bg-[var(--d-bg-active)] rounded mt-2" />
      <div className="h-3 w-12 bg-[var(--d-bg-active)] rounded mt-1.5" />
      <div className="h-8 w-full bg-[var(--d-bg-page)] rounded mt-3" />
    </div>
  );
}

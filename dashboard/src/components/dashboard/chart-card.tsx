"use client";

import { ReactNode } from "react";

interface ChartCardProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  action?: ReactNode;
}

export function ChartCard({ title, subtitle, children, action }: ChartCardProps) {
  return (
    <div className="bg-white rounded-xl border border-[var(--d-border-subtle)] p-6">
      <div className="flex items-start justify-between mb-5">
        <div>
          <h3 className="text-[13px] font-semibold text-[var(--d-text-primary)]">{title}</h3>
          {subtitle && (
            <p className="text-[11px] text-[var(--d-text-tertiary)] mt-0.5">{subtitle}</p>
          )}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

export function ChartCardSkeleton({ height = 200 }: { height?: number }) {
  return (
    <div className="bg-white rounded-xl border border-[var(--d-border-subtle)] p-6">
      <div className="h-4 w-32 bg-[var(--d-bg-active)] rounded mb-5" />
      <div className="bg-[var(--d-bg-page)] rounded-lg" style={{ height }} />
    </div>
  );
}

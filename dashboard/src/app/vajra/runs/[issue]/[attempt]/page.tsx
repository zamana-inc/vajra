"use client";

/**
 * Run Detail — deep dive into a single Vajra pipeline run.
 *
 * Header: issue info, status, duration, PR link.
 * Pipeline graph: horizontal React Flow visualization.
 * Stage cards: vertical list, one per node.
 */

import { use, useCallback, useRef } from "react";
import Link from "next/link";
import { cn } from "@/lib/design";
import { useVajra, useVajraEventStream } from "@/lib/vajra";
import type { VajraRunDetail, VajraEventMessage, VajraCollectionSummary } from "@/lib/vajra";
import { PipelineGraph } from "@/components/vajra/pipeline-graph";
import { StageCard, StageCardSkeleton, type StageDetail } from "@/components/vajra/stage-card";
import { RunStatusBadge } from "@/components/vajra/run-status-badge";
import { Duration } from "@/components/vajra/duration";
import { ChevronLeftIcon, ExternalLinkIcon } from "@/components/ui/icons";

// =============================================================================
// COLLECTION CARD
// =============================================================================

function CollectionCard({ collection }: { collection: VajraCollectionSummary }) {
  return (
    <div className="rounded-xl border border-[var(--d-border-subtle)] bg-[var(--d-bg-surface)] px-5 py-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <span className="text-[13px] font-semibold text-[var(--d-text-primary)]">{collection.id}</span>
          <span className="text-[11px] font-mono text-[var(--d-text-tertiary)]">stage: {collection.stageId}</span>
        </div>
        {collection.selectedCandidateId && (
          <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-[var(--d-success-bg)] text-[var(--d-success-text)]">
            selected: {collection.selectedCandidateId}
          </span>
        )}
      </div>

      {collection.synthesizedArtifact && (
        <div className="mb-3">
          <p className="text-[11px] text-[var(--d-text-tertiary)] mb-0.5">Synthesized artifact</p>
          <p className="text-[12px] font-mono text-[var(--d-text-link)]">{collection.synthesizedArtifact}</p>
        </div>
      )}

      {collection.candidates.length > 0 && (
        <div className="space-y-2">
          {collection.candidates.map((candidate) => (
            <div
              key={candidate.id}
              className={cn(
                "rounded-lg border px-4 py-3",
                candidate.id === collection.selectedCandidateId
                  ? "border-[var(--d-text-primary)] bg-[var(--d-bg-surface)]"
                  : "border-[var(--d-border-subtle)] bg-[var(--d-bg-page)]",
              )}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-[12px] font-semibold text-[var(--d-text-primary)]">{candidate.id}</span>
                <span
                  className={cn(
                    "text-[10px] font-semibold px-1.5 py-0.5 rounded-full",
                    candidate.status === "success"
                      ? "bg-[var(--d-success-bg)] text-[var(--d-success-text)]"
                      : "bg-[var(--d-error-bg)] text-[var(--d-error-text)]",
                  )}
                >
                  {candidate.status}
                </span>
              </div>

              {candidate.variantConfig && (
                <div className="space-y-1 mb-1">
                  <div className="flex flex-wrap gap-2">
                    {candidate.variantConfig.agent && (
                      <span className="text-[11px] font-mono text-[var(--d-text-tertiary)]">
                        agent: {candidate.variantConfig.agent}
                      </span>
                    )}
                    {candidate.variantConfig.model && (
                      <span className="text-[11px] font-mono text-[var(--d-text-tertiary)]">
                        model: {candidate.variantConfig.model}
                      </span>
                    )}
                    {candidate.variantConfig.reasoningEffort && (
                      <span className="text-[11px] font-mono text-[var(--d-text-tertiary)]">
                        effort: {candidate.variantConfig.reasoningEffort}
                      </span>
                    )}
                  </div>
                  {candidate.variantConfig.instructions && (
                    <p className="text-[11px] text-[var(--d-text-secondary)] bg-[var(--d-bg-subtle)] px-2 py-1 rounded font-mono whitespace-pre-wrap">
                      {candidate.variantConfig.instructions}
                    </p>
                  )}
                </div>
              )}

              {Object.keys(candidate.facts).length > 0 && (
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 mt-1">
                  {Object.entries(candidate.facts).map(([key, value]) => (
                    <div key={key} className="contents">
                      <span className="text-[10px] font-mono text-[var(--d-text-tertiary)]">{key}</span>
                      <span className="text-[10px] font-mono text-[var(--d-text-secondary)]">{String(value)}</span>
                    </div>
                  ))}
                </div>
              )}

              {Object.keys(candidate.artifacts).length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {Object.entries(candidate.artifacts).map(([name, path]) => (
                    <span
                      key={name}
                      className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono bg-[var(--d-bg-page)] text-[var(--d-text-secondary)] border border-[var(--d-border-subtle)]"
                      title={path}
                    >
                      {name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// PAGE
// =============================================================================

interface PageProps {
  params: Promise<{ issue: string; attempt: string }>;
}

export default function RunDetailPage({ params }: PageProps) {
  const { issue, attempt } = use(params);
  const lastRefetch = useRef(0);

  const { data, loading, error, refetch } = useVajra<VajraRunDetail>(
    `runs/${issue}/${attempt}`,
  );

  // SSE: auto-refresh when this run's events come in
  const debouncedRefetch = useCallback(() => {
    const now = Date.now();
    if (now - lastRefetch.current < 2_000) return;
    lastRefetch.current = now;
    refetch();
  }, [refetch]);

  useVajraEventStream({
    enabled: data?.status === "running",
    onEvent: (event: VajraEventMessage) => {
      if (event.issueIdentifier === issue) {
        debouncedRefetch();
      }
    },
  });

  const scrollToStage = (stageId: string) => {
    const element = document.getElementById(`stage-${stageId}`);
    element?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (loading) {
    return <RunDetailSkeleton issue={issue} attempt={attempt} />;
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-[var(--d-bg-page)]">
        <div className="px-8 pt-7">
          <BackLink />
          <div className="mt-8 text-center">
            <p className="text-[15px] font-medium text-[var(--d-text-secondary)]">
              {error ?? "Run not found"}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--d-bg-page)]">
      <div className="px-8 pt-7 pb-8">
        {/* Back link */}
        <BackLink />

        {/* Header */}
        <div className="flex items-start justify-between mt-4 mb-6">
          <div>
            <div className="flex items-center gap-3">
              {data.issueUrl ? (
                <a
                  href={data.issueUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[20px] font-semibold text-[var(--d-text-link)] hover:underline tracking-tight"
                >
                  {data.issueIdentifier}
                </a>
              ) : (
                <h1 className="text-[20px] font-semibold text-[var(--d-text-primary)] tracking-tight">
                  {data.issueIdentifier}
                </h1>
              )}
              <RunStatusBadge status={data.status} />
              {data.attempt > 0 && (
                <span className="text-[12px] font-mono text-[var(--d-text-tertiary)] bg-[var(--d-bg-page)] px-2 py-0.5 rounded-full border border-[var(--d-border-subtle)]">
                  attempt {data.attempt}
                </span>
              )}
            </div>
            <p className="text-[14px] text-[var(--d-text-secondary)] mt-1">
              {data.issueTitle}
            </p>
            <p className="text-[12px] text-[var(--d-text-tertiary)] font-mono mt-1">
              {data.workflowName}
            </p>
          </div>

          <div className="flex items-center gap-4 text-right">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--d-text-tertiary)]">
                Duration
              </p>
              <Duration
                ms={data.durationMs}
                startedAt={data.startedAt}
                live={data.status === "running"}
                className="text-[15px] font-mono tabular-nums text-[var(--d-text-primary)]"
              />
            </div>
            {data.prUrl && (
              <a
                href={data.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--d-bg-surface)] border border-[var(--d-border-subtle)] text-[13px] font-medium text-[var(--d-text-link)] hover:bg-[var(--d-bg-hover)] transition-colors"
              >
                Pull Request
                <ExternalLinkIcon className="w-3.5 h-3.5" />
              </a>
            )}
          </div>
        </div>

        {/* Run summary panel */}
        {(data.dispatchPlan || data.checkpointStatus || data.nextNodeId) && (
          <div className="mb-6 rounded-xl border border-[var(--d-border-subtle)] bg-[var(--d-bg-surface)] px-5 py-4">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--d-text-tertiary)] mb-3">
              Run Info
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {data.dispatchPlan && (
                <>
                  <div>
                    <p className="text-[11px] text-[var(--d-text-tertiary)] mb-0.5">Workflow</p>
                    <p className="text-[13px] font-mono text-[var(--d-text-primary)]">{data.dispatchPlan.workflowName}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-[var(--d-text-tertiary)] mb-0.5">Branch</p>
                    <p className="text-[13px] font-mono text-[var(--d-text-primary)]">{data.dispatchPlan.targetBranch}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-[var(--d-text-tertiary)] mb-0.5">Merge</p>
                    <p className="text-[13px] font-mono text-[var(--d-text-primary)]">{data.dispatchPlan.mergeStrategy}</p>
                  </div>
                  {data.dispatchPlan.triage && (
                    <div>
                      <p className="text-[11px] text-[var(--d-text-tertiary)] mb-0.5">Triage</p>
                      <p className="text-[13px] text-[var(--d-text-primary)]">{data.dispatchPlan.triage.action}</p>
                      {data.dispatchPlan.triage.reasoning && (
                        <p className="text-[11px] text-[var(--d-text-tertiary)] mt-0.5">{data.dispatchPlan.triage.reasoning}</p>
                      )}
                    </div>
                  )}
                </>
              )}
              {data.checkpointStatus && (
                <div>
                  <p className="text-[11px] text-[var(--d-text-tertiary)] mb-0.5">Checkpoint</p>
                  <RunStatusBadge status={data.checkpointStatus} />
                  {data.checkpointError && (
                    <p className="text-[11px] text-[var(--d-error)] mt-0.5">{data.checkpointError}</p>
                  )}
                </div>
              )}
              {data.nextNodeId && (
                <div>
                  <p className="text-[11px] text-[var(--d-text-tertiary)] mb-0.5">Next Node</p>
                  <p className="text-[13px] font-mono text-[var(--d-text-primary)]">{data.nextNodeId}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Pipeline graph */}
        <div className="mb-8">
          <PipelineGraph
            graph={data.graph}
            stages={data.stages}
            runStatus={data.status}
            onStageClick={scrollToStage}
            height={360}
          />
        </div>

        {/* Collections */}
        {data.collections && data.collections.length > 0 && (
          <div className="mb-8">
            <h2 className="text-[13px] font-semibold text-[var(--d-text-primary)] mb-3">
              Collections
            </h2>
            <div className="space-y-4">
              {data.collections.map((collection) => (
                <CollectionCard key={collection.id} collection={collection} />
              ))}
            </div>
          </div>
        )}

        {/* Stage cards */}
        <div className="space-y-4">
          {data.stageDetails.map((stage) => (
            <StageCard key={stage.id} stage={stage} id={`stage-${stage.id}`} />
          ))}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

function BackLink() {
  return (
    <Link
      href="/vajra"
      className="inline-flex items-center gap-1 text-[13px] text-[var(--d-text-tertiary)] hover:text-[var(--d-text-primary)] transition-colors"
    >
      <ChevronLeftIcon className="w-4 h-4" />
      Monitor
    </Link>
  );
}

function RunDetailSkeleton({ issue, attempt }: { issue: string; attempt: string }) {
  return (
    <div className="min-h-screen bg-[var(--d-bg-page)]">
      <div className="px-8 pt-7 pb-8">
        <BackLink />

        {/* Header skeleton */}
        <div className="mt-4 mb-6">
          <div className="flex items-center gap-3">
            <div className="h-6 w-20 bg-[var(--d-bg-active)] rounded" />
            <div className="h-5 w-16 bg-[var(--d-bg-active)] rounded-full" />
          </div>
          <div className="h-4 w-64 bg-[var(--d-bg-active)] rounded mt-2" />
        </div>

        {/* Graph skeleton */}
        <div className="h-[220px] bg-white rounded-xl border border-[var(--d-border-subtle)] mb-8" />

        {/* Stage card skeletons */}
        <div className="space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <StageCardSkeleton key={i} />
          ))}
        </div>
      </div>
    </div>
  );
}

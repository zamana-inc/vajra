"use client";

/**
 * Vajra Workflows — visual step builder + raw DOT fallback.
 *
 * Builder mode: Trigger (name, labels, default toggle) + Steps (ordered agent
 * cards, drag to reorder, on-rejection routing) + On Complete (success state,
 * inspect PR).
 *
 * Advanced mode: raw DOT editor for workflows that exceed the builder subset.
 *
 * The builder owns a simple linear-chain subset of DOT; anything richer is
 * shown in advanced mode with a banner.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import { cn } from "@/lib/design";
import { useVajra } from "@/lib/vajra";
import {
  saveVajraWorkflow,
  deleteVajraWorkflow,
  previewVajraWorkflow,
} from "@/lib/vajra/client";
import type {
  VajraAgentsResponse,
  VajraWorkflowDefinition,
  VajraWorkflowsResponse,
} from "@/lib/vajra/types";
import {
  draftToDot,
  emptyWorkflowDraft,
  makeStepId,
  type StepDraft,
  type WorkflowDraft,
  workflowToDraft,
} from "@/lib/vajra/workflow-builder";
import { Button } from "@/components/dashboard/button";
import { Toggle } from "@/components/dashboard/toggle";
import { ConfirmDialog } from "@/components/dashboard/dialog";
import {
  PlusIcon,
  TrashIcon,
  WorkflowIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CloseIcon,
  CodeIcon,

} from "@/components/ui/icons";

// =============================================================================
// STEP CARD
// =============================================================================

function StepCard({
  step,
  index,
  totalSteps,
  agents,
  onUpdate,
  onRemove,
  onMoveUp,
  onMoveDown,
  dragHandleProps,
}: {
  step: StepDraft;
  index: number;
  totalSteps: number;
  agents: string[];
  onUpdate: (update: Partial<StepDraft>) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  dragHandleProps?: Record<string, unknown>;
}) {
  const rejectionOptions: { value: string; label: string }[] = [
    { value: "continue", label: "Continue to next step" },
    { value: "exit", label: "Exit workflow" },
  ];

  for (let i = 0; i < totalSteps; i++) {
    if (i !== index) {
      rejectionOptions.push({ value: String(i), label: `Loop back to step ${i + 1}` });
    }
  }

  const rejectionValue = typeof step.onRejection === "number"
    ? String(step.onRejection)
    : step.onRejection;

  return (
    <div className="group relative">
      {/* Connector line above */}
      {index > 0 && (
        <div className="flex justify-center -mt-px mb-0">
          <div className="w-px h-6 bg-[var(--d-border)]" />
        </div>
      )}

      <div className={cn(
        "relative rounded-xl border bg-[var(--d-bg-surface)] transition-all duration-150",
        "border-[var(--d-border-subtle)] hover:border-[var(--d-border)]",
        "shadow-[var(--d-shadow-sm)]",
      )}>
        {/* Step number pill */}
        <div className="absolute -left-3 top-4 w-6 h-6 rounded-full bg-[var(--d-bg-page)] border border-[var(--d-border)] flex items-center justify-center">
          <span className="text-[11px] font-semibold text-[var(--d-text-secondary)]">{index + 1}</span>
        </div>

        <div className="pl-6 pr-4 py-4">
          {/* Top row: agent select + actions */}
          <div className="flex items-center gap-3">
            {/* Reorder buttons */}
            <div className="flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={onMoveUp}
                disabled={index === 0}
                className="p-0.5 rounded text-[var(--d-text-disabled)] hover:text-[var(--d-text-secondary)] disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ChevronUpIcon className="w-3 h-3" />
              </button>
              <button
                onClick={onMoveDown}
                disabled={index === totalSteps - 1}
                className="p-0.5 rounded text-[var(--d-text-disabled)] hover:text-[var(--d-text-secondary)] disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ChevronDownIcon className="w-3 h-3" />
              </button>
            </div>

            {/* Agent select */}
            <div className="flex-1 relative">
              <select
                value={step.agent}
                onChange={(e) => onUpdate({ agent: e.target.value })}
                className={cn(
                  "w-full appearance-none rounded-lg border border-[var(--d-border)] bg-[var(--d-bg-surface)] px-3 py-2 pr-8",
                  "text-[13px] text-[var(--d-text-primary)] font-medium",
                  "focus:outline-none focus:ring-2 focus:ring-[var(--d-border-focus)]",
                  !step.agent && "text-[var(--d-text-tertiary)]",
                )}
              >
                <option value="">Select agent...</option>
                {agents.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
              <ChevronDownIcon className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--d-text-tertiary)] pointer-events-none" />
            </div>

            {/* Label input */}
            <input
              type="text"
              value={step.label}
              onChange={(e) => onUpdate({ label: e.target.value })}
              placeholder="Display label"
              className={cn(
                "w-36 rounded-lg border border-[var(--d-border)] bg-[var(--d-bg-surface)] px-3 py-2",
                "text-[13px] text-[var(--d-text-primary)]",
                "focus:outline-none focus:ring-2 focus:ring-[var(--d-border-focus)]",
                "placeholder:text-[var(--d-text-disabled)]",
              )}
            />

            {/* Remove button */}
            <button
              onClick={onRemove}
              disabled={totalSteps <= 1}
              className={cn(
                "p-1.5 rounded-lg transition-colors",
                "text-[var(--d-text-disabled)] hover:text-[var(--d-error)] hover:bg-[var(--d-error-bg)]",
                "disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-[var(--d-text-disabled)] disabled:hover:bg-transparent",
                "opacity-0 group-hover:opacity-100",
              )}
            >
              <CloseIcon className="w-4 h-4" />
            </button>
          </div>

          <div className="mt-3 grid grid-cols-[minmax(0,1fr)_220px] gap-3 pl-8">
            <div>
              <label className="block text-[11px] font-medium text-[var(--d-text-tertiary)] mb-1">
                Step ID
              </label>
              <input
                type="text"
                value={step.nodeId}
                onChange={(e) => onUpdate({ nodeId: e.target.value })}
                placeholder="plan"
                className={cn(
                  "w-full rounded-md border border-[var(--d-border-subtle)] bg-[var(--d-bg-subtle)] px-2.5 py-1.5",
                  "text-[12px] font-mono text-[var(--d-text-secondary)]",
                  "focus:outline-none focus:ring-2 focus:ring-[var(--d-border-focus)]",
                  "placeholder:text-[var(--d-text-disabled)]",
                )}
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-[var(--d-text-tertiary)] mb-1">
                Required artifact
              </label>
              <input
                type="text"
                value={step.artifactPath}
                onChange={(e) => onUpdate({ artifactPath: e.target.value })}
                placeholder=".vajra/plan.md"
                className={cn(
                  "w-full rounded-md border border-[var(--d-border-subtle)] bg-[var(--d-bg-subtle)] px-2.5 py-1.5",
                  "text-[12px] font-mono text-[var(--d-text-secondary)]",
                  "focus:outline-none focus:ring-2 focus:ring-[var(--d-border-focus)]",
                  "placeholder:text-[var(--d-text-disabled)]",
                )}
              />
            </div>
          </div>

          {/* Rejection routing — only show for steps that could reject */}
          {step.onRejection !== "continue" && (
            <div className="mt-3 flex items-center gap-2 pl-8">
              <span className="text-[11px] font-medium text-[var(--d-text-tertiary)] uppercase tracking-wider">
                On rejection
              </span>
              <div className="relative flex-1 max-w-[200px]">
                <select
                  value={rejectionValue}
                  onChange={(e) => {
                    const v = e.target.value;
                    onUpdate({
                      onRejection: v === "continue" ? "continue" : v === "exit" ? "exit" : Number(v),
                    });
                  }}
                  className={cn(
                    "w-full appearance-none rounded-md border border-[var(--d-border-subtle)] bg-[var(--d-bg-subtle)] px-2.5 py-1",
                    "text-[12px] text-[var(--d-text-secondary)]",
                    "focus:outline-none focus:ring-2 focus:ring-[var(--d-border-focus)]",
                  )}
                >
                  {rejectionOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                <ChevronDownIcon className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-[var(--d-text-tertiary)] pointer-events-none" />
              </div>
            </div>
          )}

          {/* Toggle rejection routing */}
          {step.onRejection === "continue" && (
            <button
              onClick={() => onUpdate({ onRejection: "exit" })}
              className="mt-2 pl-8 text-[11px] text-[var(--d-text-disabled)] hover:text-[var(--d-text-tertiary)] transition-colors opacity-0 group-hover:opacity-100"
            >
              + Add rejection route
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// LABEL CHIPS INPUT
// =============================================================================

function LabelChips({
  labels,
  onChange,
}: {
  labels: string[];
  onChange: (labels: string[]) => void;
}) {
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const value = input.trim().toLowerCase().replace(/[^a-z0-9:-]/g, "-");
      if (value && !labels.includes(value)) {
        onChange([...labels, value]);
      }
      setInput("");
    } else if (e.key === "Backspace" && !input && labels.length > 0) {
      onChange(labels.slice(0, -1));
    }
  };

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1.5 min-h-[36px] rounded-lg border border-[var(--d-border)] bg-[var(--d-bg-surface)] px-2.5 py-1.5",
        "focus-within:ring-2 focus-within:ring-[var(--d-border-focus)]",
      )}
      onClick={() => inputRef.current?.focus()}
    >
      {labels.map((label) => (
        <span
          key={label}
          className="inline-flex items-center gap-1 text-[12px] font-medium px-2 py-0.5 rounded-md bg-[var(--d-info-bg)] text-[var(--d-info-text)]"
        >
          {label}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onChange(labels.filter((l) => l !== label));
            }}
            className="hover:text-[var(--d-error)] transition-colors"
          >
            <CloseIcon className="w-3 h-3" />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={labels.length === 0 ? "Type a label and press Enter" : ""}
        className="flex-1 min-w-[100px] bg-transparent text-[13px] text-[var(--d-text-primary)] placeholder:text-[var(--d-text-disabled)] outline-none"
      />
    </div>
  );
}

// =============================================================================
// WORKFLOW BUILDER EDITOR
// =============================================================================

function WorkflowBuilder({
  draft,
  agents,
  isNew,
  saving,
  switchingModes,
  deleting,
  error,
  hasChanges,
  onChange,
  onSave,
  onDelete,
  onReset,
  onSwitchToAdvanced,
}: {
  draft: WorkflowDraft;
  agents: string[];
  isNew: boolean;
  saving: boolean;
  switchingModes: boolean;
  deleting: boolean;
  error: string | null;
  hasChanges: boolean;
  onChange: (update: Partial<WorkflowDraft>) => void;
  onSave: () => void;
  onDelete: () => void;
  onReset: () => void;
  onSwitchToAdvanced: () => void;
}) {
  const updateStep = (index: number, update: Partial<StepDraft>) => {
    const next = [...draft.steps];
    next[index] = { ...next[index], ...update };
    onChange({ steps: next });
  };

  const removeStep = (index: number) => {
    if (draft.steps.length <= 1) return;
    const next = draft.steps.filter((_, i) => i !== index);
    // Fix up rejection references
    const adjusted = next.map((step) => {
      if (typeof step.onRejection === "number") {
        if (step.onRejection === index) return { ...step, onRejection: "continue" as const };
        if (step.onRejection > index) return { ...step, onRejection: step.onRejection - 1 };
      }
      return step;
    });
    onChange({ steps: adjusted });
  };

  const addStep = () => {
    onChange({
      steps: [
        ...draft.steps,
        {
          id: makeStepId(),
          nodeId: `stage_${draft.steps.length}`,
          agent: agents[0] ?? "",
          label: "",
          artifactPath: "",
          onRejection: "continue",
        },
      ],
    });
  };

  const moveStep = (from: number, to: number) => {
    if (to < 0 || to >= draft.steps.length) return;
    const next = [...draft.steps];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    // Fix up rejection references
    const adjusted = next.map((step) => {
      if (typeof step.onRejection !== "number") return step;
      let target = step.onRejection;
      if (target === from) target = to;
      else if (from < to && target > from && target <= to) target--;
      else if (from > to && target < from && target >= to) target++;
      return { ...step, onRejection: target };
    });
    onChange({ steps: adjusted });
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 pt-6 pb-16">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h2 className="text-[20px] font-semibold text-[var(--d-text-primary)] tracking-tight">
              {isNew ? "New Workflow" : draft.name}
            </h2>
            <p className="text-[13px] text-[var(--d-text-tertiary)] mt-0.5">
              {isNew ? "Define when this runs and which agents to chain" : "Edit workflow steps and routing"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={onSwitchToAdvanced}
              disabled={saving || switchingModes}
              icon={<CodeIcon />}
            >
              DOT
            </Button>
            {hasChanges && (
              <Button variant="ghost" size="sm" onClick={onReset} disabled={saving || switchingModes}>
                Discard
              </Button>
            )}
            {!isNew && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onDelete}
                disabled={saving || deleting || switchingModes}
                icon={<TrashIcon />}
                className="text-[var(--d-error)] hover:text-[var(--d-error)] hover:bg-[var(--d-error-bg)]"
              >
                Delete
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={onSave}
              loading={saving}
              disabled={switchingModes || (!hasChanges && !isNew)}
            >
              {isNew ? "Create" : "Save"}
            </Button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-6 px-4 py-3 rounded-xl bg-[var(--d-error-bg)] border border-[var(--d-error)]/20">
            <p className="text-[13px] text-[var(--d-error-text)]">{error}</p>
          </div>
        )}

        {/* ── SECTION: TRIGGER ── */}
        <section className="mb-10">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--d-text-tertiary)] mb-4">
            Trigger
          </h3>

          <div className="space-y-4">
            {/* Name */}
            <div>
              <label className="block text-[12px] font-medium text-[var(--d-text-secondary)] mb-1.5">
                Workflow name
              </label>
              <input
                type="text"
                value={draft.name}
                onChange={(e) => onChange({ name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })}
                disabled={!isNew}
                placeholder="code-and-review"
                className={cn(
                  "w-full rounded-lg border border-[var(--d-border)] bg-[var(--d-bg-surface)] px-3 py-2",
                  "text-[14px] font-mono text-[var(--d-text-primary)]",
                  "focus:outline-none focus:ring-2 focus:ring-[var(--d-border-focus)]",
                  "disabled:opacity-60 disabled:bg-[var(--d-bg-subtle)]",
                )}
              />
            </div>

            {/* Labels */}
            <div>
              <label className="block text-[12px] font-medium text-[var(--d-text-secondary)] mb-1.5">
                Triggered by labels
              </label>
              <LabelChips labels={draft.labels} onChange={(labels) => onChange({ labels })} />
              <p className="text-[11px] text-[var(--d-text-tertiary)] mt-1">
                Linear issues with these labels will use this workflow.
              </p>
            </div>

            {/* Default toggle */}
            <div className="flex items-center justify-between py-1">
              <div>
                <p className="text-[13px] font-medium text-[var(--d-text-primary)]">Default workflow</p>
                <p className="text-[11px] text-[var(--d-text-tertiary)] mt-0.5">
                  Used when no label matches any workflow.
                </p>
              </div>
              <Toggle enabled={draft.isDefault} onChange={(v) => onChange({ isDefault: v })} />
            </div>

            <div>
              <label className="block text-[12px] font-medium text-[var(--d-text-secondary)] mb-1.5">
                Workflow summary
              </label>
              <textarea
                value={draft.goal}
                onChange={(e) => onChange({ goal: e.target.value })}
                placeholder="Plan, implement, test, and ship a Linear ticket as a PR"
                rows={3}
                className={cn(
                  "w-full rounded-lg border border-[var(--d-border)] bg-[var(--d-bg-surface)] px-3 py-2",
                  "text-[13px] text-[var(--d-text-primary)] leading-relaxed",
                  "focus:outline-none focus:ring-2 focus:ring-[var(--d-border-focus)]",
                  "resize-y placeholder:text-[var(--d-text-disabled)]",
                )}
              />
              <p className="text-[11px] text-[var(--d-text-tertiary)] mt-1">
                Optional high-level goal stored in the workflow graph metadata.
              </p>
            </div>
          </div>
        </section>

        {/* ── SECTION: STEPS ── */}
        <section className="mb-10">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--d-text-tertiary)]">
              Steps
            </h3>
            <span className="text-[11px] text-[var(--d-text-disabled)]">
              {draft.steps.length} step{draft.steps.length !== 1 ? "s" : ""}
            </span>
          </div>

          {/* Start node indicator */}
          <div className="flex items-center gap-2 mb-2 pl-1">
            <div className="w-2 h-2 rounded-full bg-[var(--d-text-tertiary)]" />
            <span className="text-[11px] font-medium text-[var(--d-text-tertiary)]">Start</span>
          </div>

          <div className="pl-4">
            {draft.steps.map((step, i) => (
              <StepCard
                key={step.id}
                step={step}
                index={i}
                totalSteps={draft.steps.length}
                agents={agents}
                onUpdate={(update) => updateStep(i, update)}
                onRemove={() => removeStep(i)}
                onMoveUp={() => moveStep(i, i - 1)}
                onMoveDown={() => moveStep(i, i + 1)}
              />
            ))}

            {/* Add step button */}
            <div className="flex justify-center mt-0">
              <div className="w-px h-6 bg-[var(--d-border)]" />
            </div>
            <button
              onClick={addStep}
              className={cn(
                "w-full py-3 rounded-xl border-2 border-dashed border-[var(--d-border-subtle)]",
                "text-[13px] font-medium text-[var(--d-text-tertiary)]",
                "hover:border-[var(--d-border)] hover:text-[var(--d-text-secondary)] hover:bg-[var(--d-bg-hover)]",
                "transition-all duration-150",
                "flex items-center justify-center gap-2",
              )}
            >
              <PlusIcon className="w-4 h-4" />
              Add step
            </button>

            {/* Exit node indicator */}
            <div className="flex justify-center">
              <div className="w-px h-6 bg-[var(--d-border)]" />
            </div>
            <div className="flex items-center gap-2 pl-1">
              <div className="w-2 h-2 rounded-sm bg-[var(--d-text-tertiary)]" />
              <span className="text-[11px] font-medium text-[var(--d-text-tertiary)]">Complete</span>
            </div>
          </div>
        </section>

        {/* ── SECTION: ON COMPLETE ── */}
        <section>
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--d-text-tertiary)] mb-4">
            On Complete
          </h3>

          <div className="space-y-4">
            {/* Success state */}
            <div>
              <label className="block text-[12px] font-medium text-[var(--d-text-secondary)] mb-1.5">
                Move issue to
              </label>
              <input
                type="text"
                value={draft.successState}
                onChange={(e) => onChange({ successState: e.target.value })}
                placeholder="Done"
                className={cn(
                  "w-48 rounded-lg border border-[var(--d-border)] bg-[var(--d-bg-surface)] px-3 py-2",
                  "text-[13px] text-[var(--d-text-primary)]",
                  "focus:outline-none focus:ring-2 focus:ring-[var(--d-border-focus)]",
                )}
              />
              <p className="text-[11px] text-[var(--d-text-tertiary)] mt-1">
                Linear state to transition the issue to after all steps complete.
              </p>
            </div>

            {/* Inspect PR toggle */}
            <div className="flex items-center justify-between py-1">
              <div>
                <p className="text-[13px] font-medium text-[var(--d-text-primary)]">Inspect PR</p>
                <p className="text-[11px] text-[var(--d-text-tertiary)] mt-0.5">
                  Run PR inspection before marking the issue complete.
                </p>
              </div>
              <Toggle enabled={draft.inspectPr} onChange={(v) => onChange({ inspectPr: v })} />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

// =============================================================================
// ADVANCED DOT EDITOR (fallback for complex workflows)
// =============================================================================

function AdvancedEditor({
  workflow,
  name,
  isNew,
  saving,
  switchingModes,
  deleting,
  error,
  hasChanges,
  rawDot,
  successState,
  inspectPr,
  labels,
  isDefault,
  onNameChange,
  onRawDotChange,
  onSuccessStateChange,
  onInspectPrChange,
  onLabelsChange,
  onIsDefaultChange,
  onSave,
  onDelete,
  onReset,
  onSwitchToBuilder,
}: {
  workflow: VajraWorkflowDefinition | null;
  name: string;
  isNew: boolean;
  saving: boolean;
  switchingModes: boolean;
  deleting: boolean;
  error: string | null;
  hasChanges: boolean;
  rawDot: string;
  successState: string;
  inspectPr: boolean;
  labels: string[];
  isDefault: boolean;
  onNameChange: (v: string) => void;
  onRawDotChange: (v: string) => void;
  onSuccessStateChange: (v: string) => void;
  onInspectPrChange: (v: boolean) => void;
  onLabelsChange: (v: string[]) => void;
  onIsDefaultChange: (v: boolean) => void;
  onSave: () => void;
  onDelete: () => void;
  onReset: () => void;
  onSwitchToBuilder: () => void;
}) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 pt-6 pb-16">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-[20px] font-semibold text-[var(--d-text-primary)] tracking-tight">
              {isNew ? "New Workflow" : name || "Workflow"}
            </h2>
            <p className="text-[13px] text-[var(--d-text-tertiary)] mt-0.5">
              Edit the pipeline graph directly as DOT
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={onSwitchToBuilder}
              disabled={saving || switchingModes}
              icon={<WorkflowIcon />}
            >
              Builder
            </Button>
            {hasChanges && (
              <Button variant="ghost" size="sm" onClick={onReset} disabled={saving || switchingModes}>
                Discard
              </Button>
            )}
            {!isNew && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onDelete}
                disabled={saving || deleting || switchingModes}
                icon={<TrashIcon />}
                className="text-[var(--d-error)] hover:text-[var(--d-error)] hover:bg-[var(--d-error-bg)]"
              >
                Delete
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={onSave}
              loading={saving}
              disabled={switchingModes || !hasChanges}
            >
              Save
            </Button>
          </div>
        </div>



        {error && (
          <div className="mb-6 px-4 py-3 rounded-xl bg-[var(--d-error-bg)] border border-[var(--d-error)]/20">
            <p className="text-[13px] text-[var(--d-error-text)]">{error}</p>
          </div>
        )}

        {/* Name — editable for new workflows */}
        {isNew && (
          <div className="mb-5">
            <label className="block text-[12px] font-medium text-[var(--d-text-secondary)] mb-1.5">
              Workflow name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => onNameChange(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
              placeholder="code-and-review"
              className={cn(
                "w-full rounded-lg border border-[var(--d-border)] bg-[var(--d-bg-surface)] px-3 py-2",
                "text-[14px] font-mono text-[var(--d-text-primary)]",
                "focus:outline-none focus:ring-2 focus:ring-[var(--d-border-focus)]",
              )}
            />
          </div>
        )}

        {/* Labels */}
        <div className="mb-5">
          <label className="block text-[12px] font-medium text-[var(--d-text-secondary)] mb-1.5">
            Triggered by labels
          </label>
          <LabelChips labels={labels} onChange={onLabelsChange} />
        </div>

        {/* Default toggle */}
        <div className="flex items-center justify-between py-1 mb-5">
          <div>
            <p className="text-[13px] font-medium text-[var(--d-text-primary)]">Default workflow</p>
          </div>
          <Toggle enabled={isDefault} onChange={onIsDefaultChange} />
        </div>

        {/* DOT editor */}
        <div className="mb-5">
          <label className="block text-[12px] font-medium text-[var(--d-text-secondary)] mb-1.5">
            DOT Graph
          </label>
          <textarea
            value={rawDot}
            onChange={(e) => onRawDotChange(e.target.value)}
            rows={20}
            spellCheck={false}
            className={cn(
              "w-full rounded-lg border border-[var(--d-border)] bg-[var(--d-bg-surface)] px-4 py-3",
              "text-[13px] font-mono text-[var(--d-text-primary)] leading-relaxed",
              "focus:outline-none focus:ring-2 focus:ring-[var(--d-border-focus)]",
              "resize-y",
            )}
          />
        </div>

        {/* Success state + inspect PR */}
        <div className="grid grid-cols-2 gap-4 mb-5">
          <div>
            <label className="block text-[12px] font-medium text-[var(--d-text-secondary)] mb-1.5">
              Success state
            </label>
            <input
              type="text"
              value={successState}
              onChange={(e) => onSuccessStateChange(e.target.value)}
              className={cn(
                "w-full rounded-lg border border-[var(--d-border)] bg-[var(--d-bg-surface)] px-3 py-2",
                "text-[13px] text-[var(--d-text-primary)]",
                "focus:outline-none focus:ring-2 focus:ring-[var(--d-border-focus)]",
              )}
            />
          </div>
          <div className="flex items-end pb-1">
            <div className="flex items-center gap-3">
              <Toggle enabled={inspectPr} onChange={onInspectPrChange} />
              <span className="text-[13px] text-[var(--d-text-secondary)]">Inspect PR</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// SIDEBAR CARD
// =============================================================================

function WorkflowCard({
  workflow,
  selected,
  onClick,
}: {
  workflow: VajraWorkflowDefinition;
  selected: boolean;
  onClick: () => void;
}) {
  const stageCount = workflow.nodes.filter((n) => n.type !== "start" && n.type !== "exit").length;

  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left px-4 py-3 transition-colors duration-100 border-b border-[var(--d-border-subtle)]",
        selected
          ? "bg-[var(--d-bg-selected-strong)]"
          : "hover:bg-[var(--d-bg-hover)]",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-semibold text-[var(--d-text-primary)]">
          {workflow.name}
        </span>
        {workflow.isDefault && (
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[var(--d-info-bg)] text-[var(--d-info-text)]">
            default
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 mt-1">
        <span className="text-[11px] text-[var(--d-text-tertiary)]">
          {stageCount} step{stageCount !== 1 ? "s" : ""}
        </span>
        {workflow.successState && (
          <>
            <span className="text-[var(--d-border)]">&middot;</span>
            <span className="text-[11px] text-[var(--d-text-tertiary)]">{workflow.successState}</span>
          </>
        )}
      </div>
      {workflow.labels.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {workflow.labels.map((label) => (
            <span
              key={label}
              className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-[var(--d-info-bg)] text-[var(--d-info-text)]"
            >
              {label}
            </span>
          ))}
        </div>
      )}
      {workflow.parseError && (
        <p className="text-[11px] text-[var(--d-error)] mt-1 truncate">
          Parse error
        </p>
      )}
    </button>
  );
}

// =============================================================================
// PAGE
// =============================================================================

export default function VajraWorkflowsPage() {
  const searchParams = useSearchParams();
  const workflowsData = useVajra<VajraWorkflowsResponse>("config/workflows");
  const agentsData = useVajra<VajraAgentsResponse>("config/agents");

  const [selectedName, setSelectedName] = useState<string | null>(searchParams.get("workflow"));
  const [isNew, setIsNew] = useState(false);

  // Builder mode state
  const [draft, setDraft] = useState<WorkflowDraft | null>(null);
  const [originalJson, setOriginalJson] = useState("");

  // Advanced mode state
  const [advancedMode, setAdvancedMode] = useState(false);
  const [advName, setAdvName] = useState("");
  const [advRawDot, setAdvRawDot] = useState("");
  const [advSuccessState, setAdvSuccessState] = useState("Done");
  const [advInspectPr, setAdvInspectPr] = useState(true);
  const [advLabels, setAdvLabels] = useState<string[]>([]);
  const [advIsDefault, setAdvIsDefault] = useState(false);
  const [advOriginalJson, setAdvOriginalJson] = useState("");

  const [saving, setSaving] = useState(false);
  const [switchingModes, setSwitchingModes] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDelete, setShowDelete] = useState(false);

  const workflows = workflowsData.data?.workflows ?? [];
  const agents = agentsData.data?.agents ?? {};
  const agentNames = useMemo(() => Object.keys(agents).sort(), [agents]);

  // Auto-select first workflow
  useEffect(() => {
    if (!selectedName && workflows.length > 0 && !isNew) {
      setSelectedName(workflows[0].name);
    }
  }, [workflows, selectedName, isNew]);

  // Sync editor state when selection changes
  useEffect(() => {
    if (!selectedName) return;
    const workflow = workflows.find((w) => w.name === selectedName);
    if (!workflow) return;

    // DOT editor is the default — it handles all workflows.
    // The builder is available only for simple linear workflows via the "Builder" button.
    setDraft(null);
    setAdvancedMode(true);
    setAdvName(workflow.name);
    setAdvRawDot(workflow.rawDot);
    setAdvSuccessState(workflow.successState);
    setAdvInspectPr(workflow.inspectPr);
    setAdvLabels([...workflow.labels]);
    setAdvIsDefault(workflow.isDefault);
    setAdvOriginalJson(JSON.stringify({
      rawDot: workflow.rawDot,
      successState: workflow.successState,
      inspectPr: workflow.inspectPr,
      labels: workflow.labels,
      isDefault: workflow.isDefault,
    }));
    setIsNew(false);
    setError(null);
  }, [selectedName, workflows]);

  const hasChanges = advancedMode
    ? JSON.stringify({ rawDot: advRawDot, successState: advSuccessState, inspectPr: advInspectPr, labels: advLabels, isDefault: advIsDefault }) !== advOriginalJson
    : draft ? JSON.stringify(draft) !== originalJson : false;

  const handleSelect = (name: string) => {
    setSelectedName(name);
    setIsNew(false);
    window.history.replaceState(null, "", `/vajra/workflows?workflow=${encodeURIComponent(name)}`);
  };

  const handleNew = () => {
    // New workflows default to DOT editor
    setDraft(null);
    setSelectedName(null);
    setIsNew(true);
    setAdvancedMode(true);
    setAdvName("");
    setAdvRawDot("digraph Workflow {\n  start [shape=Mdiamond]\n  exit  [shape=Msquare]\n\n  start -> exit\n}\n");
    setAdvSuccessState("Done");
    setAdvInspectPr(true);
    setAdvLabels([]);
    setAdvIsDefault(false);
    setAdvOriginalJson("");
    setError(null);
    window.history.replaceState(null, "", "/vajra/workflows");
  };

  const handleDraftChange = (update: Partial<WorkflowDraft>) => {
    if (!draft) return;
    setDraft({ ...draft, ...update });
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);

    try {
      let name: string;
      let rawDot: string;
      let successState: string;
      let inspectPr: boolean;
      let labels: string[];
      let isDefault: boolean;

      if (advancedMode) {
        name = selectedName ?? advName;
        if (!name.trim()) {
          setError("Workflow name is required.");
          setSaving(false);
          return;
        }
        rawDot = advRawDot;
        successState = advSuccessState;
        inspectPr = advInspectPr;
        labels = advLabels;
        isDefault = advIsDefault;
      } else {
        if (!draft) return;
        if (!draft.name.trim()) {
          setError("Workflow name is required.");
          setSaving(false);
          return;
        }
        if (draft.steps.length === 0) {
          setError("At least one step is required.");
          setSaving(false);
          return;
        }
        if (draft.steps.some((s) => !s.agent)) {
          setError("Every step must have an agent selected.");
          setSaving(false);
          return;
        }

        name = draft.name;
        rawDot = draftToDot(draft);
        successState = draft.successState;
        inspectPr = draft.inspectPr;
        labels = draft.labels;
        isDefault = draft.isDefault;
      }

      await saveVajraWorkflow(name, { rawDot, successState, inspectPr, labels, isDefault });
      await workflowsData.refetch();
      setSelectedName(name);
      setIsNew(false);
      window.history.replaceState(null, "", `/vajra/workflows?workflow=${encodeURIComponent(name)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save workflow.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedName) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteVajraWorkflow(selectedName);
      await workflowsData.refetch();
      setSelectedName(null);
      setDraft(null);
      setShowDelete(false);
      window.history.replaceState(null, "", "/vajra/workflows");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete workflow.");
      setShowDelete(false);
    } finally {
      setDeleting(false);
    }
  };

  const handleReset = () => {
    if (advancedMode && selectedName) {
      const workflow = workflows.find((w) => w.name === selectedName);
      if (workflow) {
        setAdvRawDot(workflow.rawDot);
        setAdvSuccessState(workflow.successState);
        setAdvInspectPr(workflow.inspectPr);
        setAdvLabels([...workflow.labels]);
        setAdvIsDefault(workflow.isDefault);
      }
    } else if (advancedMode && isNew) {
      setAdvName("");
      setAdvRawDot("digraph Workflow {\n  start [shape=Mdiamond]\n  exit  [shape=Msquare]\n\n  start -> exit\n}\n");
      setAdvSuccessState("Done");
      setAdvInspectPr(true);
      setAdvLabels([]);
      setAdvIsDefault(false);
    } else if (selectedName) {
      const workflow = workflows.find((w) => w.name === selectedName);
      if (workflow) {
        const d = workflowToDraft(workflow);
        if (d) setDraft(d);
      }
    } else if (isNew) {
      setDraft(emptyWorkflowDraft(agentNames));
    }
  };

  const handleSwitchToAdvanced = () => {
    // Generate DOT from current draft so the user starts with something
    const rawDot = draft ? draftToDot(draft) : "";
    setAdvName(draft?.name ?? selectedName ?? "");
    setAdvRawDot(rawDot);
    setAdvSuccessState(draft?.successState ?? "Done");
    setAdvInspectPr(draft?.inspectPr ?? true);
    setAdvLabels(draft?.labels ?? []);
    setAdvIsDefault(draft?.isDefault ?? false);
    setAdvOriginalJson(""); // Mark as changed so Save is enabled
    setAdvancedMode(true);
    setDraft(null);
  };

  const handleSwitchToBuilder = async () => {
    const previewName = (selectedName ?? advName).trim();
    if (!previewName) {
      setError("Workflow name is required before switching to builder mode.");
      return;
    }

    const hadAdvancedChanges = hasChanges;
    setSwitchingModes(true);
    setError(null);
    try {
      const previewWorkflow = await previewVajraWorkflow({
        name: previewName,
        rawDot: advRawDot,
        successState: advSuccessState,
        inspectPr: advInspectPr,
        labels: advLabels,
        isDefault: advIsDefault,
      });
      const builderDraft = workflowToDraft(previewWorkflow);
      if (!builderDraft) {
        setError("This workflow uses features outside the step builder. Cannot switch to builder mode.");
        return;
      }

      setDraft(builderDraft);
      setOriginalJson(hadAdvancedChanges ? "" : JSON.stringify(builderDraft));
      setAdvancedMode(false);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to parse workflow DOT.");
    } finally {
      setSwitchingModes(false);
    }
  };

  const currentWorkflow = selectedName
    ? workflows.find((w) => w.name === selectedName) ?? null
    : null;

  const showEditor = draft !== null || advancedMode;

  return (
    <div className="h-screen overflow-hidden bg-[var(--d-bg-page)]">
      <div className="h-full flex">
        {/* Left sidebar */}
        <div className="w-[280px] flex-shrink-0 border-r border-[var(--d-border)] bg-[var(--d-bg-surface)] flex flex-col">
          <div className="px-4 pt-5 pb-3 border-b border-[var(--d-border-subtle)]">
            <div className="flex items-center justify-between mb-1">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--d-text-tertiary)]">
                  Vajra
                </p>
                <h1 className="text-[17px] font-semibold text-[var(--d-text-primary)] tracking-tight">
                  Workflows
                </h1>
              </div>
              <Button variant="primary" size="sm" icon={<PlusIcon />} onClick={handleNew}>
                New
              </Button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {workflowsData.loading ? (
              <div className="px-4 py-6">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="py-3 border-b border-[var(--d-border-subtle)]">
                    <div className="h-3.5 w-24 bg-[var(--d-bg-active)] rounded mb-2" />
                    <div className="h-3 w-32 bg-[var(--d-bg-active)] rounded" />
                  </div>
                ))}
              </div>
            ) : workflows.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <WorkflowIcon className="w-8 h-8 mx-auto text-[var(--d-text-disabled)] mb-3" />
                <p className="text-[13px] text-[var(--d-text-tertiary)]">No workflows</p>
                <p className="text-[11px] text-[var(--d-text-disabled)] mt-1">
                  Create one to get started
                </p>
              </div>
            ) : (
              workflows.map((workflow) => (
                <WorkflowCard
                  key={workflow.name}
                  workflow={workflow}
                  selected={workflow.name === selectedName && !isNew}
                  onClick={() => handleSelect(workflow.name)}
                />
              ))
            )}
          </div>
        </div>

        {/* Right editor */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {showEditor ? (
            advancedMode ? (
              <AdvancedEditor
                workflow={currentWorkflow}
                name={advName}
                isNew={isNew}
                saving={saving}
                switchingModes={switchingModes}
                deleting={deleting}
                error={error}
                hasChanges={hasChanges}
                rawDot={advRawDot}
                successState={advSuccessState}
                inspectPr={advInspectPr}
                labels={advLabels}
                isDefault={advIsDefault}
                onNameChange={setAdvName}
                onRawDotChange={setAdvRawDot}
                onSuccessStateChange={setAdvSuccessState}
                onInspectPrChange={setAdvInspectPr}
                onLabelsChange={setAdvLabels}
                onIsDefaultChange={setAdvIsDefault}
                onSave={handleSave}
                onDelete={() => setShowDelete(true)}
                onReset={handleReset}
                onSwitchToBuilder={handleSwitchToBuilder}
              />
            ) : (
              <WorkflowBuilder
                draft={draft!}
                agents={agentNames}
                isNew={isNew}
                saving={saving}
                switchingModes={switchingModes}
                deleting={deleting}
                error={error}
                hasChanges={hasChanges}
                onChange={handleDraftChange}
                onSave={handleSave}
                onDelete={() => setShowDelete(true)}
                onReset={handleReset}
                onSwitchToAdvanced={handleSwitchToAdvanced}
              />
            )
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <WorkflowIcon className="w-12 h-12 mx-auto text-[var(--d-text-disabled)] mb-4" />
                <p className="text-[15px] font-medium text-[var(--d-text-secondary)]">
                  Select a workflow
                </p>
                <p className="text-[13px] text-[var(--d-text-tertiary)] mt-1">
                  or create a new one to get started
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Delete confirmation */}
      <ConfirmDialog
        isOpen={showDelete}
        onClose={() => setShowDelete(false)}
        title={`Delete "${selectedName}"?`}
        description="This will remove the workflow definition and its DOT file. Any issues routed to this workflow will fall back to the default."
        confirmLabel="Delete"
        onConfirm={handleDelete}
        destructive
        loading={deleting}
      />
    </div>
  );
}

"use client";

/**
 * Vajra Config — structured forms for system settings.
 *
 * Sections: Tracker, Execution, Workflows, Backends, Slack.
 * No raw YAML editing — all forms, all structured.
 */

import { useState } from "react";
import { cn } from "@/lib/design";
import { useVajra } from "@/lib/vajra";
import type {
  VajraConfigSnapshot,
  VajraWorkflowsResponse,
  VajraEscalationConfig,
  VajraTriageConfig,
  VajraGitHubConfig,
  VajraFanOutDefinition,
} from "@/lib/vajra/types";
import { Toggle } from "@/components/dashboard/toggle";
import { ChartCard } from "@/components/dashboard/chart-card";
import { Tabs } from "@/components/dashboard/tabs";
import {
  CheckIcon,
} from "@/components/ui/icons";

// =============================================================================
// HELPERS
// =============================================================================

function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="block text-[12px] font-medium text-[var(--d-text-secondary)] mb-1.5">
        {label}
      </label>
      {children}
      {hint && <p className="text-[11px] text-[var(--d-text-tertiary)] mt-1">{hint}</p>}
    </div>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  mono,
  disabled,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      className={cn(
        "w-full rounded-lg border border-[var(--d-border)] bg-[var(--d-bg-surface)] px-3 py-2",
        "text-[13px] text-[var(--d-text-primary)]",
        "focus:outline-none focus:ring-2 focus:ring-[var(--d-border-focus)]",
        "disabled:opacity-50 disabled:bg-[var(--d-bg-subtle)]",
        mono && "font-mono",
        className,
      )}
    />
  );
}

function TagInput({
  tags,
  onChange,
  placeholder,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
}) {
  const [input, setInput] = useState("");

  const addTag = (tag: string) => {
    const trimmed = tag.trim();
    if (trimmed && !tags.includes(trimmed)) {
      onChange([...tags, trimmed]);
    }
    setInput("");
  };

  const removeTag = (tag: string) => {
    onChange(tags.filter((t) => t !== tag));
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 p-2 min-h-[40px] rounded-lg border border-[var(--d-border)] bg-[var(--d-bg-surface)] focus-within:ring-2 focus-within:ring-[var(--d-border-focus)]">
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[12px] font-medium bg-[var(--d-bg-page)] text-[var(--d-text-primary)] border border-[var(--d-border-subtle)]"
        >
          {tag}
          <button
            onClick={() => removeTag(tag)}
            className="text-[var(--d-text-tertiary)] hover:text-[var(--d-text-primary)]"
          >
            ×
          </button>
        </span>
      ))}
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            addTag(input);
          }
          if (e.key === "Backspace" && !input && tags.length > 0) {
            removeTag(tags[tags.length - 1]);
          }
        }}
        onBlur={() => { if (input) addTag(input); }}
        placeholder={tags.length === 0 ? placeholder : ""}
        className="flex-1 min-w-[80px] text-[13px] text-[var(--d-text-primary)] bg-transparent border-0 outline-none"
      />
    </div>
  );
}

// =============================================================================
// SECTION: TRACKER
// =============================================================================

function TrackerSection({ config }: { config: VajraConfigSnapshot }) {
  return (
    <ChartCard title="Tracker" subtitle="Linear issue source configuration">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Assignee ID">
            <TextInput value={config.tracker.assigneeId} onChange={() => {}} mono disabled />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Active States" hint="Issues in these states get picked up">
            <TagInput tags={config.tracker.activeStates} onChange={() => {}} />
          </Field>
          <Field label="Terminal States" hint="Issues in these states are considered done">
            <TagInput tags={config.tracker.terminalStates} onChange={() => {}} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Polling Interval">
            <p className="text-[13px] font-mono text-[var(--d-text-primary)]">
              {(config.polling.intervalMs / 1000).toFixed(0)}s
            </p>
          </Field>
          <Field label="API Key">
            <p className="text-[13px] text-[var(--d-text-primary)]">
              {config.tracker.apiKeyConfigured ? (
                <span className="inline-flex items-center gap-1 text-[var(--d-success-text)]">
                  <CheckIcon className="w-3.5 h-3.5" /> Configured
                </span>
              ) : (
                <span className="text-[var(--d-error-text)]">Not set</span>
              )}
            </p>
          </Field>
        </div>
      </div>
    </ChartCard>
  );
}

// =============================================================================
// SECTION: EXECUTION
// =============================================================================

function ExecutionSection({ config }: { config: VajraConfigSnapshot }) {
  const exec = config.execution;

  return (
    <ChartCard title="Execution" subtitle="Concurrency and retry settings">
      <div className="space-y-4">
        <div className="grid grid-cols-4 gap-4">
          <Field label="Max Concurrent Agents">
            <p className="text-[20px] font-semibold font-mono text-[var(--d-text-primary)]">
              {exec.maxConcurrentAgents}
            </p>
          </Field>
          <Field label="Max Retry Attempts">
            <p className="text-[20px] font-semibold font-mono text-[var(--d-text-primary)]">
              {exec.maxRetryAttempts}
            </p>
          </Field>
          <Field label="Max Retry Backoff">
            <p className="text-[20px] font-semibold font-mono text-[var(--d-text-primary)]">
              {exec.maxRetryBackoffMs >= 60000
                ? `${(exec.maxRetryBackoffMs / 60000).toFixed(0)}m`
                : `${(exec.maxRetryBackoffMs / 1000).toFixed(0)}s`}
            </p>
          </Field>
          <Field label="Agent Budget / Run">
            <p className="text-[20px] font-semibold font-mono text-[var(--d-text-primary)]">
              {exec.maxAgentInvocationsPerRun}
            </p>
          </Field>
        </div>

        {Object.keys(exec.maxConcurrentAgentsByState).length > 0 && (
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--d-text-tertiary)] mb-2">
              Per-State Limits
            </p>
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
              {Object.entries(exec.maxConcurrentAgentsByState).map(([state, limit]) => (
                <div key={state} className="contents">
                  <span className="text-[12px] font-mono text-[var(--d-text-secondary)]">{state}</span>
                  <span className="text-[12px] font-mono font-semibold text-[var(--d-text-primary)]">{limit}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </ChartCard>
  );
}

// =============================================================================
// SECTION: WORKFLOWS
// =============================================================================

function WorkflowsSection({
  workflows,
}: {
  workflows: VajraWorkflowsResponse | null;
}) {
  const entries = workflows?.workflows ?? [];
  const defaultWorkflow = workflows?.defaultWorkflow ?? null;

  return (
    <ChartCard title="Workflows" subtitle="Route issues to workflow graphs by label">
      {/* Workflow entries table */}
      <div className="bg-[var(--d-bg-page)] rounded-lg overflow-hidden border border-[var(--d-border-subtle)]">
        <div className="grid grid-cols-[1fr_1fr_110px_80px] gap-4 px-4 py-2 border-b border-[var(--d-border-subtle)] bg-[var(--d-bg-subtle)]">
          <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--d-text-tertiary)]">Name</span>
          <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--d-text-tertiary)]">DOT File</span>
          <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--d-text-tertiary)]">Success State</span>
          <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--d-text-tertiary)]">Inspect PR</span>
        </div>
        {entries.map((entry) => (
          <div key={entry.name} className="grid grid-cols-[1fr_1fr_110px_80px] gap-4 px-4 py-2.5 border-b border-[var(--d-border-subtle)] last:border-0 items-center">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold text-[var(--d-text-primary)]">{entry.name}</span>
              {(entry.isDefault || entry.name === defaultWorkflow) && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-[var(--d-info-bg)] text-[var(--d-info-text)]">
                  default
                </span>
              )}
            </div>
            <span className="text-[12px] font-mono text-[var(--d-text-link)]">{entry.dotFile}</span>
            <span className="text-[12px] text-[var(--d-text-secondary)]">{entry.successState}</span>
            <span className="text-[12px] text-[var(--d-text-secondary)]">{entry.inspectPr ? "Yes" : "No"}</span>
          </div>
        ))}
      </div>

      {entries.some((entry) => entry.labels.length > 0) && (
        <div className="mt-4">
          <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--d-text-tertiary)] mb-2">
            Label Routing
          </p>
          <div className="flex flex-wrap gap-2">
            {entries.flatMap((entry) => entry.labels.map((label) => (
              <span
                key={`${label}:${entry.name}`}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] bg-[var(--d-bg-surface)] border border-[var(--d-border-subtle)]"
              >
                <span className="font-medium text-[var(--d-text-primary)]">{label}</span>
                <span className="text-[var(--d-text-tertiary)]">→</span>
                <span className="font-mono text-[var(--d-text-link)]">{entry.name}</span>
              </span>
            )))}
          </div>
        </div>
      )}
    </ChartCard>
  );
}

// =============================================================================
// SECTION: BACKENDS
// =============================================================================

function BackendsSection({ config }: { config: VajraConfigSnapshot }) {
  const entries = Object.entries(config.backends);

  return (
    <ChartCard title="Backends" subtitle="CLI command templates for agent execution">
      <div className="space-y-3">
        {entries.map(([name, backend]) => (
          <div
            key={name}
            className="rounded-lg border border-[var(--d-border-subtle)] bg-[var(--d-bg-page)] px-4 py-3"
          >
            <span className="text-[13px] font-semibold text-[var(--d-text-primary)]">{name}</span>
            <pre className="text-[11px] font-mono text-[var(--d-text-secondary)] mt-1.5 whitespace-pre-wrap break-all leading-relaxed">
              {backend.command}
            </pre>
          </div>
        ))}
      </div>
    </ChartCard>
  );
}

// =============================================================================
// SECTION: ESCALATION
// =============================================================================

function EscalationSection({ config }: { config: VajraEscalationConfig }) {
  return (
    <ChartCard title="Escalation" subtitle="What happens when a stage escalates to a human">
      <div className="grid grid-cols-3 gap-4">
        <Field label="Linear State">
          <p className="text-[13px] font-mono text-[var(--d-text-primary)]">{config.linearState}</p>
        </Field>
        <Field label="Comment on Issue">
          <p className="text-[13px] text-[var(--d-text-primary)]">{config.comment ? "Yes" : "No"}</p>
        </Field>
        <Field label="Slack Notify">
          <p className="text-[13px] text-[var(--d-text-primary)]">{config.slackNotify ? "Yes" : "No"}</p>
        </Field>
      </div>
    </ChartCard>
  );
}

// =============================================================================
// SECTION: TRIAGE
// =============================================================================

function TriageSection({ config }: { config: VajraTriageConfig }) {
  return (
    <ChartCard title="Triage" subtitle="LLM-based issue classification before dispatch">
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <span className={cn(
            "text-[11px] font-semibold px-2 py-0.5 rounded-full",
            config.enabled
              ? "bg-[var(--d-success-bg)] text-[var(--d-success-text)]"
              : "bg-[var(--d-bg-page)] text-[var(--d-text-disabled)]",
          )}>
            {config.enabled ? "Enabled" : "Disabled"}
          </span>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <Field label="Backend">
            <p className="text-[13px] font-mono text-[var(--d-text-primary)]">{config.backend}</p>
          </Field>
          <Field label="Model">
            <p className="text-[13px] font-mono text-[var(--d-text-primary)]">{config.model}</p>
          </Field>
          <Field label="Timeout">
            <p className="text-[13px] font-mono text-[var(--d-text-primary)]">
              {config.timeoutMs >= 60000
                ? `${(config.timeoutMs / 60000).toFixed(0)}m`
                : `${(config.timeoutMs / 1000).toFixed(0)}s`}
            </p>
          </Field>
        </div>
      </div>
    </ChartCard>
  );
}

// =============================================================================
// SECTION: GITHUB
// =============================================================================

function GitHubSection({ config }: { config: VajraGitHubConfig }) {
  return (
    <ChartCard title="GitHub" subtitle="Repository integration and PR lifecycle">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Repository">
            <p className="text-[13px] font-mono text-[var(--d-text-primary)]">{config.repository}</p>
          </Field>
          <Field label="API Key">
            <p className="text-[13px] text-[var(--d-text-primary)]">
              {config.apiKeyConfigured ? (
                <span className="inline-flex items-center gap-1 text-[var(--d-success-text)]">
                  <CheckIcon className="w-3.5 h-3.5" /> Configured
                </span>
              ) : (
                <span className="text-[var(--d-error-text)]">Not set</span>
              )}
            </p>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Revision Label">
            <p className="text-[13px] font-mono text-[var(--d-text-primary)]">{config.revisionLabel}</p>
          </Field>
          <Field label="Revision Command">
            <p className="text-[13px] font-mono text-[var(--d-text-primary)]">{config.revisionCommand}</p>
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <Field label="Revision State">
            <p className="text-[13px] font-mono text-[var(--d-text-primary)]">{config.revisionState}</p>
          </Field>
          <Field label="Merged State">
            <p className="text-[13px] font-mono text-[var(--d-text-primary)]">{config.mergedState}</p>
          </Field>
          <Field label="Closed State">
            <p className="text-[13px] font-mono text-[var(--d-text-primary)]">{config.closedState ?? "—"}</p>
          </Field>
        </div>
      </div>
    </ChartCard>
  );
}

// =============================================================================
// SECTION: FAN-OUT
// =============================================================================

function FanOutSection({ fanOut }: { fanOut: Record<string, VajraFanOutDefinition> }) {
  const entries = Object.entries(fanOut);
  if (entries.length === 0) {
    return (
      <ChartCard title="Fan-Out" subtitle="Parallel variant execution">
        <p className="text-[13px] text-[var(--d-text-tertiary)]">
          No fan-out definitions configured.
        </p>
      </ChartCard>
    );
  }

  return (
    <ChartCard title="Fan-Out" subtitle="Parallel variant execution">
      <div className="space-y-4">
        {entries.map(([name, def]) => (
          <div key={name} className="rounded-lg border border-[var(--d-border-subtle)] bg-[var(--d-bg-page)] px-4 py-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[13px] font-semibold text-[var(--d-text-primary)]">{name}</span>
              <span className="text-[11px] font-mono text-[var(--d-text-tertiary)]">
                stage: {def.stage} · max parallel: {def.maxParallel}
              </span>
            </div>
            <div className="space-y-1.5">
              {def.variants.map((variant) => (
                <div
                  key={variant.id}
                  className="flex items-center gap-3 text-[12px] font-mono bg-[var(--d-bg-surface)] px-3 py-1.5 rounded border border-[var(--d-border-subtle)]"
                >
                  <span className="font-semibold text-[var(--d-text-primary)]">{variant.id}</span>
                  {variant.agent && <span className="text-[var(--d-text-tertiary)]">agent: {variant.agent}</span>}
                  {variant.model && <span className="text-[var(--d-text-tertiary)]">model: {variant.model}</span>}
                  {variant.reasoningEffort && <span className="text-[var(--d-text-tertiary)]">effort: {variant.reasoningEffort}</span>}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </ChartCard>
  );
}

// =============================================================================
// SECTION: SLACK
// =============================================================================

function SlackSection({ config }: { config: VajraConfigSnapshot }) {
  const slack = config.slack;
  if (!slack) {
    return (
      <ChartCard title="Slack" subtitle="Notification settings">
        <p className="text-[13px] text-[var(--d-text-tertiary)]">
          Slack integration is not configured.
        </p>
      </ChartCard>
    );
  }

  return (
    <ChartCard title="Slack" subtitle="Notification settings">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Channel ID">
            <p className="text-[13px] font-mono text-[var(--d-text-primary)]">{slack.channelId || "—"}</p>
          </Field>
          <Field label="Bot Token">
            <p className="text-[13px] text-[var(--d-text-primary)]">
              {slack.botTokenConfigured ? (
                <span className="inline-flex items-center gap-1 text-[var(--d-success-text)]">
                  <CheckIcon className="w-3.5 h-3.5" /> Configured
                </span>
              ) : (
                <span className="text-[var(--d-error-text)]">Not set</span>
              )}
            </p>
          </Field>
        </div>

        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <Toggle enabled={slack.notifyOnSuccess} onChange={() => {}} disabled />
            <span className="text-[13px] text-[var(--d-text-primary)]">Notify on success</span>
          </div>
          <div className="flex items-center gap-2">
            <Toggle enabled={slack.notifyOnFailure} onChange={() => {}} disabled />
            <span className="text-[13px] text-[var(--d-text-primary)]">Notify on failure</span>
          </div>
        </div>

        {Object.keys(slack.userMap).length > 0 && (
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--d-text-tertiary)] mb-2">
              User Map (Linear → Slack)
            </p>
            <div className="grid grid-cols-[1fr_auto_1fr] gap-x-3 gap-y-1.5">
              {Object.entries(slack.userMap).map(([linearId, slackId]) => (
                <div key={linearId} className="contents">
                  <span className="text-[11px] font-mono text-[var(--d-text-secondary)] truncate">{linearId}</span>
                  <span className="text-[11px] text-[var(--d-text-tertiary)]">→</span>
                  <span className="text-[11px] font-mono text-[var(--d-text-secondary)] truncate">{slackId}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </ChartCard>
  );
}

// =============================================================================
// PAGE
// =============================================================================

type ConfigTab = "general" | "workflows";

export default function VajraConfigPage() {
  const [tab, setTab] = useState<ConfigTab>("general");

  const configData = useVajra<VajraConfigSnapshot>("config");
  const workflowsData = useVajra<VajraWorkflowsResponse>("config/workflows");

  const config = configData.data;
  const loading = configData.loading;
  const error = configData.error;

  const tabs = [
    { id: "general" as const, label: "General" },
    { id: "workflows" as const, label: "Workflows" },
  ];

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--d-bg-page)]">
        <div className="px-8 pt-7">
          <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--d-text-tertiary)]">
            Vajra
          </p>
          <h1 className="text-[20px] font-semibold text-[var(--d-text-primary)] tracking-tight mt-0.5">
            Config
          </h1>
          <div className="mt-8 space-y-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="bg-white rounded-xl border border-[var(--d-border-subtle)] p-6">
                <div className="h-4 w-32 bg-[var(--d-bg-active)] rounded mb-4" />
                <div className="h-24 bg-[var(--d-bg-page)] rounded-lg" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error || !config) {
    return (
      <div className="min-h-screen bg-[var(--d-bg-page)]">
        <div className="px-8 pt-7">
          <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--d-text-tertiary)]">Vajra</p>
          <h1 className="text-[20px] font-semibold text-[var(--d-text-primary)] tracking-tight mt-0.5">Config</h1>
          <div className="mt-8 px-4 py-6 rounded-lg bg-[var(--d-error-bg)] border border-[var(--d-error)]/20">
            <p className="text-[13px] text-[var(--d-error-text)]">{error ?? "Failed to load config"}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--d-bg-page)]">
      <div className="px-8 pt-7 pb-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--d-text-tertiary)]">
              Vajra
            </p>
            <h1 className="text-[20px] font-semibold text-[var(--d-text-primary)] tracking-tight mt-0.5">
              Config
            </h1>
          </div>
        </div>

        {/* Tabs */}
        <Tabs
          tabs={tabs}
          activeTab={tab}
          onTabChange={setTab}
          variant="underline"
          className="mb-6"
        />

        {/* Tab content */}
        {tab === "general" && (
          <div className="space-y-4">
            <TrackerSection config={config} />
            <ExecutionSection config={config} />
            {config.escalation && <EscalationSection config={config.escalation} />}
            {config.triage && <TriageSection config={config.triage} />}
            {config.github && <GitHubSection config={config.github} />}
            {Object.keys(config.fanOut ?? {}).length > 0 && <FanOutSection fanOut={config.fanOut} />}
            <BackendsSection config={config} />
            <SlackSection config={config} />
          </div>
        )}

        {tab === "workflows" && (
          <WorkflowsSection workflows={workflowsData.data} />
        )}
      </div>
    </div>
  );
}

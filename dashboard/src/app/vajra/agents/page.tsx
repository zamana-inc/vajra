"use client";

/**
 * Vajra Agents — create and edit agent definitions.
 *
 * Left sidebar: agent list with backend/model badges, pipeline references.
 * Right editor: name, backend dropdown, model input, timeout, prompt (MarkdownEditor).
 *
 * Agents are the unit devs think in — "I need a better planner" or
 * "I want to swap the code reviewer to a different model."
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { cn } from "@/lib/design";
import { useVajra } from "@/lib/vajra";
import {
  saveVajraAgent,
  deleteVajraAgent,
  listVajraBackends,
} from "@/lib/vajra/client";
import type {
  VajraAgentDefinition,
  VajraAgentsResponse,
  VajraBackendPreset,
  VajraBackendsResponse,
} from "@/lib/vajra/types";
import { MarkdownEditor } from "@/components/editors/markdown-editor";
import { Button } from "@/components/dashboard/button";
import { ConfirmDialog } from "@/components/dashboard/dialog";
import {
  PlusIcon,
  TrashIcon,
  BotIcon,
  ChevronDownIcon,
} from "@/components/ui/icons";

// =============================================================================
// TYPES
// =============================================================================

interface AgentDraft {
  name: string;
  backend: string;
  model: string;
  reasoningEffort: string;
  prompt: string;
  timeoutMs: number | undefined;
}

type BackendPresetMap = VajraBackendsResponse["presets"];

function backendPresetFor(backend: string, presets: BackendPresetMap): VajraBackendPreset | null {
  return presets[backend] ?? null;
}

function agentToDraft(name: string, agent: VajraAgentDefinition, presets: BackendPresetMap): AgentDraft {
  const preset = backendPresetFor(agent.backend, presets);
  return {
    name,
    backend: agent.backend,
    model: agent.model,
    reasoningEffort: agent.reasoningEffort ?? preset?.defaultReasoningEffort ?? "",
    prompt: agent.prompt,
    timeoutMs: agent.timeoutMs,
  };
}

function emptyDraft(backends: string[], presets: BackendPresetMap): AgentDraft {
  const backend = backends[0] ?? "claude";
  const preset = backendPresetFor(backend, presets);
  return {
    name: "",
    backend,
    model: preset?.defaultModel ?? "",
    reasoningEffort: preset?.defaultReasoningEffort ?? "",
    prompt: "",
    timeoutMs: undefined,
  };
}

function withBackendDefaults(
  draft: AgentDraft,
  backend: string,
  presets: BackendPresetMap,
): AgentDraft {
  const preset = backendPresetFor(backend, presets);
  return {
    ...draft,
    backend,
    model: preset?.defaultModel ?? "",
    reasoningEffort: preset?.defaultReasoningEffort ?? "",
  };
}

function optionsWithCurrent(
  options: Array<{ value: string; label: string }>,
  currentValue: string,
): Array<{ value: string; label: string }> {
  if (!currentValue || options.some((option) => option.value === currentValue)) {
    return options;
  }

  return [
    { value: currentValue, label: `${currentValue} (custom)` },
    ...options,
  ];
}

// =============================================================================
// AGENT SIDEBAR CARD
// =============================================================================

function AgentCard({
  name,
  agent,
  references,
  selected,
  onClick,
}: {
  name: string;
  agent: VajraAgentDefinition;
  references: string[];
  selected: boolean;
  onClick: () => void;
}) {
  const promptPreview = agent.prompt.split("\n").find((l) => l.trim())?.trim() ?? "";

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
        <span className="text-[13px] font-semibold text-[var(--d-text-primary)]">{name}</span>
      </div>
      <div className="flex items-center gap-2 mt-1">
        <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-[var(--d-bg-page)] text-[var(--d-text-secondary)] border border-[var(--d-border-subtle)]">
          {agent.backend}
        </span>
        <span className="text-[11px] font-mono text-[var(--d-text-tertiary)]">
          {agent.model}
        </span>
        {agent.reasoningEffort && (
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-[var(--d-bg-page)] text-[var(--d-text-tertiary)] border border-[var(--d-border-subtle)]">
            {agent.reasoningEffort}
          </span>
        )}
      </div>
      {promptPreview && (
        <p className="text-[11px] text-[var(--d-text-tertiary)] mt-1.5 truncate leading-relaxed">
          {promptPreview}
        </p>
      )}
      {references.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {references.map((ref) => (
            <span
              key={ref}
              className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-[var(--d-info-bg)] text-[var(--d-info-text)]"
            >
              {ref}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}

// =============================================================================
// DROPDOWN
// =============================================================================

function Select({
  value,
  options,
  onChange,
  placeholder,
  disabled,
}: {
  value: string;
  options: { value: string; label: string; subtitle?: string }[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={cn(
          "w-full appearance-none rounded-lg border border-[var(--d-border)] bg-[var(--d-bg-surface)] px-3 py-2 pr-8",
          "text-[13px] text-[var(--d-text-primary)]",
          "focus:outline-none focus:ring-2 focus:ring-[var(--d-border-focus)]",
          "disabled:opacity-50 disabled:cursor-not-allowed",
        )}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}{opt.subtitle ? ` — ${opt.subtitle}` : ""}
          </option>
        ))}
      </select>
      <ChevronDownIcon className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--d-text-tertiary)] pointer-events-none" />
    </div>
  );
}

// =============================================================================
// FIELD
// =============================================================================

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-[12px] font-medium text-[var(--d-text-secondary)] mb-1.5">
        {label}
      </label>
      {children}
      {hint && (
        <p className="text-[11px] text-[var(--d-text-tertiary)] mt-1">{hint}</p>
      )}
    </div>
  );
}

// =============================================================================
// EDITOR
// =============================================================================

function AgentEditor({
  draft,
  backends,
  backendPresets,
  isNew,
  saving,
  deleting,
  error,
  hasChanges,
  onChange,
  onSave,
  onDelete,
  onReset,
}: {
  draft: AgentDraft;
  backends: string[];
  backendPresets: BackendPresetMap;
  isNew: boolean;
  saving: boolean;
  deleting: boolean;
  error: string | null;
  hasChanges: boolean;
  onChange: (update: Partial<AgentDraft>) => void;
  onSave: () => void;
  onDelete: () => void;
  onReset: () => void;
}) {
  const backendPreset = backendPresetFor(draft.backend, backendPresets);
  const modelOptions = backendPreset
    ? optionsWithCurrent(backendPreset.models, draft.model)
    : [];
  const reasoningEffortOptions = backendPreset
    ? optionsWithCurrent(
        backendPreset.reasoningEfforts.map((effort) => ({ value: effort, label: effort })),
        draft.reasoningEffort,
      )
    : [];

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-6 pt-6 pb-4">
        {/* Header bar */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-[17px] font-semibold text-[var(--d-text-primary)]">
              {isNew ? "New Agent" : draft.name}
            </h2>
            <p className="text-[12px] text-[var(--d-text-tertiary)] mt-0.5">
              {isNew ? "Define a new agent for your workflows" : "Edit agent configuration"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {hasChanges && (
              <Button variant="ghost" size="sm" onClick={onReset} disabled={saving}>
                Discard
              </Button>
            )}
            {!isNew && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onDelete}
                disabled={saving || deleting}
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
              disabled={!hasChanges && !isNew}
            >
              {isNew ? "Create" : "Save"}
            </Button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-[var(--d-error-bg)] border border-[var(--d-error)]/20">
            <p className="text-[13px] text-[var(--d-error-text)]">{error}</p>
          </div>
        )}

        {/* Fields */}
        <div className="space-y-5">
          {/* Name — only editable for new agents */}
          <Field label="Name" hint="Lowercase, used as identifier in workflow DOT files">
            <input
              type="text"
              value={draft.name}
              onChange={(e) => onChange({ name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })}
              disabled={!isNew}
              placeholder="planner"
              className={cn(
                "w-full rounded-lg border border-[var(--d-border)] bg-[var(--d-bg-surface)] px-3 py-2",
                "text-[13px] font-mono text-[var(--d-text-primary)]",
                "focus:outline-none focus:ring-2 focus:ring-[var(--d-border-focus)]",
                "disabled:opacity-60 disabled:bg-[var(--d-bg-subtle)]",
              )}
            />
          </Field>

          {/* Backend + Model side by side */}
          <div className="grid gap-4 md:grid-cols-3">
            <Field
              label="Backend"
              hint={backendPreset
                ? `Recommended defaults: ${backendPreset.defaultModel} · ${backendPreset.defaultReasoningEffort}`
                : "CLI command template to invoke"}
            >
              <Select
                value={draft.backend}
                options={backends.map((b) => ({ value: b, label: b }))}
                onChange={(v) => onChange({ backend: v })}
              />
            </Field>
            <Field label="Model" hint="Passed to the backend as {{ model }}">
              {backendPreset ? (
                <Select
                  value={draft.model}
                  options={modelOptions}
                  onChange={(v) => onChange({ model: v })}
                />
              ) : (
                <input
                  type="text"
                  value={draft.model}
                  onChange={(e) => onChange({ model: e.target.value })}
                  placeholder="gpt-5.4"
                  className={cn(
                    "w-full rounded-lg border border-[var(--d-border)] bg-[var(--d-bg-surface)] px-3 py-2",
                    "text-[13px] font-mono text-[var(--d-text-primary)]",
                    "focus:outline-none focus:ring-2 focus:ring-[var(--d-border-focus)]",
                  )}
                />
              )}
            </Field>
            <Field
              label="Thinking Effort"
              hint={backendPreset
                ? "Passed to the backend as {{ reasoning_effort }}"
                : "Optional. Used only if the backend command template references {{ reasoning_effort }}"}
            >
              {backendPreset ? (
                <Select
                  value={draft.reasoningEffort}
                  options={reasoningEffortOptions}
                  onChange={(v) => onChange({ reasoningEffort: v })}
                />
              ) : (
                <input
                  type="text"
                  value={draft.reasoningEffort}
                  onChange={(e) => onChange({ reasoningEffort: e.target.value })}
                  placeholder="xhigh"
                  className={cn(
                    "w-full rounded-lg border border-[var(--d-border)] bg-[var(--d-bg-surface)] px-3 py-2",
                    "text-[13px] font-mono text-[var(--d-text-primary)]",
                    "focus:outline-none focus:ring-2 focus:ring-[var(--d-border-focus)]",
                  )}
                />
              )}
            </Field>
          </div>

          {/* Timeout */}
          <Field label="Timeout (ms)" hint="Optional. Max execution time per stage invocation.">
            <input
              type="number"
              value={draft.timeoutMs ?? ""}
              onChange={(e) => onChange({ timeoutMs: e.target.value ? Number(e.target.value) : undefined })}
              placeholder="600000"
              className={cn(
                "w-48 rounded-lg border border-[var(--d-border)] bg-[var(--d-bg-surface)] px-3 py-2",
                "text-[13px] font-mono text-[var(--d-text-primary)]",
                "focus:outline-none focus:ring-2 focus:ring-[var(--d-border-focus)]",
              )}
            />
          </Field>

          {/* Prompt — the main event */}
          <Field label="Prompt" hint="Markdown prompt template. Reference skills by name, e.g. 'Use the vajra-plan skill.'">
            <div className="border border-[var(--d-border)] rounded-lg overflow-hidden bg-[var(--d-bg-surface)]">
              <MarkdownEditor
                value={draft.prompt}
                onChange={(v) => onChange({ prompt: v })}
              />
            </div>
          </Field>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// PAGE
// =============================================================================

export default function VajraAgentsPage() {
  const searchParams = useSearchParams();
  const agentsData = useVajra<VajraAgentsResponse>("config/agents");
  const backendsData = useVajra<VajraBackendsResponse>("config/backends");

  const [selectedName, setSelectedName] = useState<string | null>(
    searchParams.get("agent"),
  );
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [originalJson, setOriginalJson] = useState<string>("");
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const agents = agentsData.data?.agents ?? {};
  const references = agentsData.data?.references ?? {};
  const backendPresets = backendsData.data?.presets ?? {};
  const backendNames = useMemo(
    () => Object.keys(backendsData.data?.backends ?? {}),
    [backendsData.data],
  );
  const agentNames = useMemo(
    () => Object.keys(agents).sort(),
    [agents],
  );

  // Auto-select first agent
  useEffect(() => {
    if (!selectedName && agentNames.length > 0 && !isNew) {
      setSelectedName(agentNames[0]);
    }
  }, [agentNames, selectedName, isNew]);

  // Sync draft when selection changes
  useEffect(() => {
    if (selectedName && agents[selectedName]) {
      const d = agentToDraft(selectedName, agents[selectedName], backendPresets);
      setDraft(d);
      setOriginalJson(JSON.stringify(d));
      setIsNew(false);
      setError(null);
    }
  }, [selectedName, agents, backendPresets]);

  useEffect(() => {
    if (!isNew || !draft) {
      return;
    }

    const preset = backendPresetFor(draft.backend, backendPresets);
    if (!preset || draft.model || draft.reasoningEffort) {
      return;
    }

    setDraft({
      ...draft,
      model: preset.defaultModel,
      reasoningEffort: preset.defaultReasoningEffort,
    });
  }, [isNew, draft, backendPresets]);

  const hasChanges = draft ? JSON.stringify(draft) !== originalJson : false;

  const handleSelect = (name: string) => {
    setSelectedName(name);
    setIsNew(false);
    window.history.replaceState(null, "", `/vajra/agents?agent=${name}`);
  };

  const handleNew = () => {
    const d = emptyDraft(backendNames, backendPresets);
    setDraft(d);
    setOriginalJson(JSON.stringify(d));
    setSelectedName(null);
    setIsNew(true);
    setError(null);
  };

  const handleChange = (update: Partial<AgentDraft>) => {
    if (!draft) return;
    if (update.backend && update.backend !== draft.backend) {
      setDraft({
        ...withBackendDefaults(draft, update.backend, backendPresets),
        ...update,
      });
      return;
    }
    setDraft({ ...draft, ...update });
  };

  const handleSave = async () => {
    if (!draft || !draft.name.trim()) {
      setError("Agent name is required.");
      return;
    }
    if (!draft.backend) {
      setError("Backend is required.");
      return;
    }
    const backendPreset = backendPresetFor(draft.backend, backendPresets);
    const model = draft.model.trim() || backendPreset?.defaultModel || "";
    const reasoningEffort = draft.reasoningEffort.trim() || backendPreset?.defaultReasoningEffort || "";

    if (!model) {
      setError("Model is required.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await saveVajraAgent(draft.name, {
        backend: draft.backend,
        model,
        reasoningEffort: reasoningEffort || undefined,
        prompt: draft.prompt,
        timeoutMs: draft.timeoutMs,
      });
      agentsData.refetch();
      setSelectedName(draft.name);
      setIsNew(false);
      window.history.replaceState(null, "", `/vajra/agents?agent=${draft.name}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save agent.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedName) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteVajraAgent(selectedName);
      agentsData.refetch();
      setSelectedName(null);
      setDraft(null);
      setShowDelete(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete agent.");
      setShowDelete(false);
    } finally {
      setDeleting(false);
    }
  };

  const handleReset = () => {
    if (selectedName && agents[selectedName]) {
      const d = agentToDraft(selectedName, agents[selectedName], backendPresets);
      setDraft(d);
    } else if (isNew) {
      setDraft(emptyDraft(backendNames, backendPresets));
    }
  };

  return (
    <div className="h-screen overflow-hidden bg-[var(--d-bg-page)]">
      <div className="h-full flex">
        {/* Left sidebar */}
        <div className="w-[280px] flex-shrink-0 border-r border-[var(--d-border)] bg-[var(--d-bg-surface)] flex flex-col">
          {/* Sidebar header */}
          <div className="px-4 pt-5 pb-3 border-b border-[var(--d-border-subtle)]">
            <div className="flex items-center justify-between mb-1">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--d-text-tertiary)]">
                  Vajra
                </p>
                <h1 className="text-[17px] font-semibold text-[var(--d-text-primary)] tracking-tight">
                  Agents
                </h1>
              </div>
              <Button variant="primary" size="sm" icon={<PlusIcon />} onClick={handleNew}>
                New
              </Button>
            </div>
          </div>

          {/* Agent list */}
          <div className="flex-1 overflow-y-auto">
            {agentsData.loading ? (
              <div className="px-4 py-6">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="py-3 border-b border-[var(--d-border-subtle)]">
                    <div className="h-3.5 w-24 bg-[var(--d-bg-active)] rounded mb-2" />
                    <div className="h-3 w-36 bg-[var(--d-bg-active)] rounded" />
                  </div>
                ))}
              </div>
            ) : agentNames.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <BotIcon className="w-8 h-8 mx-auto text-[var(--d-text-disabled)] mb-3" />
                <p className="text-[13px] text-[var(--d-text-tertiary)]">No agents defined</p>
                <p className="text-[11px] text-[var(--d-text-disabled)] mt-1">
                  Create one to get started
                </p>
              </div>
            ) : (
              agentNames.map((name) => (
                <AgentCard
                  key={name}
                  name={name}
                  agent={agents[name]}
                  references={references[name] ?? []}
                  selected={name === selectedName && !isNew}
                  onClick={() => handleSelect(name)}
                />
              ))
            )}
          </div>
        </div>

        {/* Right editor */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {draft ? (
            <AgentEditor
            draft={draft}
            backends={backendNames}
            backendPresets={backendPresets}
            isNew={isNew}
            saving={saving}
            deleting={deleting}
              error={error}
              hasChanges={hasChanges}
              onChange={handleChange}
              onSave={handleSave}
              onDelete={() => setShowDelete(true)}
              onReset={handleReset}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <BotIcon className="w-12 h-12 mx-auto text-[var(--d-text-disabled)] mb-4" />
                <p className="text-[15px] font-medium text-[var(--d-text-secondary)]">
                  Select an agent
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
        description="This will remove the agent definition from WORKFLOW.md. Fails if any workflow references it."
        confirmLabel="Delete"
        onConfirm={handleDelete}
        destructive
        loading={deleting}
      />
    </div>
  );
}

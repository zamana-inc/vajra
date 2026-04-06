export interface AgentBackendPresetOption {
  value: string;
  label: string;
}

export interface AgentBackendPreset {
  models: AgentBackendPresetOption[];
  defaultModel: string;
  reasoningEfforts: string[];
  defaultReasoningEffort: string;
}

const KNOWN_AGENT_BACKEND_PRESETS: Record<string, AgentBackendPreset> = {
  claude: {
    models: [
      { value: "claude-opus-4-6", label: "claude-opus-4-6 (opus)" },
      { value: "claude-sonnet-4-6", label: "claude-sonnet-4-6 (sonnet)" },
      { value: "claude-haiku-4-5-20251001", label: "claude-haiku-4-5-20251001 (haiku)" },
    ],
    defaultModel: "claude-opus-4-6",
    reasoningEfforts: ["low", "medium", "high", "max"],
    defaultReasoningEffort: "high",
  },
  codex: {
    models: [
      { value: "gpt-5.4", label: "gpt-5.4" },
    ],
    defaultModel: "gpt-5.4",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "xhigh",
  },
};

export function getAgentBackendPreset(backendName: string): AgentBackendPreset | null {
  return KNOWN_AGENT_BACKEND_PRESETS[backendName.trim().toLowerCase()] ?? null;
}

export function resolveAgentExecutionConfig(opts: {
  backendName: string;
  model?: string | null;
  reasoningEffort?: string | null;
  modelFieldName?: string;
  reasoningEffortFieldName?: string;
}): {
  model: string;
  reasoningEffort?: string;
} {
  const preset = getAgentBackendPreset(opts.backendName);
  const model = String(opts.model ?? "").trim() || preset?.defaultModel || "";
  if (!model) {
    throw new Error(`${opts.modelFieldName ?? "model"} is required`);
  }

  const reasoningEffortInput = String(opts.reasoningEffort ?? "").trim().toLowerCase();
  if (!reasoningEffortInput) {
    return preset
      ? { model, reasoningEffort: preset.defaultReasoningEffort }
      : { model };
  }

  if (preset && !preset.reasoningEfforts.includes(reasoningEffortInput)) {
    throw new Error(
      `${opts.reasoningEffortFieldName ?? "reasoning_effort"} must be one of ${preset.reasoningEfforts.join(", ")}`,
    );
  }

  return {
    model,
    reasoningEffort: reasoningEffortInput,
  };
}

export function listAgentBackendPresets(backendNames: Iterable<string>): Record<string, AgentBackendPreset> {
  const presets: Record<string, AgentBackendPreset> = {};
  for (const backendName of backendNames) {
    const preset = getAgentBackendPreset(backendName);
    if (preset) {
      presets[backendName] = preset;
    }
  }
  return presets;
}

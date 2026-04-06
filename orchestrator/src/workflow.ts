import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";

import { resolveAgentExecutionConfig } from "./agent-presets";
import { backendSupportsNativeSessions } from "./backends";
import { parseDotGraph } from "./dot-parser";
import { buildTraversalGraph } from "./pipeline-graph";
import { stageExecutionType } from "./stage-executor";
import {
  AgentDefinition,
  EscalationConfig,
  FanOutDefinition,
  GitHubConfig,
  GraphNode,
  SlackConfig,
  TriageConfig,
  WorkflowConfig,
  WorkflowDocument,
  WorkflowDefinition,
  WorkflowEntry,
  WorkflowRoutingConfig,
} from "./types";
import { normalizeRequiredLowercase } from "./string-utils";

const DEFAULT_WORKFLOW_SUCCESS_STATE = "Done";

const DEFAULT_CONFIG = {
  tracker: {
    kind: "linear" as const,
    endpoint: "https://api.linear.app/graphql",
    activeStates: ["Todo", "In Progress"],
    terminalStates: ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"],
  },
  polling: {
    intervalMs: 30_000,
  },
  workspace: {
    root: "/tmp/vajra-workspaces",
  },
  artifacts: {
    root: "~/vajra-artifacts/issues",
    workspaceDir: ".vajra",
  },
  hooks: {
    timeoutMs: 60_000,
  },
  execution: {
    maxConcurrentAgents: 10,
    maxRetryAttempts: 3,
    maxRetryBackoffMs: 300_000,
    maxConcurrentAgentsByState: {} as Record<string, number>,
    maxAgentInvocationsPerRun: 20,
  },
  triage: {
    timeoutMs: 60_000,
  },
};

function parseWorkflowDocument(content: string): Record<string, unknown> {
  if (!content.startsWith("---")) {
    throw new Error("WORKFLOW.md must contain YAML front matter");
  }

  const lines = content.split(/\r?\n/);
  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closingIndex === -1) {
    throw new Error("workflow front matter is not closed");
  }

  const yamlText = lines.slice(1, closingIndex).join("\n");
  const body = lines.slice(closingIndex + 1).join("\n").trim();
  if (body) {
    throw new Error("WORKFLOW.md no longer supports a markdown prompt body; move prompts into agents.*.prompt");
  }

  const parsed = yaml.load(yamlText);
  if (parsed === undefined) {
    return {};
  }

  if (typeof parsed !== "object" || Array.isArray(parsed) || parsed === null) {
    throw new Error("workflow front matter must decode to a map");
  }

  return parsed as Record<string, unknown>;
}

function envExpand(value: string): string {
  return value.replace(/\$([A-Z0-9_]+)/g, (_match, name) => process.env[name] ?? "");
}

function maybeResolveSecret(value: string, resolveSecrets: boolean): string {
  return resolveSecrets && value.startsWith("$") ? envExpand(value) : value;
}

function expandPath(value: string, baseDir?: string): string {
  let expanded = envExpand(value);

  if (expanded.startsWith("~")) {
    expanded = path.join(os.homedir(), expanded.slice(1));
  }

  if (path.isAbsolute(expanded)) {
    return path.normalize(expanded);
  }

  if (baseDir) {
    return path.resolve(baseDir, expanded);
  }

  return path.resolve(expanded);
}

function toPortablePath(value: string): string {
  return value.split(path.sep).join("/");
}

export function workflowRelativePath(workflowPath: string, filePath: string): string {
  const relative = path.relative(path.dirname(workflowPath), filePath);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    const portable = toPortablePath(relative);
    return portable.startsWith(".") ? portable : `./${portable}`;
  }

  return filePath;
}

function parseRequiredString(value: unknown, fieldName: string): string {
  const parsed = String(value ?? "").trim();
  if (!parsed) {
    throw new Error(`${fieldName} is required`);
  }
  return parsed;
}

function parseStringList(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }

  return [...fallback];
}

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseTriageConfig(rawValue: unknown, backendNames: Set<string>): TriageConfig | null {
  if (rawValue === undefined || rawValue === null) {
    return null;
  }

  if (typeof rawValue !== "object" || Array.isArray(rawValue)) {
    throw new Error("triage must be a map");
  }

  const triage = rawValue as Record<string, unknown>;
  if (triage.enabled === false) {
    return null;
  }

  const backend = normalizeRequiredLowercase(
    parseRequiredString(triage.backend, "triage.backend"),
    "triage.backend",
  );
  if (!backendNames.has(backend)) {
    throw new Error(`triage.backend references unknown backend ${backend}`);
  }

  const model = parseRequiredString(triage.model, "triage.model");
  const reasoningEffort = typeof triage.reasoning_effort === "string"
    ? triage.reasoning_effort.trim()
    : "";

  return {
    enabled: triage.enabled !== false,
    backend,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    timeoutMs: parsePositiveInt(triage.timeout_ms, DEFAULT_CONFIG.triage.timeoutMs),
  };
}

function parseEscalationConfig(rawValue: unknown): EscalationConfig | null {
  if (rawValue === undefined || rawValue === null) {
    return null;
  }

  if (typeof rawValue !== "object" || Array.isArray(rawValue)) {
    throw new Error("escalation must be a map");
  }

  const escalation = rawValue as Record<string, unknown>;
  return {
    linearState: parseRequiredString(escalation.linear_state, "escalation.linear_state"),
    comment: escalation.comment !== false,
    slackNotify: escalation.slack_notify !== false,
  };
}

function parseFanOutConfig(rawValue: unknown, backendNames: Set<string>, agents: Record<string, AgentDefinition>): Record<string, FanOutDefinition> {
  if (rawValue === undefined || rawValue === null) {
    return {};
  }

  if (typeof rawValue !== "object" || Array.isArray(rawValue)) {
    throw new Error("fan_out must be a map");
  }

  const definitions: Record<string, FanOutDefinition> = {};
  for (const [rawCollectionId, value] of Object.entries(rawValue as Record<string, unknown>)) {
    const collectionId = rawCollectionId.trim();
    if (!collectionId) {
      continue;
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`fan_out.${collectionId} must be a map`);
    }

    const definition = value as Record<string, unknown>;
    const variants = Array.isArray(definition.variants) ? definition.variants : [];
    if (variants.length === 0) {
      throw new Error(`fan_out.${collectionId}.variants must contain at least one variant`);
    }

    definitions[collectionId] = {
      stage: parseRequiredString(definition.stage, `fan_out.${collectionId}.stage`),
      maxParallel: parsePositiveInt(definition.max_parallel, variants.length),
      completionPolicy: "wait_all",
      variants: variants.map((entry, index) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw new Error(`fan_out.${collectionId}.variants[${index}] must be a map`);
        }

        const variant = entry as Record<string, unknown>;
        const agent = typeof variant.agent === "string"
          ? normalizeRequiredLowercase(variant.agent, `fan_out.${collectionId}.variants[${index}].agent`)
          : undefined;
        if (agent && !agents[agent]) {
          throw new Error(`fan_out.${collectionId}.variants[${index}].agent references unknown agent ${agent}`);
        }

        const model = typeof variant.model === "string" ? variant.model.trim() : "";
        const reasoningEffort = typeof variant.reasoning_effort === "string" ? variant.reasoning_effort.trim() : "";
        const backend = agent ? agents[agent]?.backend : undefined;
        if (backend && !backendNames.has(backend)) {
          throw new Error(`fan_out.${collectionId}.variants[${index}].agent backend ${backend} is not configured`);
        }

        return {
          id: parseRequiredString(variant.id, `fan_out.${collectionId}.variants[${index}].id`),
          ...(agent ? { agent } : {}),
          ...(model ? { model } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
          ...(typeof variant.instructions === "string" && variant.instructions.trim()
            ? { instructions: variant.instructions.trim() }
            : {}),
        };
      }),
    };
  }

  return definitions;
}

function normalizeStateMap(rawValue: unknown): Record<string, number> {
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    return {};
  }

  const output: Record<string, number> = {};
  for (const [key, value] of Object.entries(rawValue)) {
    const parsed = parsePositiveInt(value, -1);
    if (parsed > 0) {
      output[key.trim().toLowerCase()] = parsed;
    }
  }
  return output;
}

async function validateWorkflowDotFile(filePath: string, fieldName: string): Promise<void> {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      throw new Error(`${fieldName} must point to a file`);
    }
  } catch (error) {
    if (error instanceof Error && error.message === `${fieldName} must point to a file`) {
      throw error;
    }

    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`${fieldName} does not exist: ${filePath}`);
    }
    throw error;
  }
}

export function validateWorkflowGraph(opts: {
  workflowName: string;
  dotFile: string;
  graphNodes: Iterable<GraphNode>;
  agents: Record<string, AgentDefinition>;
}): void {
  const errors: string[] = [];

  for (const node of opts.graphNodes) {
    if (node.type === "start" || node.type === "exit") {
      continue;
    }

    if (node.attrs.prompt) {
      errors.push(
        `workflows.${opts.workflowName}.dot_file stage ${node.id} uses removed prompt attribute; move it to agents.${normalizeRequiredLowercase(node.attrs.agent ?? node.id, `stage ${node.id}.agent`)}.prompt`,
      );
    }

    if (node.attrs.model) {
      errors.push(
        `workflows.${opts.workflowName}.dot_file stage ${node.id} uses removed model attribute; move it to its agent definition`,
      );
    }

    if (node.type === "fan_out" || node.type === "fan_in") {
      if (!String(node.attrs.collection ?? "").trim()) {
        errors.push(`workflows.${opts.workflowName}.dot_file ${node.type} stage ${node.id} must define collection`);
      }
      continue;
    }

    if (stageExecutionType(node) === "tool") {
      if (node.attrs.agent) {
        errors.push(`workflows.${opts.workflowName}.dot_file tool stage ${node.id} must not define an agent`);
      }
      continue;
    }

    const agentName = normalizeRequiredLowercase(parseRequiredString(node.attrs.agent, `stage ${node.id}.agent`), `stage ${node.id}.agent`);
    const agent = opts.agents[agentName];
    if (!agent) {
      errors.push(`workflows.${opts.workflowName}.dot_file stage ${node.id} references unknown agent ${agentName}`);
      continue;
    }

    if (String(node.attrs.thread ?? "").trim() && !backendSupportsNativeSessions(agent.backend)) {
      errors.push(`workflows.${opts.workflowName}.dot_file stage ${node.id} uses thread but agent backend ${agent.backend} does not support native sessions`);
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
}

function workflowDocumentRecord(document: WorkflowDocument): Record<string, unknown> {
  return {
    tracker: {
      kind: document.tracker.kind,
      endpoint: document.tracker.endpoint,
      api_key: document.tracker.apiKey,
      assignee_id: document.tracker.assigneeId,
      active_states: [...document.tracker.activeStates],
      terminal_states: [...document.tracker.terminalStates],
    },
    polling: {
      interval_ms: document.polling.intervalMs,
    },
    workspace: {
      root: document.workspace.root,
    },
    artifacts: {
      root: document.artifacts.root,
      workspace_dir: document.artifacts.workspaceDir,
    },
    hooks: {
      after_create: document.hooks.afterCreate,
      before_run: document.hooks.beforeRun,
      after_run: document.hooks.afterRun,
      before_remove: document.hooks.beforeRemove,
      timeout_ms: document.hooks.timeoutMs,
    },
    execution: {
      max_concurrent_agents: document.execution.maxConcurrentAgents,
      max_retry_attempts: document.execution.maxRetryAttempts,
      max_retry_backoff_ms: document.execution.maxRetryBackoffMs,
      max_concurrent_agents_by_state: { ...document.execution.maxConcurrentAgentsByState },
      max_agent_invocations_per_run: document.execution.maxAgentInvocationsPerRun,
    },
    ...(document.escalation ? {
      escalation: {
        linear_state: document.escalation.linearState,
        comment: document.escalation.comment,
        slack_notify: document.escalation.slackNotify,
      },
    } : {}),
    ...(Object.keys(document.fanOut).length > 0 ? {
      fan_out: Object.fromEntries(
        Object.entries(document.fanOut).map(([collectionId, definition]) => [
          collectionId,
          {
            stage: definition.stage,
            max_parallel: definition.maxParallel,
            completion_policy: definition.completionPolicy,
            variants: definition.variants.map((variant) => ({
              id: variant.id,
              ...(variant.agent ? { agent: variant.agent } : {}),
              ...(variant.model ? { model: variant.model } : {}),
              ...(variant.reasoningEffort ? { reasoning_effort: variant.reasoningEffort } : {}),
              ...(variant.instructions ? { instructions: variant.instructions } : {}),
            })),
          },
        ]),
      ),
    } : {}),
    ...(document.triage ? {
      triage: {
        enabled: document.triage.enabled,
        backend: document.triage.backend,
        model: document.triage.model,
        reasoning_effort: document.triage.reasoningEffort,
        timeout_ms: document.triage.timeoutMs,
      },
    } : {}),
    workflows: Object.fromEntries(
      Object.entries(document.workflows).map(([name, entry]) => [
        name,
        {
          dot_file: entry.dotFile,
          success_state: entry.successState ?? DEFAULT_WORKFLOW_SUCCESS_STATE,
          inspect_pr: entry.inspectPr !== false,
        },
      ]),
    ),
    workflow_routing: {
      default_workflow: document.workflowRouting.defaultWorkflow,
      by_label: { ...document.workflowRouting.byLabel },
    },
    backends: Object.fromEntries(
      Object.entries(document.backends).map(([name, entry]) => [
        name,
        { command: entry.command },
      ]),
    ),
    agents: Object.fromEntries(
      Object.entries(document.agents).map(([name, entry]) => [
        name,
        {
          backend: entry.backend,
          model: entry.model,
          prompt: entry.prompt,
          reasoning_effort: entry.reasoningEffort,
          timeout_ms: entry.timeoutMs,
        },
      ]),
    ),
    ...(document.github ? {
      github: {
        repository: document.github.repository,
        api_key: document.github.apiKey,
        webhook_secret: document.github.webhookSecret,
        revision_label: document.github.revisionLabel,
        revision_command: document.github.revisionCommand,
        revision_state: document.github.revisionState,
        merged_state: document.github.mergedState,
        closed_state: document.github.closedState ?? undefined,
      },
    } : {}),
    ...(document.slack ? {
      slack: {
        bot_token: document.slack.botToken,
        channel_id: document.slack.channelId,
        user_map: { ...document.slack.userMap },
        notify_on_success: document.slack.notifyOnSuccess,
        notify_on_failure: document.slack.notifyOnFailure,
      },
    } : {}),
  };
}

export function serializeWorkflowDocument(document: WorkflowDocument): string {
  const yamlText = yaml.dump(workflowDocumentRecord(document), {
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
  }).trimEnd();
  return `---\n${yamlText}\n---\n`;
}

async function parseWorkflowEntry(name: string, rawValue: unknown, baseDir: string): Promise<WorkflowEntry> {
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    throw new Error(`workflows.${name} must be a map`);
  }

  const entry = rawValue as Record<string, unknown>;
  const parsedSuccessState = String(entry.success_state ?? "").trim();
  const dotFile = parseRequiredString(entry.dot_file, `workflows.${name}.dot_file`);
  await validateWorkflowDotFile(expandPath(dotFile, baseDir), `workflows.${name}.dot_file`);

  return {
    dotFile,
    successState: parsedSuccessState || DEFAULT_WORKFLOW_SUCCESS_STATE,
    inspectPr: entry.inspect_pr !== false,
  };
}

async function parseWorkflowDefinitions(
  rawConfig: Record<string, unknown>,
  workflowPath: string,
): Promise<Record<string, WorkflowEntry>> {
  const baseDir = path.dirname(workflowPath);
  const rawWorkflows = rawConfig.workflows;

  if (!rawWorkflows || typeof rawWorkflows !== "object" || Array.isArray(rawWorkflows)) {
    throw new Error("workflows is required");
  }

  const workflows = Object.fromEntries(await Promise.all(
    Object.entries(rawWorkflows as Record<string, unknown>).map(async ([name, value]) => {
      const normalizedName = normalizeRequiredLowercase(name, "workflow name");
      return [normalizedName, await parseWorkflowEntry(normalizedName, value, baseDir)] as const;
    }),
  ));

  return workflows;
}

function parseWorkflowRouting(
  rawConfig: Record<string, unknown>,
  workflows: Record<string, WorkflowEntry>,
): WorkflowRoutingConfig {
  const rawRouting = rawConfig.workflow_routing;
  if (!rawRouting || typeof rawRouting !== "object" || Array.isArray(rawRouting)) {
    throw new Error("workflow_routing is required");
  }

  const routing = rawRouting as Record<string, unknown>;
  const defaultWorkflow = normalizeRequiredLowercase(
    parseRequiredString(routing.default_workflow, "workflow_routing.default_workflow"),
    "workflow_routing.default_workflow",
  );
  if (!workflows[defaultWorkflow]) {
    throw new Error(`workflow_routing.default_workflow references unknown workflow ${defaultWorkflow}`);
  }

  const rawByLabel = routing.by_label;
  const byLabel: Record<string, string> = Object.fromEntries(
    Object.entries((rawByLabel && typeof rawByLabel === "object" && !Array.isArray(rawByLabel))
      ? rawByLabel as Record<string, unknown>
      : {})
      .map(([label, workflowName]) => [
        normalizeRequiredLowercase(label, "workflow_routing.by_label label"),
        normalizeRequiredLowercase(String(workflowName ?? ""), `workflow_routing.by_label.${label}`),
      ])
      .filter(([label, workflowName]) => Boolean(label) && Boolean(workflowName)),
  );

  for (const [label, workflowName] of Object.entries(byLabel)) {
    if (!workflows[workflowName]) {
      throw new Error(`workflow_routing.by_label.${label} references unknown workflow ${workflowName}`);
    }
  }

  return {
    defaultWorkflow,
    byLabel,
  };
}

function parseBackendsConfig(rawValue: unknown): Record<string, { command: string }> {
  if (rawValue === undefined) {
    return {};
  }

  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    throw new Error("backends must be a map");
  }

  const parsedBackends: Record<string, { command: string }> = {};
  for (const [name, value] of Object.entries(rawValue as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`backends.${name} must be a map`);
    }

    const normalizedName = normalizeRequiredLowercase(name, "backend name");
    const command = parseRequiredString((value as Record<string, unknown>).command, `backends.${normalizedName}.command`);
    parsedBackends[normalizedName] = { command };
  }

  return parsedBackends;
}

function parseAgentsConfig(rawValue: unknown, backendNames: Set<string>): Record<string, AgentDefinition> {
  if (rawValue === undefined) {
    return {};
  }

  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    throw new Error("agents must be a map");
  }

  const parsedAgents: Record<string, AgentDefinition> = {};
  for (const [name, value] of Object.entries(rawValue as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`agents.${name} must be a map`);
    }

    const entry = value as Record<string, unknown>;
    const normalizedName = normalizeRequiredLowercase(name, "agent name");
    const backend = normalizeRequiredLowercase(parseRequiredString(entry.backend, `agents.${normalizedName}.backend`), `agents.${normalizedName}.backend`);
    if (!backendNames.has(backend)) {
      throw new Error(`agents.${normalizedName}.backend references unknown backend ${backend}`);
    }

    const prompt = parseRequiredString(entry.prompt, `agents.${normalizedName}.prompt`);
    const parsedTimeoutMs = parsePositiveInt(entry.timeout_ms, -1);
    const resolvedExecution = resolveAgentExecutionConfig({
      backendName: backend,
      model: typeof entry.model === "string" ? entry.model : undefined,
      reasoningEffort: typeof entry.reasoning_effort === "string" ? entry.reasoning_effort : undefined,
      modelFieldName: `agents.${normalizedName}.model`,
      reasoningEffortFieldName: `agents.${normalizedName}.reasoning_effort`,
    });

    parsedAgents[normalizedName] = {
      backend,
      model: resolvedExecution.model,
      prompt,
      ...(resolvedExecution.reasoningEffort ? { reasoningEffort: resolvedExecution.reasoningEffort } : {}),
      ...(parsedTimeoutMs > 0 ? { timeoutMs: parsedTimeoutMs } : {}),
    };
  }

  return parsedAgents;
}

async function parseWorkflowSourceDocument(
  rawConfig: Record<string, unknown>,
  workflowPath: string,
): Promise<WorkflowDocument> {
  const tracker = (rawConfig.tracker ?? {}) as Record<string, unknown>;
  const polling = (rawConfig.polling ?? {}) as Record<string, unknown>;
  const workspace = (rawConfig.workspace ?? {}) as Record<string, unknown>;
  const artifacts = (rawConfig.artifacts ?? {}) as Record<string, unknown>;
  const hooks = (rawConfig.hooks ?? {}) as Record<string, unknown>;
  const execution = (rawConfig.execution ?? {}) as Record<string, unknown>;
  const escalation = rawConfig.escalation;
  const fanOut = rawConfig.fan_out;
  const triage = rawConfig.triage;
  const github = (rawConfig.github ?? {}) as Record<string, unknown>;
  const slack = (rawConfig.slack ?? {}) as Record<string, unknown>;

  const parsedBackends = parseBackendsConfig(rawConfig.backends);
  const parsedAgents = parseAgentsConfig(rawConfig.agents, new Set(Object.keys(parsedBackends)));
  const parsedTriage = parseTriageConfig(triage, new Set(Object.keys(parsedBackends)));
  const parsedEscalation = parseEscalationConfig(escalation);
  const parsedFanOut = parseFanOutConfig(fanOut, new Set(Object.keys(parsedBackends)), parsedAgents);
  const parsedWorkflows = await parseWorkflowDefinitions(rawConfig, workflowPath);
  const parsedWorkflowRouting = parseWorkflowRouting(rawConfig, parsedWorkflows);

  return {
    tracker: {
      kind: "linear",
      endpoint: String(tracker.endpoint ?? DEFAULT_CONFIG.tracker.endpoint),
      apiKey: String(tracker.api_key ?? "").trim(),
      assigneeId: parseRequiredString(tracker.assignee_id, "tracker.assignee_id"),
      activeStates: parseStringList(tracker.active_states, DEFAULT_CONFIG.tracker.activeStates),
      terminalStates: parseStringList(tracker.terminal_states, DEFAULT_CONFIG.tracker.terminalStates),
    },
    polling: {
      intervalMs: parsePositiveInt(polling.interval_ms, DEFAULT_CONFIG.polling.intervalMs),
    },
    workspace: {
      root: String(workspace.root ?? DEFAULT_CONFIG.workspace.root),
    },
    artifacts: {
      root: String(artifacts.root ?? DEFAULT_CONFIG.artifacts.root),
      workspaceDir: String(artifacts.workspace_dir ?? DEFAULT_CONFIG.artifacts.workspaceDir).trim() || DEFAULT_CONFIG.artifacts.workspaceDir,
    },
    hooks: {
      afterCreate: typeof hooks.after_create === "string" ? hooks.after_create : undefined,
      beforeRun: typeof hooks.before_run === "string" ? hooks.before_run : undefined,
      afterRun: typeof hooks.after_run === "string" ? hooks.after_run : undefined,
      beforeRemove: typeof hooks.before_remove === "string" ? hooks.before_remove : undefined,
      timeoutMs: parsePositiveInt(hooks.timeout_ms, DEFAULT_CONFIG.hooks.timeoutMs),
    },
    execution: {
      maxConcurrentAgents: parsePositiveInt(execution.max_concurrent_agents, DEFAULT_CONFIG.execution.maxConcurrentAgents),
      maxRetryAttempts: parseNonNegativeInt(execution.max_retry_attempts, DEFAULT_CONFIG.execution.maxRetryAttempts),
      maxRetryBackoffMs: parsePositiveInt(execution.max_retry_backoff_ms, DEFAULT_CONFIG.execution.maxRetryBackoffMs),
      maxConcurrentAgentsByState: normalizeStateMap(execution.max_concurrent_agents_by_state),
      maxAgentInvocationsPerRun: parsePositiveInt(
        execution.max_agent_invocations_per_run,
        DEFAULT_CONFIG.execution.maxAgentInvocationsPerRun,
      ),
    },
    escalation: parsedEscalation,
    fanOut: parsedFanOut,
    triage: parsedTriage,
    workflows: parsedWorkflows,
    workflowRouting: parsedWorkflowRouting,
    backends: parsedBackends,
    agents: parsedAgents,
    github: parseGitHubConfig(github),
    slack: parseSlackConfig(slack),
  };
}

function resolveWorkflowEntry(entry: WorkflowEntry, workflowPath: string): WorkflowEntry {
  const baseDir = path.dirname(workflowPath);
  return {
    dotFile: expandPath(entry.dotFile, baseDir),
    successState: entry.successState ?? DEFAULT_WORKFLOW_SUCCESS_STATE,
    inspectPr: entry.inspectPr !== false,
  };
}

function resolveGitHubConfig(github: GitHubConfig | null): GitHubConfig | null {
  if (!github) {
    return null;
  }

  const apiKey = maybeResolveSecret(github.apiKey, true).trim();
  const webhookSecret = maybeResolveSecret(github.webhookSecret, true).trim();
  if (!github.repository || !apiKey || !webhookSecret) {
    return null;
  }

  return {
    ...github,
    apiKey,
    webhookSecret,
  };
}

function parseGitHubConfig(github: Record<string, unknown>): GitHubConfig | null {
  const repository = String(github.repository ?? "").trim();
  const apiKey = String(github.api_key ?? "").trim();
  const webhookSecret = String(github.webhook_secret ?? "").trim();

  if (!repository || !apiKey || !webhookSecret) {
    return null;
  }

  const closedState = String(github.closed_state ?? "").trim();
  return {
    repository,
    apiKey,
    webhookSecret,
    revisionLabel: String(github.revision_label ?? "vajra-revision").trim() || "vajra-revision",
    revisionCommand: String(github.revision_command ?? "/vajra revise").trim() || "/vajra revise",
    revisionState: String(github.revision_state ?? "In Progress").trim() || "In Progress",
    mergedState: String(github.merged_state ?? "Done").trim() || "Done",
    closedState: closedState || null,
  };
}

function resolveSlackConfig(slack: SlackConfig | null): SlackConfig | null {
  if (!slack) {
    return null;
  }

  const botToken = maybeResolveSecret(slack.botToken, true).trim();
  if (!botToken || !slack.channelId) {
    return null;
  }

  return {
    ...slack,
    botToken,
    userMap: { ...slack.userMap },
  };
}

function parseSlackConfig(slack: Record<string, unknown>): SlackConfig | null {
  const botToken = String(slack.bot_token ?? "").trim();
  const channelId = String(slack.channel_id ?? "").trim();

  if (!botToken || !channelId) {
    return null;
  }

  const rawUserMap = (slack.user_map ?? {}) as Record<string, unknown>;
  const userMap: Record<string, string> = {};
  for (const [linearId, slackId] of Object.entries(rawUserMap)) {
    const trimmedSlackId = String(slackId ?? "").trim();
    if (trimmedSlackId) {
      userMap[linearId.trim()] = trimmedSlackId;
    }
  }

  return {
    botToken,
    channelId,
    userMap,
    notifyOnSuccess: slack.notify_on_success !== false,
    notifyOnFailure: slack.notify_on_failure !== false,
  };
}

function resolveWorkflowConfig(document: WorkflowDocument, workflowPath: string): WorkflowConfig {
  const baseDir = path.dirname(workflowPath);

  return {
    tracker: {
      ...document.tracker,
      apiKey: maybeResolveSecret(document.tracker.apiKey, true),
      activeStates: [...document.tracker.activeStates],
      terminalStates: [...document.tracker.terminalStates],
    },
    polling: { ...document.polling },
    workspace: {
      root: expandPath(document.workspace.root, baseDir),
    },
    artifacts: {
      root: expandPath(document.artifacts.root, baseDir),
      workspaceDir: document.artifacts.workspaceDir,
    },
    hooks: { ...document.hooks },
    execution: {
      ...document.execution,
      maxConcurrentAgentsByState: { ...document.execution.maxConcurrentAgentsByState },
    },
    escalation: document.escalation
      ? { ...document.escalation }
      : null,
    fanOut: Object.fromEntries(
      Object.entries(document.fanOut).map(([collectionId, definition]) => [
        collectionId,
        {
          ...definition,
          variants: definition.variants.map((variant) => ({ ...variant })),
        },
      ]),
    ),
    triage: document.triage
      ? { ...document.triage }
      : null,
    workflows: Object.fromEntries(
      Object.entries(document.workflows).map(([name, entry]) => [name, resolveWorkflowEntry(entry, workflowPath)]),
    ),
    workflowRouting: {
      defaultWorkflow: document.workflowRouting.defaultWorkflow,
      byLabel: { ...document.workflowRouting.byLabel },
    },
    backends: Object.fromEntries(
      Object.entries(document.backends).map(([name, entry]) => [name, { ...entry }]),
    ),
    agents: Object.fromEntries(
      Object.entries(document.agents).map(([name, entry]) => [name, { ...entry }]),
    ),
    github: resolveGitHubConfig(document.github),
    slack: resolveSlackConfig(document.slack),
  };
}

async function validateWorkflowGraphs(definition: WorkflowDefinition): Promise<void> {
  const seenFanOutStages = new Set<string>();

  for (const [workflowName, entry] of Object.entries(definition.config.workflows)) {
    const graphSource = await readFile(entry.dotFile, "utf8");
    const graph = parseDotGraph(graphSource);
    buildTraversalGraph(graph);
    validateWorkflowGraph({
      workflowName,
      dotFile: entry.dotFile,
      graphNodes: graph.nodes.values(),
      agents: definition.config.agents,
    });

    for (const node of graph.nodes.values()) {
      if (node.type === "fan_out") {
        const collectionId = String(node.attrs.collection ?? "").trim();
        const fanOut = definition.config.fanOut[collectionId];
        if (!collectionId || !fanOut) {
          throw new Error(`workflows.${workflowName}.dot_file fan_out stage ${node.id} references unknown collection ${collectionId || "(missing)"}`);
        }
        if (fanOut.stage !== node.id) {
          throw new Error(`fan_out.${collectionId}.stage must reference ${node.id}, found ${fanOut.stage}`);
        }
        seenFanOutStages.add(node.id);
      }

      if (node.type === "fan_in") {
        const collectionId = String(node.attrs.collection ?? "").trim();
        if (!collectionId || !definition.config.fanOut[collectionId]) {
          throw new Error(`workflows.${workflowName}.dot_file fan_in stage ${node.id} references unknown collection ${collectionId || "(missing)"}`);
        }
      }
    }
  }

  for (const [collectionId, fanOut] of Object.entries(definition.config.fanOut)) {
    if (!seenFanOutStages.has(fanOut.stage)) {
      throw new Error(`fan_out.${collectionId}.stage references unknown fan_out node ${fanOut.stage}`);
    }
  }
}

export async function loadWorkflowFile(workflowPath: string): Promise<WorkflowDefinition> {
  const content = await readFile(workflowPath, "utf8");
  const rawConfig = parseWorkflowDocument(content);
  const document = await parseWorkflowSourceDocument(rawConfig, workflowPath);
  const config = resolveWorkflowConfig(document, workflowPath);

  const definition: WorkflowDefinition = {
    path: workflowPath,
    config,
    document,
  };

  await validateWorkflowGraphs(definition);
  return definition;
}

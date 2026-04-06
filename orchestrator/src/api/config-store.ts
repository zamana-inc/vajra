import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { listAgentBackendPresets, resolveAgentExecutionConfig } from "../agent-presets";
import { parseDotGraph } from "../dot-parser";
import { buildTraversalGraph } from "../pipeline-graph";
import { builtInSkillsRoot } from "../skills";
import { normalizeRequiredLowercase } from "../string-utils";
import {
  AgentDefinition,
  BackendDefinition,
  MutableWorkflowStore,
  WorkflowDocument,
  WorkflowDefinition,
} from "../types";
import {
  loadWorkflowFile,
  serializeWorkflowDocument,
  validateWorkflowGraph,
  workflowRelativePath,
} from "../workflow";
import {
  ApiAgentsResponse,
  ApiBackendsResponse,
  ApiGitHubConfig,
  ApiSkillDefinition,
  ApiSkillsResponse,
  ApiTrackerConfig,
  ApiWorkflowConfigSnapshot,
  ApiWorkflowDefinition,
  ApiWorkflowsResponse,
  ApiSlackConfig,
} from "./types";
import { apiPipelineShapeFromGraph } from "./pipeline-shape";

type WorkflowRecord = ApiWorkflowDefinition & {
  referencedAgents: Set<string>;
};

type ConfigUpdateInput = Partial<{
  tracker: {
    endpoint: string;
    apiKey?: string | null;
    assigneeId: string;
    activeStates: string[];
    terminalStates: string[];
  };
  polling: {
    intervalMs: number;
  };
  workspace: {
    root: string;
  };
  artifacts: {
    root: string;
    workspaceDir: string;
  };
  hooks: {
    afterCreate?: string;
    beforeRun?: string;
    afterRun?: string;
    beforeRemove?: string;
    timeoutMs: number;
  };
  execution: {
    maxConcurrentAgents: number;
    maxRetryAttempts: number;
    maxRetryBackoffMs: number;
    maxConcurrentAgentsByState: Record<string, number>;
    maxAgentInvocationsPerRun: number;
  };
  escalation:
    | {
        linearState: string;
        comment: boolean;
        slackNotify: boolean;
      }
    | null;
  triage:
    | {
        enabled: boolean;
        backend: string;
        model: string;
        reasoningEffort?: string;
        timeoutMs: number;
      }
    | null;
  github:
    | {
        repository: string;
        apiKey?: string | null;
        webhookSecret?: string | null;
        revisionLabel: string;
        revisionCommand: string;
        revisionState: string;
        mergedState: string;
        closedState?: string | null;
      }
    | null;
  slack:
    | {
        botToken?: string | null;
        channelId: string;
        userMap: Record<string, string>;
        notifyOnSuccess: boolean;
        notifyOnFailure: boolean;
      }
    | null;
}>;

class WriteMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function hasConfiguredString(value: unknown): boolean {
  return String(value ?? "").trim().length > 0;
}

function cloneWorkflowDocument(document: WorkflowDocument): WorkflowDocument {
  return structuredClone(document);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function workflowLabels(definition: WorkflowDefinition, workflowName: string): string[] {
  const labels = Object.entries(definition.config.workflowRouting.byLabel)
    .filter(([, mappedWorkflow]) => mappedWorkflow === workflowName)
    .map(([label]) => label);

  return [...new Set(labels)].sort();
}

function emptyWorkflowDefinition(name: string, entry: {
  dotFile: string;
  successState?: string;
  inspectPr?: boolean;
}, labels: string[], isDefault: boolean): ApiWorkflowDefinition {
  return {
    name,
    dotFile: entry.dotFile,
    rawDot: "",
    goal: null,
    successState: entry.successState ?? "Done",
    inspectPr: entry.inspectPr !== false,
    labels,
    isDefault,
    parseError: null,
    nodes: [],
    edges: [],
  };
}

export class WorkflowAdminService {
  private readonly writeMutex = new WriteMutex();

  constructor(
    private readonly workflowStore: MutableWorkflowStore,
    private readonly skillsRoot: string = builtInSkillsRoot(),
  ) {}

  async rawDocument(): Promise<string> {
    return readFile(this.workflowStore.current().path, "utf8");
  }

  configSnapshot(): ApiWorkflowConfigSnapshot {
    const definition = this.workflowStore.current();
    const document = definition.document;

    const tracker: ApiTrackerConfig = {
      kind: definition.config.tracker.kind,
      endpoint: definition.config.tracker.endpoint,
      apiKeyConfigured: hasConfiguredString(document.tracker.apiKey),
      assigneeId: definition.config.tracker.assigneeId,
      activeStates: [...definition.config.tracker.activeStates],
      terminalStates: [...definition.config.tracker.terminalStates],
    };

    const slack: ApiSlackConfig | null = definition.config.slack
      ? {
          channelId: definition.config.slack.channelId,
          userMap: { ...definition.config.slack.userMap },
          notifyOnSuccess: definition.config.slack.notifyOnSuccess,
          notifyOnFailure: definition.config.slack.notifyOnFailure,
          botTokenConfigured: hasConfiguredString(document.slack?.botToken),
        }
      : null;

    const github: ApiGitHubConfig | null = definition.config.github
      ? {
          repository: definition.config.github.repository,
          revisionLabel: definition.config.github.revisionLabel,
          revisionCommand: definition.config.github.revisionCommand,
          revisionState: definition.config.github.revisionState,
          mergedState: definition.config.github.mergedState,
          closedState: definition.config.github.closedState,
          apiKeyConfigured: hasConfiguredString(document.github?.apiKey),
          webhookSecretConfigured: hasConfiguredString(document.github?.webhookSecret),
        }
      : null;

    return {
      tracker,
      polling: { ...definition.config.polling },
      workspace: { ...definition.config.workspace },
      artifacts: { ...definition.config.artifacts },
      hooks: { ...definition.config.hooks },
      execution: {
        ...definition.config.execution,
        maxConcurrentAgentsByState: { ...definition.config.execution.maxConcurrentAgentsByState },
      },
      escalation: definition.config.escalation
        ? { ...definition.config.escalation }
        : null,
      fanOut: Object.fromEntries(
        Object.entries(definition.config.fanOut).map(([collectionId, definition]) => [
          collectionId,
          {
            ...definition,
            variants: definition.variants.map((variant) => ({ ...variant })),
          },
        ]),
      ),
      triage: definition.config.triage
        ? { ...definition.config.triage }
        : null,
      workflows: Object.fromEntries(
        Object.entries(definition.config.workflows).map(([name, entry]) => [name, { ...entry }]),
      ),
      workflowRouting: {
        defaultWorkflow: definition.config.workflowRouting.defaultWorkflow,
        byLabel: { ...definition.config.workflowRouting.byLabel },
      },
      backends: Object.fromEntries(
        Object.entries(definition.config.backends).map(([name, entry]) => [name, { ...entry }]),
      ),
      agents: Object.fromEntries(
        Object.entries(definition.config.agents).map(([name, entry]) => [name, { ...entry }]),
      ),
      github,
      slack,
    };
  }

  async updateConfig(input: ConfigUpdateInput): Promise<ApiWorkflowConfigSnapshot> {
    await this.mutateWorkflow(async (document) => {
      if (input.tracker) {
        document.tracker.kind = "linear";
        document.tracker.endpoint = input.tracker.endpoint;
        document.tracker.assigneeId = input.tracker.assigneeId;
        document.tracker.activeStates = [...input.tracker.activeStates];
        document.tracker.terminalStates = [...input.tracker.terminalStates];
        if ("apiKey" in input.tracker) {
          document.tracker.apiKey = input.tracker.apiKey ?? "";
        }
      }

      if (input.polling) {
        document.polling.intervalMs = input.polling.intervalMs;
      }

      if (input.workspace) {
        document.workspace.root = input.workspace.root;
      }

      if (input.artifacts) {
        document.artifacts.root = input.artifacts.root;
        document.artifacts.workspaceDir = input.artifacts.workspaceDir;
      }

      if (input.hooks) {
        document.hooks.afterCreate = input.hooks.afterCreate ?? undefined;
        document.hooks.beforeRun = input.hooks.beforeRun ?? undefined;
        document.hooks.afterRun = input.hooks.afterRun ?? undefined;
        document.hooks.beforeRemove = input.hooks.beforeRemove ?? undefined;
        document.hooks.timeoutMs = input.hooks.timeoutMs;
      }

      if (input.execution) {
        document.execution.maxConcurrentAgents = input.execution.maxConcurrentAgents;
        document.execution.maxRetryAttempts = input.execution.maxRetryAttempts;
        document.execution.maxRetryBackoffMs = input.execution.maxRetryBackoffMs;
        document.execution.maxConcurrentAgentsByState = { ...input.execution.maxConcurrentAgentsByState };
        document.execution.maxAgentInvocationsPerRun = input.execution.maxAgentInvocationsPerRun;
      }

      if ("escalation" in input) {
        if (input.escalation === null) {
          document.escalation = null;
        } else if (input.escalation) {
          document.escalation = {
            linearState: input.escalation.linearState,
            comment: input.escalation.comment,
            slackNotify: input.escalation.slackNotify,
          };
        }
      }

      if ("triage" in input) {
        if (input.triage === null) {
          document.triage = null;
        } else if (input.triage) {
          const backend = normalizeRequiredLowercase(input.triage.backend, "triage.backend");
          if (!document.backends[backend]) {
            throw new Error(`triage.backend references unknown backend ${backend}`);
          }
          const model = String(input.triage.model ?? "").trim();
          if (!model) {
            throw new Error("triage.model is required");
          }
          document.triage = {
            enabled: input.triage.enabled !== false,
            backend,
            model,
            ...(input.triage.reasoningEffort ? { reasoningEffort: input.triage.reasoningEffort } : {}),
            timeoutMs: input.triage.timeoutMs,
          };
        }
      }

      if ("github" in input) {
        if (input.github === null) {
          document.github = null;
        } else if (input.github) {
          const nextGitHub = input.github;
          const github = document.github ?? {
            repository: "",
            apiKey: "",
            webhookSecret: "",
            revisionLabel: "vajra-revision",
            revisionCommand: "/vajra revise",
            revisionState: "In Progress",
            mergedState: "Done",
            closedState: null,
          };
          github.repository = nextGitHub.repository;
          github.revisionLabel = nextGitHub.revisionLabel;
          github.revisionCommand = nextGitHub.revisionCommand;
          github.revisionState = nextGitHub.revisionState;
          github.mergedState = nextGitHub.mergedState;
          github.closedState = nextGitHub.closedState ?? null;
          if ("apiKey" in nextGitHub) {
            github.apiKey = nextGitHub.apiKey ?? "";
          }
          if ("webhookSecret" in nextGitHub) {
            github.webhookSecret = nextGitHub.webhookSecret ?? "";
          }
          document.github = github;
        } else {
          document.github = null;
        }
      }

      if ("slack" in input) {
        if (input.slack === null) {
          document.slack = null;
        } else if (input.slack) {
          const nextSlack = input.slack;
          const slack = document.slack ?? {
            botToken: "",
            channelId: "",
            userMap: {},
            notifyOnSuccess: true,
            notifyOnFailure: true,
          };
          slack.channelId = nextSlack.channelId;
          slack.userMap = { ...nextSlack.userMap };
          slack.notifyOnSuccess = nextSlack.notifyOnSuccess;
          slack.notifyOnFailure = nextSlack.notifyOnFailure;
          if ("botToken" in nextSlack) {
            slack.botToken = nextSlack.botToken ?? "";
          }
          document.slack = slack;
        } else {
          document.slack = null;
        }
      }
    });

    return this.configSnapshot();
  }

  async listAgents(): Promise<ApiAgentsResponse> {
    const definition = this.workflowStore.current();
    const workflows = await this.workflowEntries(definition);
    const references = new Map<string, Set<string>>();

    for (const workflow of workflows) {
      for (const agentName of workflow.referencedAgents) {
        const entries = references.get(agentName) ?? new Set<string>();
        entries.add(workflow.name);
        references.set(agentName, entries);
      }
    }

    return {
      agents: Object.fromEntries(
        Object.entries(definition.config.agents).map(([name, agent]) => [name, { ...agent }]),
      ),
      references: Object.fromEntries(
        [...references.entries()]
          .map(([name, workflowsForAgent]) => [name, [...workflowsForAgent].sort()] as const)
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
    };
  }

  async saveAgent(name: string, input: Partial<AgentDefinition>): Promise<ApiAgentsResponse> {
    const normalizedName = normalizeRequiredLowercase(name, "agent name");
    await this.mutateWorkflow(async (document, current) => {
      const existing = current.config.agents[normalizedName];
      const backend = normalizeRequiredLowercase(
        String(input.backend ?? existing?.backend ?? ""),
        "agent backend",
      );
      const prompt = String(input.prompt ?? existing?.prompt ?? "").trim();
      if (!prompt) {
        throw new Error("agent prompt is required");
      }

      const resolvedExecution = resolveAgentExecutionConfig({
        backendName: backend,
        model: input.model ?? existing?.model,
        reasoningEffort: input.reasoningEffort ?? existing?.reasoningEffort,
        modelFieldName: "agent model",
        reasoningEffortFieldName: "agent reasoning_effort",
      });
      const timeoutMs = input.timeoutMs ?? existing?.timeoutMs;
      document.agents[normalizedName] = {
        backend,
        model: resolvedExecution.model,
        prompt,
        ...(resolvedExecution.reasoningEffort ? { reasoningEffort: resolvedExecution.reasoningEffort } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
      };
    });

    return this.listAgents();
  }

  async deleteAgent(name: string): Promise<ApiAgentsResponse> {
    const normalizedName = normalizeRequiredLowercase(name, "agent name");
    const workflows = await this.workflowEntries(this.workflowStore.current());
    const referencedBy = workflows
      .filter((workflow) => workflow.referencedAgents.has(normalizedName))
      .map((workflow) => workflow.name)
      .sort();
    if (referencedBy.length > 0) {
      throw new Error(`agent ${normalizedName} is referenced by workflows: ${referencedBy.join(", ")}`);
    }

    await this.mutateWorkflow(async (document) => {
      delete document.agents[normalizedName];
    });

    return this.listAgents();
  }

  backends(): ApiBackendsResponse {
    const definition = this.workflowStore.current();
    const references = new Map<string, string[]>();
    for (const [agentName, agent] of Object.entries(definition.config.agents)) {
      const entries = references.get(agent.backend) ?? [];
      entries.push(agentName);
      references.set(agent.backend, entries);
    }

    return {
      backends: Object.fromEntries(
        Object.entries(definition.config.backends).map(([name, backend]) => [name, { ...backend }]),
      ),
      references: Object.fromEntries(
        [...references.entries()]
          .map(([name, agents]) => [name, [...agents].sort()] as const)
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
      presets: listAgentBackendPresets(Object.keys(definition.config.backends)),
    };
  }

  async saveBackend(name: string, input: Partial<BackendDefinition>): Promise<ApiBackendsResponse> {
    const normalizedName = normalizeRequiredLowercase(name, "backend name");
    await this.mutateWorkflow(async (document, current) => {
      const existing = current.config.backends[normalizedName];
      const command = String(input.command ?? existing?.command ?? "").trim();
      if (!command) {
        throw new Error("backend command is required");
      }
      document.backends[normalizedName] = { command };
    });

    return this.backends();
  }

  async workflows(): Promise<ApiWorkflowsResponse> {
    const definition = this.workflowStore.current();
    return {
      workflows: (await this.workflowEntries(definition)).map((workflow) => this.publicWorkflow(workflow)),
      defaultWorkflow: definition.config.workflowRouting.defaultWorkflow,
    };
  }

  async workflow(name: string): Promise<ApiWorkflowDefinition | null> {
    const normalizedName = normalizeRequiredLowercase(name, "workflow name");
    const entry = (await this.workflowEntries(this.workflowStore.current()))
      .find((workflow) => workflow.name === normalizedName);
    return entry ? this.publicWorkflow(entry) : null;
  }

  async previewWorkflow(input: {
    name: string;
    rawDot: string;
    successState?: string;
    inspectPr?: boolean;
    labels?: string[];
    isDefault?: boolean;
  }): Promise<ApiWorkflowDefinition> {
    const current = this.workflowStore.current();
    const normalizedName = normalizeRequiredLowercase(input.name, "workflow name");
    const existing = current.config.workflows[normalizedName];
    const dotFile = existing?.dotFile ?? path.join(path.dirname(current.path), "pipelines", `${normalizedName}.dot`);
    const rawDot = String(input.rawDot ?? "");
    if (!rawDot.trim()) {
      throw new Error(`workflow ${normalizedName} requires rawDot`);
    }

    const graph = parseDotGraph(rawDot);
    buildTraversalGraph(graph);
    validateWorkflowGraph({
      workflowName: normalizedName,
      dotFile,
      graphNodes: graph.nodes.values(),
      agents: current.config.agents,
    });

    const shape = apiPipelineShapeFromGraph(graph);
    const labels = [...new Set((input.labels ?? workflowLabels(current, normalizedName))
      .map((label) => normalizeRequiredLowercase(label, "workflow label")))]
      .sort();

    return {
      ...emptyWorkflowDefinition(
        normalizedName,
        {
          dotFile,
          successState: input.successState ?? existing?.successState ?? "Done",
          inspectPr: input.inspectPr ?? (existing?.inspectPr !== false),
        },
        labels,
        input.isDefault ?? current.config.workflowRouting.defaultWorkflow === normalizedName,
      ),
      rawDot,
      goal: shape.goal,
      parseError: null,
      nodes: shape.nodes.map((node) => ({
        ...node,
        agentName: node.agentName
          ? normalizeRequiredLowercase(node.agentName, `workflow ${normalizedName} stage ${node.id} agent`)
          : null,
      })),
      edges: shape.edges,
    };
  }

  async saveWorkflow(name: string, input: Partial<{
    rawDot: string;
    successState: string;
    inspectPr: boolean;
    labels: string[];
    isDefault: boolean;
  }>): Promise<ApiWorkflowDefinition | null> {
    const normalizedName = normalizeRequiredLowercase(name, "workflow name");
    return this.writeMutex.run(async () => {
      const current = this.workflowStore.current();
      const existing = current.config.workflows[normalizedName];
      const dotFile = existing?.dotFile ?? path.join(path.dirname(current.path), "pipelines", `${normalizedName}.dot`);
      const rawDot = input.rawDot ?? await readFile(dotFile, "utf8").catch(() => "");
      if (!rawDot.trim()) {
        throw new Error(`workflow ${normalizedName} requires rawDot`);
      }

      const graph = parseDotGraph(rawDot);
      buildTraversalGraph(graph);
      validateWorkflowGraph({
        workflowName: normalizedName,
        dotFile,
        graphNodes: graph.nodes.values(),
        agents: current.config.agents,
      });

      const currentLabels = workflowLabels(current, normalizedName);
      const nextLabels = [...new Set((input.labels ?? currentLabels)
        .map((label) => normalizeRequiredLowercase(label, "workflow label")))]
        .sort();

      const nextDocument = cloneWorkflowDocument(current.document);
      nextDocument.workflows[normalizedName] = {
        dotFile: workflowRelativePath(current.path, dotFile),
        successState: input.successState ?? existing?.successState ?? "Done",
        inspectPr: input.inspectPr ?? (existing?.inspectPr !== false),
      };

      nextDocument.workflowRouting.byLabel = Object.fromEntries(
        Object.entries(nextDocument.workflowRouting.byLabel)
          .filter(([, workflowName]) => workflowName !== normalizedName),
      );
      for (const label of nextLabels) {
        nextDocument.workflowRouting.byLabel[label] = normalizedName;
      }

      const configuredWorkflowNames = new Set([
        ...Object.keys(nextDocument.workflows),
        normalizedName,
      ]);
      const currentDefault = normalizeRequiredLowercase(
        nextDocument.workflowRouting.defaultWorkflow || current.config.workflowRouting.defaultWorkflow || normalizedName,
        "workflow_routing.default_workflow",
      );
      nextDocument.workflowRouting.defaultWorkflow = input.isDefault === true
        ? normalizedName
        : configuredWorkflowNames.has(currentDefault)
          ? currentDefault
          : normalizedName;

      const hadDotFile = await fileExists(dotFile);
      const previousDot = hadDotFile ? await readFile(dotFile, "utf8") : null;
      await mkdir(path.dirname(dotFile), { recursive: true });
      const tmpPath = path.join(
        path.dirname(dotFile),
        `.tmp-${randomBytes(6).toString("hex")}-${path.basename(dotFile)}`,
      );

      try {
        await writeFile(tmpPath, rawDot, "utf8");
        await rename(tmpPath, dotFile);
        await this.writeWorkflowDocument(current.path, nextDocument);
      } catch (error) {
        await rm(tmpPath, { force: true }).catch(() => {});
        if (hadDotFile && previousDot !== null) {
          await writeFile(dotFile, previousDot, "utf8").catch(() => {});
        } else if (!hadDotFile) {
          await rm(dotFile, { force: true }).catch(() => {});
        }
        throw error;
      }

      return this.workflow(normalizedName);
    });
  }

  async deleteWorkflow(name: string): Promise<ApiWorkflowsResponse> {
    const normalizedName = normalizeRequiredLowercase(name, "workflow name");
    return this.writeMutex.run(async () => {
      const current = this.workflowStore.current();
      const existing = current.config.workflows[normalizedName];
      if (!existing) {
        throw new Error(`workflow ${normalizedName} does not exist`);
      }

      // Build the updated config first — if this fails, nothing changes
      const nextDocument = cloneWorkflowDocument(current.document);
      delete nextDocument.workflows[normalizedName];

      nextDocument.workflowRouting.byLabel = Object.fromEntries(
        Object.entries(nextDocument.workflowRouting.byLabel)
          .filter(([, workflowName]) => workflowName !== normalizedName),
      );

      if (nextDocument.workflowRouting.defaultWorkflow === normalizedName) {
        nextDocument.workflowRouting.defaultWorkflow = Object.keys(nextDocument.workflows)[0] ?? "";
      }

      // Write config first — atomic via temp file + rename.
      // If this fails, both config and DOT file remain intact.
      await this.writeWorkflowDocument(current.path, nextDocument);

      // Config committed successfully — now remove the DOT file.
      // If this fails, the orphaned DOT file is harmless (config no longer references it).
      await rm(existing.dotFile, { force: true }).catch(() => {});

      return this.workflows();
    });
  }

  async skills(): Promise<ApiSkillsResponse> {
    const skills = await this.skillDefinitions();
    return { skills };
  }

  async saveSkill(name: string, content: string): Promise<ApiSkillDefinition> {
    return this.writeMutex.run(async () => {
      const normalizedName = normalizeRequiredLowercase(name, "skill name");
      if (!normalizedName.startsWith("vajra-")) {
        throw new Error("skill name must start with vajra-");
      }

      const skillDir = path.join(this.skillsRoot, normalizedName);
      const skillPath = path.join(skillDir, "SKILL.md");
      await mkdir(skillDir, { recursive: true });
      await writeFile(skillPath, content, "utf8");
      return {
        name: normalizedName,
        path: skillPath,
        content,
      };
    });
  }

  async deleteSkill(name: string): Promise<ApiSkillsResponse> {
    return this.writeMutex.run(async () => {
      const normalizedName = normalizeRequiredLowercase(name, "skill name");
      if (!normalizedName.startsWith("vajra-")) {
        throw new Error("skill name must start with vajra-");
      }

      const skillDir = path.join(this.skillsRoot, normalizedName);
      const skillPath = path.join(skillDir, "SKILL.md");
      if (!(await fileExists(skillPath))) {
        throw new Error(`skill ${normalizedName} does not exist`);
      }

      await rm(skillDir, { recursive: true, force: true });
      return this.skills();
    });
  }

  private async skillDefinitions(): Promise<ApiSkillDefinition[]> {
    const entries = await readdir(this.skillsRoot, { withFileTypes: true });
    const skills = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("vajra-"))
      .map(async (entry) => {
        const skillPath = path.join(this.skillsRoot, entry.name, "SKILL.md");
        return {
          name: entry.name,
          path: skillPath,
          content: await readFile(skillPath, "utf8"),
        };
      }));

    return skills.sort((left, right) => left.name.localeCompare(right.name));
  }

  private async workflowEntries(definition: WorkflowDefinition): Promise<WorkflowRecord[]> {
    const seenDotFiles = new Map<string, string>();
    const entries: WorkflowRecord[] = [];

    for (const [name, entry] of Object.entries(definition.config.workflows).sort(([left], [right]) => left.localeCompare(right))) {
      const existing = seenDotFiles.get(entry.dotFile);
      if (existing && existing !== name) {
        throw new Error(`workflows ${existing} and ${name} both reference ${entry.dotFile}`);
      }
      seenDotFiles.set(entry.dotFile, name);

      let definitionEntry: WorkflowRecord = {
        ...emptyWorkflowDefinition(
          name,
          entry,
          workflowLabels(definition, name),
          definition.config.workflowRouting.defaultWorkflow === name,
        ),
        referencedAgents: new Set<string>(),
      };

      try {
        const rawDot = await readFile(entry.dotFile, "utf8");
        const graph = parseDotGraph(rawDot);
        const shape = apiPipelineShapeFromGraph(graph);
        const nodes = shape.nodes.map((node) => {
          const agentName = node.agentName ? normalizeRequiredLowercase(node.agentName, `workflow ${name} stage ${node.id} agent`) : null;
          if (agentName) {
            definitionEntry.referencedAgents.add(agentName);
          }
          return {
            ...node,
            agentName,
          };
        });

        definitionEntry = {
          ...definitionEntry,
          rawDot,
          goal: shape.goal,
          parseError: null,
          nodes,
          edges: shape.edges,
        };
      } catch (error) {
        definitionEntry = {
          ...definitionEntry,
          rawDot: await readFile(entry.dotFile, "utf8").catch(() => ""),
          parseError: error instanceof Error ? error.message : String(error),
        };
      }

      entries.push(definitionEntry);
    }

    return entries;
  }

  private async mutateWorkflow(
    mutation: (document: WorkflowDocument, current: WorkflowDefinition) => Promise<void> | void,
  ): Promise<WorkflowDefinition> {
    return this.writeMutex.run(async () => {
      const current = this.workflowStore.current();
      const nextDocument = cloneWorkflowDocument(current.document);
      await mutation(nextDocument, current);
      return this.writeWorkflowDocument(current.path, nextDocument);
    });
  }

  private async writeWorkflowDocument(workflowPath: string, document: WorkflowDocument): Promise<WorkflowDefinition> {
    const workflowDir = path.dirname(workflowPath);
    const tmpPath = path.join(
      workflowDir,
      `.tmp-${randomBytes(6).toString("hex")}-${path.basename(workflowPath)}`,
    );

    try {
      await writeFile(tmpPath, serializeWorkflowDocument(document), "utf8");
      await loadWorkflowFile(tmpPath);
      await rename(tmpPath, workflowPath);
      return this.workflowStore.load();
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  private publicWorkflow(entry: WorkflowRecord): ApiWorkflowDefinition {
    const { referencedAgents: _referencedAgents, ...workflow } = entry;
    return workflow;
  }
}

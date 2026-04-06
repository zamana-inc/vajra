import {
  AgentDefinition,
  ArtifactConfig,
  BackendDefinition,
  DispatchPlan,
  EscalationConfig,
  ExecutionConfig,
  FanOutVariantConfig,
  FanOutDefinition,
  GitHubConfig,
  HooksConfig,
  PollingConfig,
  SlackConfig,
  TriageConfig,
  TrackerConfig,
  WorkflowRoutingConfig,
  WorkflowEntry,
  WorkspaceConfig,
} from "../types";
import { AgentBackendPreset } from "../agent-presets";

export interface ApiStateBarrierEntry {
  issueId: string;
  state: string;
}

export interface ApiRunningIssue {
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  state: string;
  attempt: number;
  workspacePath: string;
  stopReason: string | null;
}

export interface ApiRetryAttempt {
  issueId: string;
  issueIdentifier: string;
  attempt: number;
  dueAtMs: number;
  dueAt: string;
  error: string | null;
}

export interface ApiStateSnapshot {
  startedAt: string | null;
  lastTickAt: string | null;
  workflowReloadError: string | null;
  uptimeMs: number | null;
  activeCount: number;
  retryingCount: number;
  waitingCount: number;
  claimedCount: number;
  completedBarrierCount: number;
  failedBarrierCount: number;
  nextRetryAt: string | null;
  running: ApiRunningIssue[];
  retryAttempts: ApiRetryAttempt[];
  completed: ApiStateBarrierEntry[];
  failed: ApiStateBarrierEntry[];
}

export type ApiRunStatus = "running" | "success" | "failure" | "cancelled" | "wait_human";

export interface ApiRunStageSummary {
  id: string;
  label: string;
  agentName: string | null;
  status: "pending" | "running" | "success" | "failure" | "cancelled" | "wait_human";
  durationMs: number | null;
  visitCount: number;
}

export interface ApiRunSummary {
  id: string;
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  issueUrl: string | null;
  attempt: number;
  workflowName: string;
  status: ApiRunStatus;
  startedAt: string;
  finishedAt: string | null;
  lastEventAt: string;
  durationMs: number | null;
  prUrl: string | null;
  error: string | null;
  dispatchPlan: DispatchPlan | null;
  currentStageId: string | null;
  currentStageLabel: string | null;
  stages: ApiRunStageSummary[];
}

export interface ApiRunStatusCounts {
  running: number;
  success: number;
  failure: number;
  cancelled: number;
  waitHuman: number;
}

export interface ApiRunsResponse {
  runs: ApiRunSummary[];
  total: number;
  counts: ApiRunStatusCounts;
}

export interface ApiRunArtifact {
  name: string;
  path: string;
}

export interface ApiStageVisit {
  visit: number;
  status: string | null;
  durationMs: number | null;
  exitCode: number | null;
  prompt: string | null;
  output: string | null;
  artifacts: ApiRunArtifact[];
  meta: Record<string, unknown>;
}

export interface ApiRunStageDetail {
  id: string;
  label: string;
  agentName: string | null;
  status: ApiRunStageSummary["status"];
  durationMs: number | null;
  exitCode: number | null;
  model: string | null;
  reasoningEffort: string | null;
  backend: string | null;
  prompt: string | null;
  output: string | null;
  artifacts: ApiRunArtifact[];
  meta: Record<string, unknown>;
  previousVisits: ApiStageVisit[];
}

export interface ApiCollectionCandidate {
  id: string;
  status: "success" | "failure";
  artifacts: Record<string, string>;
  facts: Record<string, string | number | boolean | null>;
  variantConfig: FanOutVariantConfig;
}

export interface ApiCollectionSummary {
  id: string;
  stageId: string;
  selectedCandidateId: string | null;
  synthesizedArtifact: string | null;
  candidates: ApiCollectionCandidate[];
}

export interface ApiRunDetail extends ApiRunSummary {
  graphId: string | null;
  dotFile: string | null;
  graph: {
    nodes: ApiWorkflowNode[];
    edges: ApiWorkflowEdge[];
  } | null;
  checkpointStatus: ApiRunStatus | null;
  checkpointError: string | null;
  nextNodeId: string | null;
  collections: ApiCollectionSummary[];
  stageDetails: ApiRunStageDetail[];
}

export interface ApiTrackerConfig extends Omit<TrackerConfig, "apiKey"> {
  apiKeyConfigured: boolean;
}

export interface ApiSlackConfig extends Omit<SlackConfig, "botToken"> {
  botTokenConfigured: boolean;
}

export interface ApiGitHubConfig extends Omit<GitHubConfig, "apiKey" | "webhookSecret"> {
  apiKeyConfigured: boolean;
  webhookSecretConfigured: boolean;
}

export interface ApiWorkflowConfigSnapshot {
  tracker: ApiTrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  artifacts: ArtifactConfig;
  hooks: HooksConfig;
  execution: ExecutionConfig;
  escalation: EscalationConfig | null;
  fanOut: Record<string, FanOutDefinition>;
  triage: TriageConfig | null;
  workflows: Record<string, WorkflowEntry>;
  workflowRouting: WorkflowRoutingConfig;
  backends: Record<string, BackendDefinition>;
  agents: Record<string, AgentDefinition>;
  github: ApiGitHubConfig | null;
  slack: ApiSlackConfig | null;
}

export interface ApiAgentsResponse {
  agents: Record<string, AgentDefinition>;
  references: Record<string, string[]>;
}

export interface ApiBackendsResponse {
  backends: Record<string, BackendDefinition>;
  references: Record<string, string[]>;
  presets: Record<string, AgentBackendPreset>;
}

export interface ApiWorkflowNode {
  id: string;
  label: string;
  type: "start" | "exit" | "agent" | "tool" | "fan_out" | "fan_in";
  agentName: string | null;
  artifactPath: string | null;
  maxVisits: number | null;
  command: string | null;
  attrs: Record<string, string>;
}

export interface ApiWorkflowEdge {
  from: string;
  to: string;
  onLabel: string | null;
  condition: string | null;
  isDefault: boolean;
  attrs: Record<string, string>;
}

export interface ApiWorkflowDefinition {
  name: string;
  dotFile: string;
  rawDot: string;
  goal: string | null;
  successState: string;
  inspectPr: boolean;
  labels: string[];
  isDefault: boolean;
  parseError: string | null;
  nodes: ApiWorkflowNode[];
  edges: ApiWorkflowEdge[];
}

export interface ApiWorkflowsResponse {
  workflows: ApiWorkflowDefinition[];
  defaultWorkflow: string;
}

export interface ApiSkillDefinition {
  name: string;
  path: string;
  content: string;
}

export interface ApiSkillsResponse {
  skills: ApiSkillDefinition[];
}

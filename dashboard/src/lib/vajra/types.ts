export interface VajraStateBarrierEntry {
  issueId: string;
  state: string;
}

export interface VajraRunningIssue {
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  state: string;
  attempt: number;
  workspacePath: string;
  stopReason: string | null;
}

export interface VajraRetryAttempt {
  issueId: string;
  issueIdentifier: string;
  attempt: number;
  dueAtMs: number;
  dueAt: string;
  error: string | null;
}

export interface VajraStateSnapshot {
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
  running: VajraRunningIssue[];
  retryAttempts: VajraRetryAttempt[];
  completed: VajraStateBarrierEntry[];
  failed: VajraStateBarrierEntry[];
}

export type VajraRunStatus = "running" | "success" | "failure" | "cancelled" | "wait_human";

export interface VajraRunStageSummary {
  id: string;
  label: string;
  agentName: string | null;
  status: "pending" | "running" | "success" | "failure" | "cancelled" | "wait_human";
  durationMs: number | null;
  visitCount: number;
}

export interface VajraRunSummary {
  id: string;
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  issueUrl: string | null;
  attempt: number;
  workflowName: string;
  status: VajraRunStatus;
  startedAt: string;
  finishedAt: string | null;
  lastEventAt: string;
  durationMs: number | null;
  prUrl: string | null;
  error: string | null;
  dispatchPlan: VajraDispatchPlan | null;
  currentStageId: string | null;
  currentStageLabel: string | null;
  stages: VajraRunStageSummary[];
}

export interface VajraRunStatusCounts {
  running: number;
  success: number;
  failure: number;
  cancelled: number;
  waitHuman: number;
}

export interface VajraRunsResponse {
  runs: VajraRunSummary[];
  total: number;
  counts: VajraRunStatusCounts;
}

export interface VajraRunArtifact {
  name: string;
  path: string;
}

export interface VajraStageVisit {
  visit: number;
  status: string | null;
  durationMs: number | null;
  exitCode: number | null;
  prompt: string | null;
  output: string | null;
  artifacts: VajraRunArtifact[];
  meta: Record<string, unknown>;
}

export interface VajraRunStageDetail {
  id: string;
  label: string;
  agentName: string | null;
  status: VajraRunStageSummary["status"];
  durationMs: number | null;
  exitCode: number | null;
  model: string | null;
  reasoningEffort: string | null;
  backend: string | null;
  prompt: string | null;
  output: string | null;
  artifacts: VajraRunArtifact[];
  meta: Record<string, unknown>;
  previousVisits?: VajraStageVisit[];
}

export interface VajraCollectionCandidate {
  id: string;
  status: "success" | "failure";
  artifacts: Record<string, string>;
  facts: Record<string, string | number | boolean | null>;
  variantConfig: VajraFanOutVariantConfig;
}

export interface VajraCollectionSummary {
  id: string;
  stageId: string;
  selectedCandidateId: string | null;
  synthesizedArtifact: string | null;
  candidates: VajraCollectionCandidate[];
}

export interface VajraRunDetail extends VajraRunSummary {
  graphId: string | null;
  dotFile: string | null;
  graph: {
    nodes: VajraWorkflowNode[];
    edges: VajraWorkflowEdge[];
  } | null;
  checkpointStatus: VajraRunStatus | null;
  checkpointError: string | null;
  nextNodeId: string | null;
  collections: VajraCollectionSummary[];
  stageDetails: VajraRunStageDetail[];
}

export interface VajraTrackerConfig {
  kind: "linear";
  endpoint: string;
  apiKeyConfigured: boolean;
  assigneeId: string;
  activeStates: string[];
  terminalStates: string[];
}

export interface VajraPollingConfig {
  intervalMs: number;
}

export interface VajraWorkspaceConfig {
  root: string;
}

export interface VajraArtifactConfig {
  root: string;
  workspaceDir: string;
}

export interface VajraHooksConfig {
  afterCreate?: string;
  beforeRun?: string;
  afterRun?: string;
  beforeRemove?: string;
  timeoutMs: number;
}

export interface VajraExecutionConfig {
  maxConcurrentAgents: number;
  maxRetryAttempts: number;
  maxRetryBackoffMs: number;
  maxAgentInvocationsPerRun: number;
  maxConcurrentAgentsByState: Record<string, number>;
}

export interface VajraBackendDefinition {
  command: string;
}

export interface VajraBackendPresetOption {
  value: string;
  label: string;
}

export interface VajraBackendPreset {
  models: VajraBackendPresetOption[];
  defaultModel: string;
  reasoningEfforts: string[];
  defaultReasoningEffort: string;
}

export interface VajraAgentDefinition {
  backend: string;
  model: string;
  prompt: string;
  reasoningEffort?: string;
  timeoutMs?: number;
}

export interface VajraWorkflowEntry {
  dotFile: string;
  successState?: string;
  inspectPr?: boolean;
}

export interface VajraWorkflowRouting {
  defaultWorkflow: string;
  byLabel: Record<string, string>;
}

export interface VajraSlackConfig {
  channelId: string;
  userMap: Record<string, string>;
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
  botTokenConfigured: boolean;
}

export interface VajraEscalationConfig {
  linearState: string;
  comment: boolean;
  slackNotify: boolean;
}

export interface VajraFanOutVariantConfig {
  id: string;
  agent?: string;
  model?: string;
  reasoningEffort?: string;
  instructions?: string;
}

export interface VajraFanOutDefinition {
  stage: string;
  maxParallel: number;
  completionPolicy: "wait_all";
  variants: VajraFanOutVariantConfig[];
}

export interface VajraTriageConfig {
  enabled: boolean;
  backend: string;
  model: string;
  reasoningEffort?: string;
  timeoutMs: number;
}

export interface VajraTriageDecision {
  action: "dispatch" | "request-clarification";
  workflowName?: string;
  baseBranch?: string;
  targetBranch?: string;
  mergeStrategy?: "pr-only" | "auto-merge";
  labels?: string[];
  reasoning?: string;
  comment?: string;
  wasFallback?: boolean;
}

export interface VajraDispatchPlan {
  workflowName: string;
  successState: string;
  baseBranch: string;
  targetBranch: string;
  mergeStrategy: "pr-only" | "auto-merge";
  labelsToAdd: string[];
  triage: VajraTriageDecision | null;
}

export interface VajraGitHubConfig {
  repository: string;
  apiKeyConfigured: boolean;
  webhookSecretConfigured: boolean;
  revisionLabel: string;
  revisionCommand: string;
  revisionState: string;
  mergedState: string;
  closedState: string | null;
}

export interface VajraConfigSnapshot {
  tracker: VajraTrackerConfig;
  polling: VajraPollingConfig;
  workspace: VajraWorkspaceConfig;
  artifacts: VajraArtifactConfig;
  hooks: VajraHooksConfig;
  execution: VajraExecutionConfig;
  escalation: VajraEscalationConfig | null;
  fanOut: Record<string, VajraFanOutDefinition>;
  triage: VajraTriageConfig | null;
  workflows: Record<string, VajraWorkflowEntry>;
  workflowRouting: VajraWorkflowRouting;
  backends: Record<string, VajraBackendDefinition>;
  agents: Record<string, VajraAgentDefinition>;
  github: VajraGitHubConfig | null;
  slack: VajraSlackConfig | null;
}

export interface VajraAgentsResponse {
  agents: Record<string, VajraAgentDefinition>;
  references: Record<string, string[]>;
}

export interface VajraBackendsResponse {
  backends: Record<string, VajraBackendDefinition>;
  references: Record<string, string[]>;
  presets: Record<string, VajraBackendPreset>;
}

export interface VajraWorkflowNode {
  id: string;
  label: string;
  type: "start" | "exit" | "agent" | "tool" | "fan_out" | "fan_in";
  agentName: string | null;
  artifactPath: string | null;
  maxVisits: number | null;
  command: string | null;
  attrs: Record<string, string>;
}

export interface VajraWorkflowEdge {
  from: string;
  to: string;
  onLabel: string | null;
  condition: string | null;
  isDefault: boolean;
  attrs: Record<string, string>;
}

export interface VajraWorkflowDefinition {
  name: string;
  dotFile: string;
  rawDot: string;
  goal: string | null;
  successState: string;
  inspectPr: boolean;
  labels: string[];
  isDefault: boolean;
  parseError: string | null;
  nodes: VajraWorkflowNode[];
  edges: VajraWorkflowEdge[];
}

export interface VajraWorkflowsResponse {
  workflows: VajraWorkflowDefinition[];
  defaultWorkflow: string;
}

export interface VajraSkillDefinition {
  name: string;
  path: string;
  content: string;
}

export interface VajraSkillsResponse {
  skills: VajraSkillDefinition[];
}

export interface VajraEventMessage {
  type: string;
  timestamp: string;
  issueId?: string;
  issueIdentifier?: string;
  [key: string]: unknown;
}

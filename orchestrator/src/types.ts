export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  state: string;
  priority: number | null;
  labels: string[];
  assigneeId: string | null;
  creatorId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  url: string | null;
  blockedBy: BlockerRef[];
}

export interface TrackerConfig {
  kind: "linear";
  endpoint: string;
  apiKey: string;
  assigneeId: string;
  activeStates: string[];
  terminalStates: string[];
}

export interface PollingConfig {
  intervalMs: number;
}

export interface WorkspaceConfig {
  root: string;
}

export interface ArtifactConfig {
  root: string;
  workspaceDir: string;
}

export interface HooksConfig {
  afterCreate?: string;
  beforeRun?: string;
  afterRun?: string;
  beforeRemove?: string;
  timeoutMs: number;
}

export interface ExecutionConfig {
  maxConcurrentAgents: number;
  // Additional retries after the initial attempt. 0 means fail immediately.
  maxRetryAttempts: number;
  maxRetryBackoffMs: number;
  maxConcurrentAgentsByState: Record<string, number>;
  maxAgentInvocationsPerRun: number;
}

export interface EscalationConfig {
  linearState: string;
  comment: boolean;
  slackNotify: boolean;
}

export interface FanOutVariantConfig {
  id: string;
  agent?: string;
  model?: string;
  reasoningEffort?: string;
  instructions?: string;
}

export interface FanOutDefinition {
  stage: string;
  maxParallel: number;
  completionPolicy: "wait_all";
  variants: FanOutVariantConfig[];
}

export interface SlackConfig {
  botToken: string;
  channelId: string;
  userMap: Record<string, string>; // linear user id -> slack user id
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
}

export interface GitHubConfig {
  repository: string;
  apiKey: string;
  webhookSecret: string;
  revisionLabel: string;
  revisionCommand: string;
  revisionState: string;
  mergedState: string;
  closedState: string | null;
}

export interface BackendDefinition {
  command: string;
}

export interface AgentDefinition {
  backend: string;
  model: string;
  prompt: string;
  reasoningEffort?: string;
  timeoutMs?: number;
}

export interface WorkflowEntry {
  dotFile: string;
  successState?: string;
  inspectPr?: boolean;
}

export interface WorkflowRoutingConfig {
  defaultWorkflow: string;
  byLabel: Record<string, string>;
}

export interface TriageConfig {
  enabled: boolean;
  backend: string;
  model: string;
  reasoningEffort?: string;
  timeoutMs: number;
}

export interface TriageDecision {
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

export interface DispatchPlan {
  workflowName: string;
  successState: string;
  baseBranch: string;
  targetBranch: string;
  mergeStrategy: "pr-only" | "auto-merge";
  labelsToAdd: string[];
  triage: TriageDecision | null;
}

export interface WorkflowConfig {
  tracker: TrackerConfig;
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
  github: GitHubConfig | null;
  slack: SlackConfig | null;
}

export type WorkflowDocument = WorkflowConfig;

export interface WorkflowDefinition {
  path: string;
  config: WorkflowConfig;
  document: WorkflowDocument;
}

export type GraphNodeType = "start" | "exit" | "agent" | "tool" | "fan_out" | "fan_in";

export interface GraphNode {
  id: string;
  attrs: Record<string, string>;
  type: GraphNodeType;
}

export interface GraphEdge {
  from: string;
  to: string;
  attrs: Record<string, string>;
}

export interface PipelineGraph {
  id: string;
  graphAttrs: Record<string, string>;
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
}

export interface WorkspaceInfo {
  path: string;
  workspaceKey: string;
  createdNow: boolean;
}

export interface PullRequestMetadata {
  url: string;
  title?: string | null;
  number?: number | null;
  headRefName?: string | null;
  headSha?: string | null;
  additions?: number | null;
  deletions?: number | null;
  state?: string | null;
}

export interface PullRequestRecord {
  issueIdentifier: string;
  repository: string;
  number: number;
  url: string;
  title: string | null;
  headRefName: string | null;
  headSha: string | null;
  state: string | null;
  updatedAt: string;
}

export interface ReviewRequestTrigger {
  type: "changes_requested" | "command";
  deliveryId: string;
  requestedAt: string;
  reviewId: number | null;
  commentId: number | null;
  actor: string | null;
  command: string | null;
}

export interface ReviewRequestState {
  issueIdentifier: string;
  repository: string;
  prNumber: number;
  prUrl: string | null;
  processedDeliveryIds: string[];
  trigger: ReviewRequestTrigger;
  updatedAt: string;
}

export type StageMetadataScalar = string | number | boolean | null;
export interface StageMetadata {
  [key: string]: StageMetadataValue;
}
export type StageMetadataValue = StageMetadataScalar | StageMetadata | StageMetadataValue[];

export type OutcomeStatus = "success" | "failure" | "wait_human";

export interface StageOutcome {
  status: OutcomeStatus;
  label: string | null;
  facts: StageMetadata;
  notes: string | null;
  artifacts: Record<string, string>;
}

export interface StageContextEntry {
  id: string;
  label: string;
  type: "agent" | "tool" | "fan_out" | "fan_in";
  status: "pending" | "running" | "success" | "failure" | "cancelled" | "wait_human";
  artifacts: Record<string, string>;
  metadata: StageMetadata;
  backend: string | null;
  command: string | null;
  promptPath: string | null;
  outputPath: string | null;
  exitCode: number | null;
  durationMs: number | null;
  updatedAt: string;
}

export interface IssueContext {
  issue: {
    id: string;
    identifier: string;
    title: string;
    description: string;
    state: string;
    labels: string[];
    url: string;
  };
  attempt: number;
  workspacePath: string;
  workspaceArtifactsDir: string;
  // Visit history for the current run/resume chain. Nodes can appear multiple times.
  completedNodes: string[];
  // Latest stage entry per node id. Full per-visit history lives in completedNodes + run logs.
  stages: Record<string, StageContextEntry>;
  updatedAt: string;
}

export interface ThreadNativeSession {
  sessionId: string;
  backend: string;
  model: string;
  createdAt: string;
}

export interface Collection {
  id: string;
  stageId: string;
  candidates: Candidate[];
  selectedCandidateId?: string;
  synthesizedArtifact?: string;
}

export interface Candidate {
  id: string;
  variantConfig: FanOutVariantConfig;
  status: "success" | "failure";
  artifacts: Record<string, string>;
  facts: Record<string, string | number | boolean | null>;
}

export interface GitHubReviewBundleFinding {
  author: string;
  body: string;
  path?: string;
  line?: number;
}

export interface GitHubReviewBundle {
  prNumber: number;
  prUrl: string;
  decision: "revise" | "lgtm";
  summary: string;
  unresolvedFindings: GitHubReviewBundleFinding[];
}

export interface AgentResult {
  output: string;
  exitCode: number;
  durationMs: number;
  sessionId?: string;
  invalidateSession?: boolean;
}

export interface AgentBackend {
  readonly name: string;
  readonly supportsNativeSessions?: boolean;
  isAvailable(): Promise<boolean>;
  execute(opts: {
    workspace: string;
    prompt: string;
    model?: string;
    reasoningEffort?: string;
    createSession?: boolean;
    sessionId?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<AgentResult>;
}

export interface PipelineCheckpoint {
  issueId: string;
  issueIdentifier: string;
  attempt: number;
  workspacePath: string;
  graphId: string;
  startedAt: string;
  finishedAt: string | null;
  completedNodes: string[];
  nextNodeId: string | null;
  status: "running" | "success" | "failure" | "cancelled" | "wait_human";
  error: string | null;
}

export interface PipelineRunMetadata {
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  issueUrl: string | null;
  attempt: number;
  workflowName: string;
  graphId: string;
  dotFile: string;
  workspacePath: string;
  artifactsPath: string;
  dispatchPlan: DispatchPlan | null;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "success" | "failure" | "cancelled" | "wait_human";
  error: string | null;
  prUrl: string | null;
}

export interface PipelineRunResult {
  status: "success" | "failure" | "cancelled" | "wait_human";
  completedNodes: string[];
  checkpointPath: string;
  error?: string;
  /** Non-transient failure classification (auth or rate-limit). */
  failureClass?: "auth" | "rate-limit";
  context?: IssueContext;
  failedStageId?: string;
  pr?: PullRequestMetadata | null;
  prUrl?: string | null;
}

export interface PipelineRunHandle {
  promise: Promise<PipelineRunResult>;
  cancel(reason?: string): Promise<void>;
}

export interface RetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  error?: string;
  dispatchPlan?: DispatchPlan;
}

export const RUN_STOP_REASONS = {
  missingFromTracker: "issue missing from tracker",
  unassigned: "issue is no longer assigned to vajra",
  terminal: "issue reached terminal state",
  inactive: "issue is no longer active",
  shutdown: "orchestrator shutdown",
} as const;

export type RunningStopReason = typeof RUN_STOP_REASONS[keyof typeof RUN_STOP_REASONS];

export interface RunningEntry {
  issue: Issue;
  attempt: number;
  workspacePath: string;
  dispatchPlan?: DispatchPlan;
  handle: PipelineRunHandle;
  stopReason?: RunningStopReason;
  cancelPromise?: Promise<void>;
}

export interface OrchestratorState {
  running: Map<string, RunningEntry>;
  claimed: ReadonlySet<string>;
  retryAttempts: Map<string, RetryEntry>;
  completed: Map<string, string>;
  failed: Map<string, string>;
  clarificationRequested: Map<string, string>;
}

export interface TrackerClient {
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]>;
  fetchTerminalIssues(): Promise<Issue[]>;
  fetchIssueByIdentifier?(identifier: string): Promise<Issue | null>;
  transitionIssue(issueId: string, stateName: string): Promise<void>;
  addIssueLabel?(issueId: string, labelName: string): Promise<void>;
  removeIssueLabel?(issueId: string, labelName: string): Promise<void>;
  commentOnIssue?(issueId: string, body: string): Promise<void>;
}

export interface WorkflowStore {
  current(): WorkflowDefinition;
}

export interface MutableWorkflowStore extends WorkflowStore {
  load(): Promise<WorkflowDefinition>;
  reloadStatus?(): { lastReloadError: string | null };
}

export interface PipelineRunner {
  startRun(opts: {
    issue: Issue;
    attempt: number;
    workflow: WorkflowDefinition;
    workspacePath: string;
    dispatchPlan?: DispatchPlan;
  }): PipelineRunHandle;
}

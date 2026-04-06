import { IssueArtifactStore } from "./artifacts";
import { PipelineRunStore } from "./pipeline-run-store";
import { ResolvedAgentExecution } from "./stage-executor";
import { Issue, IssueContext, PipelineRunMetadata, PipelineRunResult } from "./types";

export type StageLoopState = {
  context: IssueContext;
  completedNodes: string[];
  agentInvocations: number;
};

export type StageIterationResult =
  | {
      kind: "continue";
      nextNodeId: string;
      state: StageLoopState;
    }
  | {
      kind: "finished";
      result: PipelineRunResult;
    };

export type ResolvedStageAgent = ResolvedAgentExecution & {
  agentName: string;
  promptTemplate: string;
};

export type PipelineRunMetadataBase = Omit<PipelineRunMetadata, "finishedAt" | "status" | "error">;

export type FinishStageIterationOptions = {
  artifactStore: IssueArtifactStore;
  context: IssueContext;
  runStore: PipelineRunStore;
  runMetadataBase: PipelineRunMetadataBase;
  status: PipelineRunResult["status"];
  issue: Issue;
  attempt: number;
  graphId: string;
  workspacePath: string;
  completedNodes: string[];
  nextNodeId: string | null;
  error: string | null;
  failureClass?: "auth" | "rate-limit";
  failedStageId?: string;
  finishedAt?: string;
};

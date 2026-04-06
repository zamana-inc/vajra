import type {
  VajraAgentDefinition,
  VajraAgentsResponse,
  VajraBackendDefinition,
  VajraBackendsResponse,
  VajraConfigSnapshot,
  VajraRunDetail,
  VajraRunStageDetail,
  VajraRunsResponse,
  VajraSkillsResponse,
  VajraWorkflowDefinition,
  VajraWorkflowsResponse,
} from "./types";
import { requestVajraJson } from "./request";

export function getVajraState<T>() {
  return requestVajraJson<T>("state");
}

export function listVajraRuns(params?: { status?: string; since?: string; limit?: number }) {
  return requestVajraJson<VajraRunsResponse>("runs", { params });
}

export function getVajraRun(issueIdentifier: string, attempt: number) {
  return requestVajraJson<VajraRunDetail>(`runs/${encodeURIComponent(issueIdentifier)}/${attempt}`);
}

export function getVajraStage(issueIdentifier: string, attempt: number, stageId: string) {
  return requestVajraJson<VajraRunStageDetail>(
    `runs/${encodeURIComponent(issueIdentifier)}/${attempt}/stages/${encodeURIComponent(stageId)}`,
  );
}

export function getVajraConfig() {
  return requestVajraJson<VajraConfigSnapshot>("config");
}

export function updateVajraConfig(body: unknown) {
  return requestVajraJson<VajraConfigSnapshot>("config", {
    method: "PUT",
    body,
  });
}

export function getVajraRawConfig() {
  return requestVajraJson<{ content: string }>("config/raw");
}

export function listVajraAgents() {
  return requestVajraJson<VajraAgentsResponse>("config/agents");
}

export function saveVajraAgent(name: string, body: Partial<VajraAgentDefinition>) {
  return requestVajraJson<VajraAgentsResponse>(`config/agents/${encodeURIComponent(name)}`, {
    method: "PUT",
    body,
  });
}

export function deleteVajraAgent(name: string) {
  return requestVajraJson<VajraAgentsResponse>(`config/agents/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

export function listVajraBackends() {
  return requestVajraJson<VajraBackendsResponse>("config/backends");
}

export function saveVajraBackend(name: string, body: Partial<VajraBackendDefinition>) {
  return requestVajraJson<VajraBackendsResponse>(`config/backends/${encodeURIComponent(name)}`, {
    method: "PUT",
    body,
  });
}

export function listVajraWorkflows() {
  return requestVajraJson<VajraWorkflowsResponse>("config/workflows");
}

export function getVajraWorkflow(name: string) {
  return requestVajraJson<VajraWorkflowDefinition>(`config/workflows/${encodeURIComponent(name)}`);
}

export function saveVajraWorkflow(name: string, body: Partial<{
  rawDot: string;
  successState: string;
  inspectPr: boolean;
  labels: string[];
  isDefault: boolean;
}>) {
  return requestVajraJson<VajraWorkflowDefinition>(`config/workflows/${encodeURIComponent(name)}`, {
    method: "PUT",
    body,
  });
}

export function previewVajraWorkflow(body: Partial<{
  name: string;
  rawDot: string;
  successState: string;
  inspectPr: boolean;
  labels: string[];
  isDefault: boolean;
}>) {
  return requestVajraJson<VajraWorkflowDefinition>("config/workflows/preview", {
    method: "POST",
    body,
  });
}

export function deleteVajraWorkflow(name: string) {
  return requestVajraJson<VajraWorkflowsResponse>(`config/workflows/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

export function listVajraSkills() {
  return requestVajraJson<VajraSkillsResponse>("config/skills");
}

export function saveVajraSkill(name: string, content: string) {
  return requestVajraJson<{ name: string; path: string; content: string }>(
    `config/skills/${encodeURIComponent(name)}`,
    {
      method: "PUT",
      body: { content },
    },
  );
}

export function deleteVajraSkill(name: string) {
  return requestVajraJson<VajraSkillsResponse>(`config/skills/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

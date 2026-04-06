import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";

import { IssueArtifactStore } from "../src/artifacts";
import { Issue } from "../src/types";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "1",
    identifier: "ENG-42",
    title: "Issue",
    description: null,
    state: "Todo",
    priority: 1,
    labels: [],
    assigneeId: "vajra-uuid",
    creatorId: null,
    createdAt: "2026-03-10T00:00:00.000Z",
    updatedAt: null,
    url: null,
    blockedBy: [],
    ...overrides,
  };
}

test("IssueArtifactStore keeps shared artifacts while clearing per-run scratch", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-artifacts-"));
  const config = {
    root: path.join(tempDir, "plans"),
    workspaceDir: ".vajra",
  };
  const workspacePath = path.join(tempDir, "workspace");
  const store = new IssueArtifactStore(config, makeIssue(), workspacePath);

  await mkdir(store.durableDirPath(), { recursive: true });
  await mkdir(store.durableRunDirPath(), { recursive: true });
  await writeFile(path.join(store.durableDirPath(), "plan.md"), "shared plan", "utf8");
  await writeFile(path.join(store.durableRunDirPath(), "revision-summary.md"), "stale run summary", "utf8");

  await store.hydrateWorkspace();

  assert.equal(
    await readFile(path.join(store.workspaceDirPath(), "plan.md"), "utf8"),
    "shared plan",
  );
  assert.equal(
    await readFile(path.join(store.runWorkspaceDirPath(), "revision-summary.md"), "utf8"),
    "stale run summary",
  );

  await store.resetRunArtifacts();

  assert.equal(
    await readFile(path.join(store.workspaceDirPath(), "plan.md"), "utf8"),
    "shared plan",
  );
  await assert.rejects(stat(path.join(store.runWorkspaceDirPath(), "revision-summary.md")));
  await assert.rejects(stat(path.join(store.durableRunDirPath(), "revision-summary.md")));

  const context = await store.loadContext(3);
  assert.equal(context.workspaceArtifactsDir, ".vajra/run");

  await rm(tempDir, { recursive: true, force: true });
});

test("IssueArtifactStore.saveContext durably writes context without copying the full workspace snapshot", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-artifacts-context-"));
  const config = {
    root: path.join(tempDir, "plans"),
    workspaceDir: ".vajra",
  };
  const workspacePath = path.join(tempDir, "workspace");
  const store = new IssueArtifactStore(config, makeIssue({ identifier: "ENG-77" }), workspacePath);

  await mkdir(store.runWorkspaceDirPath(), { recursive: true });
  await writeFile(path.join(store.workspaceDirPath(), "plan.md"), "workspace-only plan", "utf8");

  await store.saveContext({
    issue: {
      id: "1",
      identifier: "ENG-77",
      title: "Issue",
      description: "",
      state: "Todo",
      labels: [],
      url: "",
    },
    attempt: 2,
    workspacePath,
    workspaceArtifactsDir: ".vajra/run",
    completedNodes: ["plan"],
    stages: {},
    updatedAt: "2026-03-30T00:00:00.000Z",
  });

  const durableContext = JSON.parse(await readFile(store.durableContextPath(), "utf8")) as {
    attempt: number;
    completedNodes: string[];
  };
  assert.equal(durableContext.attempt, 2);
  assert.deepEqual(durableContext.completedNodes, ["plan"]);
  await assert.rejects(stat(path.join(store.durableDirPath(), "plan.md")));

  await store.persistWorkspaceArtifacts();

  assert.equal(
    await readFile(path.join(store.durableDirPath(), "plan.md"), "utf8"),
    "workspace-only plan",
  );
});

test("IssueArtifactStore restores a backup durable snapshot before hydrating the workspace", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-artifacts-backup-"));
  const config = {
    root: path.join(tempDir, "plans"),
    workspaceDir: ".vajra",
  };
  const workspacePath = path.join(tempDir, "workspace");
  const store = new IssueArtifactStore(config, makeIssue({ identifier: "ENG-88" }), workspacePath);

  await mkdir(store.durableBackupDirPath(), { recursive: true });
  await writeFile(path.join(store.durableBackupDirPath(), "plan.md"), "recovered plan", "utf8");

  await store.hydrateWorkspace();

  assert.equal(
    await readFile(path.join(store.workspaceDirPath(), "plan.md"), "utf8"),
    "recovered plan",
  );
  assert.equal(
    await readFile(path.join(store.durableDirPath(), "plan.md"), "utf8"),
    "recovered plan",
  );
  await assert.rejects(stat(store.durableBackupDirPath()));
});

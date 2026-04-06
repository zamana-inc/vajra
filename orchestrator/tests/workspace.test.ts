import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";

import { WorkspaceManager, safeIdentifier } from "../src/workspace";

test("safeIdentifier replaces unsafe path characters", () => {
  assert.equal(safeIdentifier("ENG-42/hello world"), "ENG-42_hello_world");
});

test("validateWorkspacePath rejects symlink components", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-workspace-"));
  const root = path.join(tempDir, "root");
  const outside = path.join(tempDir, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, path.join(root, "linked"));

  const manager = new WorkspaceManager(
    { root },
    { timeoutMs: 1_000 },
  );

  await assert.rejects(
    manager.validateWorkspacePath(path.join(root, "linked", "nested")),
    /symlink/,
  );
});

test("validateWorkspacePath rejects traversal outside the workspace root", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-workspace-traversal-"));
  const root = path.join(tempDir, "root");
  await mkdir(root, { recursive: true });

  const manager = new WorkspaceManager(
    { root },
    { timeoutMs: 1_000 },
  );

  await assert.rejects(
    manager.validateWorkspacePath(path.join(root, "..", "escape")),
    /escapes root/,
  );
});

test("validateWorkspacePath rejects workspace path equal to root", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-workspace-root-"));
  const root = path.join(tempDir, "root");
  await mkdir(root, { recursive: true });

  const manager = new WorkspaceManager(
    { root },
    { timeoutMs: 1_000 },
  );

  await assert.rejects(
    manager.validateWorkspacePath(root),
    /must not equal workspace root/,
  );
});

test("runBeforeRunHook syncs managed skills into the workspace and excludes them from git", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-workspace-skills-"));
  const root = path.join(tempDir, "root");
  const skillsRoot = path.join(tempDir, "skills");
  const workspacePath = path.join(root, "ENG-42");
  await mkdir(path.join(skillsRoot, "vajra-plan"), { recursive: true });
  await mkdir(path.join(skillsRoot, "vajra-prepare-pr"), { recursive: true });
  await writeFile(path.join(skillsRoot, "vajra-plan", "SKILL.md"), "---\nname: vajra-plan\ndescription: plan\n---\n", "utf8");
  await writeFile(path.join(skillsRoot, "vajra-prepare-pr", "SKILL.md"), "---\nname: vajra-prepare-pr\ndescription: pr\n---\n", "utf8");

  await mkdir(path.join(workspacePath, ".git", "info"), { recursive: true });
  await mkdir(path.join(workspacePath, ".codex", "skills", "custom-skill"), { recursive: true });
  await writeFile(path.join(workspacePath, ".codex", "skills", "custom-skill", "SKILL.md"), "custom", "utf8");

  const manager = new WorkspaceManager(
    { root },
    { timeoutMs: 1_000 },
    undefined,
    undefined,
    skillsRoot,
  );

  await manager.runBeforeRunHook(workspacePath);

  assert.equal(
    await readFile(path.join(workspacePath, ".codex", "skills", "vajra-plan", "SKILL.md"), "utf8"),
    "---\nname: vajra-plan\ndescription: plan\n---\n",
  );
  assert.equal(
    await readFile(path.join(workspacePath, ".claude", "skills", "vajra-prepare-pr", "SKILL.md"), "utf8"),
    "---\nname: vajra-prepare-pr\ndescription: pr\n---\n",
  );
  assert.equal(
    await readFile(path.join(workspacePath, ".codex", "skills", "custom-skill", "SKILL.md"), "utf8"),
    "custom",
  );

  const exclude = await readFile(path.join(workspacePath, ".git", "info", "exclude"), "utf8");
  assert.match(exclude, /# BEGIN Vajra managed skills/);
  assert.match(exclude, /\/\.codex\/skills\/vajra-\*\//);
  assert.match(exclude, /\/\.claude\/skills\/vajra-\*\//);
});

test("runBeforeRunHook refreshes managed skills without duplicating exclude entries", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-workspace-refresh-"));
  const root = path.join(tempDir, "root");
  const skillsRoot = path.join(tempDir, "skills");
  const workspacePath = path.join(root, "ENG-84");
  await mkdir(path.join(skillsRoot, "vajra-plan"), { recursive: true });
  await mkdir(path.join(skillsRoot, "vajra-fix"), { recursive: true });
  await writeFile(path.join(skillsRoot, "vajra-plan", "SKILL.md"), "version-one", "utf8");
  await writeFile(path.join(skillsRoot, "vajra-fix", "SKILL.md"), "fix-skill", "utf8");

  await mkdir(path.join(workspacePath, ".git", "info"), { recursive: true });
  await mkdir(path.join(workspacePath, ".codex", "skills", "vajra-stale"), { recursive: true });
  await writeFile(path.join(workspacePath, ".codex", "skills", "vajra-stale", "SKILL.md"), "stale", "utf8");

  const manager = new WorkspaceManager(
    { root },
    { timeoutMs: 1_000 },
    undefined,
    undefined,
    skillsRoot,
  );

  await manager.runBeforeRunHook(workspacePath);
  await writeFile(path.join(skillsRoot, "vajra-plan", "SKILL.md"), "version-two", "utf8");
  await manager.runBeforeRunHook(workspacePath);

  assert.equal(
    await readFile(path.join(workspacePath, ".codex", "skills", "vajra-plan", "SKILL.md"), "utf8"),
    "version-two",
  );
  assert.equal(
    await readFile(path.join(workspacePath, ".claude", "skills", "vajra-fix", "SKILL.md"), "utf8"),
    "fix-skill",
  );

  const codexSkillDirs = await readdir(path.join(workspacePath, ".codex", "skills"));
  assert.ok(!codexSkillDirs.includes("vajra-stale"));

  const exclude = await readFile(path.join(workspacePath, ".git", "info", "exclude"), "utf8");
  assert.equal((exclude.match(/# BEGIN Vajra managed skills/g) ?? []).length, 1);
  assert.equal((exclude.match(/# END Vajra managed skills/g) ?? []).length, 1);
});

test("runBeforeRunHook skips rewriting managed skills when sources have not changed", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-workspace-skill-cache-"));
  const root = path.join(tempDir, "root");
  const skillsRoot = path.join(tempDir, "skills");
  const workspacePath = path.join(root, "ENG-99");
  await mkdir(path.join(skillsRoot, "vajra-plan"), { recursive: true });
  await writeFile(path.join(skillsRoot, "vajra-plan", "SKILL.md"), "stable-skill", "utf8");
  await mkdir(path.join(workspacePath, ".git", "info"), { recursive: true });

  const manager = new WorkspaceManager(
    { root },
    { timeoutMs: 1_000 },
    undefined,
    undefined,
    skillsRoot,
  );

  await manager.runBeforeRunHook(workspacePath);
  const skillPath = path.join(workspacePath, ".codex", "skills", "vajra-plan", "SKILL.md");
  const firstStat = await stat(skillPath);

  await new Promise((resolve) => setTimeout(resolve, 25));
  await manager.runBeforeRunHook(workspacePath);
  const secondStat = await stat(skillPath);

  assert.equal(secondStat.mtimeMs, firstStat.mtimeMs);
});

test("workspace hooks receive triage-derived environment variables", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-workspace-hook-env-"));
  const root = path.join(tempDir, "root");
  const calls: Array<{ command: string; env?: Record<string, string> }> = [];

  const manager = new WorkspaceManager(
    { root },
    {
      afterCreate: "echo after-create",
      beforeRun: "echo before-run",
      timeoutMs: 1_000,
    },
    {
      async run(command, opts) {
        calls.push({
          command,
          env: opts.env,
        });
        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        };
      },
    },
  );

  const hookEnv = {
    VAJRA_BASE_BRANCH: "dev",
    VAJRA_TARGET_BRANCH: "dev",
    VAJRA_MERGE_STRATEGY: "auto-merge",
  };
  const workspace = await manager.prepareWorkspace("ENG-77", hookEnv);
  await manager.runBeforeRunHook(workspace.path, hookEnv);

  assert.deepEqual(calls, [
    { command: "echo after-create", env: hookEnv },
    { command: "echo before-run", env: hookEnv },
  ]);
});

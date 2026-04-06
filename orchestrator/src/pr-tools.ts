import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { GitHubClient } from "./github";
import { CommandResult, CommandRunner } from "./process";
import { GitHubConfig, PullRequestMetadata, StageMetadata } from "./types";

type BuiltInPrCommand = "publish-pr" | "update-pr";

export interface BuiltInToolExecutionResult extends CommandResult {
  resultMetadata?: StageMetadata;
}

function tokenizeCommand(command: string): string[] {
  const matches = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map((token) => {
    if ((token.startsWith("\"") && token.endsWith("\"")) || (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1);
    }
    return token;
  });
}

function parseArgs(command: string): { subcommand: BuiltInPrCommand; args: Map<string, string | true> } | null {
  const tokens = tokenizeCommand(command);
  if (tokens[0] !== "vajra" || (tokens[1] !== "publish-pr" && tokens[1] !== "update-pr")) {
    return null;
  }

  const args = new Map<string, string | true>();
  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const name = token.slice(2);
    const next = tokens[index + 1];
    if (!next || next.startsWith("--")) {
      args.set(name, true);
      continue;
    }

    args.set(name, next);
    index += 1;
  }

  return {
    subcommand: tokens[1],
    args,
  };
}

function resolveFilePath(cwd: string, value: string | true | undefined): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  return path.isAbsolute(value) ? value : path.join(cwd, value);
}

async function readOptionalText(filePath: string | null): Promise<string | null> {
  if (!filePath) {
    return null;
  }

  try {
    const content = await readFile(filePath, "utf8");
    const trimmed = content.trim();
    return trimmed || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function inferTitleFromBody(body: string | null): string {
  const firstLine = String(body ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  if (!firstLine) {
    throw new Error("PR title is required; provide --title-file or a body with a non-empty first line");
  }
  return firstLine;
}

function findExistingPrByBranch(pullRequests: Array<{ number: number; headRefName: string | null }>, branch: string): number | null {
  const match = pullRequests.find((pullRequest) => String(pullRequest.headRefName ?? "").trim() === branch);
  return match?.number ?? null;
}

async function currentBranch(commandRunner: CommandRunner, cwd: string, signal?: AbortSignal): Promise<string> {
  const result = await commandRunner.run("git branch --show-current", {
    cwd,
    timeoutMs: 10_000,
    signal,
  });
  const branch = result.stdout.trim();
  if (!branch || branch === "HEAD") {
    throw new Error("workspace is not on a named git branch");
  }
  return branch;
}

function resultMetadata(opts: {
  pr: PullRequestMetadata;
  action: "created" | "reused" | "updated";
}): StageMetadata {
  return {
    pr: {
      url: opts.pr.url,
      title: opts.pr.title ?? null,
      number: opts.pr.number ?? null,
      headRefName: opts.pr.headRefName ?? null,
      state: opts.pr.state ?? null,
    },
    facts: {
      pr_number: opts.pr.number ?? null,
      pr_url: opts.pr.url,
      pr_action: opts.action,
    },
  };
}

async function persistWorkspacePr(workspacePath: string, pr: PullRequestMetadata): Promise<void> {
  const filePath = path.join(workspacePath, ".vajra", "pr.json");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(pr, null, 2), "utf8");
}

async function readStoredPrNumber(workspacePath: string): Promise<number | null> {
  try {
    const payload = JSON.parse(await readFile(path.join(workspacePath, ".vajra", "pr.json"), "utf8")) as Record<string, unknown>;
    return typeof payload.number === "number"
      ? payload.number
      : Number.isFinite(Number(payload.number))
        ? Number(payload.number)
        : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function publishPr(opts: {
  githubConfig: GitHubConfig;
  commandRunner: CommandRunner;
  cwd: string;
  args: Map<string, string | true>;
  signal?: AbortSignal;
}): Promise<BuiltInToolExecutionResult> {
  const github = new GitHubClient(opts.githubConfig);
  const branch = await currentBranch(opts.commandRunner, opts.cwd, opts.signal);
  const title = await readOptionalText(resolveFilePath(opts.cwd, opts.args.get("title-file"))) ?? inferTitleFromBody(
    await readOptionalText(resolveFilePath(opts.cwd, opts.args.get("body-file"))),
  );
  const body = await readOptionalText(resolveFilePath(opts.cwd, opts.args.get("body-file"))) ?? "";
  const base = typeof opts.args.get("base") === "string" && String(opts.args.get("base")).trim()
    ? String(opts.args.get("base")).trim()
    : "main";

  const existingPrNumber = findExistingPrByBranch(
    await github.listOpenPullRequests(opts.githubConfig.repository),
    branch,
  );
  const pr = existingPrNumber
    ? await github.updatePullRequest(opts.githubConfig.repository, existingPrNumber, { title, body })
    : await github.createPullRequest(opts.githubConfig.repository, { title, body, head: branch, base });
  const action = existingPrNumber ? "reused" : "created";

  await persistWorkspacePr(opts.cwd, pr);

  return {
    stdout: `${action === "created" ? "Created" : "Reused"} PR ${pr.url}`,
    stderr: "",
    exitCode: 0,
    durationMs: 1,
    resultMetadata: resultMetadata({ pr, action }),
  };
}

async function updatePr(opts: {
  githubConfig: GitHubConfig;
  commandRunner: CommandRunner;
  cwd: string;
  args: Map<string, string | true>;
  signal?: AbortSignal;
}): Promise<BuiltInToolExecutionResult> {
  const github = new GitHubClient(opts.githubConfig);
  const branch = await currentBranch(opts.commandRunner, opts.cwd, opts.signal);
  const title = await readOptionalText(resolveFilePath(opts.cwd, opts.args.get("title-file")));
  const body = await readOptionalText(resolveFilePath(opts.cwd, opts.args.get("body-file")));
  const openPullRequests = await github.listOpenPullRequests(opts.githubConfig.repository);
  const existingPrNumber = await readStoredPrNumber(opts.cwd) ?? findExistingPrByBranch(openPullRequests, branch);
  if (!existingPrNumber) {
    throw new Error(`no open pull request found for branch ${branch}`);
  }

  const pr = await github.updatePullRequest(opts.githubConfig.repository, existingPrNumber, {
    ...(title ? { title } : {}),
    ...(body !== null ? { body } : {}),
  });
  await persistWorkspacePr(opts.cwd, pr);

  return {
    stdout: `Updated PR ${pr.url}`,
    stderr: "",
    exitCode: 0,
    durationMs: 1,
    resultMetadata: resultMetadata({ pr, action: "updated" }),
  };
}

export async function executeBuiltInVajraTool(opts: {
  command: string;
  githubConfig: GitHubConfig | null;
  commandRunner: CommandRunner;
  cwd: string;
  signal?: AbortSignal;
}): Promise<BuiltInToolExecutionResult | null> {
  const parsed = parseArgs(opts.command);
  if (!parsed) {
    return null;
  }

  if (!opts.githubConfig) {
    throw new Error(`built-in tool ${parsed.subcommand} requires github integration`);
  }

  if (parsed.subcommand === "publish-pr") {
    return publishPr({
      githubConfig: opts.githubConfig,
      commandRunner: opts.commandRunner,
      cwd: opts.cwd,
      args: parsed.args,
      signal: opts.signal,
    });
  }

  return updatePr({
    githubConfig: opts.githubConfig,
    commandRunner: opts.commandRunner,
    cwd: opts.cwd,
    args: parsed.args,
    signal: opts.signal,
  });
}

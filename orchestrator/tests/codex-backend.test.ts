import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { CodexBackend } from "../src/codex-backend";
import { CommandResult, CommandRunner } from "../src/process";

class RecordingCommandRunner implements CommandRunner {
  readonly commands: string[] = [];

  constructor(private readonly resultFactory: (command: string) => Promise<CommandResult> | CommandResult) {}

  async run(command: string, opts: {
    cwd: string;
    timeoutMs?: number;
    killGraceMs?: number;
    env?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<CommandResult> {
    this.commands.push(command);
    return this.resultFactory(command);
  }
}

function outputPathFromCommand(command: string): string | null {
  const match = command.match(/(?:^|\s)-o\s+'([^']+)'/);
  return match?.[1] ?? null;
}

test("CodexBackend starts a native session and captures the thread id", async () => {
  const runner = new RecordingCommandRunner(async (command) => {
    const outputPath = outputPathFromCommand(command);
    assert.ok(outputPath);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, "OK\n", "utf8");

    return {
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "item.completed",
          item: { id: "item_0", type: "agent_message", text: "OK" },
        }),
      ].join("\n"),
      stderr: "",
      exitCode: 0,
      durationMs: 15,
    };
  });

  const backend = new CodexBackend("codex", {
    command: "codex exec --dangerously-bypass-approvals-and-sandbox --model {{ model }} -c reasoning_effort={{ reasoning_effort }} {{ prompt | shellquote }}",
  }, runner);

  const result = await backend.execute({
    workspace: "/tmp",
    prompt: "Reply with OK",
    model: "gpt-5.4",
    reasoningEffort: "high",
    createSession: true,
  });

  assert.equal(result.output, "OK");
  assert.equal(result.sessionId, "thread-123");
  assert.equal(result.invalidateSession, undefined);
  assert.match(runner.commands[0], /\bcodex exec --json\b/);
  assert.match(runner.commands[0], /(?:^|\s)-o\s/);
});

test("CodexBackend resumes a native session and preserves the thread id", async () => {
  const runner = new RecordingCommandRunner(async (command) => {
    const outputPath = outputPathFromCommand(command);
    assert.ok(outputPath);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, "77", "utf8");

    return {
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "thread-77" }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "item.completed",
          item: { id: "item_0", type: "agent_message", text: "77" },
        }),
      ].join("\n"),
      stderr: "",
      exitCode: 0,
      durationMs: 10,
    };
  });

  const backend = new CodexBackend("codex", {
    command: "codex exec --dangerously-bypass-approvals-and-sandbox --model {{ model }} -c reasoning_effort={{ reasoning_effort }} {{ prompt | shellquote }}",
  }, runner);

  const result = await backend.execute({
    workspace: "/tmp",
    prompt: "What number?",
    model: "gpt-5.4",
    reasoningEffort: "high",
    sessionId: "thread-77",
  });

  assert.equal(result.output, "77");
  assert.equal(result.sessionId, "thread-77");
  assert.equal(result.invalidateSession, undefined);
  assert.match(runner.commands[0], /\bcodex exec resume --json\b/);
  assert.match(runner.commands[0], /'thread-77'/);
});

test("CodexBackend treats a resumed command that returns a different thread id as invalid", async () => {
  const runner = new RecordingCommandRunner(async (command) => {
    const outputPath = outputPathFromCommand(command);
    assert.ok(outputPath);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, "fresh answer", "utf8");

    return {
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "thread-new" }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "item.completed",
          item: { id: "item_0", type: "agent_message", text: "fresh answer" },
        }),
      ].join("\n"),
      stderr: "",
      exitCode: 0,
      durationMs: 9,
    };
  });

  const backend = new CodexBackend("codex", {
    command: "codex exec --dangerously-bypass-approvals-and-sandbox --model {{ model }} -c reasoning_effort={{ reasoning_effort }} {{ prompt | shellquote }}",
  }, runner);

  const result = await backend.execute({
    workspace: "/tmp",
    prompt: "Resume prior work",
    model: "gpt-5.4",
    reasoningEffort: "high",
    sessionId: "thread-old",
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.invalidateSession, true);
  assert.equal(result.sessionId, "thread-new");
  assert.match(result.output, /returned a different thread id/i);
});

import test from "node:test";
import assert from "node:assert/strict";

import { ClaudeBackend } from "../src/claude-backend";
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

test("ClaudeBackend starts a native session and parses the JSON result", async () => {
  const runner = new RecordingCommandRunner(async () => ({
    stdout: JSON.stringify({
      type: "result",
      subtype: "success",
      result: "OK",
      session_id: "session-abc",
    }),
    stderr: "",
    exitCode: 0,
    durationMs: 12,
  }));

  const backend = new ClaudeBackend("claude", {
    command: "claude --output-format json --dangerously-skip-permissions --model {{ model }} -p {{ prompt | shellquote }}",
  }, runner);

  const result = await backend.execute({
    workspace: "/tmp",
    prompt: "Say OK",
    model: "claude-sonnet-4-6",
    createSession: true,
  });

  assert.equal(result.output, "OK");
  assert.equal(result.sessionId, "session-abc");
  assert.equal(result.invalidateSession, undefined);
  assert.match(runner.commands[0], /\bclaude\b/);
  assert.match(runner.commands[0], /--session-id/);
  assert.match(runner.commands[0], /claude-sonnet-4-6/);
});

test("ClaudeBackend resumes a native session", async () => {
  const runner = new RecordingCommandRunner(async () => ({
    stdout: JSON.stringify({
      type: "result",
      subtype: "success",
      result: "77",
      session_id: "session-77",
    }),
    stderr: "",
    exitCode: 0,
    durationMs: 8,
  }));

  const backend = new ClaudeBackend("claude", {
    command: "claude --output-format json --dangerously-skip-permissions --model {{ model }} -p {{ prompt | shellquote }}",
  }, runner);

  const result = await backend.execute({
    workspace: "/tmp",
    prompt: "What number?",
    model: "claude-sonnet-4-6",
    sessionId: "session-77",
  });

  assert.equal(result.output, "77");
  assert.equal(result.sessionId, "session-77");
  assert.match(runner.commands[0], /--resume/);
  assert.match(runner.commands[0], /session-77/);
});

test("ClaudeBackend marks missing sessions for invalidation", async () => {
  const runner = new RecordingCommandRunner(async () => ({
    stdout: "",
    stderr: "No conversation found with session ID: session-missing",
    exitCode: 1,
    durationMs: 3,
  }));

  const backend = new ClaudeBackend("claude", {
    command: "claude --output-format json --dangerously-skip-permissions --model {{ model }} -p {{ prompt | shellquote }}",
  }, runner);

  const result = await backend.execute({
    workspace: "/tmp",
    prompt: "Try again",
    model: "claude-sonnet-4-6",
    sessionId: "session-missing",
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.invalidateSession, true);
  assert.match(result.output, /No conversation found with session ID/);
});

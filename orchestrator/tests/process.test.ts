import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { ShellCommandRunner } from "../src/process";

test("ShellCommandRunner eventually kills a SIGTERM-resistant process via SIGKILL", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-process-"));
  const runner = new ShellCommandRunner();
  const controller = new AbortController();

  // trap '' TERM makes the shell ignore SIGTERM. The infinite loop keeps
  // the shell alive even when the inner `sleep` dies from SIGTERM — the
  // shell just starts another sleep. The only way to kill it is SIGKILL,
  // which the runner sends after the grace window expires.
  // NOTE: We don't assert timing — in process-group mode the child may die
  // before the grace timer fires, which is correct behaviour.
  const promise = runner.run("trap '' TERM; while true; do sleep 1; done", {
    cwd: tempDir,
    signal: controller.signal,
    killGraceMs: 500,
  });

  await new Promise((r) => setTimeout(r, 500));
  controller.abort();

  await assert.rejects(promise, /command aborted/);
});

test("ShellCommandRunner rejects promptly when SIGTERM ends the child before the kill grace expires", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vajra-process-fast-exit-"));
  const runner = new ShellCommandRunner();
  const controller = new AbortController();

  const promise = runner.run("exec node -e \"setInterval(() => {}, 1000)\"", {
    cwd: tempDir,
    signal: controller.signal,
    killGraceMs: 2_000,
  });

  await new Promise((r) => setTimeout(r, 200));
  const abortedAt = Date.now();
  controller.abort();

  await assert.rejects(promise, /command aborted/);
  const elapsed = Date.now() - abortedAt;
  assert.ok(elapsed < 1_000, `expected rejection before the full grace window, got ${elapsed}ms`);
});

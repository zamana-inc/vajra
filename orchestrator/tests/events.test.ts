import test from "node:test";
import assert from "node:assert/strict";

import { VajraEventBus } from "../src/events";
import { LogEventSubscriber } from "../src/subscribers/log";

test("VajraEventBus notifies type-specific and wildcard listeners", () => {
  const bus = new VajraEventBus();
  const specific: string[] = [];
  const wildcard: string[] = [];

  const specificListener = (event: { type: "orchestrator:tick"; running: number }) => {
    specific.push(`${event.type}:${event.running}`);
  };
  const wildcardListener = (event: { type: string }) => {
    wildcard.push(event.type);
  };

  bus.on("orchestrator:tick", specificListener);
  bus.onAny(wildcardListener);

  bus.emit({
    type: "orchestrator:tick",
    timestamp: "2026-03-11T00:00:00.000Z",
    running: 2,
    claimed: 1,
    retrying: 0,
    completed: 3,
  });

  assert.deepEqual(specific, ["orchestrator:tick:2"]);
  assert.deepEqual(wildcard, ["orchestrator:tick"]);
});

test("VajraEventBus off and offAny unsubscribe listeners", () => {
  const bus = new VajraEventBus();
  const specific: string[] = [];
  const wildcard: string[] = [];

  const specificListener = (event: { type: "orchestrator:shutdown" }) => {
    specific.push(event.type);
  };
  const wildcardListener = (event: { type: string }) => {
    wildcard.push(event.type);
  };

  bus.on("orchestrator:shutdown", specificListener);
  bus.onAny(wildcardListener);
  bus.off("orchestrator:shutdown", specificListener);
  bus.offAny(wildcardListener);

  bus.emit({
    type: "orchestrator:shutdown",
    timestamp: "2026-03-11T00:00:00.000Z",
  });

  assert.deepEqual(specific, []);
  assert.deepEqual(wildcard, []);
});

test("VajraEventBus assigns increasing event sequences without mutating the caller payload", () => {
  const bus = new VajraEventBus();
  const seenSequences: number[] = [];
  const payload = {
    type: "orchestrator:tick" as const,
    timestamp: "2026-03-11T00:00:00.000Z",
    running: 2,
    claimed: 1,
    retrying: 0,
    completed: 3,
  };

  bus.onAny((event) => {
    seenSequences.push((event as { _sequence?: number })._sequence ?? -1);
  });

  bus.emit(payload);
  bus.emit({
    ...payload,
    timestamp: "2026-03-11T00:00:01.000Z",
  });

  assert.deepEqual(seenSequences, [1, 2]);
  assert.equal("_sequence" in payload, false);
});

test("LogEventSubscriber writes event-shaped JSON log lines", () => {
  const bus = new VajraEventBus();
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => {
    lines.push(String(message ?? ""));
  };

  try {
    const subscriber = new LogEventSubscriber(bus);
    bus.emit({
      type: "issue:dispatched",
      timestamp: "2026-03-11T12:00:00.000Z",
      issueId: "1",
      issueIdentifier: "ENG-1",
      issueTitle: "Add events",
      issueUrl: "https://linear.app/acme/issue/ENG-1",
      issueCreatorId: "creator-1",
      state: "Todo",
      attempt: 0,
      workspacePath: "/tmp/workspaces/ENG-1",
      workflowName: "default",
      successState: "Done",
      baseBranch: "main",
      targetBranch: "main",
      mergeStrategy: "pr-only",
      labelsToAdd: [],
      triaged: false,
      triageReasoning: null,
      triageFallback: false,
    });
    subscriber.close();
  } finally {
    console.log = originalLog;
  }

  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(parsed.ts, "2026-03-11T12:00:00.000Z");
  assert.equal(parsed.message, "issue:dispatched");
  assert.equal(parsed.issueIdentifier, "ENG-1");
  assert.equal(parsed.state, "Todo");
  assert.equal(parsed.workspacePath, "/tmp/workspaces/ENG-1");
  assert.equal(parsed.workflowName, "default");
});

import test from "node:test";
import assert from "node:assert/strict";

import { classifyStageError } from "../src/error-classifier";

// -- Auth failures (terminal) ------------------------------------------------

test("classifyStageError detects Codex auth failure from JSON error events", () => {
  const output = `{"id":"0","msg":{"type":"error","message":"exceeded retry limit, last status: 401 Unauthorized"}}`;

  const result = classifyStageError({ output, backend: "codex" });
  assert.equal(result?.failureClass, "auth");
  assert.match(result?.detail ?? "", /Codex authentication failed/);
  assert.equal(result?.retryAfterHint, null);
});

test("classifyStageError detects Codex auth failure from plain exec output", () => {
  const output = `[2026-03-30T17:27:02] ERROR: exceeded retry limit, last status: 401 Unauthorized`;

  const result = classifyStageError({ output, backend: "codex" });
  assert.equal(result?.failureClass, "auth");
  assert.match(result?.detail ?? "", /401 Unauthorized/);
});

test("classifyStageError detects Codex not-signed-in guidance", () => {
  const output = `Not signed in. Please run 'codex login' to sign in with ChatGPT, then re-run 'codex cloud'.`;

  const result = classifyStageError({ output, backend: "codex" });
  assert.equal(result?.failureClass, "auth");
  assert.match(result?.detail ?? "", /not signed in/i);
});

test("classifyStageError detects Claude authentication_error envelopes", () => {
  const output = `{"type":"error","error":{"type":"authentication_error","message":"OAuth authentication is currently not supported."}}`;

  const result = classifyStageError({ output, backend: "claude" });
  assert.equal(result?.failureClass, "auth");
  assert.match(result?.detail ?? "", /OAuth/);
});

test("classifyStageError detects Claude not-logged-in result envelopes", () => {
  const output = `{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}`;

  const result = classifyStageError({ output, backend: "claude" });
  assert.equal(result?.failureClass, "auth");
  assert.match(result?.detail ?? "", /not logged in/i);
});

// -- Rate limits (terminal for current account) ------------------------------

test("classifyStageError detects Claude rate limit with reset time", () => {
  const output = `{"type":"result","subtype":"success","is_error":true,"result":"You've hit your limit · resets 6pm (Europe/Berlin)"}`;

  const result = classifyStageError({ output, backend: "claude" });
  assert.equal(result?.failureClass, "rate-limit");
  assert.equal(result?.retryAfterHint, "6pm (Europe/Berlin)");
  assert.match(result?.detail ?? "", /usage limit/i);
});

test("classifyStageError detects Claude rate limit with curly apostrophe", () => {
  const output = `You\u2019ve hit your limit \u00b7 resets 1am (Europe/Berlin)`;

  const result = classifyStageError({
    output: `{"type":"result","subtype":"success","is_error":true,"result":"${output}"}`,
    backend: "claude",
  });
  assert.equal(result?.failureClass, "rate-limit");
  assert.equal(result?.retryAfterHint, "1am (Europe/Berlin)");
});

// -- Transient / unrecognized ------------------------------------------------

test("classifyStageError returns null for unrecognized errors", () => {
  assert.equal(classifyStageError({ output: "tests failed: 3 assertions", backend: "codex" }), null);
  assert.equal(classifyStageError({ output: "npm ERR! code ELIFECYCLE", backend: "claude" }), null);
  assert.equal(classifyStageError({ output: "", backend: "codex" }), null);
});

test("classifyStageError returns null for normal agent output", () => {
  const output = `Plan written to .vajra/run/plan.md.\n\nSummary: This is a small change.`;
  assert.equal(classifyStageError({ output, backend: "codex" }), null);
});

test("classifyStageError ignores auth-looking substrings in arbitrary model output", () => {
  const output = `Please update the docs to mention refresh_token_reused and "You've hit your limit · resets 6pm".`;
  assert.equal(classifyStageError({ output, backend: "codex" }), null);
  assert.equal(classifyStageError({ output, backend: "claude" }), null);
});

test("classifyStageError ignores Claude-style error text for non-Claude backends", () => {
  const output = `{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}`;
  assert.equal(classifyStageError({ output, backend: "plan-backend" }), null);
});

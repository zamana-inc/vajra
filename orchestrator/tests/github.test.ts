import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { GitHubClient, parseGitHubWebhookRequest, verifyGitHubWebhookSignature } from "../src/github";

function sign(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

test("parseGitHubWebhookRequest accepts JSON payloads with a valid signature", () => {
  const rawBody = JSON.stringify({
    zen: "Keep it logically awesome.",
    hook_id: 123,
  });

  const parsed = parseGitHubWebhookRequest({
    rawBody,
    headers: {
      "x-hub-signature-256": sign("secret", rawBody),
      "x-github-delivery": "delivery-1",
      "x-github-event": "ping",
    },
    secret: "secret",
  });

  assert.equal(parsed.deliveryId, "delivery-1");
  assert.equal(parsed.event, "ping");
  assert.equal(parsed.payload.zen, "Keep it logically awesome.");
});

test("parseGitHubWebhookRequest accepts form-encoded GitHub payload bodies", () => {
  const payload = JSON.stringify({
    zen: "Keep it logically awesome.",
    hook_id: 123,
  });
  const rawBody = `payload=${encodeURIComponent(payload)}`;

  const parsed = parseGitHubWebhookRequest({
    rawBody,
    headers: {
      "x-hub-signature-256": sign("secret", rawBody),
      "x-github-delivery": "delivery-2",
      "x-github-event": "ping",
    },
    secret: "secret",
  });

  assert.equal(parsed.deliveryId, "delivery-2");
  assert.equal(parsed.event, "ping");
  assert.equal(parsed.payload.hook_id, 123);
});

test("verifyGitHubWebhookSignature rejects mismatched signatures", () => {
  assert.equal(verifyGitHubWebhookSignature({
    rawBody: "{\"zen\":\"nope\"}",
    signatureHeader: sign("wrong-secret", "{\"zen\":\"nope\"}"),
    secret: "secret",
  }), false);
});

test("GitHubClient lists repository branches and open pull requests", async () => {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);

    if (url.includes("/branches")) {
      return new Response(JSON.stringify([
        { name: "main" },
        { name: "dev" },
      ]), { status: 200 });
    }

    return new Response(JSON.stringify([
      {
        number: 42,
        html_url: "https://github.com/acme-corp/acme-app/pull/42",
        head: { ref: "eng-42-docs" },
        base: { ref: "dev" },
      },
    ]), { status: 200 });
  };

  const github = new GitHubClient({
    repository: "acme-corp/acme-app",
    apiKey: "token",
    webhookSecret: "secret",
    revisionLabel: "vajra-revision",
    revisionCommand: "/vajra revise",
    revisionState: "In Progress",
    mergedState: "Done",
    closedState: "Todo",
  }, fetchImpl);

  const [branches, pullRequests] = await Promise.all([
    github.listBranches("acme-corp/acme-app"),
    github.listOpenPullRequests("acme-corp/acme-app"),
  ]);

  assert.deepEqual(branches, ["main", "dev"]);
  assert.deepEqual(pullRequests, [
    {
      number: 42,
      headRefName: "eng-42-docs",
      baseRefName: "dev",
      url: "https://github.com/acme-corp/acme-app/pull/42",
    },
  ]);
  assert.ok(requests.some((url) => url.includes("/repos/acme-corp/acme-app/branches")));
  assert.ok(requests.some((url) => url.includes("/repos/acme-corp/acme-app/pulls?state=open")));
});

test("GitHubClient enables pull request auto-merge through GitHub GraphQL", async () => {
  const requests: Array<{ url: string; body: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({
      url,
      body: typeof init?.body === "string" ? init.body : null,
    });

    if (url.endsWith("/pulls/42")) {
      return new Response(JSON.stringify({
        node_id: "PR_node_42",
      }), { status: 200 });
    }

    return new Response(JSON.stringify({
      data: {
        enablePullRequestAutoMerge: { clientMutationId: null },
      },
    }), { status: 200 });
  };

  const github = new GitHubClient({
    repository: "acme-corp/acme-app",
    apiKey: "token",
    webhookSecret: "secret",
    revisionLabel: "vajra-revision",
    revisionCommand: "/vajra revise",
    revisionState: "In Progress",
    mergedState: "Done",
    closedState: "Todo",
  }, fetchImpl);

  await github.enablePullRequestAutoMerge("acme-corp/acme-app", 42);

  assert.equal(requests[0]?.url, "https://api.github.com/repos/acme-corp/acme-app/pulls/42");
  assert.equal(requests[1]?.url, "https://api.github.com/graphql");
  assert.match(String(requests[1]?.body ?? ""), /enablePullRequestAutoMerge/);
  assert.match(String(requests[1]?.body ?? ""), /PR_node_42/);
});

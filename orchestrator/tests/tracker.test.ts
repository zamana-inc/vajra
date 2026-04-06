import test from "node:test";
import assert from "node:assert/strict";

import { LinearTrackerClient } from "../src/tracker";

function makeIssueNode(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: "1",
    identifier: "ENG-1",
    title: "Issue",
    state: { name: "Todo" },
    assignee: { id: "vajra-uuid" },
    labels: { nodes: [] },
    relations: { nodes: [] },
    ...overrides,
  };
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("LinearTrackerClient paginates candidate issues and chunks state lookups", async () => {
  const requests: Array<{ query: string; variables: Record<string, unknown>; headers: Record<string, unknown> }> = [];
  let candidatePage = 0;

  const fetchImpl: typeof fetch = async (_input, init) => {
    const payload = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
    requests.push({
      ...payload,
      headers: (init?.headers ?? {}) as Record<string, unknown>,
    });

    if (payload.query.includes("CandidateIssues")) {
      candidatePage += 1;
      if (candidatePage === 1) {
        return new Response(JSON.stringify({
          data: {
            issues: {
              pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
              nodes: [makeIssueNode({ id: "1", identifier: "ENG-1", title: "First" })],
            },
          },
        }), { status: 200 });
      }

      return new Response(JSON.stringify({
        data: {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [makeIssueNode({ id: "2", identifier: "ENG-2", title: "Second" })],
          },
        },
      }), { status: 200 });
    }

    return new Response(JSON.stringify({
      data: {
        issues: {
          nodes: ((payload.variables.ids as string[]) ?? []).map((id) => makeIssueNode({
            id,
            identifier: `ENG-${id}`,
            title: `Issue ${id}`,
          })),
        },
      },
    }), { status: 200 });
  };

  const tracker = new LinearTrackerClient({
    kind: "linear",
    endpoint: "https://api.linear.app/graphql",
    apiKey: "token",
    assigneeId: "vajra-uuid",
    activeStates: ["Todo"],
    terminalStates: ["Done"],
  }, fetchImpl);

  const candidates = await tracker.fetchCandidateIssues();
  const states = await tracker.fetchIssueStatesByIds(Array.from({ length: 55 }, (_, index) => String(index + 1)));

  assert.equal(candidates.length, 2);
  assert.equal(states.length, 55);

  const candidateRequests = requests.filter((request) => request.query.includes("CandidateIssues"));
  const stateRequests = requests.filter((request) => request.query.includes("IssueStates"));

  assert.equal(candidateRequests.length, 2);
  assert.equal(stateRequests.length, 2);
  assert.equal((stateRequests[0]?.variables.ids as string[]).length, 50);
  assert.equal((stateRequests[1]?.variables.ids as string[]).length, 5);
  assert.equal(candidateRequests[0]?.headers.authorization, "token");
  assert.ok(!candidateRequests[0]?.query.includes("slugId"));
  assert.ok(stateRequests[0]?.query.includes("query IssueStates($ids: [ID!])"));
  assert.ok(!candidateRequests[0]?.query.includes("type { name }"));
  assert.ok(!stateRequests[0]?.query.includes("type { name }"));
});

test("LinearTrackerClient includes assignee filter when assigneeId is configured", async () => {
  const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];

  const fetchImpl: typeof fetch = async (_input, init) => {
    const payload = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
    requests.push(payload);

    return new Response(JSON.stringify({
      data: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [makeIssueNode({ title: "Assigned" })],
        },
      },
    }), { status: 200 });
  };

  const tracker = new LinearTrackerClient({
    kind: "linear",
    endpoint: "https://api.linear.app/graphql",
    apiKey: "token",
    assigneeId: "vajra-uuid",
    activeStates: ["Todo"],
    terminalStates: ["Done"],
  }, fetchImpl);

  const candidates = await tracker.fetchCandidateIssues();
  const terminalIssues = await tracker.fetchTerminalIssues();
  assert.equal(candidates.length, 1);
  assert.equal(terminalIssues.length, 1);
  assert.equal(candidates[0].assigneeId, "vajra-uuid");

  const candidateQuery = requests.find((r) => r.query.includes("CandidateIssues"));
  const terminalQuery = requests.find((r) => r.query.includes("TerminalIssues"));
  assert.ok(candidateQuery);
  assert.ok(terminalQuery);
  assert.ok(candidateQuery!.query.includes("assigneeId"));
  assert.ok(!candidateQuery!.query.includes("slugId"));
  assert.equal(candidateQuery!.variables.assigneeId, "vajra-uuid");
  assert.ok(terminalQuery!.query.includes("assigneeId"));
  assert.ok(!terminalQuery!.query.includes("slugId"));
  assert.equal(terminalQuery!.variables.assigneeId, "vajra-uuid");
});

test("LinearTrackerClient throws when assigneeId is missing", async () => {
  const tracker = new LinearTrackerClient({
    kind: "linear",
    endpoint: "https://api.linear.app/graphql",
    apiKey: "token",
    assigneeId: "",
    activeStates: ["Todo"],
    terminalStates: ["Done"],
  });

  await assert.rejects(
    tracker.fetchCandidateIssues(),
    /assignee_id is required/,
  );
});

test("LinearTrackerClient surfaces network failures with endpoint and cause details", async () => {
  const fetchImpl: typeof fetch = async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND api.linear.app"), { code: "ENOTFOUND" });
    throw new Error("fetch failed", { cause });
  };

  const tracker = new LinearTrackerClient({
    kind: "linear",
    endpoint: "https://api.linear.app/graphql",
    apiKey: "token",
    assigneeId: "vajra-uuid",
    activeStates: ["Todo"],
    terminalStates: ["Done"],
  }, fetchImpl);

  await assert.rejects(
    tracker.fetchCandidateIssues(),
    /linear request failed for https:\/\/api\.linear\.app\/graphql: fetch failed \| getaddrinfo ENOTFOUND api\.linear\.app/,
  );
});

test("LinearTrackerClient parses blockers from relations", async () => {
  const fetchImpl: typeof fetch = async () => {
    return new Response(JSON.stringify({
      data: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [makeIssueNode({
            relations: {
              nodes: [
                {
                  type: "blocks",
                  relatedIssue: {
                    id: "2",
                    identifier: "ENG-2",
                    state: { name: "In Progress" },
                  },
                },
                {
                  type: "related",
                  relatedIssue: {
                    id: "3",
                    identifier: "ENG-3",
                    state: { name: "Todo" },
                  },
                },
              ],
            },
          })],
        },
      },
    }), { status: 200 });
  };

  const tracker = new LinearTrackerClient({
    kind: "linear",
    endpoint: "https://api.linear.app/graphql",
    apiKey: "token",
    assigneeId: "vajra-uuid",
    activeStates: ["Todo"],
    terminalStates: ["Done"],
  }, fetchImpl);

  const [candidate] = await tracker.fetchCandidateIssues();
  assert.deepEqual(candidate?.blockedBy, [
    { id: "2", identifier: "ENG-2", state: "In Progress" },
  ]);
});

test("LinearTrackerClient transitions an issue using Linear's String-typed issue and state arguments", async () => {
  const requests: Array<{ query: string; variables: Record<string, unknown>; headers: Record<string, unknown> }> = [];

  const fetchImpl: typeof fetch = async (_input, init) => {
    const payload = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
    requests.push({
      ...payload,
      headers: (init?.headers ?? {}) as Record<string, unknown>,
    });

    if (payload.query.includes("IssueTeamStates")) {
      return new Response(JSON.stringify({
        data: {
          issue: {
            team: {
              states: {
                nodes: [
                  { id: "state-todo", name: "Todo" },
                  { id: "state-done", name: "Done" },
                ],
              },
            },
          },
        },
      }), { status: 200 });
    }

    return new Response(JSON.stringify({
      data: {
        issueUpdate: { success: true },
      },
    }), { status: 200 });
  };

  const tracker = new LinearTrackerClient({
    kind: "linear",
    endpoint: "https://api.linear.app/graphql",
    apiKey: "token",
    assigneeId: "vajra-uuid",
    activeStates: ["Todo"],
    terminalStates: ["Done"],
  }, fetchImpl);

  await tracker.transitionIssue("issue-1", "Done");

  assert.equal(requests.length, 2);
  assert.ok(requests[0].query.includes("query IssueTeamStates($issueId: String!)"));
  assert.deepEqual(requests[0].variables, { issueId: "issue-1" });
  assert.equal(requests[0].headers.authorization, "token");
  assert.ok(requests[1].query.includes("mutation TransitionIssue($issueId: String!, $stateId: String!)"));
  assert.deepEqual(requests[1].variables, { issueId: "issue-1", stateId: "state-done" });
});

test("LinearTrackerClient posts issue comments through commentCreate", async () => {
  const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];

  const fetchImpl: typeof fetch = async (_input, init) => {
    const payload = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
    requests.push(payload);

    return new Response(JSON.stringify({
      data: {
        commentCreate: { success: true },
      },
    }), { status: 200 });
  };

  const tracker = new LinearTrackerClient({
    kind: "linear",
    endpoint: "https://api.linear.app/graphql",
    apiKey: "token",
    assigneeId: "vajra-uuid",
    activeStates: ["Todo"],
    terminalStates: ["Done"],
  }, fetchImpl);

  await tracker.commentOnIssue("issue-1", "Please clarify the expected outcome.");

  assert.equal(requests.length, 1);
  assert.ok(requests[0].query.includes("mutation CommentOnIssue($issueId: String!, $body: String!)"));
  assert.deepEqual(requests[0].variables, {
    issueId: "issue-1",
    body: "Please clarify the expected outcome.",
  });
});

test("LinearTrackerClient throws when issue transition does not succeed", async () => {
  const fetchImpl: typeof fetch = async (_input, init) => {
    const payload = JSON.parse(String(init?.body ?? "{}")) as { query: string };

    if (payload.query.includes("IssueTeamStates")) {
      return new Response(JSON.stringify({
        data: {
          issue: {
            team: {
              states: {
                nodes: [{ id: "state-done", name: "Done" }],
              },
            },
          },
        },
      }), { status: 200 });
    }

    return new Response(JSON.stringify({
      data: {
        issueUpdate: { success: false },
      },
    }), { status: 200 });
  };

  const tracker = new LinearTrackerClient({
    kind: "linear",
    endpoint: "https://api.linear.app/graphql",
    apiKey: "token",
    assigneeId: "vajra-uuid",
    activeStates: ["Todo"],
    terminalStates: ["Done"],
  }, fetchImpl);

  await assert.rejects(
    tracker.transitionIssue("issue-1", "Done"),
    /issue transition failed/,
  );
});

test("LinearTrackerClient retries GraphQL rate limit responses using retry-after headers", async () => {
  let attempts = 0;

  const fetchImpl: typeof fetch = async () => {
    attempts += 1;

    if (attempts === 1) {
      return new Response(JSON.stringify({
        errors: [
          {
            message: "Rate limited",
            extensions: { code: "RATELIMITED" },
          },
        ],
      }), {
        status: 400,
        headers: {
          "retry-after": "0",
        },
      });
    }

    return new Response(JSON.stringify({
      data: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [makeIssueNode({ id: "2", identifier: "ENG-2", title: "Retried" })],
        },
      },
    }), { status: 200 });
  };

  const tracker = new LinearTrackerClient({
    kind: "linear",
    endpoint: "https://api.linear.app/graphql",
    apiKey: "token",
    assigneeId: "vajra-uuid",
    activeStates: ["Todo"],
    terminalStates: ["Done"],
  }, fetchImpl);

  const candidates = await tracker.fetchCandidateIssues();

  assert.equal(attempts, 2);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.identifier, "ENG-2");
});

test("LinearTrackerClient serializes concurrent GraphQL requests", async () => {
  const releases: Array<() => void> = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const fetchImpl: typeof fetch = async (_input, init) => {
    const payload = JSON.parse(String(init?.body ?? "{}")) as { query: string };
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);

    await new Promise<void>((resolve) => {
      releases.push(resolve);
    });

    inFlight -= 1;

    if (payload.query.includes("IssueStates")) {
      return new Response(JSON.stringify({
        data: {
          issues: {
            nodes: [makeIssueNode({ id: "1", identifier: "ENG-1", title: "State" })],
          },
        },
      }), { status: 200 });
    }

    return new Response(JSON.stringify({
      data: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [makeIssueNode()],
        },
      },
    }), { status: 200 });
  };

  const tracker = new LinearTrackerClient({
    kind: "linear",
    endpoint: "https://api.linear.app/graphql",
    apiKey: "token",
    assigneeId: "vajra-uuid",
    activeStates: ["Todo"],
    terminalStates: ["Done"],
  }, fetchImpl);

  const pending = [
    tracker.fetchCandidateIssues(),
    tracker.fetchTerminalIssues(),
    tracker.fetchIssueStatesByIds(["1"]),
  ];

  await flushAsync();
  assert.equal(maxInFlight, 1);

  for (let index = 0; index < pending.length; index += 1) {
    while (releases.length === 0) {
      await flushAsync();
    }

    const release = releases.shift();
    release?.();
    await flushAsync();
    assert.equal(maxInFlight, 1);
  }

  const [candidates, terminalIssues, states] = await Promise.all(pending);
  assert.equal(candidates.length, 1);
  assert.equal(terminalIssues.length, 1);
  assert.equal(states.length, 1);
  assert.equal(maxInFlight, 1);
});

test("LinearTrackerClient holds rate-limit deferrals inside the serialized queue", async () => {
  const requestTimes: Array<{ query: string; startedAt: number }> = [];
  let candidateAttempts = 0;

  const fetchImpl: typeof fetch = async (_input, init) => {
    const payload = JSON.parse(String(init?.body ?? "{}")) as { query: string };
    requestTimes.push({ query: payload.query, startedAt: Date.now() });

    if (payload.query.includes("CandidateIssues")) {
      candidateAttempts += 1;
      if (candidateAttempts === 1) {
        return new Response(JSON.stringify({
          errors: [{ message: "Rate limited", extensions: { code: "RATELIMITED" } }],
        }), {
          status: 400,
          headers: { "retry-after": "0.05" },
        });
      }
    }

    return new Response(JSON.stringify({
      data: {
        issues: payload.query.includes("IssueStates")
          ? {
              nodes: [makeIssueNode()],
            }
          : {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [makeIssueNode()],
            },
      },
    }), { status: 200 });
  };

  const tracker = new LinearTrackerClient({
    kind: "linear",
    endpoint: "https://api.linear.app/graphql",
    apiKey: "token",
    assigneeId: "vajra-uuid",
    activeStates: ["Todo"],
    terminalStates: ["Done"],
  }, fetchImpl);

  const [candidates, terminalIssues] = await Promise.all([
    tracker.fetchCandidateIssues(),
    tracker.fetchTerminalIssues(),
  ]);

  assert.equal(candidates.length, 1);
  assert.equal(terminalIssues.length, 1);

  const firstCandidate = requestTimes.find((request) => request.query.includes("CandidateIssues"));
  const terminalRequest = requestTimes.find((request) => request.query.includes("TerminalIssues"));
  assert.ok(firstCandidate);
  assert.ok(terminalRequest);
  assert.ok(
    (terminalRequest!.startedAt - firstCandidate!.startedAt) >= 40,
    `expected terminal request to observe the rate-limit deferral, saw ${terminalRequest!.startedAt - firstCandidate!.startedAt}ms`,
  );
});

test("LinearTrackerClient paginates label lookups until the matching label is found", async () => {
  const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];

  const fetchImpl: typeof fetch = async (_input, init) => {
    const payload = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
    requests.push(payload);

    if (payload.query.includes("IssueLabels")) {
      const after = String(payload.variables.after ?? "");
      if (!after) {
        return new Response(JSON.stringify({
          data: {
            issueLabels: {
              pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
              nodes: [{ id: "label-a", name: "alpha" }],
            },
          },
        }), { status: 200 });
      }

      return new Response(JSON.stringify({
        data: {
          issueLabels: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ id: "label-docs", name: "Document" }],
          },
        },
      }), { status: 200 });
    }

    return new Response(JSON.stringify({
      data: {
        issueUpdate: { success: true },
      },
    }), { status: 200 });
  };

  const tracker = new LinearTrackerClient({
    kind: "linear",
    endpoint: "https://api.linear.app/graphql",
    apiKey: "token",
    assigneeId: "vajra-uuid",
    activeStates: ["Todo"],
    terminalStates: ["Done"],
  }, fetchImpl);

  await tracker.addIssueLabel("issue-1", "document");

  const labelRequests = requests.filter((request) => request.query.includes("IssueLabels"));
  assert.equal(labelRequests.length, 2);
  assert.deepEqual(labelRequests[0]?.variables, { first: 100, after: null });
  assert.deepEqual(labelRequests[1]?.variables, { first: 100, after: "cursor-1" });
  const addLabel = requests.find((request) => request.query.includes("AddIssueLabel"));
  assert.deepEqual(addLabel?.variables, { issueId: "issue-1", labelId: "label-docs" });
});

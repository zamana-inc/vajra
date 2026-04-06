import { Issue, TrackerClient, TrackerConfig } from "./types";
import { normalizeLowercase, normalizeLowercaseText } from "./string-utils";

type FetchLike = typeof fetch;
type IssueLabelLookupPage = {
  issueLabels: {
    nodes: Array<{ id?: string; name?: string }>;
    pageInfo?: {
      hasNextPage?: boolean;
      endCursor?: string | null;
    };
  };
};

const DEFAULT_LINEAR_RETRY_AFTER_MS = 1_000;
const MAX_LINEAR_RATE_LIMIT_RETRIES = 3;
const ISSUE_SELECTION = `
  id
  identifier
  title
  description
  priority
  createdAt
  updatedAt
  url
  state { name }
  assignee { id }
  creator { id }
  labels { nodes { name } }
  relations { nodes { type relatedIssue { id identifier state { name } } } }
`;

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => setTimeout(resolve, ms));
}

class LinearRateLimitError extends Error {
  constructor(readonly retryAfterMs: number | null) {
    super("linear rate limited");
    this.name = "LinearRateLimitError";
  }
}

class LinearRequestScheduler {
  private tail: Promise<void> = Promise.resolve();

  private blockedUntilMs = 0;

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      const waitMs = this.blockedUntilMs - Date.now();
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      return await operation();
    } finally {
      release();
    }
  }

  defer(ms: number): void {
    if (ms <= 0) {
      return;
    }

    this.blockedUntilMs = Math.max(this.blockedUntilMs, Date.now() + ms);
  }
}

function parseRetryAfterMs(retryAfterHeader: string | null): number | null {
  if (!retryAfterHeader) {
    return null;
  }

  const retryAfterSeconds = Number(retryAfterHeader);
  if (Number.isFinite(retryAfterSeconds)) {
    return Math.max(0, retryAfterSeconds * 1_000);
  }

  const retryAtMs = Date.parse(retryAfterHeader);
  if (Number.isNaN(retryAtMs)) {
    return null;
  }

  return Math.max(0, retryAtMs - Date.now());
}

function extractBlockedBy(rawIssue: Record<string, unknown>): Issue["blockedBy"] {
  const relations = ((rawIssue.relations as { nodes?: Array<Record<string, unknown>> } | undefined)?.nodes ?? []);
  return relations
    .filter((relation) => normalizeLowercaseText(relation.type) === "blocks")
    .map((relation) => {
      const related = (relation.relatedIssue ?? {}) as Record<string, unknown>;
      return {
        id: related.id ? String(related.id) : null,
        identifier: related.identifier ? String(related.identifier) : null,
        state: related.state && typeof related.state === "object" ? String((related.state as Record<string, unknown>).name ?? "") : null,
      };
    });
}

function normalizeIssue(rawIssue: Record<string, unknown>): Issue {
  const labels = ((rawIssue.labels as { nodes?: Array<{ name?: string }> } | undefined)?.nodes ?? [])
    .map((label) => normalizeLowercaseText(label.name))
    .filter(Boolean);

  return {
    id: String(rawIssue.id ?? ""),
    identifier: String(rawIssue.identifier ?? ""),
    title: String(rawIssue.title ?? ""),
    description: rawIssue.description ? String(rawIssue.description) : null,
    state: String((rawIssue.state as Record<string, unknown> | undefined)?.name ?? ""),
    priority: typeof rawIssue.priority === "number" ? rawIssue.priority : Number.isFinite(Number(rawIssue.priority)) ? Number(rawIssue.priority) : null,
    labels,
    assigneeId: rawIssue.assignee && typeof rawIssue.assignee === "object" ? String((rawIssue.assignee as Record<string, unknown>).id ?? "") || null : null,
    creatorId: rawIssue.creator && typeof rawIssue.creator === "object" ? String((rawIssue.creator as Record<string, unknown>).id ?? "") || null : null,
    createdAt: rawIssue.createdAt ? String(rawIssue.createdAt) : null,
    updatedAt: rawIssue.updatedAt ? String(rawIssue.updatedAt) : null,
    url: rawIssue.url ? String(rawIssue.url) : null,
    blockedBy: extractBlockedBy(rawIssue),
  };
}

function describeFetchFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const parts = [error.message];
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message && cause.message !== error.message) {
    parts.push(cause.message);
  } else if (cause && typeof cause === "object") {
    const code = "code" in cause ? String((cause as { code?: unknown }).code ?? "").trim() : "";
    const message = "message" in cause ? String((cause as { message?: unknown }).message ?? "").trim() : "";
    if (code) {
      parts.push(code);
    }
    if (message && !parts.includes(message)) {
      parts.push(message);
    }
  }

  return parts.filter(Boolean).join(" | ");
}

async function postGraphQL<T>(
  fetchImpl: FetchLike,
  config: TrackerConfig,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(config.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: config.apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (error) {
    throw new Error(`linear request failed for ${config.endpoint}: ${describeFetchFailure(error)}`);
  }

  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  if (response.status === 429) {
    throw new LinearRateLimitError(retryAfterMs);
  }

  const rawBody = await response.text();
  let payload: {
    data?: T;
    errors?: Array<{ message?: string; extensions?: { code?: string } }>;
  } | null = null;

  if (rawBody) {
    try {
      payload = JSON.parse(rawBody) as {
        data?: T;
        errors?: Array<{ message?: string; extensions?: { code?: string } }>;
      };
    } catch {
      payload = null;
    }
  }

  if (payload?.errors?.some((error) => String(error.extensions?.code ?? "").toUpperCase() === "RATELIMITED")) {
    throw new LinearRateLimitError(retryAfterMs);
  }

  if (!response.ok) {
    throw new Error(`linear http error ${response.status}: ${rawBody}`);
  }

  if (payload?.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message ?? "unknown graphql error").join("; "));
  }

  if (!payload?.data) {
    throw new Error("linear response missing data");
  }

  return payload.data;
}

async function postGraphQLWithRetry<T>(
  scheduler: LinearRequestScheduler,
  fetchImpl: FetchLike,
  config: TrackerConfig,
  query: string,
  variables: Record<string, unknown>,
  maxRetries = MAX_LINEAR_RATE_LIMIT_RETRIES,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await scheduler.run(async () => {
        try {
          return await postGraphQL<T>(fetchImpl, config, query, variables);
        } catch (error) {
          if (error instanceof LinearRateLimitError) {
            scheduler.defer(error.retryAfterMs ?? DEFAULT_LINEAR_RETRY_AFTER_MS);
          }
          throw error;
        }
      });
    } catch (error) {
      if (!(error instanceof LinearRateLimitError) || attempt === maxRetries) {
        throw error;
      }
    }
  }

  throw new Error("linear graphql retry loop exhausted");
}

async function fetchPagedIssues(
  scheduler: LinearRequestScheduler,
  fetchImpl: FetchLike,
  config: TrackerConfig,
  query: string,
  variables: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const nodes: Array<Record<string, unknown>> = [];
  let after: string | null = null;

  do {
    const requestVariables: Record<string, unknown> = { ...variables, first: 50, after };
    const data: {
      issues: {
        nodes: Array<Record<string, unknown>>;
        pageInfo?: {
          hasNextPage?: boolean;
          endCursor?: string | null;
        };
      };
    } = await postGraphQLWithRetry(
      scheduler,
      fetchImpl,
      config,
      query,
      requestVariables,
    );

    nodes.push(...data.issues.nodes);
    after = data.issues.pageInfo?.hasNextPage ? (data.issues.pageInfo.endCursor ?? null) : null;
  } while (after);

  return nodes;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export class LinearTrackerClient implements TrackerClient {
  private readonly requestScheduler = new LinearRequestScheduler();

  constructor(
    private readonly config: TrackerConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async fetchCandidateIssues(): Promise<Issue[]> {
    if (!this.config.assigneeId) {
      throw new Error("tracker.assignee_id is required — refusing to poll without an assignee filter");
    }

    const nodes = await fetchPagedIssues(
      this.requestScheduler,
      this.fetchImpl,
      this.config,
      `
        query CandidateIssues($stateNames: [String!], $assigneeId: ID!, $first: Int, $after: String) {
          issues(
            filter: {
              state: { name: { in: $stateNames } }
              assignee: { id: { eq: $assigneeId } }
            }
            first: $first
            after: $after
          ) {
            pageInfo { hasNextPage endCursor }
            nodes {
              ${ISSUE_SELECTION}
            }
          }
        }
      `,
      {
        stateNames: this.config.activeStates,
        assigneeId: this.config.assigneeId,
      },
    );

    return nodes.map(normalizeIssue);
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    if (issueIds.length === 0) {
      return [];
    }

    const allNodes: Array<Record<string, unknown>> = [];
    for (const idChunk of chunk(issueIds, 50)) {
      const data = await postGraphQLWithRetry<{
        issues: { nodes: Array<Record<string, unknown>> };
      }>(
        this.requestScheduler,
        this.fetchImpl,
        this.config,
        `
          query IssueStates($ids: [ID!]) {
            issues(filter: { id: { in: $ids } }) {
              nodes {
                ${ISSUE_SELECTION}
              }
            }
          }
        `,
        { ids: idChunk },
      );

      allNodes.push(...data.issues.nodes);
    }

    return allNodes.map(normalizeIssue);
  }

  async fetchTerminalIssues(): Promise<Issue[]> {
    if (!this.config.assigneeId) {
      throw new Error("tracker.assignee_id is required — refusing to clean up without an assignee filter");
    }

    const nodes = await fetchPagedIssues(
      this.requestScheduler,
      this.fetchImpl,
      this.config,
      `
        query TerminalIssues($stateNames: [String!], $assigneeId: ID!, $first: Int, $after: String) {
          issues(
            filter: {
              state: { name: { in: $stateNames } }
              assignee: { id: { eq: $assigneeId } }
            }
            first: $first
            after: $after
          ) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              ${ISSUE_SELECTION}
            }
          }
        }
      `,
      {
        stateNames: this.config.terminalStates,
        assigneeId: this.config.assigneeId,
      },
    );

    return nodes.map(normalizeIssue);
  }

  async fetchIssueByIdentifier(identifier: string): Promise<Issue | null> {
    const normalizedIdentifier = String(identifier ?? "").trim();
    if (!normalizedIdentifier) {
      return null;
    }

    const data = await postGraphQLWithRetry<{
      issue: Record<string, unknown> | null;
    }>(
      this.requestScheduler,
      this.fetchImpl,
      this.config,
      `
        query IssueByIdentifier($identifier: String!) {
          issue(id: $identifier) {
            ${ISSUE_SELECTION}
          }
        }
      `,
      { identifier: normalizedIdentifier },
    );

    return data.issue ? normalizeIssue(data.issue) : null;
  }

  async transitionIssue(issueId: string, stateName: string): Promise<void> {
    // Linear's live GraphQL schema uses String, not ID, for issue/state identifiers here.
    // Confirmed via https://api.linear.app/graphql introspection on 2026-03-11.
    // Keep these variables typed as String! unless Linear changes the schema.
    // Look up the workflow state ID by name for the issue's team.
    const stateData = await postGraphQLWithRetry<{
      issue: { team?: { states?: { nodes?: Array<{ id: string; name: string }> } } | null } | null;
    }>(
      this.requestScheduler,
      this.fetchImpl,
      this.config,
      `
        query IssueTeamStates($issueId: String!) {
          issue(id: $issueId) {
            team { states { nodes { id name } } }
          }
        }
      `,
      { issueId },
    );

    const states = stateData.issue?.team?.states?.nodes ?? [];
    if (states.length === 0) {
      throw new Error(`unable to load team states for issue ${issueId}`);
    }

    const targetState = states.find(
      (s) => s.name.toLowerCase() === stateName.toLowerCase(),
    );
    if (!targetState) {
      throw new Error(`state "${stateName}" not found for issue ${issueId}`);
    }

    const mutationResult = await postGraphQLWithRetry<{
      issueUpdate?: { success?: boolean | null } | null;
    }>(
      this.requestScheduler,
      this.fetchImpl,
      this.config,
      `
        mutation TransitionIssue($issueId: String!, $stateId: String!) {
          issueUpdate(id: $issueId, input: { stateId: $stateId }) {
            success
          }
        }
      `,
      { issueId, stateId: targetState.id },
    );

    if (!mutationResult.issueUpdate?.success) {
      throw new Error(`issue transition failed for issue ${issueId}`);
    }
  }

  async commentOnIssue(issueId: string, body: string): Promise<void> {
    const commentBody = String(body ?? "").trim();
    if (!commentBody) {
      return;
    }

    const mutationResult = await postGraphQLWithRetry<{
      commentCreate?: { success?: boolean | null } | null;
    }>(
      this.requestScheduler,
      this.fetchImpl,
      this.config,
      `
        mutation CommentOnIssue($issueId: String!, $body: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) {
            success
          }
        }
      `,
      { issueId, body: commentBody },
    );

    if (!mutationResult.commentCreate?.success) {
      throw new Error(`issue comment create failed for issue ${issueId}`);
    }
  }

  async addIssueLabel(issueId: string, labelName: string): Promise<void> {
    const labelId = await this.resolveLabelId(labelName);
    if (!labelId) {
      throw new Error(`label "${labelName}" not found`);
    }

    const mutationResult = await postGraphQLWithRetry<{
      issueUpdate?: { success?: boolean | null } | null;
    }>(
      this.requestScheduler,
      this.fetchImpl,
      this.config,
      `
        mutation AddIssueLabel($issueId: String!, $labelId: String!) {
          issueUpdate(id: $issueId, input: { addedLabelIds: [$labelId] }) {
            success
          }
        }
      `,
      { issueId, labelId },
    );

    if (!mutationResult.issueUpdate?.success) {
      throw new Error(`issue label add failed for issue ${issueId}`);
    }
  }

  async removeIssueLabel(issueId: string, labelName: string): Promise<void> {
    const labelId = await this.resolveLabelId(labelName);
    if (!labelId) {
      return;
    }

    const mutationResult = await postGraphQLWithRetry<{
      issueUpdate?: { success?: boolean | null } | null;
    }>(
      this.requestScheduler,
      this.fetchImpl,
      this.config,
      `
        mutation RemoveIssueLabel($issueId: String!, $labelId: String!) {
          issueUpdate(id: $issueId, input: { removedLabelIds: [$labelId] }) {
            success
          }
        }
      `,
      { issueId, labelId },
    );

    if (!mutationResult.issueUpdate?.success) {
      throw new Error(`issue label remove failed for issue ${issueId}`);
    }
  }

  private async resolveLabelId(labelName: string): Promise<string | null> {
    const normalizedLabel = normalizeLowercase(labelName);
    if (!normalizedLabel) {
      return null;
    }

    let after: string | null = null;
    do {
      const data: IssueLabelLookupPage = await postGraphQLWithRetry<IssueLabelLookupPage>(
        this.requestScheduler,
        this.fetchImpl,
        this.config,
        `
          query IssueLabels($first: Int, $after: String) {
            issueLabels(first: $first, after: $after) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                name
              }
            }
          }
        `,
        { first: 100, after },
      );

      const match = data.issueLabels.nodes.find(
        (label: { id?: string; name?: string }) => normalizeLowercaseText(label.name) === normalizedLabel,
      );
      if (match?.id) {
        return String(match.id);
      }

      after = data.issueLabels.pageInfo?.hasNextPage
        ? (data.issueLabels.pageInfo.endCursor ?? null)
        : null;
    } while (after);

    return null;
  }
}

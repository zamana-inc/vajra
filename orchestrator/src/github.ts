import { createHmac, timingSafeEqual } from "node:crypto";

import { GitHubConfig, PullRequestMetadata } from "./types";

type FetchLike = typeof fetch;

export interface GitHubWebhookEnvelope {
  deliveryId: string;
  event: string;
  payload: Record<string, unknown>;
}

export interface GitHubPullRequestDetails extends PullRequestMetadata {
  repository: string;
  number: number;
  merged: boolean;
}

export interface GitHubReview {
  id: number;
  state: string;
  body: string | null;
  submittedAt: string | null;
  userLogin: string | null;
  htmlUrl: string | null;
}

export interface GitHubIssueComment {
  id: number;
  body: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  userLogin: string | null;
  htmlUrl: string | null;
  isBot: boolean;
}

export interface GitHubOpenPullRequest {
  number: number;
  headRefName: string | null;
  baseRefName: string | null;
  url: string | null;
}

export interface CreatePullRequestInput {
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
}

export interface UpdatePullRequestInput {
  title?: string;
  body?: string;
}

export interface GitHubReviewComment {
  id: number;
  body: string | null;
  path: string | null;
  line: number | null;
  reviewId: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  userLogin: string | null;
  htmlUrl: string | null;
  isBot: boolean;
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) {
    return raw[0] ?? null;
  }
  return typeof raw === "string" ? raw : null;
}

export function verifyGitHubWebhookSignature(opts: {
  rawBody: string;
  signatureHeader: string | null;
  secret: string;
}): boolean {
  const signatureHeader = String(opts.signatureHeader ?? "").trim();
  if (!signatureHeader.startsWith("sha256=") || !opts.secret) {
    return false;
  }

  const received = Buffer.from(signatureHeader, "utf8");
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", opts.secret).update(opts.rawBody).digest("hex")}`,
    "utf8",
  );
  if (received.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(received, expected);
}

function parseGitHubWebhookPayload(rawBody: string): Record<string, unknown> {
  const trimmed = rawBody.trim();
  if (!trimmed) {
    throw new Error("missing GitHub webhook payload");
  }

  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as Record<string, unknown>;
  }

  const formBody = new URLSearchParams(trimmed);
  const payload = formBody.get("payload");
  if (!payload) {
    throw new Error("unsupported GitHub webhook payload encoding");
  }

  return JSON.parse(payload) as Record<string, unknown>;
}

export function parseGitHubWebhookRequest(opts: {
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
  secret: string;
}): GitHubWebhookEnvelope {
  if (!verifyGitHubWebhookSignature({
    rawBody: opts.rawBody,
    signatureHeader: headerValue(opts.headers, "x-hub-signature-256"),
    secret: opts.secret,
  })) {
    throw new Error("invalid GitHub webhook signature");
  }

  const deliveryId = headerValue(opts.headers, "x-github-delivery");
  if (!deliveryId) {
    throw new Error("missing GitHub delivery id");
  }

  const event = headerValue(opts.headers, "x-github-event");
  if (!event) {
    throw new Error("missing GitHub event name");
  }

  const payload = parseGitHubWebhookPayload(opts.rawBody);
  return {
    deliveryId,
    event,
    payload,
  };
}

export function extractIssueIdentifierFromBranch(headRefName: string | null | undefined): string | null {
  const ref = String(headRefName ?? "").trim().toLowerCase();
  if (!ref) {
    return null;
  }

  const match = ref.match(/(?:^|\/)([a-z]+-\d+)(?:$|[/-])/i);
  return match?.[1] ? match[1].toUpperCase() : null;
}

export function isPullRequestIssueComment(payload: Record<string, unknown>): boolean {
  const issue = payload.issue;
  if (!issue || typeof issue !== "object") {
    return false;
  }
  const pullRequest = (issue as Record<string, unknown>).pull_request;
  return !!pullRequest && typeof pullRequest === "object";
}

export function extractRevisionCommand(body: string | null | undefined, command: string): string | null {
  const content = String(body ?? "").trim();
  const normalizedCommand = String(command ?? "").trim();
  if (!content || !normalizedCommand) {
    return null;
  }

  return content.toLowerCase().startsWith(normalizedCommand.toLowerCase()) ? content : null;
}

function normalizeReview(value: Record<string, unknown>): GitHubReview {
  return {
    id: Number(value.id ?? 0),
    state: String(value.state ?? "").trim().toLowerCase(),
    body: typeof value.body === "string" ? value.body : null,
    submittedAt: typeof value.submitted_at === "string" ? value.submitted_at : null,
    userLogin: value.user && typeof value.user === "object" ? String((value.user as Record<string, unknown>).login ?? "") || null : null,
    htmlUrl: typeof value.html_url === "string" ? value.html_url : null,
  };
}

function normalizeIssueComment(value: Record<string, unknown>): GitHubIssueComment {
  const user = value.user && typeof value.user === "object" ? value.user as Record<string, unknown> : null;
  return {
    id: Number(value.id ?? 0),
    body: typeof value.body === "string" ? value.body : null,
    createdAt: typeof value.created_at === "string" ? value.created_at : null,
    updatedAt: typeof value.updated_at === "string" ? value.updated_at : null,
    userLogin: user ? String(user.login ?? "") || null : null,
    htmlUrl: typeof value.html_url === "string" ? value.html_url : null,
    isBot: user ? String(user.type ?? "").trim().toLowerCase() === "bot" : false,
  };
}

function normalizeReviewComment(value: Record<string, unknown>): GitHubReviewComment {
  const user = value.user && typeof value.user === "object" ? value.user as Record<string, unknown> : null;
  return {
    id: Number(value.id ?? 0),
    body: typeof value.body === "string" ? value.body : null,
    path: typeof value.path === "string" ? value.path : null,
    line: typeof value.line === "number" ? value.line : Number.isFinite(Number(value.line)) ? Number(value.line) : null,
    reviewId: typeof value.pull_request_review_id === "number"
      ? value.pull_request_review_id
      : Number.isFinite(Number(value.pull_request_review_id))
        ? Number(value.pull_request_review_id)
        : null,
    createdAt: typeof value.created_at === "string" ? value.created_at : null,
    updatedAt: typeof value.updated_at === "string" ? value.updated_at : null,
    userLogin: user ? String(user.login ?? "") || null : null,
    htmlUrl: typeof value.html_url === "string" ? value.html_url : null,
    isBot: user ? String(user.type ?? "").trim().toLowerCase() === "bot" : false,
  };
}

export class GitHubClient {
  constructor(
    private readonly config: GitHubConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async fetchPullRequest(repository: string, number: number): Promise<GitHubPullRequestDetails> {
    const payload = await this.requestJson<Record<string, unknown>>(`/repos/${repository}/pulls/${number}`);
    const head = payload.head && typeof payload.head === "object" ? payload.head as Record<string, unknown> : {};
    return {
      repository,
      url: String(payload.html_url ?? ""),
      title: typeof payload.title === "string" ? payload.title : null,
      number: typeof payload.number === "number" ? payload.number : number,
      headRefName: typeof head.ref === "string" ? head.ref : null,
      headSha: typeof head.sha === "string" ? head.sha : null,
      state: typeof payload.state === "string" ? payload.state : null,
      merged: payload.merged === true,
    };
  }

  async fetchPullRequestNodeId(repository: string, number: number): Promise<string | null> {
    const payload = await this.requestJson<Record<string, unknown>>(`/repos/${repository}/pulls/${number}`);
    return typeof payload.node_id === "string" ? payload.node_id : null;
  }

  async listBranches(repository: string): Promise<string[]> {
    const payload = await this.paginate<Record<string, unknown>>(`/repos/${repository}/branches`);
    return payload
      .map((entry) => typeof entry.name === "string" ? entry.name.trim() : "")
      .filter(Boolean);
  }

  async listOpenPullRequests(repository: string): Promise<GitHubOpenPullRequest[]> {
    const payload = await this.paginate<Record<string, unknown>>(`/repos/${repository}/pulls?state=open`);
    return payload
      .map((entry) => {
        const head = entry.head && typeof entry.head === "object" ? entry.head as Record<string, unknown> : {};
        const base = entry.base && typeof entry.base === "object" ? entry.base as Record<string, unknown> : {};
        return {
          number: typeof entry.number === "number" ? entry.number : Number.parseInt(String(entry.number ?? ""), 10) || 0,
          headRefName: typeof head.ref === "string" ? head.ref : null,
          baseRefName: typeof base.ref === "string" ? base.ref : null,
          url: typeof entry.html_url === "string" ? entry.html_url : null,
        };
      })
      .filter((pullRequest) => pullRequest.number > 0);
  }

  async createPullRequest(repository: string, input: CreatePullRequestInput): Promise<PullRequestMetadata> {
    const payload = await this.requestJson<Record<string, unknown>>(`/repos/${repository}/pulls`, {
      method: "POST",
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        draft: input.draft === true,
      }),
    });

    return normalizePullRequestMetadata(payload);
  }

  async updatePullRequest(repository: string, number: number, input: UpdatePullRequestInput): Promise<PullRequestMetadata> {
    const payload = await this.requestJson<Record<string, unknown>>(`/repos/${repository}/pulls/${number}`, {
      method: "PATCH",
      body: JSON.stringify({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
      }),
    });

    return normalizePullRequestMetadata(payload);
  }

  async enablePullRequestAutoMerge(
    repository: string,
    number: number,
    mergeMethod: "squash" | "merge" | "rebase" = "squash",
  ): Promise<void> {
    const pullRequestId = await this.fetchPullRequestNodeId(repository, number);
    if (!pullRequestId) {
      throw new Error(`pull request ${repository}#${number} did not return a GraphQL node id`);
    }

    const response = await this.fetchImpl("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        "accept": "application/vnd.github+json",
        "authorization": `Bearer ${this.config.apiKey}`,
        "content-type": "application/json",
        "user-agent": "vajra",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({
        query: `
          mutation EnableAutoMerge($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
            enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod }) {
              clientMutationId
            }
          }
        `,
        variables: {
          pullRequestId,
          mergeMethod: mergeMethod.toUpperCase(),
        },
      }),
    });

    const rawBody = await response.text();
    if (!response.ok) {
      throw new Error(`GitHub http error ${response.status}: ${rawBody}`);
    }

    const payload = JSON.parse(rawBody) as {
      data?: { enablePullRequestAutoMerge?: unknown };
      errors?: Array<{ message?: string }>;
    };
    if (payload.errors?.length) {
      throw new Error(payload.errors.map((error) => error.message ?? "unknown graphql error").join("; "));
    }

    if (!payload.data?.enablePullRequestAutoMerge) {
      throw new Error(`GitHub auto-merge enablement failed for ${repository}#${number}`);
    }
  }

  async listPullRequestReviews(repository: string, number: number): Promise<GitHubReview[]> {
    const payload = await this.paginate<Record<string, unknown>>(`/repos/${repository}/pulls/${number}/reviews`);
    return payload.map((entry) => normalizeReview(entry));
  }

  async listIssueComments(repository: string, number: number): Promise<GitHubIssueComment[]> {
    const payload = await this.paginate<Record<string, unknown>>(`/repos/${repository}/issues/${number}/comments`);
    return payload.map((entry) => normalizeIssueComment(entry));
  }

  async listReviewComments(repository: string, number: number): Promise<GitHubReviewComment[]> {
    const payload = await this.paginate<Record<string, unknown>>(`/repos/${repository}/pulls/${number}/comments`);
    return payload.map((entry) => normalizeReviewComment(entry));
  }

  private async paginate<T>(path: string): Promise<T[]> {
    const results: T[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const pageItems = await this.requestJson<T[]>(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      results.push(...pageItems);
      if (pageItems.length < 100) {
        break;
      }
    }
    return results;
  }

  private async requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`https://api.github.com${path}`, {
      method: init.method,
      headers: {
        "accept": "application/vnd.github+json",
        "authorization": `Bearer ${this.config.apiKey}`,
        "content-type": "application/json",
        "user-agent": "vajra",
        "x-github-api-version": "2022-11-28",
        ...(init.headers ?? {}),
      },
      body: init.body,
    });

    const rawBody = await response.text();
    if (!response.ok) {
      throw new Error(`GitHub http error ${response.status}: ${rawBody}`);
    }

    return JSON.parse(rawBody) as T;
  }
}

function normalizePullRequestMetadata(value: Record<string, unknown>): PullRequestMetadata {
  const head = value.head && typeof value.head === "object" ? value.head as Record<string, unknown> : {};
  return {
    url: String(value.html_url ?? "").trim(),
    title: typeof value.title === "string" ? value.title : null,
    number: typeof value.number === "number" ? value.number : Number.isFinite(Number(value.number)) ? Number(value.number) : null,
    headRefName: typeof head.ref === "string" ? head.ref : null,
    headSha: typeof head.sha === "string" ? head.sha : null,
    state: typeof value.state === "string" ? value.state : null,
  };
}

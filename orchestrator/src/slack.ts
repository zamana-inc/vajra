import { Issue, SlackConfig } from "./types";

type FetchLike = typeof fetch;

export class SlackNotifier {
  constructor(
    private readonly config: SlackConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  resolveSlackUserId(linearUserId: string | null): string | null {
    if (!linearUserId) return null;
    return this.config.userMap[linearUserId] ?? null;
  }

  async postMessage(text: string): Promise<void> {
    const response = await this.fetchImpl("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.config.botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: this.config.channelId,
        text,
        unfurl_links: true,
      }),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(`slack http error ${response.status}: ${bodyText.slice(0, 200)}`);
    }

    let data: { ok: boolean; error?: string };
    try {
      data = await response.json() as { ok: boolean; error?: string };
    } catch {
      throw new Error("slack returned non-JSON response");
    }

    if (!data.ok) {
      throw new Error(`slack api error: ${data.error ?? "unknown"}`);
    }
  }

  async notifyPRReady(opts: {
    issue: Issue;
    prUrl: string;
  }): Promise<void> {
    const slackUserId = this.resolveSlackUserId(opts.issue.creatorId);
    const mention = slackUserId ? `<@${slackUserId}> ` : "";
    const text = `${mention}PR ready for review: <${opts.prUrl}|${opts.issue.identifier}: ${opts.issue.title}>`;
    await this.postMessage(text);
  }

  async notifyPipelineSuccess(opts: {
    issue: Issue;
    prUrl: string | null;
  }): Promise<void> {
    if (opts.prUrl) {
      await this.notifyPRReady({ issue: opts.issue, prUrl: opts.prUrl });
      return;
    }
    const slackUserId = this.resolveSlackUserId(opts.issue.creatorId);
    const mention = slackUserId ? `<@${slackUserId}> ` : "";
    const issueLink = opts.issue.url ? `<${opts.issue.url}|${opts.issue.identifier}>` : opts.issue.identifier;
    const text = `${mention}Pipeline completed for ${issueLink}: ${opts.issue.title}`;
    await this.postMessage(text);
  }

  async notifyPipelineFailure(opts: {
    issue: Issue;
    error: string;
    stage?: string;
  }): Promise<void> {
    const slackUserId = this.resolveSlackUserId(opts.issue.creatorId);
    const mention = slackUserId ? `<@${slackUserId}> ` : "";
    const stageInfo = opts.stage ? ` at stage \`${opts.stage}\`` : "";
    const issueLink = opts.issue.url ? `<${opts.issue.url}|${opts.issue.identifier}>` : opts.issue.identifier;
    const text = `${mention}Pipeline failed for ${issueLink}${stageInfo}: ${opts.error}`;
    await this.postMessage(text);
  }

  async notifyHumanReviewRequired(opts: {
    issue: Issue;
    reason: string;
  }): Promise<void> {
    const slackUserId = this.resolveSlackUserId(opts.issue.creatorId);
    const mention = slackUserId ? `<@${slackUserId}> ` : "";
    const issueLink = opts.issue.url ? `<${opts.issue.url}|${opts.issue.identifier}>` : opts.issue.identifier;
    const text = `${mention}Human review needed for ${issueLink}: ${opts.reason}`;
    await this.postMessage(text);
  }
}

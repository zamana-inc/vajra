import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "node:stream";

import { VajraEvent, VajraEventBus } from "../events";
import { log } from "../logger";
import { VajraOrchestrator } from "../orchestrator";
import { MutableWorkflowStore } from "../types";
import { WorkflowAdminService } from "./config-store";
import { getRunDetail, getRunStageDetail } from "./run-detail";
import { listRunSummaries, readLoggedEvents } from "./run-history";
import { RuntimeStateTracker } from "./runtime-state";
import { ApiRunStatus } from "./types";

function parseBearerToken(header: string | string[] | undefined): string | null {
  if (!header) {
    return null;
  }

  const normalized = Array.isArray(header) ? header[0] : header;
  const [scheme, token] = normalized.split(/\s+/, 2);
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") {
    return null;
  }

  return token;
}

function parseSinceMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const match = value.trim().match(/^(\d+)(ms|s|m|h|d)$/i);
  if (!match) {
    return undefined;
  }

  const magnitude = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multiplier = unit === "ms"
    ? 1
    : unit === "s"
      ? 1_000
      : unit === "m"
        ? 60_000
        : unit === "h"
          ? 3_600_000
          : 86_400_000;
  return magnitude * multiplier;
}

function parseLimit(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseAttempt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("attempt must be a non-negative integer");
  }

  return parsed;
}

function parseEventCursor(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function resolveEventReplayCursor(opts: {
  lastEventId?: string | string[];
  after?: string | string[];
}): number | undefined {
  return parseEventCursor(opts.lastEventId) ?? parseEventCursor(opts.after);
}

function replyWithCors(reply: FastifyReply, corsOrigin?: string): void {
  if (!corsOrigin) {
    return;
  }

  reply.header("access-control-allow-origin", corsOrigin);
  reply.header("access-control-allow-headers", "authorization, content-type");
  reply.header("access-control-allow-methods", "GET,HEAD,OPTIONS,POST,PUT,DELETE");
}

function isAllowedStatus(value: string | undefined): value is ApiRunStatus {
  return value === "running" || value === "success" || value === "failure" || value === "cancelled";
}

function sendClientError(reply: FastifyReply, error: unknown, statusCode = 400) {
  reply.status(statusCode).send({
    error: error instanceof Error ? error.message : String(error),
  });
}

type RawBodyRequest = FastifyRequest & {
  rawBody?: string;
};

export function createApiServer(opts: {
  eventBus: VajraEventBus;
  orchestrator: VajraOrchestrator;
  workflowStore: MutableWorkflowStore;
  logsRoot: string;
  apiKey?: string;
  corsOrigin?: string;
  skillsRoot?: string;
  now?: () => number;
  reviewLoop?: {
    handleWebhook(opts: {
      rawBody: string;
      headers: Record<string, string | string[] | undefined>;
    }): Promise<{ statusCode: number; body: Record<string, unknown> }>;
  };
}): FastifyInstance {
  const app = Fastify({
    logger: false,
  });
  const runtimeState = new RuntimeStateTracker(opts.orchestrator, opts.eventBus, opts.workflowStore, opts.now);
  const configAdmin = new WorkflowAdminService(opts.workflowStore, opts.skillsRoot);

  // GitHub sends pings as application/x-www-form-urlencoded despite webhook
  // config requesting JSON. Accept that content type so Fastify doesn't
  // reject with 415 before reaching the handler. The preParsing hook
  // captures the raw body for signature verification anyway.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      try {
        done(null, typeof body === "string" ? JSON.parse(body) : body);
      } catch {
        done(null, body);
      }
    },
  );

  app.addHook("preParsing", async (request, _reply, payload) => {
    if (request.method !== "POST" || request.url !== "/github/webhooks") {
      return payload;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of payload) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks);
    Object.assign(request as RawBodyRequest, { rawBody: rawBody.toString("utf8") });
    return Readable.from(rawBody);
  });

  app.addHook("onRequest", async (request, reply) => {
    replyWithCors(reply, opts.corsOrigin);

    if (request.method === "OPTIONS") {
      reply.status(204).send();
      return;
    }

    if (request.url === "/github/webhooks") {
      return;
    }

    if (!opts.apiKey) {
      return;
    }

    const token = parseBearerToken(request.headers.authorization);
    if (token === opts.apiKey) {
      return;
    }

    reply.status(401).send({
      error: "unauthorized",
    });
  });

  app.post("/github/webhooks", async (request: RawBodyRequest, reply) => {
    const event = request.headers["x-github-event"] as string | undefined;
    const delivery = request.headers["x-github-delivery"] as string | undefined;
    log("webhook:received", { event: event ?? "unknown", delivery: delivery ?? "unknown" });

    if (!opts.reviewLoop) {
      log("webhook:rejected", { reason: "github integration not configured" });
      reply.status(404).send({ error: "github integration not configured" });
      return;
    }

    try {
      const result = await opts.reviewLoop.handleWebhook({
        rawBody: request.rawBody ?? JSON.stringify(request.body ?? {}),
        headers: request.headers,
      });
      log("webhook:handled", { event: event ?? "unknown", status: result.statusCode });
      reply.status(result.statusCode).send(result.body);
    } catch (error) {
      log("webhook:error", { event: event ?? "unknown", error: error instanceof Error ? error.message : String(error) });
      sendClientError(reply, error, 500);
    }
  });

  app.get("/state", async () => runtimeState.snapshot());

  app.get("/runs", async (request: FastifyRequest<{
    Querystring: {
      status?: string;
      since?: string;
      limit?: string;
    };
  }>, reply) => {
    const status = isAllowedStatus(request.query.status) ? request.query.status : undefined;
    const sinceMs = parseSinceMs(request.query.since);
    const limit = parseLimit(request.query.limit, 100);
    reply.header("cache-control", "no-store");

    return listRunSummaries({
      logsRoot: opts.logsRoot,
      workflowStore: opts.workflowStore,
      status,
      sinceMs,
      limit,
      now: opts.now,
    });
  });

  app.get("/runs/:issue/:attempt", async (request: FastifyRequest<{
    Params: { issue: string; attempt: string };
  }>, reply) => {
    try {
      const detail = await getRunDetail({
        logsRoot: opts.logsRoot,
        workflowStore: opts.workflowStore,
        issueIdentifier: request.params.issue,
        attempt: parseAttempt(request.params.attempt),
      });
      if (!detail) {
        reply.status(404).send({ error: "run not found" });
        return;
      }

      reply.header("cache-control", "no-store");
      return detail;
    } catch (error) {
      sendClientError(reply, error);
    }
  });

  app.get("/runs/:issue/:attempt/stages/:stageId", async (request: FastifyRequest<{
    Params: { issue: string; attempt: string; stageId: string };
  }>, reply) => {
    try {
      const stage = await getRunStageDetail({
        logsRoot: opts.logsRoot,
        workflowStore: opts.workflowStore,
        issueIdentifier: request.params.issue,
        attempt: parseAttempt(request.params.attempt),
        stageId: request.params.stageId,
      });
      if (!stage) {
        reply.status(404).send({ error: "stage not found" });
        return;
      }

      reply.header("cache-control", "no-store");
      return stage;
    } catch (error) {
      sendClientError(reply, error);
    }
  });

  app.get("/config", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return configAdmin.configSnapshot();
  });

  app.put("/config", async (request: FastifyRequest<{ Body: Record<string, unknown> }>, reply) => {
    try {
      return await configAdmin.updateConfig(request.body ?? {});
    } catch (error) {
      sendClientError(reply, error);
    }
  });

  app.get("/config/raw", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return {
      content: await configAdmin.rawDocument(),
    };
  });

  app.get("/config/agents", async () => configAdmin.listAgents());

  app.put("/config/agents/:name", async (request: FastifyRequest<{
    Params: { name: string };
    Body: Record<string, unknown>;
  }>, reply) => {
    try {
      return await configAdmin.saveAgent(request.params.name, {
        backend: typeof request.body?.backend === "string" ? request.body.backend : undefined,
        model: typeof request.body?.model === "string" ? request.body.model : undefined,
        reasoningEffort: typeof request.body?.reasoningEffort === "string"
          ? request.body.reasoningEffort
          : typeof request.body?.reasoning_effort === "string"
            ? request.body.reasoning_effort
            : undefined,
        prompt: typeof request.body?.prompt === "string" ? request.body.prompt : undefined,
        timeoutMs: typeof request.body?.timeoutMs === "number"
          ? request.body.timeoutMs
          : Number.isFinite(Number(request.body?.timeoutMs))
            ? Number(request.body.timeoutMs)
            : undefined,
      });
    } catch (error) {
      sendClientError(reply, error);
    }
  });

  app.delete("/config/agents/:name", async (request: FastifyRequest<{
    Params: { name: string };
  }>, reply) => {
    try {
      return await configAdmin.deleteAgent(request.params.name);
    } catch (error) {
      sendClientError(reply, error);
    }
  });

  app.get("/config/backends", async () => configAdmin.backends());

  app.put("/config/backends/:name", async (request: FastifyRequest<{
    Params: { name: string };
    Body: Record<string, unknown>;
  }>, reply) => {
    try {
      return await configAdmin.saveBackend(request.params.name, {
        command: typeof request.body?.command === "string" ? request.body.command : undefined,
      });
    } catch (error) {
      sendClientError(reply, error);
    }
  });

  app.get("/config/workflows", async () => configAdmin.workflows());

  app.post("/config/workflows/preview", async (request: FastifyRequest<{
    Body: Record<string, unknown>;
  }>, reply) => {
    try {
      return await configAdmin.previewWorkflow({
        name: typeof request.body?.name === "string" ? request.body.name : "",
        rawDot: typeof request.body?.rawDot === "string" ? request.body.rawDot : "",
        successState: typeof request.body?.successState === "string" ? request.body.successState : undefined,
        inspectPr: typeof request.body?.inspectPr === "boolean" ? request.body.inspectPr : undefined,
        labels: Array.isArray(request.body?.labels)
          ? request.body.labels.map((label) => String(label)).filter(Boolean)
          : undefined,
        isDefault: typeof request.body?.isDefault === "boolean" ? request.body.isDefault : undefined,
      });
    } catch (error) {
      sendClientError(reply, error);
    }
  });

  app.get("/config/workflows/:name", async (request: FastifyRequest<{
    Params: { name: string };
  }>, reply) => {
    try {
      const workflow = await configAdmin.workflow(request.params.name);
      if (!workflow) {
        reply.status(404).send({ error: "workflow not found" });
        return;
      }

      return workflow;
    } catch (error) {
      sendClientError(reply, error);
    }
  });

  app.put("/config/workflows/:name", async (request: FastifyRequest<{
    Params: { name: string };
    Body: Record<string, unknown>;
  }>, reply) => {
    try {
      const workflow = await configAdmin.saveWorkflow(request.params.name, {
        rawDot: typeof request.body?.rawDot === "string" ? request.body.rawDot : undefined,
        successState: typeof request.body?.successState === "string" ? request.body.successState : undefined,
        inspectPr: typeof request.body?.inspectPr === "boolean" ? request.body.inspectPr : undefined,
        labels: Array.isArray(request.body?.labels)
          ? request.body.labels.map((label) => String(label)).filter(Boolean)
          : undefined,
        isDefault: typeof request.body?.isDefault === "boolean" ? request.body.isDefault : undefined,
      });
      if (!workflow) {
        reply.status(404).send({ error: "workflow not found" });
        return;
      }

      return workflow;
    } catch (error) {
      sendClientError(reply, error);
    }
  });

  app.delete("/config/workflows/:name", async (request: FastifyRequest<{
    Params: { name: string };
  }>, reply) => {
    try {
      return await configAdmin.deleteWorkflow(request.params.name);
    } catch (error) {
      sendClientError(reply, error);
    }
  });

  app.get("/config/skills", async () => configAdmin.skills());

  app.put("/config/skills/:name", async (request: FastifyRequest<{
    Params: { name: string };
    Body: Record<string, unknown>;
  }>, reply) => {
    try {
      return await configAdmin.saveSkill(
        request.params.name,
        typeof request.body?.content === "string" ? request.body.content : "",
      );
    } catch (error) {
      sendClientError(reply, error);
    }
  });

  app.delete("/config/skills/:name", async (request: FastifyRequest<{
    Params: { name: string };
  }>, reply) => {
    try {
      return await configAdmin.deleteSkill(request.params.name);
    } catch (error) {
      sendClientError(reply, error);
    }
  });

  app.get("/events", async (request: FastifyRequest<{
    Querystring: {
      after?: string;
    };
  }>, reply) => {
    replyWithCors(reply, opts.corsOrigin);
    reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
    reply.raw.setHeader("cache-control", "no-cache, no-transform");
    reply.raw.setHeader("connection", "keep-alive");
    reply.raw.flushHeaders?.();
    reply.hijack();

    const write = (payload: string) => {
      reply.raw.write(payload);
    };
    const afterSequence = resolveEventReplayCursor({
      lastEventId: request.headers["last-event-id"],
      after: request.query.after,
    });
    const formatEvent = (event: VajraEvent, sequence?: number) => {
      const payload = { ...(event as VajraEvent & { _sequence?: number }) };
      delete payload._sequence;
      return `${sequence !== undefined ? `id: ${sequence}\n` : ""}data: ${JSON.stringify(payload)}\n\n`;
    };
    const listener = (event: VajraEvent) => {
      const liveSequence = (event as VajraEvent & { _sequence?: number })._sequence;
      const sequence = Number.isFinite(liveSequence) && (liveSequence ?? 0) > 0
        ? Number(liveSequence)
        : undefined;
      write(formatEvent(event, sequence));
    };
    const heartbeat = setInterval(() => {
      write(": ping\n\n");
    }, 15_000);
    const cleanup = () => {
      clearInterval(heartbeat);
      opts.eventBus.offAny(listener);
      request.raw.off("close", cleanup);
      request.raw.off("error", cleanup);
      reply.raw.end();
    };

    if (afterSequence !== undefined) {
      const replay = await readLoggedEvents({
        logsRoot: opts.logsRoot,
        afterSequence,
      });
      for (const entry of replay) {
        write(formatEvent(entry.event, entry.sequence));
      }
    }

    opts.eventBus.onAny(listener);
    request.raw.on("close", cleanup);
    request.raw.on("error", cleanup);
    write(": connected\n\n");
  });

  app.addHook("onClose", async () => {
    runtimeState.close();
  });

  return app;
}

#!/usr/bin/env node
import os from "node:os";
import path from "node:path";

import { createApiServer } from "./api/server";
import { VajraEventBus } from "./events";
import { LocalPipelineRunner } from "./pipeline";
import { LinearTrackerClient } from "./tracker";
import { LogEventSubscriber } from "./subscribers/log";
import { EventLogSubscriber } from "./subscribers/event-log";
import { SlackEventSubscriber } from "./subscribers/slack";
import { WorkflowFileStore } from "./workflow-store";
import { WorkspaceManager } from "./workspace";
import { VajraOrchestrator } from "./orchestrator";
import { ReviewLoopService } from "./review-loop";
import { requireConfiguredApiKey } from "./runtime-config";

async function main(): Promise<void> {
  const workflowPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(process.cwd(), "WORKFLOW.md");
  const logsRoot = process.argv[3]
    ? path.resolve(process.argv[3])
    : process.env.VAJRA_LOGS_ROOT
      ? path.resolve(process.env.VAJRA_LOGS_ROOT)
      : path.join(os.homedir(), ".vajra-runs");
  const eventBus = new VajraEventBus();
  const logSubscriber = new LogEventSubscriber(eventBus);
  const eventLogSubscriber = await EventLogSubscriber.create(eventBus, logsRoot);

  const workflowStore = new WorkflowFileStore(workflowPath);
  const workflow = await workflowStore.load();
  await workflowStore.watch();
  const slackSubscriber = new SlackEventSubscriber(eventBus, workflowStore);

  const tracker = new LinearTrackerClient(workflow.config.tracker);
  const pipelineRunner = new LocalPipelineRunner(logsRoot, undefined, undefined, eventBus);
  const reviewLoop = new ReviewLoopService(workflowStore, tracker);
  const apiKey = requireConfiguredApiKey(process.env.VAJRA_API_KEY);
  const orchestrator = new VajraOrchestrator(
    tracker,
    workflowStore,
    pipelineRunner,
    () => new WorkspaceManager(workflowStore.current().config.workspace, workflowStore.current().config.hooks, undefined, eventBus),
    undefined,
    eventBus,
    { logsRoot },
    ({ issue, workflowName }) => reviewLoop.prepareRun({ issue, workflowName }),
  );
  const apiServer = createApiServer({
    eventBus,
    orchestrator,
    workflowStore,
    logsRoot,
    apiKey,
    corsOrigin: process.env.VAJRA_CORS_ORIGIN,
    reviewLoop,
  });
  const apiPort = Number.parseInt(process.env.VAJRA_API_PORT ?? "3847", 10);
  const apiHost = process.env.VAJRA_API_HOST ?? "0.0.0.0";
  await apiServer.listen({
    host: apiHost,
    port: Number.isFinite(apiPort) && apiPort > 0 ? apiPort : 3847,
  });
  await orchestrator.startup();
  await orchestrator.tick();

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const scheduleNextTick = () => {
    if (stopped) {
      return;
    }

    timer = setTimeout(() => {
      void orchestrator.tick()
        .catch((error) => {
          console.error(JSON.stringify({
            message: "orchestrator tick failed",
            error: error instanceof Error ? error.message : String(error),
          }));
        })
        .finally(() => {
          scheduleNextTick();
        });
    }, workflowStore.current().config.polling.intervalMs);
  };

  const shutdown = async (signal: string) => {
    if (stopped) {
      return;
    }

    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    await orchestrator.shutdown();
    await apiServer.close();
    await workflowStore.close();
    await eventLogSubscriber.close();
    slackSubscriber.close();
    logSubscriber.close();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  scheduleNextTick();
}

void main().catch((error) => {
  console.error(JSON.stringify({
    message: "vajra failed to start",
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});

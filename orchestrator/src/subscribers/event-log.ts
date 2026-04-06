import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { VajraEvent, VajraEventBus } from "../events";
import { eventLogPath, readLoggedEvents } from "../api/run-history";

const LOGGED_EVENT_TYPES = new Set<VajraEvent["type"]>([
  "issue:triaged",
  "issue:dispatched",
  "pipeline:stage:start",
  "pipeline:stage:complete",
  "issue:completed",
  "issue:escalated",
  "issue:failed",
  "issue:cancelled",
  "issue:retry:scheduled",
]);

export class EventLogSubscriber {
  private writes = Promise.resolve();

  private readonly listener = (event: VajraEvent) => {
    if (!LOGGED_EVENT_TYPES.has(event.type)) {
      return;
    }

    const targetPath = eventLogPath(this.logsRoot);
    this.writes = this.writes
      .then(async () => {
        await mkdir(path.dirname(targetPath), { recursive: true });
        await appendFile(targetPath, `${JSON.stringify(event)}\n`, "utf8");
      })
      .catch((error) => {
        console.error(JSON.stringify({
          message: "vajra event log write failed",
          error: error instanceof Error ? error.message : String(error),
          eventType: event.type,
        }));
      });
  };

  private constructor(
    private readonly eventBus: VajraEventBus,
    private readonly logsRoot: string,
  ) {
    this.eventBus.onAny(this.listener);
  }

  static async create(
    eventBus: VajraEventBus,
    logsRoot: string,
  ): Promise<EventLogSubscriber> {
    const existingEvents = await readLoggedEvents({ logsRoot });
    eventBus.initializeSequence(existingEvents.at(-1)?.sequence ?? 0);
    return new EventLogSubscriber(eventBus, logsRoot);
  }

  async close(): Promise<void> {
    this.eventBus.offAny(this.listener);
    await this.writes;
  }
}

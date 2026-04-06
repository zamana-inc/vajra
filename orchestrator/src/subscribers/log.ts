import { VajraEvent, VajraEventBus } from "../events";
import { log } from "../logger";

function eventData(event: VajraEvent): Record<string, unknown> {
  const { type: _type, timestamp: _timestamp, ...data } = event;
  return data;
}

export class LogEventSubscriber {
  private readonly listener = (event: VajraEvent) => {
    log(event.type, eventData(event), event.timestamp);
  };

  constructor(private readonly eventBus: VajraEventBus) {
    this.eventBus.onAny(this.listener);
  }

  close(): void {
    this.eventBus.offAny(this.listener);
  }
}

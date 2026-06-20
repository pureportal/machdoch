import type { ScheduledTriggerEventInput } from "../scheduler.js";
import type {
  RalphWatchDefinition,
  RalphWatchFileEvent,
} from "../ralph-watches.js";
import { createRalphWatchEventPayload } from "./create-ralph-watch-event-payload.helper.js";

export const createRalphWatchTriggerEventInput = (
  watchDefinition: RalphWatchDefinition,
  event: RalphWatchFileEvent,
): ScheduledTriggerEventInput => ({
  type: `workspace-file.${event.type}`,
  kind: "workspace-file",
  source: "watcher",
  workspaceRoot: watchDefinition.executionWorkspaceRoot,
  payload: createRalphWatchEventPayload(watchDefinition, event),
  dedupeKey: `${watchDefinition.id}:${event.type}:${event.path}:${event.mtimeMs ?? event.occurredAt}`,
  occurredAt: event.occurredAt,
});

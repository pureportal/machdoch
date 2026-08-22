import type {
  RalphWatchDefinition,
  RalphWatchFileEvent,
} from "../ralph-watches.js";

export const createRalphWatchEventPayload = (
  watchDefinition: RalphWatchDefinition,
  event: RalphWatchFileEvent,
): Record<string, unknown> => ({
  watchId: watchDefinition.id,
  eventType: event.type,
  path: event.path,
  rootPath: event.rootPath,
  relativePath: event.relativePath,
  size: event.size,
  mtimeMs: event.mtimeMs,
  isDirectory: event.isDirectory,
  flowScope: watchDefinition.flow.scope,
  flowId: watchDefinition.flow.id,
});

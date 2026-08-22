import type { RalphWatchEventType } from "../ralph-watches.js";

const RALPH_WATCH_EVENT_TYPES = [
  "created",
  "changed",
  "deleted",
  "renamed",
] as const;

export const normalizeRalphWatchEvents = (
  events: RalphWatchEventType[] | undefined,
): RalphWatchEventType[] => {
  const normalized = Array.from(
    new Set(
      (events && events.length > 0 ? events : ["created", "changed"])
        .filter((event): event is RalphWatchEventType =>
          RALPH_WATCH_EVENT_TYPES.includes(event as RalphWatchEventType),
        ),
    ),
  );

  if (normalized.length === 0) {
    throw new Error("Expected Ralph watch to include at least one event type.");
  }

  return normalized;
};

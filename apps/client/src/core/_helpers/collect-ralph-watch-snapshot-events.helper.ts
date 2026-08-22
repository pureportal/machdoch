import type { RalphWatchEventType } from "../ralph-watches.js";
import type { RalphWatchFileSnapshot } from "./scan-ralph-watch-files.helper.js";

export interface RalphWatchSnapshotEvent {
  eventType: RalphWatchEventType;
  path: string;
  snapshot: RalphWatchFileSnapshot | undefined;
}

export const collectRalphWatchSnapshotEvents = (
  previous: ReadonlyMap<string, RalphWatchFileSnapshot>,
  current: ReadonlyMap<string, RalphWatchFileSnapshot>,
): RalphWatchSnapshotEvent[] => {
  const events: RalphWatchSnapshotEvent[] = [];

  for (const [path, snapshot] of current.entries()) {
    const oldSnapshot = previous.get(path);

    if (!oldSnapshot) {
      events.push({ eventType: "created", path, snapshot });
      continue;
    }

    if (oldSnapshot.size !== snapshot.size || oldSnapshot.mtimeMs !== snapshot.mtimeMs) {
      events.push({ eventType: "changed", path, snapshot });
    }
  }

  for (const [path, snapshot] of previous.entries()) {
    if (!current.has(path)) {
      events.push({ eventType: "deleted", path, snapshot });
    }
  }

  return events;
};

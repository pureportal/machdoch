import { relative, sep } from "node:path";
import type {
  RalphWatchEventType,
  RalphWatchFileEvent,
  RalphWatchRoot,
} from "../ralph-watches.js";
import type { RalphWatchFileSnapshot } from "./scan-ralph-watch-files.helper.js";

export interface CreateRalphWatchFileEventInput {
  root: RalphWatchRoot;
  eventType: RalphWatchEventType;
  path: string;
  snapshot: RalphWatchFileSnapshot | undefined;
  occurredAt: number;
}

export const createRalphWatchFileEvent = ({
  root,
  eventType,
  path,
  snapshot,
  occurredAt,
}: CreateRalphWatchFileEventInput): RalphWatchFileEvent => ({
  type: eventType,
  path,
  rootPath: root.path,
  relativePath: relative(root.path, path).split(sep).join("/"),
  ...(snapshot?.size !== undefined ? { size: snapshot.size } : {}),
  ...(snapshot?.mtimeMs !== undefined ? { mtimeMs: snapshot.mtimeMs } : {}),
  ...(snapshot?.isDirectory !== undefined ? { isDirectory: snapshot.isDirectory } : {}),
  occurredAt,
});

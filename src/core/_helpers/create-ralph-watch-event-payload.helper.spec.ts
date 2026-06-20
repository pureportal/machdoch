import { createRalphWatchEventPayload } from "./create-ralph-watch-event-payload.helper.ts";
import type {
  RalphWatchDefinition,
  RalphWatchFileEvent,
} from "../ralph-watches.ts";

const createWatchDefinition = (): RalphWatchDefinition => ({
  id: "watch-1",
  enabled: true,
  flow: { scope: "workspace", id: "flow-1" },
  executionWorkspaceRoot: "C:\\Workspace",
  roots: [],
  events: ["changed"],
  params: {},
  permissions: {
    allowedRoots: ["C:\\Workspace"],
    allowCommands: false,
    allowWrites: false,
    allowNetwork: false,
    allowMcpTools: false,
  },
  debounceMs: 1_000,
  stabilityMs: 300,
  pollIntervalMs: 5_000,
  maxEventsPerWindow: { maxEvents: 100, windowMs: 60_000 },
  concurrencyLimit: 1,
  createdAt: "2026-06-19T00:00:00.000Z",
  updatedAt: "2026-06-19T00:00:00.000Z",
});

describe("createRalphWatchEventPayload", () => {
  it("maps watch metadata and file event fields into scheduler payload shape", () => {
    const event: RalphWatchFileEvent = {
      type: "changed",
      path: "C:\\Workspace\\src\\app.ts",
      rootPath: "C:\\Workspace",
      relativePath: "src/app.ts",
      size: 42,
      mtimeMs: 123,
      isDirectory: false,
      occurredAt: 456,
    };

    expect(createRalphWatchEventPayload(createWatchDefinition(), event)).toEqual({
      watchId: "watch-1",
      eventType: "changed",
      path: "C:\\Workspace\\src\\app.ts",
      rootPath: "C:\\Workspace",
      relativePath: "src/app.ts",
      size: 42,
      mtimeMs: 123,
      isDirectory: false,
      flowScope: "workspace",
      flowId: "flow-1",
    });
  });
});

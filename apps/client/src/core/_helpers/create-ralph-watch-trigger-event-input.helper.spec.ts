import { createRalphWatchTriggerEventInput } from "./create-ralph-watch-trigger-event-input.helper.ts";
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

describe("createRalphWatchTriggerEventInput", () => {
  it("creates scheduler trigger events from Ralph watch file events", () => {
    const event: RalphWatchFileEvent = {
      type: "changed",
      path: "C:\\Workspace\\src\\app.ts",
      rootPath: "C:\\Workspace",
      relativePath: "src/app.ts",
      size: 42,
      mtimeMs: 123,
      occurredAt: 456,
    };

    expect(createRalphWatchTriggerEventInput(createWatchDefinition(), event)).toEqual({
      type: "workspace-file.changed",
      kind: "workspace-file",
      source: "watcher",
      workspaceRoot: "C:\\Workspace",
      payload: {
        watchId: "watch-1",
        eventType: "changed",
        path: "C:\\Workspace\\src\\app.ts",
        rootPath: "C:\\Workspace",
        relativePath: "src/app.ts",
        size: 42,
        mtimeMs: 123,
        isDirectory: undefined,
        flowScope: "workspace",
        flowId: "flow-1",
      },
      dedupeKey: "watch-1:changed:C:\\Workspace\\src\\app.ts:123",
      occurredAt: 456,
    });
  });

  it("uses occurredAt as the dedupe time when mtimeMs is absent", () => {
    const event: RalphWatchFileEvent = {
      type: "deleted",
      path: "C:\\Workspace\\old.ts",
      rootPath: "C:\\Workspace",
      relativePath: "old.ts",
      occurredAt: 789,
    };

    expect(createRalphWatchTriggerEventInput(createWatchDefinition(), event)).toMatchObject({
      type: "workspace-file.deleted",
      dedupeKey: "watch-1:deleted:C:\\Workspace\\old.ts:789",
      occurredAt: 789,
    });
  });
});

import type {
  RalphFlowScope,
  RalphRunSummary,
} from "../../../../core/ralph.js";
import type { ActiveDesktopTaskSummary } from "../../runtime";
import {
  getRalphLibraryKey,
  type RalphOverviewLibrary,
} from "../ralph-overview-model";

export const createOverviewLibrary = (
  workspaceRoot: string,
  scope: RalphFlowScope = "workspace",
): RalphOverviewLibrary => ({
  key: getRalphLibraryKey(workspaceRoot, scope),
  workspaceRoot,
  scope,
  loaded: true,
  loading: false,
  error: null,
  flows: [
    {
      id: "release",
      alias: "ship",
      name: "Release",
      path: `${workspaceRoot}/flow.json`,
      blockCount: 2,
      edgeCount: 1,
      variableCount: 0,
      variables: [],
    },
  ],
  runs: [],
});

export const createOverviewTask = (
  workspaceRoot: string,
  id = workspaceRoot,
  scope: RalphFlowScope = "workspace",
): ActiveDesktopTaskSummary => ({
  id,
  kind: "ralph",
  workspaceRoot,
  arguments: ["run", "ship", "--scope", scope],
  startedAt: Date.parse("2026-09-10T12:00:00.000Z"),
});

export const createOverviewRun = (
  overrides: Partial<RalphRunSummary> = {},
): RalphRunSummary => ({
  id: "run-1",
  path: "/run.json",
  flowId: "release",
  flowName: "Release",
  status: "completed",
  createdAt: "2026-09-10T12:00:00.000Z",
  recoverable: false,
  summary: "Done",
  blockCount: 2,
  eventCount: 3,
  ...overrides,
});

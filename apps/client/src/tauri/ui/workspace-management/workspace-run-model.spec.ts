import { describe, expect, it } from "vitest";
import type { WorkspaceRunConfigurationStatus } from "../../../shared/workspace-run.js";
import {
  applyWorkspaceRunLogBatch,
  collectWorkspaceRunLogs,
  mergeWorkspaceRunSnapshotLogs,
  workspaceRunDirectAction,
  workspaceRunStatusPresentation,
  workspaceRunSupportsHotReload,
} from "./workspace-run-model";

const taskStatus = (
  id: string,
  hotReload: boolean,
): WorkspaceRunConfigurationStatus => ({
  configuration: {
    id,
    name: id,
    kind: "task",
    primary: false,
    command: "example",
    workingDirectory: ".",
    environment: {},
    hotReload,
    ports: [],
    urls: [],
    restartPolicy: {
      onCrash: false,
      maxRestarts: 5,
      windowMs: 60_000,
      backoffMs: 1_000,
      maxBackoffMs: 30_000,
    },
  },
  state: "stopped",
  pid: null,
  startedAt: null,
  stoppedAt: null,
  exitCode: null,
  restartCount: 0,
  health: null,
  recentFailures: [],
  logs: [],
  children: [],
});

describe("workspace run model", () => {
  it("distinguishes hot reload from manual restart tasks and composites", () => {
    const composite: WorkspaceRunConfigurationStatus = {
      ...taskStatus("fullstack", false),
      configuration: {
        id: "fullstack",
        name: "Fullstack Start",
        kind: "composite",
        primary: true,
        children: ["backend", "frontend"],
        startOrder: "parallel",
      },
      children: [taskStatus("backend", true), taskStatus("frontend", true)],
    };

    expect(workspaceRunSupportsHotReload(taskStatus("worker", false))).toBe(
      false,
    );
    expect(workspaceRunSupportsHotReload(composite)).toBe(true);
    composite.children[1] = taskStatus("frontend", false);
    expect(workspaceRunSupportsHotReload(composite)).toBe(false);
  });

  it("selects direct recovery actions from lifecycle state", () => {
    const stopped = taskStatus("stopped", false);
    const crashed = {
      ...taskStatus("crashed", false),
      state: "crashed" as const,
    };
    const running = {
      ...taskStatus("running", false),
      state: "running" as const,
      pid: 42,
    };
    const terminalUnhealthy = {
      ...taskStatus("unhealthy", false),
      state: "unhealthy" as const,
    };
    const liveUnhealthy = { ...terminalUnhealthy, pid: 42 };
    const stopping = {
      ...taskStatus("stopping", false),
      state: "stopping" as const,
    };

    expect(workspaceRunDirectAction(stopped)).toBe("start");
    expect(workspaceRunDirectAction(crashed)).toBe("start");
    expect(workspaceRunDirectAction(running)).toBe("stop");
    expect(workspaceRunDirectAction(terminalUnhealthy)).toBe("start");
    expect(workspaceRunDirectAction(liveUnhealthy)).toBe("stop");
    expect(workspaceRunDirectAction(stopping)).toBe("none");
  });

  it("distinguishes successful completion from an explicit stop", () => {
    const completed = {
      ...taskStatus("completed", false),
      startedAt: 1,
      stoppedAt: 2,
      exitCode: 0,
    };

    expect(workspaceRunStatusPresentation(completed).label).toBe("Completed");
    expect(
      workspaceRunStatusPresentation(taskStatus("never-started", false)).label,
    ).toBe("Stopped");
  });

  it("merges composite output by canonical sequence", () => {
    const backend = taskStatus("backend", false);
    backend.logs = [
      { sequence: 3, at: 1, stream: "stderr", line: "backend error" },
    ];
    const frontend = taskStatus("frontend", true);
    frontend.logs = [
      { sequence: 2, at: 2, stream: "stdout", line: "frontend ready" },
    ];
    const composite: WorkspaceRunConfigurationStatus = {
      ...taskStatus("fullstack", false),
      configuration: {
        id: "fullstack",
        name: "Fullstack",
        kind: "composite",
        primary: true,
        children: ["backend", "frontend"],
        startOrder: "parallel",
      },
      children: [backend, frontend],
    };

    expect(
      collectWorkspaceRunLogs(composite).map(({ label, entry }) => [
        label,
        entry.line,
      ]),
    ).toEqual([
      ["frontend", "frontend ready"],
      ["backend", "backend error"],
    ]);
  });

  it("applies bounded log batches to tasks and composite children", () => {
    const backend = taskStatus("backend", false);
    backend.startedAt = 1;
    const composite: WorkspaceRunConfigurationStatus = {
      ...taskStatus("fullstack", false),
      configuration: {
        id: "fullstack",
        name: "Fullstack",
        kind: "composite",
        primary: true,
        children: ["backend"],
        startOrder: "parallel",
      },
      children: [backend],
    };
    const entries = Array.from({ length: 405 }, (_, index) => ({
      configurationId: "backend",
      startedAt: 1,
      entry: {
        sequence: index + 1,
        at: index,
        stream: "stdout" as const,
        line: `line-${index + 1}`,
      },
    }));
    entries.push({
      configurationId: "backend",
      startedAt: 2,
      entry: {
        sequence: 999,
        at: 999,
        stream: "stdout",
        line: "stale-run",
      },
    });

    const updated = applyWorkspaceRunLogBatch(
      {
        workspaceRoot: "C:/workspace",
        primaryConfigurationId: "fullstack",
        configurations: [backend, composite],
      },
      { workspaceRoot: "C:/workspace", entries },
    );

    expect(updated.configurations[0]?.logs).toHaveLength(400);
    expect(updated.configurations[0]?.logs[0]?.line).toBe("line-6");
    expect(updated.configurations[0]?.logs.at(-1)?.line).toBe("line-405");
    expect(updated.configurations[1]?.children[0]?.logs.at(-1)?.line).toBe(
      "line-405",
    );
  });

  it("preserves newer streamed output when a state snapshot arrives", () => {
    const previous = taskStatus("server", false);
    previous.startedAt = 10;
    previous.logs = [{ sequence: 2, at: 2, stream: "stdout", line: "newer" }];
    const next = taskStatus("server", false);
    next.startedAt = 10;
    next.logs = [{ sequence: 1, at: 1, stream: "stdout", line: "older" }];

    const merged = mergeWorkspaceRunSnapshotLogs(
      {
        workspaceRoot: "C:/workspace",
        primaryConfigurationId: "server",
        configurations: [previous],
      },
      {
        workspaceRoot: "C:/workspace",
        primaryConfigurationId: "server",
        configurations: [next],
      },
    );

    expect(merged.configurations[0]?.logs.map((entry) => entry.line)).toEqual([
      "older",
      "newer",
    ]);
    next.startedAt = 11;
    expect(
      mergeWorkspaceRunSnapshotLogs(
        {
          workspaceRoot: "C:/workspace",
          primaryConfigurationId: "server",
          configurations: [previous],
        },
        {
          workspaceRoot: "C:/workspace",
          primaryConfigurationId: "server",
          configurations: [next],
        },
      ).configurations[0]?.logs,
    ).toEqual(next.logs);
  });
});

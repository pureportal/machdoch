import { describe, expect, it } from "vitest";
import type {
  WorkspaceRunConfigurationStatus,
  WorkspaceRunInput,
} from "../../../shared/workspace-run.js";
import {
  applyWorkspaceRunLogBatch,
  collectWorkspaceRunLogs,
  formatWorkspaceRunDuration,
  mergeWorkspaceRunSnapshotLogs,
  workspaceRunCommandPreview,
  workspaceRunDirectAction,
  workspaceRunElapsed,
  workspaceRunInitialInputValues,
  workspaceRunInputErrors,
  workspaceRunInputValueLabel,
  workspaceRunListSections,
  workspaceRunStatusInputs,
  workspaceRunStatusPresentation,
  workspaceRunSupportsHotReload,
  workspaceRunType,
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
    runType: "service",
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
  inputValues: {},
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
        inputs: [],
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
        inputs: [],
        configurations: [previous],
      },
      {
        workspaceRoot: "C:/workspace",
        primaryConfigurationId: "server",
        inputs: [],
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
          inputs: [],
          configurations: [previous],
        },
        {
          workspaceRoot: "C:/workspace",
          primaryConfigurationId: "server",
          inputs: [],
          configurations: [next],
        },
      ).configurations[0]?.logs,
    ).toEqual(next.logs);
  });

  it("classifies jobs and presents their outcomes", () => {
    const job = (
      id: string,
      overrides: Partial<WorkspaceRunConfigurationStatus> = {},
    ): WorkspaceRunConfigurationStatus => {
      const status = taskStatus(id, false);
      return {
        ...status,
        configuration: { ...status.configuration, runType: "job" } as never,
        ...overrides,
      };
    };
    const sequence: WorkspaceRunConfigurationStatus = {
      ...taskStatus("reset", false),
      configuration: {
        id: "reset",
        name: "Reset",
        kind: "composite",
        primary: false,
        children: ["migrate", "seed"],
        startOrder: "sequence",
      },
      children: [job("migrate"), job("seed")],
    };

    expect(workspaceRunType(sequence)).toBe("job");
    sequence.children[1] = taskStatus("server", false);
    expect(workspaceRunType(sequence)).toBe("service");
    expect(workspaceRunStatusPresentation(job("migrate")).label).toBe(
      "Not run",
    );
    expect(
      workspaceRunStatusPresentation(
        job("migrate", { state: "crashed", startedAt: 1, exitCode: 1 }),
      ),
    ).toEqual({ label: "Failed", tone: "danger" });
    expect(
      workspaceRunStatusPresentation(
        taskStatus("server", false) as WorkspaceRunConfigurationStatus,
      ).label,
    ).toBe("Stopped");
  });

  it("groups configurations into service and job sections and filters them", () => {
    const grouped = (
      id: string,
      runType: "service" | "job",
      group?: string,
    ): WorkspaceRunConfigurationStatus => {
      const status = taskStatus(id, false);
      return {
        ...status,
        configuration: {
          ...status.configuration,
          runType,
          ...(group ? { group } : {}),
        } as never,
      };
    };
    const statuses = [
      grouped("deploy", "job", "Infra"),
      grouped("api", "service"),
      grouped("lint", "job"),
      grouped("diff", "job", "Infra"),
    ];

    expect(
      workspaceRunListSections(statuses, "").map((section) => [
        section.runType,
        section.groups.map((group) => [
          group.name,
          group.statuses.map((status) => status.configuration.id),
        ]),
      ]),
    ).toEqual([
      ["service", [[null, ["api"]]]],
      [
        "job",
        [
          [null, ["lint"]],
          ["Infra", ["deploy", "diff"]],
        ],
      ],
    ]);
    expect(
      workspaceRunListSections(statuses, "infra").flatMap((section) =>
        section.groups.flatMap((group) =>
          group.statuses.map((status) => status.configuration.id),
        ),
      ),
    ).toEqual(["deploy", "diff"]);
  });

  it("derives arguments, validation, previews, and labels for a run", () => {
    const inputs: WorkspaceRunInput[] = [
      {
        type: "select",
        id: "env",
        label: "Environment",
        options: [{ value: "dev", label: "Development" }, { value: "prod" }],
      },
      {
        type: "boolean",
        id: "write",
        label: "Write files",
        default: false,
        trueValue: "--write",
        falseValue: "",
      },
      {
        type: "text",
        id: "name",
        label: "Name",
        default: "",
        required: true,
      },
    ];
    const status = taskStatus("sync", false);
    status.configuration = {
      ...status.configuration,
      command: "npm run env:sync -- --env ${input:env} ${input:write}",
    } as never;

    const statusInputs = workspaceRunStatusInputs(status, inputs);
    const values = workspaceRunInitialInputValues(statusInputs);

    expect(statusInputs.map((input) => input.id)).toEqual(["env", "write"]);
    expect(values).toEqual({ env: "dev", write: false });
    expect(workspaceRunCommandPreview(status, inputs, { ...values, write: true }))
      .toBe("npm run env:sync -- --env dev --write");
    expect(workspaceRunInputErrors(inputs, { name: " " })).toEqual({
      name: "Name is required.",
    });
    expect(workspaceRunInputValueLabel(inputs[0]!, "dev")).toBe("Development");
    expect(workspaceRunInputValueLabel(inputs[0]!, "prod")).toBe("prod");
    expect(workspaceRunInputValueLabel(inputs[1]!, true)).toBe("On");
  });

  it("formats run durations for running and finished runs", () => {
    const running = {
      ...taskStatus("server", false),
      state: "running" as const,
      startedAt: 1_000,
    };
    const finished = {
      ...taskStatus("build", false),
      startedAt: 1_000,
      stoppedAt: 5_200,
      exitCode: 0,
    };

    expect(workspaceRunElapsed(running, 61_000)).toBe(60_000);
    expect(workspaceRunElapsed(finished, 99_000)).toBe(4_200);
    expect(workspaceRunElapsed(taskStatus("idle", false), 1)).toBeNull();
    expect(formatWorkspaceRunDuration(4_200)).toBe("4.2s");
    expect(formatWorkspaceRunDuration(42_000)).toBe("42s");
    expect(formatWorkspaceRunDuration(192_000)).toBe("3m 12s");
    expect(formatWorkspaceRunDuration(3_840_000)).toBe("1h 4m");
  });
});

import { describe, expect, it } from "vitest";
import { getRalphOverviewRuns } from "./ralph-overview-model";
import {
  createOverviewLibrary,
  createOverviewRun,
  createOverviewTask,
} from "./__test__/ralph-overview-fixtures";

describe("RALPH overview activity", () => {
  it("keeps identical flow ids in different workspaces and scopes distinct", () => {
    const first = createOverviewLibrary("C:/one");
    const second = createOverviewLibrary("C:/two");
    const global = createOverviewLibrary("C:/one", "user");
    first.runs = [createOverviewRun({ status: "running" })];
    second.runs = [createOverviewRun({ status: "running" })];
    global.runs = [createOverviewRun({ status: "running" })];
    const runs = getRalphOverviewRuns(
      [first, second, global],
      [
        createOverviewTask("\\\\?\\C:\\One\\", "first"),
        createOverviewTask("C:/two", "second"),
        createOverviewTask("C:/two", "global", "user"),
      ],
    );
    expect(runs).toHaveLength(3);
    expect(
      runs.map((run) => [
        run.taskId,
        run.flowName,
        run.scope,
        run.workspaceRoot,
      ]),
    ).toEqual([
      ["first", "Release", "workspace", "\\\\?\\C:\\One\\"],
      ["global", "Release", "user", "C:/two"],
      ["second", "Release", "workspace", "C:/two"],
    ]);
  });

  it("matches each active task once and lets a resumed task override its old terminal record", () => {
    const library = createOverviewLibrary("/one");
    library.runs = [
      createOverviewRun({ id: "crashed", status: "crashed" }),
      createOverviewRun({ status: "running" }),
      createOverviewRun({
        id: "run-2",
        status: "running",
        createdAt: "2026-09-10T12:00:02.000Z",
      }),
    ];
    const resume = {
      ...createOverviewTask("/one", "resume"),
      arguments: ["resume", "crashed"],
    };
    const runs = getRalphOverviewRuns(
      [library],
      [
        createOverviewTask("/one", "first"),
        {
          ...createOverviewTask("/one", "second"),
          startedAt: Date.parse("2026-09-10T12:00:02.000Z"),
        },
        resume,
      ],
    );
    expect(runs).toHaveLength(3);
    expect(runs.find((run) => run.taskId === "resume")?.runId).toBe("crashed");
    expect(runs.find((run) => run.taskId === "first")?.runId).toBe("run-1");
    expect(runs.find((run) => run.taskId === "second")?.runId).toBe("run-2");
  });

  it("shows activity before history loads, excluding status queries", () => {
    const task = createOverviewTask("/unlisted");
    const runs = getRalphOverviewRuns(
      [],
      [
        task,
        { ...task, id: "query", arguments: ["snapshot"] },
        {
          ...task,
          id: "generation",
          arguments: ["create", "--name", "New flow"],
        },
      ],
    );
    expect(runs).toHaveLength(2);
    expect(runs.find((run) => run.key === task.id)).toMatchObject({
      flowId: "ship",
      workspaceRoot: "/unlisted",
      status: "running",
    });
    expect(runs.find((run) => run.key === "generation")).toMatchObject({
      flowName: "New flow",
      status: "generating",
    });
  });

  it("includes CLI runs and leaves unknown global workspace attribution unset", () => {
    const library = createOverviewLibrary("/one", "user");
    library.runs = [
      createOverviewRun({ status: "running", workspaceRoot: "/actual" }),
      createOverviewRun({ id: "unknown", status: "running" }),
      createOverviewRun({ id: "old" }),
    ];
    const runs = getRalphOverviewRuns([library], []);
    expect(runs.map((run) => run.workspaceRoot)).toEqual(["/actual", null]);
  });
});

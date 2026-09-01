import { beforeEach, describe, expect, it, vi } from "vitest";
import { productCommandSchema } from "@machdoch/fleet-protocol";
import type { ProviderModelCatalogSnapshot } from "../model-catalog";
import type { FleetControlCommandEvent } from "../runtime";

const runtime = vi.hoisted(() => ({
  listRalphFlows: vi.fn(),
  listRalphRuns: vi.fn(),
  loadActiveDesktopTasks: vi.fn(),
  resumeRalphRun: vi.fn(),
  runRalphFlow: vi.fn(),
}));

vi.mock("../runtime", () => runtime);

import {
  executeFleetRalphCommand,
  loadFleetRalphSnapshot,
  resolveFleetRalphCommandRuntime,
} from "./fleet-ralph";

const flow = {
  id: "release-flow",
  alias: "release",
  name: "Release flow",
  path: "C:/repo/.machdoch/ralph/release-flow.json",
  blockCount: 3,
  edgeCount: 2,
  variableCount: 0,
  variables: [],
};

const run = (
  id: string,
  status: "running" | "crashed" | "partial",
  createdAt: string,
) => ({
  id,
  path: `C:/repo/.machdoch/ralph/runs/${id}/run.json`,
  createdAt,
  ...(status === "running" ? {} : { finishedAt: createdAt }),
  flowId: flow.id,
  flowName: flow.name,
  status,
  recoverable: status === "crashed",
  summary: status,
  blockCount: 1,
  eventCount: 2,
});

const command = (
  overrides: Partial<FleetControlCommandEvent> = {},
): FleetControlCommandEvent => ({
  commandId: "command-1",
  kind: "ralph-run",
  workspace: "C:/repo",
  scope: "workspace",
  flowId: flow.id,
  parameters: {},
  provider: "openai",
  model: "gpt-5.6",
  reasoning: "high",
  createdAt: 1,
  ...overrides,
});

const modelCatalog: ProviderModelCatalogSnapshot = {
  generatedAt: 1,
  providers: [
    {
      provider: "openai",
      source: "test",
      available: true,
      models: [
        {
          id: "gpt-5.6",
          label: "GPT-5.6",
          capabilities: { reasoningModes: ["default", "high"] },
        },
      ],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  runtime.listRalphFlows.mockImplementation(
    async (_workspace: string, scope: "workspace" | "user") => ({
      scope,
      flows: scope === "workspace" ? [flow] : [],
    }),
  );
  runtime.listRalphRuns.mockImplementation(
    async (
      _workspace: string,
      _flowId: undefined,
      scope: "workspace" | "user",
    ) => ({
      scope,
      runs: [],
    }),
  );
  runtime.loadActiveDesktopTasks.mockResolvedValue([]);
  runtime.runRalphFlow.mockResolvedValue({});
  runtime.resumeRalphRun.mockResolvedValue({});
});

describe("loadFleetRalphSnapshot", () => {
  it("matches active tasks once and gives active resumes precedence over stale run state", async () => {
    runtime.listRalphRuns.mockImplementation(
      async (
        _workspace: string,
        _flowId: undefined,
        scope: "workspace" | "user",
      ) => ({
        scope,
        runs:
          scope === "workspace"
            ? [
                run("run-one", "running", "2026-01-01T00:00:02.000Z"),
                run("run-two", "running", "2026-01-01T00:00:04.000Z"),
                run("run-crashed", "crashed", "2026-01-01T00:00:01.000Z"),
                run("run-partial", "partial", "2026-01-01T00:00:00.000Z"),
              ]
            : [],
      }),
    );
    runtime.loadActiveDesktopTasks.mockResolvedValue([
      {
        id: "task-two",
        kind: "ralph",
        workspaceRoot: "\\\\?\\C:\\Repo\\",
        arguments: ["run", "release", "--scope", "workspace"],
        startedAt: Date.parse("2026-01-01T00:00:04.100Z"),
      },
      {
        id: "task-one",
        kind: "ralph",
        workspaceRoot: "C:/repo",
        arguments: ["run", "release-flow", "--scope", "workspace"],
        startedAt: Date.parse("2026-01-01T00:00:02.100Z"),
      },
      {
        id: "task-resume",
        kind: "ralph",
        workspaceRoot: "c:\\repo\\",
        arguments: ["resume", "run-crashed", "--scope", "workspace"],
        startedAt: Date.parse("2026-01-01T00:00:05.000Z"),
      },
    ]);

    const snapshot = await loadFleetRalphSnapshot("C:/Repo");

    expect(snapshot.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "run-one",
          taskId: "task-one",
          status: "running",
          cancellable: true,
        }),
        expect.objectContaining({
          id: "run-two",
          taskId: "task-two",
          status: "running",
          cancellable: true,
        }),
        expect.objectContaining({
          id: "run-crashed",
          taskId: "task-resume",
          status: "running",
          cancellable: true,
          recoverable: false,
        }),
        expect.objectContaining({
          id: "run-partial",
          recoverable: false,
        }),
      ]),
    );
    expect(
      snapshot.runs.flatMap((entry) => (entry.taskId ? [entry.taskId] : [])),
    ).toHaveLength(3);
  });

  it("publishes unmatched active aliases with their canonical flow identity", async () => {
    runtime.loadActiveDesktopTasks.mockResolvedValue([
      {
        id: "task-active",
        kind: "ralph",
        workspaceRoot: "C:/repo",
        arguments: ["run", "release", "--scope", "workspace"],
        startedAt: 10,
      },
    ]);

    const snapshot = await loadFleetRalphSnapshot("C:/repo");

    expect(snapshot.runs).toContainEqual(
      expect.objectContaining({
        id: "task-active",
        flowId: "release-flow",
        flowName: "Release flow",
        taskId: "task-active",
        status: "running",
      }),
    );
  });
});

describe("Fleet RALPH commands", () => {
  it("rejects parameter names that collide after normalization", () => {
    const result = productCommandSchema.safeParse({
      kind: "ralph-run",
      workspace: "C:/repo",
      scope: "workspace",
      flowId: "release-flow",
      parameters: { environment: "staging", " environment ": "production" },
      provider: "openai",
      model: "gpt-5.6",
      reasoning: "high",
    });

    expect(result.success).toBe(false);
  });

  it("validates the selected runtime and executes a normalized run", async () => {
    const request = command({
      workspace: " C:/repo ",
      flowId: " release-flow ",
      parameters: { environment: "production" },
      maxTransitions: 48,
    });
    const selectedRuntime = resolveFleetRalphCommandRuntime(
      request,
      modelCatalog,
    );

    await executeFleetRalphCommand(request, selectedRuntime);

    expect(selectedRuntime).toEqual({
      workspace: "C:/repo",
      provider: "openai",
      model: "gpt-5.6",
      reasoning: "high",
      scope: "workspace",
      taskId: "ralph-fleet-command-1",
    });
    expect(runtime.runRalphFlow).toHaveBeenCalledWith("C:/repo", {
      scope: "workspace",
      mode: "machdoch",
      provider: "openai",
      model: "gpt-5.6",
      reasoning: "high",
      taskId: "ralph-fleet-command-1",
      maxTransitions: 48,
      name: "release-flow",
      params: { environment: "production" },
    });
  });

  it("rejects unavailable models and unsupported reasoning before launch", () => {
    expect(() =>
      resolveFleetRalphCommandRuntime(
        command({ model: "gpt-missing" }),
        modelCatalog,
      ),
    ).toThrow("model is unavailable");
    expect(() =>
      resolveFleetRalphCommandRuntime(
        command({ reasoning: "minimal" }),
        modelCatalog,
      ),
    ).toThrow("reasoning mode is unavailable");
    expect(runtime.runRalphFlow).not.toHaveBeenCalled();
  });
});

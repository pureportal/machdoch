import { afterEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { loadRuntimeConfig } from "../../core/config.js";
import { discoverCustomizations } from "../../core/customizations.js";
import { createTaskExecutionController } from "../../core/execution.js";
import { parseCliArgs } from "./cli-args.js";
import { printTaskPreview } from "./cli-task-run.js";

vi.mock("../../core/config.js", () => ({
  loadRuntimeConfig: vi.fn(async (workspaceRoot) => ({
    workspaceRoot,
    mode: "machdoch",
    compatibility: { discoverGithubCustomizations: false },
  })),
}));
vi.mock("../../core/customizations.js", () => ({
  discoverCustomizations: vi.fn(async () => ({})),
}));
vi.mock("../../core/execution.js", () => ({
  createTaskExecutionController: vi.fn(() => ({
    signal: new AbortController().signal,
    cancel: vi.fn(),
    execute: async () => ({
      task: "Inspect the workspace",
      mode: "machdoch",
      status: "executed",
      summary: "Done",
      executedTools: [],
      outputSections: [],
    }),
  })),
}));

afterEach(() => vi.clearAllMocks());

describe("CLI task workspace selection", () => {
  it("uses Not Set without loading the launch folder or capturing its changes", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await printTaskPreview(parseCliArgs(["run", "Hello", "--json"]));
    expect(loadRuntimeConfig).toHaveBeenCalledWith(
      homedir(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    expect(discoverCustomizations).toHaveBeenCalledWith(
      homedir(),
      expect.anything(),
    );
    expect(
      vi.mocked(createTaskExecutionController).mock.calls[0]?.[3],
    ).toMatchObject({
      captureFileChanges: false,
      conversationContext: { workspace: { selection: "not-set" } },
    });
  });

  it("uses the selected folder when --cwd is provided", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await printTaskPreview(
      parseCliArgs(["run", "Hello", "--cwd", process.cwd(), "--json"]),
    );
    expect(loadRuntimeConfig).toHaveBeenCalledWith(
      process.cwd(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    expect(
      vi.mocked(createTaskExecutionController).mock.calls[0]?.[3],
    ).not.toHaveProperty("captureFileChanges");
  });

  it("skips capture when the desktop disables changed files for a selected workspace", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await printTaskPreview(
      parseCliArgs([
        "run",
        "Hello",
        "--cwd",
        process.cwd(),
        "--skip-file-change-detection",
        "--json",
      ]),
    );

    expect(
      vi.mocked(createTaskExecutionController).mock.calls[0]?.[3],
    ).toMatchObject({ captureFileChanges: false });
  });

  it("keeps desktop Not Set context when the bridge supplies a runtime directory", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await printTaskPreview(
      parseCliArgs(["run", "Hello", "--cwd", homedir(), "--json"]),
      {
        conversationContext: {
          history: [],
          workspace: { selection: "not-set" },
        },
      },
    );
    expect(
      vi.mocked(createTaskExecutionController).mock.calls[0]?.[3],
    ).toMatchObject({
      captureFileChanges: false,
      conversationContext: { workspace: { selection: "not-set" } },
    });
  });
});

describe("desktop task timeout ownership", () => {
  it.each([
    ["true", null],
    [undefined, 1_200_000],
    ["false", 1_200_000],
  ] as const)(
    "uses the host timer only when the bridge enables it (%s)",
    async (managed, expected) => {
      vi.stubEnv("MACHDOCH_DESKTOP_MANAGES_TASK_TIMEOUT", managed);
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await printTaskPreview(
        parseCliArgs(["--quick", "--json", "--task", "Inspect the workspace"]),
      );
      expect(
        vi.mocked(createTaskExecutionController).mock.calls[0]?.[3]
          ?.idleTimeoutMs,
      ).toBe(expected);
    },
  );
});

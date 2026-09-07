import { afterEach, describe, expect, it, vi } from "vitest";
import { createTaskExecutionController } from "../../core/execution.js";
import { parseCliArgs } from "./cli-args.js";
import { printTaskPreview } from "./cli-task-run.js";

vi.mock("../../core/config.js", () => ({
  loadRuntimeConfig: vi.fn(async () => ({
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

describe("desktop task timeout ownership", () => {
  it.each([
    ["true", null],
    [undefined, undefined],
    ["false", undefined],
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

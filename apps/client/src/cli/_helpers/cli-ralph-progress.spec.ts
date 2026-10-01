import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFlow,
  customizations,
  runtimeConfig,
} from "../../core/__test__/ralph-test-helpers.js";
import type { RalphRunOptions, RalphRunResult } from "../../core/ralph.js";
import { parseCliArgs } from "./cli-args.js";
import { printRalphSummary } from "./cli-ralph-commands.js";

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  discover: vi.fn(),
  readFlow: vi.fn(),
  logger: vi.fn(),
  run: vi.fn(),
  stderr: vi.fn<(line: string) => void>(),
  stdout: vi.fn(),
}));

vi.mock("../../core/config.js", () => ({ loadRuntimeConfig: mocks.config }));
vi.mock("../../core/customizations.js", () => ({
  discoverCustomizations: mocks.discover,
}));
vi.mock("../../core/ralph.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/ralph.js")>()),
  readRalphFlow: mocks.readFlow,
  createRalphRunLogger: mocks.logger,
  runRalphFlow: mocks.run,
}));
vi.mock("./cli-io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cli-io.js")>()),
  writeStderrLine: mocks.stderr,
  writeStdoutLine: mocks.stdout,
}));

afterEach(() => {
  process.exitCode = undefined;
});

describe("RALPH desktop progress transport", () => {
  it("sends block lifecycle events and agent output through structured stderr in JSON mode", async () => {
    const flow = createFlow();
    mocks.config.mockResolvedValue(runtimeConfig);
    mocks.discover.mockResolvedValue(customizations);
    mocks.readFlow.mockResolvedValue(flow);
    mocks.logger.mockResolvedValue({
      runId: "run-1",
      paths: {
        recordPath: "run.json",
        simpleMarkdownPath: "simple.md",
        traceJsonlPath: "trace.jsonl",
      },
    });
    mocks.run.mockImplementation(
      async (
        _flow: unknown,
        _config: unknown,
        _customizations: unknown,
        options: RalphRunOptions,
      ): Promise<RalphRunResult> => {
        await options.onEvent?.({
          type: "block-start",
          blockId: "fix-tsc",
          attempt: 1,
        });
        await options.onStateChange?.({
          task: "Fix TSC",
          mode: "machdoch",
          state: "executing",
          message: "Checking changes",
          executedTools: [],
          outputSections: [],
          cancellable: true,
          actionOutput: {
            toolName: "run_shell_command",
            stream: "stdout",
            chunk: "tests passed",
          },
          timelineEvent: {
            kind: "output",
            phase: "streaming",
            label: "Checking changes",
            metadata: { ralphBlockId: "fix-tsc", ralphBlockTitle: "Fix TSC" },
          },
        });
        return {
          flow: flow.id,
          status: "completed",
          summary: "Done",
          missingVariables: [],
          unknownVariables: [],
          events: [],
          blockResults: [],
          validation: {
            valid: true,
            errors: [],
            warnings: [],
            errorIssues: [],
            warningIssues: [],
            variables: [],
          },
        };
      },
    );

    await printRalphSummary(parseCliArgs(["--json", "ralph", "run", flow.id]));

    const progress = mocks.stderr.mock.calls.map(([line]) => {
      expect(line.startsWith("machdoch-progress: ")).toBe(true);
      return JSON.parse(line.slice("machdoch-progress: ".length));
    });
    expect(progress).toHaveLength(2);
    expect(progress[0].timelineEvent.metadata).toMatchObject({
      ralphEventType: "block-start",
      ralphBlockId: "fix-tsc",
    });
    expect(progress[1]).toMatchObject({
      actionOutput: { chunk: "tests passed" },
      timelineEvent: { metadata: { ralphBlockId: "fix-tsc" } },
    });
    expect(mocks.stdout).toHaveBeenCalledOnce();
  });
});

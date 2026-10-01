import { PassThrough } from "node:stream";
import type { WriteStream } from "node:tty";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createActionFeedbackProgressReporter } from "./cli-progress.js";
import type { TaskExecutionProgress } from "../../core/types.js";

const progress = (
  message: string,
  extra: Partial<TaskExecutionProgress> = {},
): TaskExecutionProgress => ({
  task: "test",
  mode: "machdoch",
  state: "executing",
  message,
  cancellable: true,
  executedTools: [],
  outputSections: [],
  ...extra,
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("agent feedback", () => {
  it("caps noisy tool output, preserves errors, and stops its spinner", () => {
    vi.useFakeTimers();
    vi.stubEnv("TERM", "xterm");
    const output = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 60,
    });
    output.resume();
    const lines: string[] = [];
    const reporter = createActionFeedbackProgressReporter(
      (line = "") => lines.push(line),
      { output: output as unknown as WriteStream },
    );
    reporter.report(progress("Requested run shell command: test."));
    reporter.reportOutput({
      toolName: "run_shell_command",
      stream: "stdout",
      chunk: Array.from({ length: 10 }, (_, index) => `line ${index}\n`).join(
        "",
      ),
    });
    reporter.reportOutput({
      toolName: "run_shell_command",
      stream: "stderr",
      chunk: "error detail\n",
    });
    reporter.report(progress("Done", { state: "completed" }));
    reporter.finish();
    expect(lines.filter((line) => line.includes("line "))).toHaveLength(6);
    expect(lines.some((line) => line.includes("4 more lines"))).toBe(true);
    expect(lines.some((line) => line.includes("error detail"))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const count = lines.length;
    reporter.finish();
    expect(lines).toHaveLength(count);
  });

  it("shows repeated actions as separate operations after progress advances", () => {
    const lines: string[] = [];
    const reporter = createActionFeedbackProgressReporter((line = "") =>
      lines.push(line),
    );
    reporter.report(progress("Requested read file: README.md."));
    reporter.report(progress("File read"));
    reporter.report(progress("Requested read file: README.md."));
    reporter.finish();
    expect(lines.filter((line) => line.startsWith("›"))).toHaveLength(2);
  });
});

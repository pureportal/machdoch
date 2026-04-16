import process from "node:process";
import type {
  TaskExecutionProgressHandler,
  TaskExecutionResult,
} from "../../core/types.js";
import { formatExecutionProgressLines } from "./cli-output.js";

export const writeStdoutLine = (line = ""): void => {
  process.stdout.write(`${line}\n`);
};

export const writeStderrLine = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

export const createVerboseProgressReporter = (
  writeLine: (line: string) => void,
): TaskExecutionProgressHandler => {
  let previousSnapshotKey = "";

  return (progress): void => {
    const snapshotKey = [
      progress.state,
      progress.message,
      progress.reason ?? "",
      progress.executedTools.join(","),
    ].join("|");

    if (snapshotKey === previousSnapshotKey) {
      return;
    }

    previousSnapshotKey = snapshotKey;

    for (const line of formatExecutionProgressLines(progress)) {
      writeLine(`machdoch: ${line}`);
    }
  };
};

export const attachCancellationHandlers = (
  controller: { cancel(reason?: string): void },
  options: { json: boolean },
): (() => void) => {
  let cancellationRequested = false;

  const requestCancellation = (signalName: NodeJS.Signals): void => {
    if (cancellationRequested) {
      process.exitCode = 130;
      return;
    }

    cancellationRequested = true;
    controller.cancel(`${signalName} received. Execution cancelled by user.`);

    if (!options.json) {
      writeStderrLine(
        "machdoch: cancellation requested; stopping after the current execution step.",
      );
    }
  };

  const handleSigint = (): void => {
    requestCancellation("SIGINT");
  };
  const handleSigterm = (): void => {
    requestCancellation("SIGTERM");
  };

  process.on("SIGINT", handleSigint);
  process.on("SIGTERM", handleSigterm);

  return (): void => {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
  };
};

export const printExecutionSummary = (execution: TaskExecutionResult): void => {
  writeStdoutLine(`task: ${execution.task}`);
  writeStdoutLine(`mode: ${execution.mode}`);
  writeStdoutLine(`execution status: ${execution.status}`);
  writeStdoutLine(`summary: ${execution.summary}`);
  writeStdoutLine(
    `executed tools: ${execution.executedTools.length > 0 ? execution.executedTools.join(", ") : "none"}`,
  );

  if (execution.reason) {
    writeStdoutLine(`reason: ${execution.reason}`);
  }

  if (execution.autopilot) {
    writeStdoutLine(
      `autopilot: executor iterations=${execution.autopilot.executorIterations}, validator passes=${execution.autopilot.validatorPasses}, continuation requests=${execution.autopilot.continuationCount}`,
    );
  }

  for (const section of execution.outputSections) {
    writeStdoutLine(`${section.title.toLowerCase()}:`);
    for (const line of section.lines) {
      writeStdoutLine(`  - ${line}`);
    }
  }
};

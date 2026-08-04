import { readFile } from "node:fs/promises";
import process from "node:process";
import type {
  TaskActionOutput,
  TaskActionOutputHandler,
  TaskExecutionProgressHandler,
  TaskExecutionProgress,
  TaskExecutionResult,
  TaskExecutionSection,
} from "../../core/types.js";
import { isTerminalTaskExecutionState } from "../../core/_helpers/execution-progress.js";
import { formatExecutionProgressLines } from "./cli-output.js";

export const STRUCTURED_PROGRESS_PREFIX = "machdoch-progress: ";

const splitMarkdownLines = (markdown: string): string[] => {
  return markdown.replace(/\r\n/g, "\n").split("\n");
};

const createStructuredProgressSnapshot = (
  progress: TaskExecutionProgress,
): TaskExecutionProgress => {
  return {
    ...progress,
    outputSections: [],
  };
};

const createStatusFallbackLine = (execution: TaskExecutionResult): string => {
  switch (execution.status) {
    case "planned":
      return `Plan ready: ${execution.summary}`;
    case "executed":
      return execution.summary;
    case "blocked":
      return `Blocked: ${execution.summary}`;
    case "cancelled":
      return `Cancelled: ${execution.summary}`;
    case "unsupported":
      return `Cannot continue: ${execution.summary}`;
  }
};

const getVisibleOutputSections = (
  sections: TaskExecutionSection[],
): TaskExecutionSection[] => {
  return sections.filter((section) => section.audience !== "internal");
};

export const writeStdoutLine = (line = ""): void => {
  process.stdout.write(`${line}\n`);
};

export const writeStderrLine = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

export const createVerboseProgressReporter = (
  writeLine: (line: string) => void,
  options: { structured?: boolean } = {},
): TaskExecutionProgressHandler => {
  let previousSnapshotKey = "";

  return (progress): void => {
    if (options.structured) {
      const snapshotKey = JSON.stringify(
        createStructuredProgressSnapshot(progress),
      );

      writeLine(`${STRUCTURED_PROGRESS_PREFIX}${snapshotKey}`);
      return;
    }

    if (isTerminalTaskExecutionState(progress.state)) {
      return;
    }

    const lines = formatExecutionProgressLines(progress);
    const snapshotKey = lines.join("|");

    if (lines.length === 0 || snapshotKey === previousSnapshotKey) {
      return;
    }

    previousSnapshotKey = snapshotKey;

    for (const line of lines) {
      writeLine(`machdoch: ${line}`);
    }
  };
};

export const createStructuredActionOutputReporter = (
  task: string,
  mode: TaskExecutionProgress["mode"],
  writeLine: (line: string) => void,
): TaskActionOutputHandler => {
  return (output): void => {
    if (output.chunk.length === 0) {
      return;
    }

    const progress: TaskExecutionProgress = {
      task,
      mode,
      state: "executing",
      message: `${output.toolName} ${output.stream} output`,
      executedTools: [],
      outputSections: [],
      cancellable: true,
      actionOutput: output,
    };

    writeLine(
      `${STRUCTURED_PROGRESS_PREFIX}${JSON.stringify(
        createStructuredProgressSnapshot(progress),
      )}`,
    );
  };
};

export interface ActionFeedbackProgressReporter {
  report: TaskExecutionProgressHandler;
  reportOutput: TaskActionOutputHandler;
  finish(): void;
}

const ACTION_FEEDBACK_STATES = new Set<TaskExecutionProgress["state"]>([
  "planning",
  "executing",
  "verifying",
  "monitoring",
]);

const removeTrailingPeriod = (value: string): string => {
  return value.replace(/\.$/u, "");
};

const quoteActionValue = (value: string): string => {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
};

const formatActionRequest = (message: string): string => {
  const shellMatch = /^Requested run shell command: (.+)\.$/u.exec(message);

  if (shellMatch?.[1]) {
    return `execute command ${quoteActionValue(shellMatch[1])}`;
  }

  const requestMatch = /^Requested (.+)\.$/u.exec(message);

  return requestMatch?.[1] ?? removeTrailingPeriod(message);
};

const formatActionFeedbackLine = (
  progress: TaskExecutionProgress,
): string | undefined => {
  const message = progress.message.trim();

  if (
    message.length === 0 ||
    isTerminalTaskExecutionState(progress.state) ||
    !ACTION_FEEDBACK_STATES.has(progress.state)
  ) {
    return undefined;
  }

  if (message.startsWith("Requested ")) {
    return `action: ${formatActionRequest(message)}`;
  }

  return `thinking: ${message}`;
};

export const createActionFeedbackProgressReporter = (
  writeLine: (line?: string) => void,
): ActionFeedbackProgressReporter => {
  let started = false;
  let finished = false;
  let previousLine = "";
  const outputLineBuffers: Record<TaskActionOutput["stream"], string> = {
    stdout: "",
    stderr: "",
  };

  const start = (): void => {
    if (started) {
      return;
    }

    started = true;
    writeLine("--- Actions Start ---");
  };

  const writeActionLine = (line: string): void => {
    start();
    writeLine(line);
  };

  const report: TaskExecutionProgressHandler = (progress): void => {
    if (finished) {
      return;
    }

    const line = formatActionFeedbackLine(progress);

    if (!line || line === previousLine) {
      return;
    }

    previousLine = line;
    writeActionLine(line);
  };

  const reportOutput: TaskActionOutputHandler = (output): void => {
    if (finished || output.chunk.length === 0) {
      return;
    }

    const normalizedChunk = output.chunk
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
    const stream = output.stream;
    const lines = `${outputLineBuffers[stream]}${normalizedChunk}`.split("\n");

    outputLineBuffers[stream] = lines.pop() ?? "";

    for (const line of lines) {
      writeActionLine(`${stream}: ${line}`);
    }
  };

  const flushOutput = (): void => {
    for (const stream of ["stdout", "stderr"] as const) {
      const line = outputLineBuffers[stream];

      if (line.length === 0) {
        continue;
      }

      outputLineBuffers[stream] = "";
      writeActionLine(`${stream}: ${line}`);
    }
  };

  return {
    report,
    reportOutput,
    finish: (): void => {
      if (finished) {
        return;
      }

      flushOutput();

      if (!started) {
        return;
      }

      finished = true;
      writeLine("--- Actions End ---");
      writeLine();
    },
  };
};

export const attachCancellationHandlers = (
  controller: { cancel(reason?: string): void },
  options: {
    json: boolean;
    cancellationFilePath?: string;
    cancellationPollMs?: number;
  },
): (() => void) => {
  let cancellationRequested = false;
  let detached = false;
  let cancellationFileReadPending = false;
  let cancellationFileObserved = false;
  const cancellationFilePath =
    options.cancellationFilePath?.trim() ||
    process.env.MACHDOCH_RALPH_CANCEL_PATH?.trim();

  const requestCancellation = (reason: string): void => {
    if (cancellationRequested) {
      process.exitCode = 130;
      return;
    }

    cancellationRequested = true;
    controller.cancel(reason);

    if (!options.json) {
      writeStderrLine(
        "machdoch: cancellation requested; stopping after the current execution step.",
      );
    }
  };

  const handleSigint = (): void => {
    requestCancellation("SIGINT received. Execution cancelled by user.");
  };
  const handleSigterm = (): void => {
    requestCancellation("SIGTERM received. Execution cancelled by user.");
  };

  let cancellationFileHandle: ReturnType<typeof setInterval> | undefined;
  const stopCancellationFilePolling = (): void => {
    if (cancellationFileHandle) {
      clearInterval(cancellationFileHandle);
      cancellationFileHandle = undefined;
    }
  };
  const pollCancellationFile = async (): Promise<void> => {
    if (
      detached ||
      cancellationFileObserved ||
      cancellationFileReadPending ||
      !cancellationFilePath
    ) {
      return;
    }

    cancellationFileReadPending = true;
    try {
      const requestedReason = (
        await readFile(cancellationFilePath, "utf8")
      ).trim();
      if (detached) {
        return;
      }
      cancellationFileObserved = true;
      stopCancellationFilePolling();
      requestCancellation(
        requestedReason || "Desktop requested cancellation of the Ralph run.",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !detached) {
        cancellationFileObserved = true;
        stopCancellationFilePolling();
        requestCancellation(
          `Desktop cancellation request could not be read: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      cancellationFileReadPending = false;
    }
  };

  process.on("SIGINT", handleSigint);
  process.on("SIGTERM", handleSigterm);
  if (cancellationFilePath) {
    cancellationFileHandle = setInterval(
      () => void pollCancellationFile(),
      Math.max(10, options.cancellationPollMs ?? 250),
    );
    cancellationFileHandle.unref();
    void pollCancellationFile();
  }

  return (): void => {
    detached = true;
    stopCancellationFilePolling();
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
  };
};

export const getExecutionResultMarkdown = (
  execution: TaskExecutionResult,
): string | undefined => {
  const responseMarkdown = execution.response?.markdown.trim();

  return responseMarkdown || undefined;
};

export const formatExecutionSummaryLines = (
  execution: TaskExecutionResult,
): string[] => {
  const resultMarkdown = getExecutionResultMarkdown(execution);

  if (resultMarkdown) {
    return splitMarkdownLines(resultMarkdown);
  }

  const visibleSections = getVisibleOutputSections(execution.outputSections);
  const lines = [createStatusFallbackLine(execution)];

  if (execution.reason && execution.status !== "executed") {
    lines.push(`Reason: ${execution.reason}`);
  }

  for (const section of visibleSections) {
    if (lines.length > 0) {
      lines.push("");
    }

    lines.push(`${section.title}:`);
    for (const line of section.lines) {
      lines.push(line);
    }
  }

  return lines;
};

export const printExecutionSummary = (execution: TaskExecutionResult): void => {
  for (const line of formatExecutionSummaryLines(execution)) {
    writeStdoutLine(line);
  }
};

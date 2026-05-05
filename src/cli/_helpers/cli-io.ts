import process from "node:process";
import type {
  TaskExecutionProgressHandler,
  TaskExecutionResult,
  TaskExecutionSection,
  TaskExecutionState,
} from "../../core/types.js";
import { formatExecutionProgressLines } from "./cli-output.js";

const TERMINAL_PROGRESS_STATES: ReadonlySet<TaskExecutionState> = new Set([
  "completed",
  "approval-required",
  "blocked",
  "unsupported",
  "cancelled",
]);

const INTERNAL_OUTPUT_SECTION_TITLES: ReadonlySet<string> = new Set([
  "Autopilot audit",
  "Instruction context",
  "Prompt context",
  "Task context",
  "Tool trace",
]);

const splitMarkdownLines = (markdown: string): string[] => {
  return markdown.replace(/\r\n/g, "\n").split("\n");
};

const createStatusFallbackLine = (execution: TaskExecutionResult): string => {
  switch (execution.status) {
    case "executed":
      return execution.summary;
    case "approval-required":
      return `Approval required: ${execution.summary}`;
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
  return sections.filter(
    (section) => !INTERNAL_OUTPUT_SECTION_TITLES.has(section.title),
  );
};

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
    if (TERMINAL_PROGRESS_STATES.has(progress.state)) {
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

import type {
  TaskThinkingActionOutputSummary,
  TaskThinkingTrace,
} from "@machdoch/fleet-protocol/task-thinking";

export const retainTaskActionOutput = (
  trace: Pick<
    TaskThinkingTrace,
    "actionOutputLines" | "actionOutputSummaries" | "timelineEvents"
  >,
  lineLimit: number,
): Pick<TaskThinkingTrace, "actionOutputLines" | "actionOutputSummaries"> => {
  const lines = trace.actionOutputLines ?? [];
  const removedLineCount = Math.max(0, lines.length - lineLimit);

  if (removedLineCount === 0) {
    return {
      ...(trace.actionOutputLines !== undefined
        ? { actionOutputLines: lines }
        : {}),
      ...(trace.actionOutputSummaries?.length
        ? { actionOutputSummaries: trace.actionOutputSummaries }
        : {}),
    };
  }

  const removedOutput: TaskThinkingActionOutputSummary[] = [
    ...(trace.actionOutputSummaries ?? []),
    ...lines.slice(0, removedLineCount).map((line) => ({
      id: `omitted:${line.id}`,
      toolName: line.toolName,
      timestamp: line.timestamp,
      endedAt: line.timestamp,
      stdoutLineCount: line.stream === "stdout" ? 1 : 0,
      stderrLineCount: line.stream === "stderr" ? 1 : 0,
    })),
  ].sort((left, right) => left.timestamp - right.timestamp);
  const events = trace.timelineEvents
    .filter((event) => event.phase !== "usage")
    .sort((left, right) => right.timestamp - left.timestamp);
  const summaries: TaskThinkingActionOutputSummary[] = [];
  let previousBoundary: string | undefined;

  for (const output of removedOutput) {
    const boundary = events.find(
      (event) =>
        event.timestamp < output.timestamp ||
        (event.timestamp === output.timestamp && event.phase === "started"),
    )?.id;
    const previous = summaries.at(-1);

    if (
      previous?.toolName === output.toolName &&
      boundary === previousBoundary
    ) {
      summaries[summaries.length - 1] = {
        ...previous,
        endedAt: Math.max(previous.endedAt, output.endedAt),
        stdoutLineCount: previous.stdoutLineCount + output.stdoutLineCount,
        stderrLineCount: previous.stderrLineCount + output.stderrLineCount,
      };
    } else {
      summaries.push(output);
    }

    previousBoundary = boundary;
  }

  return {
    actionOutputLines: lines.slice(removedLineCount),
    actionOutputSummaries: summaries,
  };
};

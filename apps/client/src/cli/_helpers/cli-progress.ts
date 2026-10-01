import type { WriteStream } from "node:tty";
import type {
  TaskActionOutputHandler,
  TaskExecutionProgressHandler,
} from "../../core/types.js";
import { isTerminalTaskExecutionState } from "../../core/_helpers/execution-progress.js";
import { createCliStyle } from "./cli-terminal.js";
import { clipTerminalText, safeTerminalText } from "./cli-terminal-text.js";

export interface ActionFeedbackProgressReporter {
  report: TaskExecutionProgressHandler;
  reportOutput: TaskActionOutputHandler;
  finish(): void;
}

export const createActionFeedbackProgressReporter = (
  writeLine: (line?: string) => void,
  options: { output?: WriteStream; verbose?: boolean } = {},
): ActionFeedbackProgressReporter => {
  const output = options.output;
  const interactive = output?.isTTY === true && process.env.TERM !== "dumb";
  const style = createCliStyle({ isTTY: interactive });
  const startedAt = Date.now();
  const buffers = new Map<string, string>();
  let status = "Working";
  let previousLine = "";
  let previousAction = "";
  let previousCompletion = "";
  let outputLines = 0;
  let hiddenLines = 0;
  let finished = false;
  let active = false;
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const clear = (): void => {
    if (active && interactive) output.write("\r\u001b[2K");
    active = false;
  };
  const render = (): void => {
    if (!interactive || finished) return;
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    const clock =
      elapsed < 60
        ? `${elapsed}s`
        : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
    const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][
      frame++ % 10
    ];
    const suffix = ` · ${clock} · Ctrl+C cancel`;
    clear();
    output.write(
      style.muted(
        clipTerminalText(
          `${spinner} ${status}${suffix}`,
          Math.max(4, (output.columns || 80) - 1),
        ),
      ),
    );
    active = true;
  };
  const print = (line: string): void => {
    clear();
    writeLine(line);
    render();
  };
  const flushHidden = (): void => {
    if (hiddenLines)
      print(style.muted(`  … ${hiddenLines} more lines (/verbose on)`));
    hiddenLines = 0;
    outputLines = 0;
  };
  const printOutput = (stream: string, line: string): void => {
    if (
      options.verbose ||
      !interactive ||
      outputLines < 6 ||
      stream.endsWith(":stderr")
    ) {
      print(
        `  ${stream.endsWith(":stderr") ? style.warning(safeTerminalText(line)) : style.muted(safeTerminalText(line))}`,
      );
    } else hiddenLines += 1;
    outputLines += 1;
  };
  const flushBuffers = (): void => {
    for (const [stream, line] of buffers) if (line) printOutput(stream, line);
    buffers.clear();
  };

  return {
    report: (progress) => {
      if (finished) return;
      if (isTerminalTaskExecutionState(progress.state)) {
        status = progress.state === "completed" ? "Done" : progress.message;
        return;
      }
      const text = safeTerminalText(progress.message).trim();
      if (!text) return;
      const event = progress.timelineEvent;
      if (
        event?.kind === "tool-call" &&
        ["completed", "failed"].includes(event.phase)
      ) {
        const key = `${event.callId ?? event.label}:${event.phase}`;
        if (key !== previousCompletion) {
          previousCompletion = key;
          flushBuffers();
          flushHidden();
          const label = safeTerminalText(event.label);
          print(
            event.phase === "failed"
              ? style.error(
                  `✗ ${label}${event.detail ? ` · ${safeTerminalText(event.detail)}` : ""}`,
                )
              : style.success(`✓ ${label}`),
          );
        }
      }
      if (text.startsWith("Requested ")) {
        const actionKey = event?.callId ?? text;
        if (actionKey === previousAction) return;
        flushBuffers();
        flushHidden();
        previousAction = actionKey;
        status = "Executing";
        print(
          style.command(
            `› ${text.replace(/^Requested /u, "").replace(/\.$/u, "")}`,
          ),
        );
      } else {
        if (event?.kind !== "tool-call" || event.phase !== "started")
          previousAction = "";
        status =
          progress.modelStream?.kind === "assistant"
            ? "Writing response"
            : progress.modelStream?.kind === "reasoning"
              ? "Thinking"
              : text;
        if (
          progress.modelStream?.kind === "assistant" &&
          progress.modelStream.complete
        ) {
          const content = safeTerminalText(progress.modelStream.content).trim();
          if (content && content !== previousLine) {
            previousLine = content;
            print(content);
          }
        } else if (!interactive && text !== previousLine) {
          previousLine = text;
          writeLine(`· ${text}`);
        }
      }
      if (!timer && interactive) {
        timer = setInterval(render, 120);
        timer.unref();
      }
      render();
    },
    reportOutput: (output) => {
      if (finished || !output.chunk) return;
      const stream = `${output.toolName}:${output.stream}`;
      const lines = (
        (buffers.get(stream) ?? "") + safeTerminalText(output.chunk)
      ).split("\n");
      let pending = lines.pop() ?? "";
      for (const line of lines) printOutput(stream, line);
      while (pending.length > 8192) {
        printOutput(stream, pending.slice(0, 8192));
        pending = pending.slice(8192);
      }
      buffers.set(stream, pending);
    },
    finish: () => {
      if (finished) return;
      if (timer) clearInterval(timer);
      flushBuffers();
      flushHidden();
      clear();
      finished = true;
      if (interactive)
        writeLine(
          style.muted(
            `${status} · ${Math.floor((Date.now() - startedAt) / 1000)}s`,
          ),
        );
    },
  };
};

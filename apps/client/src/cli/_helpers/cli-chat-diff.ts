import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CliUsageError } from "./cli-error.js";
import { createCliStyle } from "./cli-terminal.js";
import { safeTerminalText } from "./cli-terminal-text.js";

export const showWorkspaceDiff = async (
  workspaceRoot: string,
  staged: boolean,
  write: (line: string) => void,
): Promise<void> => {
  let diff: string;
  try {
    const result = await promisify(execFile)(
      "git",
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--color=never",
        ...(staged ? ["--cached"] : []),
        "--",
      ],
      {
        cwd: workspaceRoot,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
      },
    );
    diff = safeTerminalText(result.stdout).trimEnd();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(`Cannot read Git changes: ${detail}`);
  }
  if (!diff) {
    write(staged ? "No staged changes." : "No unstaged changes.");
    return;
  }
  const style = createCliStyle();
  write(
    diff
      .split("\n")
      .map((line) =>
        line.startsWith("diff --git") || line.startsWith("@@")
          ? style.heading(line)
          : line.startsWith("+")
            ? style.success(line)
            : line.startsWith("-")
              ? style.error(line)
              : line,
      )
      .join("\n"),
  );
};

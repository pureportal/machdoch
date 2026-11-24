export type ShellIntegrationEvent =
  | { kind: "prompt-start" }
  | { kind: "prompt-end" }
  | { kind: "command-executed" }
  | { kind: "command-finished"; exitCode: number | null }
  | { kind: "command-line"; command: string }
  | { kind: "cwd"; path: string };

export const unescapeShellIntegrationValue = (value: string): string =>
  value.replace(
    /\\(\\|x([0-9a-fA-F]{2}))/gu,
    (_, escaped: string, hex?: string) =>
      hex ? String.fromCharCode(Number.parseInt(hex, 16)) : escaped,
  );

const exitCode = (value: string | undefined): number | null => {
  if (value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
};

const promptEvent = (
  code: string | undefined,
  rest: string[],
): ShellIntegrationEvent | null => {
  switch (code) {
    case "A":
      return { kind: "prompt-start" };
    case "B":
      return { kind: "prompt-end" };
    case "C":
      return { kind: "command-executed" };
    case "D":
      return { kind: "command-finished", exitCode: exitCode(rest[0]) };
    default:
      return null;
  }
};

export const parseVsCodeShellSequence = (
  data: string,
): ShellIntegrationEvent | null => {
  const [code, ...rest] = data.split(";");
  if (code === "E") {
    return {
      kind: "command-line",
      command: unescapeShellIntegrationValue(rest[0] ?? ""),
    };
  }
  if (code === "P") {
    const property = rest.join(";");
    const separator = property.indexOf("=");
    if (separator < 0 || property.slice(0, separator) !== "Cwd") return null;
    return {
      kind: "cwd",
      path: unescapeShellIntegrationValue(property.slice(separator + 1)),
    };
  }
  return promptEvent(code, rest);
};

export const parseFinalTermSequence = (
  data: string,
): ShellIntegrationEvent | null => {
  const [code, ...rest] = data.split(";");
  return promptEvent(code, rest);
};

export const parseWorkingDirectoryUrl = (
  data: string,
): ShellIntegrationEvent | null => {
  try {
    const url = new URL(data);
    if (url.protocol !== "file:") return null;
    const path = decodeURIComponent(url.pathname).replace(
      /^\/([a-zA-Z]:\/)/u,
      "$1",
    );
    return { kind: "cwd", path };
  } catch {
    return null;
  }
};

export interface TerminalCommandRecord {
  promptLine: number;
  outputLine: number | null;
  endLine: number | null;
  command: string | null;
  exitCode: number | null;
}

export const adjacentCommandLine = (
  records: readonly Pick<TerminalCommandRecord, "promptLine">[],
  currentLine: number,
  direction: "previous" | "next",
): number | null => {
  const lines = records.map((record) => record.promptLine);
  if (direction === "previous") {
    const previous = lines.filter((line) => line < currentLine);
    return previous.length ? Math.max(...previous) : null;
  }
  const next = lines.filter((line) => line > currentLine);
  return next.length ? Math.min(...next) : null;
};

export const workspaceRelativeDirectory = (
  absolute: string,
  workspaceRoot: string,
): string | null => {
  const normalize = (value: string) =>
    value.replaceAll("\\", "/").replace(/\/+$/u, "");
  const path = normalize(absolute);
  const root = normalize(workspaceRoot);
  const windows = /^[a-zA-Z]:\//u.test(root);
  const same = (left: string, right: string) =>
    windows ? left.toLowerCase() === right.toLowerCase() : left === right;
  if (same(path, root)) return ".";
  const prefix = `${root}/`;
  return same(path.slice(0, prefix.length), prefix)
    ? path.slice(prefix.length)
    : null;
};

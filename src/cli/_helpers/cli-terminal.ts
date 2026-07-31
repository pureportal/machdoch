import process from "node:process";

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
} as const;

export const shouldUseColor = (options?: {
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
}): boolean => {
  const env = options?.env ?? process.env;
  const isTTY = options?.isTTY ?? process.stdout.isTTY === true;

  if (Object.prototype.hasOwnProperty.call(env, "NO_COLOR")) {
    return false;
  }

  if (env.FORCE_COLOR === "0" || env.TERM === "dumb") {
    return false;
  }

  return isTTY || Object.prototype.hasOwnProperty.call(env, "FORCE_COLOR");
};

const colorize = (code: string, value: string, enabled: boolean): string =>
  enabled ? `${code}${value}${ANSI.reset}` : value;

export interface CliStyle {
  enabled: boolean;
  heading(value: string): string;
  label(value: string): string;
  command(value: string): string;
  success(value: string): string;
  warning(value: string): string;
  error(value: string): string;
  muted(value: string): string;
}

export const createCliStyle = (options?: {
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  enabled?: boolean;
}): CliStyle => {
  const enabled = options?.enabled ?? shouldUseColor(options);

  return {
    enabled,
    heading: (value) => colorize(`${ANSI.bold}${ANSI.cyan}`, value, enabled),
    label: (value) => colorize(ANSI.bold, value, enabled),
    command: (value) => colorize(ANSI.cyan, value, enabled),
    success: (value) => colorize(ANSI.green, value, enabled),
    warning: (value) => colorize(ANSI.yellow, value, enabled),
    error: (value) => colorize(ANSI.red, value, enabled),
    muted: (value) => colorize(ANSI.dim, value, enabled),
  };
};

export const formatKeyValueRows = (
  rows: ReadonlyArray<readonly [string, string]>,
  options?: { terminalWidth?: number; indent?: string },
): string[] => {
  if (rows.length === 0) {
    return [];
  }

  const terminalWidth =
    options?.terminalWidth ??
    process.stdout.columns ??
    Number.POSITIVE_INFINITY;
  const indent = options?.indent ?? "  ";
  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const useStackedLayout =
    Number.isFinite(terminalWidth) &&
    labelWidth + indent.length + 3 + 24 > terminalWidth;

  if (useStackedLayout) {
    return rows.flatMap(([label, value]) => [
      `${indent}${label}`,
      `${indent}  ${value}`,
    ]);
  }

  return rows.map(
    ([label, value]) => `${indent}${label.padEnd(labelWidth)}  ${value}`,
  );
};

import type { TaskExecutionSection } from "../types.js";

const DEFAULT_OUTPUT_MAX_CHARS = 12_000;
const DEFAULT_PREVIEW_LINES = 80;
const DEFAULT_TOOL_TRACE_PREVIEW_CHARS = 220;

export const createLinesFromText = (
  text: string,
  maxLines = DEFAULT_PREVIEW_LINES,
  startLine = 1,
): string[] => {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const previewLines = lines
    .slice(0, maxLines)
    .map((line, index) => `${startLine + index}: ${line}`);

  if (lines.length > maxLines) {
    previewLines.push(`… truncated after ${maxLines} of ${lines.length} lines`);
  }

  return previewLines;
};

export const createTextSection = (
  title: string,
  text: string,
  maxLines = DEFAULT_PREVIEW_LINES,
  startLine = 1,
): TaskExecutionSection => {
  const previewLines = createLinesFromText(text, maxLines, startLine);

  return {
    title,
    lines: previewLines.length > 0 ? previewLines : ["(empty)"],
  };
};

export const limitText = (
  value: string,
  maxChars = DEFAULT_OUTPUT_MAX_CHARS,
): string => {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}\n… truncated after ${maxChars} characters`;
};

export const compactTraceText = (value: string): string => {
  const compacted = value.replace(/\s+/g, " ").trim();

  if (compacted.length <= DEFAULT_TOOL_TRACE_PREVIEW_CHARS) {
    return compacted;
  }

  return `${compacted.slice(0, DEFAULT_TOOL_TRACE_PREVIEW_CHARS)}…`;
};

export const stringifyUnknown = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

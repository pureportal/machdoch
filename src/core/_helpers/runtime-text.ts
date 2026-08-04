import type { TaskExecutionSection } from "../types.js";
import { sliceUtf16PrefixAtCodePointBoundary } from "../../shared/unicode.js";

const DEFAULT_OUTPUT_MAX_CHARS = 12_000;
const DEFAULT_PREVIEW_LINES = 80;
const DEFAULT_TOOL_TRACE_PREVIEW_CHARS = 220;

export const createLinesFromText = (
  text: string,
  maxLines = DEFAULT_PREVIEW_LINES,
  startLine = 1,
): string[] => {
  const truncatedByCharacterLimit = text.length > DEFAULT_OUTPUT_MAX_CHARS;
  const normalized = sliceUtf16PrefixAtCodePointBoundary(
    text,
    DEFAULT_OUTPUT_MAX_CHARS,
  )
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const previewLines = lines
    .slice(0, maxLines)
    .map((line, index) => `${startLine + index}: ${line}`);

  if (lines.length > maxLines) {
    previewLines.push(`… truncated after ${maxLines} of ${lines.length} lines`);
  }

  if (truncatedByCharacterLimit) {
    previewLines.push(
      `… truncated preview after ${DEFAULT_OUTPUT_MAX_CHARS} characters`,
    );
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

  return `${sliceUtf16PrefixAtCodePointBoundary(value, maxChars)}\n… truncated after ${maxChars} characters`;
};

export const compactTraceText = (value: string): string => {
  const compacted = value.replace(/\s+/g, " ").trim();

  if (compacted.length <= DEFAULT_TOOL_TRACE_PREVIEW_CHARS) {
    return compacted;
  }

  return `${sliceUtf16PrefixAtCodePointBoundary(
    compacted,
    DEFAULT_TOOL_TRACE_PREVIEW_CHARS,
  )}…`;
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

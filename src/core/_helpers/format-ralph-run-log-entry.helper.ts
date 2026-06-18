import type { RalphSimpleLogEntry } from "../ralph.js";

const MAX_RALPH_TRACE_TEXT_CHARS = 32_000;
const MAX_RALPH_TRACE_VALUE_DEPTH = 6;
const MAX_RALPH_TRACE_COLLECTION_ENTRIES = 200;

const SENSITIVE_LOG_KEY_PATTERN =
  /(?:api[-_]?key|authorization|bearer|credential|password|secret|token)/iu;
const SENSITIVE_INLINE_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|(?:api[-_]?key|authorization|password|secret|token)\s*[:=]\s*["']?[^"'\s,;]+)/giu;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const redactLogText = (value: string): string => {
  return value.replace(SENSITIVE_INLINE_PATTERN, (match) => {
    const separatorIndex = Math.max(match.indexOf(":"), match.indexOf("="));

    if (separatorIndex > 0) {
      return `${match.slice(0, separatorIndex + 1)} [redacted]`;
    }

    if (/^Bearer\s+/iu.test(match)) {
      return "Bearer [redacted]";
    }

    return "[redacted]";
  });
};

export const capLogText = (value: string, limit: number): string => {
  const redacted = redactLogText(value);

  if (redacted.length <= limit) {
    return redacted;
  }

  return `${redacted.slice(0, limit)}\n[Ralph log text truncated at ${limit} characters.]`;
};

export const sanitizeTraceValue = (value: unknown, depth = 0): unknown => {
  if (typeof value === "string") {
    return capLogText(value, MAX_RALPH_TRACE_TEXT_CHARS);
  }

  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: capLogText(value.message, MAX_RALPH_TRACE_TEXT_CHARS),
      ...(value.stack
        ? { stack: capLogText(value.stack, MAX_RALPH_TRACE_TEXT_CHARS) }
        : {}),
    };
  }

  if (depth >= MAX_RALPH_TRACE_VALUE_DEPTH) {
    return "[Ralph trace value truncated]";
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_RALPH_TRACE_COLLECTION_ENTRIES)
      .map((entry) => sanitizeTraceValue(entry, depth + 1));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, MAX_RALPH_TRACE_COLLECTION_ENTRIES)
        .map(([key, entry]) => [
          key,
          SENSITIVE_LOG_KEY_PATTERN.test(key)
            ? "[redacted]"
            : sanitizeTraceValue(entry, depth + 1),
        ]),
    );
  }

  return String(value);
};

const formatDuration = (durationMs: number | undefined): string => {
  if (durationMs === undefined) {
    return "";
  }

  if (durationMs < 1_000) {
    return ` (${durationMs} ms)`;
  }

  return ` (${(durationMs / 1_000).toFixed(1)} s)`;
};

export const formatRalphSimpleMarkdownEntry = (
  entry: RalphSimpleLogEntry,
): string => {
  const prefix = entry.createdAt;
  const block = entry.blockTitle
    ? ` [${entry.blockTitle}]`
    : entry.blockId
      ? ` [${entry.blockId}]`
      : "";
  const output = entry.output ? ` -> ${entry.output}` : "";
  const duration = formatDuration(entry.durationMs);
  const detail = entry.inputPreview
    ? `\n  input: ${entry.inputPreview.replace(/\r?\n/gu, " ").trim()}`
    : entry.outputPreview
      ? `\n  output: ${entry.outputPreview.replace(/\r?\n/gu, " ").trim()}`
      : "";

  return `- ${prefix}${block} ${entry.message}${output}${duration}${detail}`;
};

export const createRalphLogLine = (entry: unknown): string => {
  return `${JSON.stringify(sanitizeTraceValue(entry))}\n`;
};

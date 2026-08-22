import type { RalphSimpleLogEntry } from "../ralph.js";

const MAX_RALPH_TRACE_TEXT_CHARS = 32_000;
const MAX_RALPH_TRACE_VALUE_DEPTH = 6;
const MAX_RALPH_TRACE_COLLECTION_ENTRIES = 200;

const SENSITIVE_LOG_KEYS = new Set([
  "access_token",
  "api_key",
  "apikey",
  "authorization",
  "client_secret",
  "credential",
  "password",
  "private_key",
  "secret",
  "token",
]);
const SENSITIVE_VALUE_CONTAINER_KEYS = new Set(["env", "headers"]);
const SECRET_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CODEX_ACCESS_TOKEN",
  "CODEX_API_KEY",
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GOOGLE_API_KEY",
  "OPENAI_API_KEY",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const redactLogText = (value: string): string => {
  let redacted = value;

  for (const key of SECRET_ENV_KEYS) {
    const secret = process.env[key];
    if (secret) {
      redacted = redacted.replaceAll(secret, "[redacted]");
    }
  }

  return redacted;
};

export const capLogText = (value: string, limit: number): string => {
  const redacted = redactLogText(value);

  if (redacted.length <= limit) {
    return redacted;
  }

  return `${redacted.slice(0, limit)}\n[Ralph log text truncated at ${limit} characters.]`;
};

export const sanitizeTraceValue = (
  value: unknown,
  depth = 0,
  redactValue = false,
): unknown => {
  if (redactValue) {
    return "[redacted]";
  }
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
        .map(([key, entry]) => {
          const normalizedKey = key.toLowerCase();
          return [
            key,
            sanitizeTraceValue(
              entry,
              depth + 1,
              SENSITIVE_LOG_KEYS.has(normalizedKey) ||
                SENSITIVE_VALUE_CONTAINER_KEYS.has(normalizedKey),
            ),
          ];
        }),
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

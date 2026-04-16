import type {
  RuntimeProfileSummary,
  TaskExecutionProgress,
  TaskExecutionState,
} from "../../core/types.js";

const TERMINAL_PROGRESS_STATES: ReadonlySet<TaskExecutionState> = new Set([
  "completed",
  "approval-required",
  "blocked",
  "unsupported",
  "cancelled",
]);

const DEFAULT_BODY_PREVIEW_LINES = 8;

export const formatExecutionProgressLines = (
  progress: TaskExecutionProgress,
): string[] => {
  const lines = [`[${progress.state}] ${progress.message}`];

  if (progress.reason) {
    lines.push(`reason: ${progress.reason}`);
  }

  if (
    progress.executedTools.length > 0 &&
    TERMINAL_PROGRESS_STATES.has(progress.state)
  ) {
    lines.push(`tools: ${progress.executedTools.join(", ")}`);
  }

  return lines;
};

export const formatProfileLine = (
  profile: RuntimeProfileSummary,
  activeProfile: string | undefined,
): string => {
  const activeMarker = activeProfile === profile.name ? " (active)" : "";

  return `  - ${profile.name}${activeMarker}${profile.description ? `: ${profile.description}` : ""}`;
};

export const createDiscoveryOptions = (
  discoverGithubCustomizations: boolean | undefined,
): { discoverGithubCustomizations: true } | undefined => {
  return discoverGithubCustomizations
    ? { discoverGithubCustomizations: true }
    : undefined;
};

export const createBodyPreviewLines = (
  body: string,
  maxPreviewLines = DEFAULT_BODY_PREVIEW_LINES,
): string[] => {
  const normalizedBody = body
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

  if (normalizedBody.length === 0) {
    return [];
  }

  const bodyLines = normalizedBody.split("\n");
  const previewLines = bodyLines.slice(0, maxPreviewLines);

  if (bodyLines.length > maxPreviewLines) {
    previewLines.push(
      `… truncated after ${maxPreviewLines} of ${bodyLines.length} lines`,
    );
  }

  return previewLines;
};
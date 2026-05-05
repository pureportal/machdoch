import type {
  RuntimeProfileSummary,
  TaskExecutionProgress,
  TaskExecutionState,
} from "../../core/types.js";

const DEFAULT_BODY_PREVIEW_LINES = 8;

export const formatExecutionProgressLines = (
  progress: TaskExecutionProgress,
): string[] => {
  const terminalPrefixes: Record<
    Extract<
      TaskExecutionState,
      | "completed"
      | "approval-required"
      | "blocked"
      | "unsupported"
      | "cancelled"
    >,
    string
  > = {
    completed: "Done",
    "approval-required": "Approval required",
    blocked: "Needs input",
    unsupported: "Cannot continue",
    cancelled: "Cancelled",
  };

  if (progress.state in terminalPrefixes) {
    const prefix =
      terminalPrefixes[
        progress.state as keyof typeof terminalPrefixes
      ];
    const lines = [`${prefix}: ${progress.message}`];

    if (progress.reason) {
      lines.push(`Reason: ${progress.reason}`);
    }

    if (progress.executedTools.length > 0) {
      lines.push(`Tools used: ${progress.executedTools.join(", ")}`);
    }

    return lines;
  }

  if (progress.state === "verifying" || progress.state === "monitoring") {
    return ["Checking the result..."];
  }

  if (progress.state === "executing") {
    return ["Working on it..."];
  }

  const lines = ["Preparing the task..."];

  if (progress.reason) {
    lines.push(`Reason: ${progress.reason}`);
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

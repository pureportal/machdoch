import process from "node:process";
import type { CustomizationDiscoveryOptions } from "../../core/customizations.js";
import type {
  TaskExecutionProgress,
  TaskExecutionState,
} from "../../core/types.js";
import type { RuntimeProfileSummary } from "../../core/runtime-contract.generated.js";

const createStateProgressLine = (
  progress: TaskExecutionProgress,
): string => {
  const message = progress.message.trim();

  return `[${progress.state}] ${message || "Task state changed."}`;
};

export const formatExecutionProgressLines = (
  progress: TaskExecutionProgress,
): string[] => {
  const terminalPrefixes: Record<
    Extract<
      TaskExecutionState,
      "completed" | "planned" | "blocked" | "unsupported" | "cancelled"
    >,
    string
  > = {
    completed: "Done",
    planned: "Plan ready",
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

  const lines = [createStateProgressLine(progress)];

  if (progress.reason) {
    lines.push(`reason: ${progress.reason}`);
  }

  if (progress.executedTools.length > 0) {
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
): CustomizationDiscoveryOptions => {
  return {
    discoverUserCustomizations: true,
    includeDiagnostics: true,
    ...(discoverGithubCustomizations
      ? { discoverGithubCustomizations: true }
      : {}),
  };
};

export const createUserConfigSummaryLines = (
  userConfigPath: string | undefined,
  options?: {
    env?: NodeJS.ProcessEnv;
    getuid?: () => number;
  },
): string[] => {
  const lines = [`user config: ${userConfigPath?.trim() || "unknown"}`];
  const env = options?.env ?? process.env;
  const getuid =
    options?.getuid ??
    (typeof process.getuid === "function"
      ? process.getuid.bind(process)
      : undefined);
  const sudoUser = env.SUDO_USER?.trim();

  if (getuid?.() === 0 && sudoUser && sudoUser !== "root") {
    lines.push(
      `sudo notice: running as root via sudo for ${sudoUser}; this may inspect root's user config. Run without sudo to inspect ${sudoUser}'s normal config.`,
    );
  }

  return lines;
};

import type { WorkspaceGitCall } from "@machdoch/fleet-protocol/workspace-contract";

export interface WorkspaceGitSlowCall {
  command: string;
  repository: string;
  durationMs: number;
  queuedMs: number;
  priority: WorkspaceGitCall["priority"];
  success: boolean;
}

const repositoryName = (repository: string): string =>
  repository.split(/[\\/]/u).filter(Boolean).at(-1) ?? repository;

export const slowestWorkspaceGitCalls = (
  calls: readonly WorkspaceGitCall[],
  limit: number,
): WorkspaceGitSlowCall[] =>
  [...calls]
    .sort(
      (left, right) =>
        right.durationMs + right.queuedMs - (left.durationMs + left.queuedMs),
    )
    .slice(0, limit)
    .map((call) => ({
      command: call.arguments
        .filter((argument) => !argument.startsWith("core."))
        .filter((argument) => argument !== "-c")
        .join(" "),
      repository: repositoryName(call.repository),
      durationMs: Math.round(call.durationMs),
      queuedMs: Math.round(call.queuedMs),
      priority: call.priority,
      success: call.success,
    }));

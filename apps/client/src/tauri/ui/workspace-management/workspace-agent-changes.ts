import type { TaskExecutionFileChanges } from "@machdoch/fleet-protocol/task-file-changes";

export interface AgentChangedFile {
  path: string;
  operation: TaskExecutionFileChanges["files"][number]["operation"];
}

interface MessageWithExecution {
  source?:
    | { kind: string; execution?: { fileChanges?: TaskExecutionFileChanges } }
    | undefined;
}

const joinRepositoryPath = (
  repositoryPath: string | undefined,
  path: string,
): string =>
  !repositoryPath || repositoryPath === "."
    ? path
    : `${repositoryPath.replace(/\/+$/u, "")}/${path}`;

export const latestAgentChangedFiles = (
  messages: readonly MessageWithExecution[],
): AgentChangedFile[] => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const source = messages[index]?.source;
    const changes =
      source?.kind === "execution" ? source.execution?.fileChanges : undefined;
    if (!changes) continue;
    return changes.files.map((file) => ({
      path: joinRepositoryPath(file.repositoryPath, file.path),
      operation: file.operation,
    }));
  }
  return [];
};

export const formatFileContextForChat = (context: {
  path: string;
  selection: { fromLine: number; toLine: number; text: string } | null;
}): string => {
  if (!context.selection) return `\`${context.path}\``;
  const range =
    context.selection.fromLine === context.selection.toLine
      ? `${context.selection.fromLine}`
      : `${context.selection.fromLine}-${context.selection.toLine}`;
  return `\`${context.path}:${range}\`\n\`\`\`\n${context.selection.text}\n\`\`\``;
};

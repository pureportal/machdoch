import type { RalphFlowScope } from "../../../../core/ralph.js";
import type { ActiveDesktopTaskSummary } from "../../runtime";
import { createFlowAlias } from "./create-flow-alias.helper";
import { normalizeRalphFlowScope } from "./normalize-ralph-flow-scope.helper";

type RalphTaskArguments = Pick<ActiveDesktopTaskSummary, "arguments">;

export const createRalphRunTaskId = (flowId: string): string => {
  const safeFlowId = createFlowAlias(flowId) || "flow";

  return `ralph-${safeFlowId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
};

export const parseRalphRunTaskId = (
  taskId: string,
): { flowId: string; startedAt: number } | null => {
  const match = /^ralph-(.+)-(\d+)-[a-z0-9]+$/u.exec(taskId.trim());

  if (!match) {
    return null;
  }

  const flowId = match[1];
  const startedAt = Number(match[2]);

  if (!flowId || !Number.isFinite(startedAt)) {
    return null;
  }

  return { flowId, startedAt };
};

export const normalizeWorkspaceForTaskComparison = (
  workspaceRoot: string | null | undefined,
): string => {
  let normalized = (workspaceRoot ?? "").trim().replace(/\\/gu, "/");
  const namespacedUncMatch = /^\/{2}[?.]\/unc\//iu.exec(normalized);

  if (namespacedUncMatch) {
    normalized = `//${normalized.slice(namespacedUncMatch[0].length)}`;
  } else {
    const namespaceMatch = /^\/{2}[?.]\//u.exec(normalized);
    const withoutNamespace = namespaceMatch
      ? normalized.slice(namespaceMatch[0].length)
      : "";

    if (/^[a-z]:\//iu.test(withoutNamespace)) {
      normalized = withoutNamespace;
    }
  }

  normalized = normalized.startsWith("//")
    ? `//${normalized.slice(2).replace(/\/{2,}/gu, "/")}`
    : normalized.replace(/\/{2,}/gu, "/");

  if (normalized.length > 1 && !/^[a-z]:\/$/iu.test(normalized)) {
    normalized = normalized.replace(/\/+$/u, "");
  }

  return /^[a-z]:\//iu.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
};

export const getRalphArgumentValue = (
  argumentsList: readonly string[],
  flag: string,
): string | null => {
  const index = argumentsList.indexOf(flag);

  return index >= 0 ? argumentsList[index + 1]?.trim() || null : null;
};

export const getRalphTaskAction = (task: RalphTaskArguments): string | null => {
  return task.arguments[0]?.trim() || null;
};

export const getRalphTaskFlowReference = (
  task: RalphTaskArguments,
): string | null => {
  const action = getRalphTaskAction(task);

  if (action === "run") {
    return task.arguments[1]?.trim() || null;
  }

  if (action === "create") {
    return getRalphArgumentValue(task.arguments, "--name");
  }

  return null;
};

export const getRalphTaskFlowScope = (
  task: RalphTaskArguments,
): RalphFlowScope => {
  return normalizeRalphFlowScope(
    getRalphArgumentValue(task.arguments, "--scope"),
  );
};

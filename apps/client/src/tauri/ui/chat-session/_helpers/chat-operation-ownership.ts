export interface ChatOperationOwner {
  launchId: string;
  windowId: string;
  instanceId: string;
}

interface NativeChatOperationOwner {
  id: string;
  kind: string;
  sessionId?: string;
}

const CHAT_OPERATION_KINDS = new Set([
  "chat-run",
  "prompt-enhancement",
  "task-interview",
]);

export type ChatOperationRecoveryAction =
  | "retain"
  | "cancel"
  | "reconcile"
  | "observe";

export const getChatOperationRecoveryAction = (
  owner: ChatOperationOwner,
  current: ChatOperationOwner,
  active: boolean,
): ChatOperationRecoveryAction => {
  if (
    owner.launchId === current.launchId &&
    owner.windowId === current.windowId &&
    owner.instanceId === current.instanceId
  ) {
    return "retain";
  }

  const orphaned =
    owner.launchId !== current.launchId ||
    (owner.windowId === current.windowId &&
      owner.instanceId !== current.instanceId);

  if (!orphaned) {
    return active ? "retain" : "observe";
  }

  return active ? "cancel" : "reconcile";
};

export const getOrphanedChatOperationIds = (
  activeTasks: readonly NativeChatOperationOwner[],
  sessionIds: ReadonlySet<string>,
): string[] => {
  return activeTasks
    .filter(
      (task) =>
        CHAT_OPERATION_KINDS.has(task.kind) &&
        (!task.sessionId || !sessionIds.has(task.sessionId)),
    )
    .map((task) => task.id)
    .sort();
};

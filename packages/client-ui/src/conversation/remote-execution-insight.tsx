import { useMemo } from "react";
import type { ProductMessage } from "@machdoch/fleet-protocol";
import type { TaskExecutionInsight } from "@machdoch/fleet-protocol/task-execution-insight";
import {
  taskFileChangePageSchema,
  taskFileChangeHunkPageSchema,
  type TaskFileChangeReader,
} from "@machdoch/fleet-protocol/task-file-changes";
import type {
  FleetOperationTransport,
  ProductCommandHandler,
} from "@machdoch/product-ui";
import { ExecutionInsightRow } from "./execution-insight-row";

export function RemoteExecutionInsight({
  sessionId,
  message,
  execution,
  transport,
  onCommand,
  enabled,
  onOpenWorkspaceFile,
}: {
  sessionId: string;
  message: ProductMessage;
  execution: TaskExecutionInsight;
  transport: FleetOperationTransport;
  onCommand: ProductCommandHandler;
  enabled: boolean;
  onOpenWorkspaceFile: (path: string) => void;
}): React.ReactElement {
  const messageId = message.id;
  const reader = useMemo<TaskFileChangeReader>(
    () => ({
      getFiles: async (changeSetId, afterId) =>
        taskFileChangePageSchema.parse(
          await transport.invoke("get_session_file_change_files", {
            sessionId,
            messageId,
            changeSetId,
            limit: 100,
            ...(afterId === undefined ? {} : { afterId }),
          }),
        ),
      getHunks: async (changeSetId, fileId, afterOrdinal) =>
        taskFileChangeHunkPageSchema.parse(
          await transport.invoke("get_session_file_change_hunks", {
            sessionId,
            messageId,
            changeSetId,
            fileId,
            limit: 100,
            ...(afterOrdinal === undefined ? {} : { afterOrdinal }),
          }),
        ),
    }),
    [sessionId, messageId, transport],
  );
  return (
    <ExecutionInsightRow
      execution={execution}
      fileChangeReader={reader}
      onOpenWorkspaceFile={onOpenWorkspaceFile}
      onRetryTask={
        enabled && message.actions.canRetry && message.taskId
          ? () => {
              void onCommand({ kind: "retry", taskId: message.taskId! });
            }
          : undefined
      }
      onContinueTask={
        enabled && message.actions.canContinue && message.taskId
          ? () => {
              void onCommand({ kind: "continue", taskId: message.taskId! });
            }
          : undefined
      }
    />
  );
}

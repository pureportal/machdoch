import {
  useEffect,
  type MutableRefObject,
} from "react";
import {
  subscribeToDesktopTaskProgress,
} from "../../runtime";
import {
  appendThinkingProgress,
  type TaskThinkingTrace,
} from "../../task-thinking.model";
import type { TaskExecutionProgress } from "../../../../core/types.js";

export type UpdateThinkingTrace = (
  sessionId: string,
  taskId: string,
  updater: (trace: TaskThinkingTrace) => TaskThinkingTrace,
) => void;

export type HandleDesktopTaskProgress = (
  progress: TaskExecutionProgress,
  timestamp: number,
) => void;

export type HandleUnhandledDesktopTaskProgress = (
  sessionId: string,
  taskId: string,
  progress: TaskExecutionProgress,
  timestamp: number,
) => void;

export type ResolveDesktopTaskSessionId = (taskId: string) => string | null;

export const useDesktopTaskProgress = (options: {
  activeDesktopTasksRef: MutableRefObject<Map<string, string>>;
  ignoredDesktopTaskIdsRef: MutableRefObject<Set<string>>;
  progressHandlersRef?: MutableRefObject<Map<string, HandleDesktopTaskProgress>>;
  onUnhandledProgress?: HandleUnhandledDesktopTaskProgress;
  resolveSessionIdForTask?: ResolveDesktopTaskSessionId;
  updateThinkingTrace: UpdateThinkingTrace;
}): void => {
  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void subscribeToDesktopTaskProgress((progressEvent) => {
      let sessionId = options.activeDesktopTasksRef.current.get(
        progressEvent.taskId,
      );

      if (!sessionId) {
        sessionId =
          options.resolveSessionIdForTask?.(progressEvent.taskId) ?? undefined;

        if (sessionId) {
          options.activeDesktopTasksRef.current.set(progressEvent.taskId, sessionId);
        }
      }

      if (
        !sessionId ||
        options.ignoredDesktopTaskIdsRef.current.has(progressEvent.taskId)
      ) {
        return;
      }

      options.updateThinkingTrace(sessionId, progressEvent.taskId, (trace) => {
        return appendThinkingProgress(
          trace,
          progressEvent.progress,
          progressEvent.timestamp,
        );
      });

      const progressHandler = options.progressHandlersRef?.current.get(
        progressEvent.taskId,
      );

      if (progressHandler) {
        progressHandler(progressEvent.progress, progressEvent.timestamp);
        return;
      }

      options.onUnhandledProgress?.(
        sessionId,
        progressEvent.taskId,
        progressEvent.progress,
        progressEvent.timestamp,
      );
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
        return;
      }

      unsubscribe = unlisten;
    });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [
    options.activeDesktopTasksRef,
    options.ignoredDesktopTaskIdsRef,
    options.onUnhandledProgress,
    options.progressHandlersRef,
    options.resolveSessionIdForTask,
    options.updateThinkingTrace,
  ]);
};

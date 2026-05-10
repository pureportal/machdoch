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

export type UpdateThinkingTrace = (
  sessionId: string,
  taskId: string,
  updater: (trace: TaskThinkingTrace) => TaskThinkingTrace,
) => void;

export const useDesktopTaskProgress = (options: {
  activeDesktopTasksRef: MutableRefObject<Map<string, string>>;
  ignoredDesktopTaskIdsRef: MutableRefObject<Set<string>>;
  updateThinkingTrace: UpdateThinkingTrace;
}): void => {
  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void subscribeToDesktopTaskProgress((progressEvent) => {
      const sessionId = options.activeDesktopTasksRef.current.get(
        progressEvent.taskId,
      );

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
    options.updateThinkingTrace,
  ]);
};

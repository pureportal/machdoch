import {
  useEffect,
  useRef,
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

interface QueuedDesktopTaskProgress {
  progress: TaskExecutionProgress;
  timestamp: number;
}

interface QueuedDesktopTaskProgressBatch {
  sessionId: string;
  taskId: string;
  events: QueuedDesktopTaskProgress[];
}

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
  const optionsRef = useRef(options);

  optionsRef.current = options;

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    let scheduledFlushId: number | null = null;
    let scheduledFlushKind: "animation-frame" | "timeout" | null = null;
    const queuedProgressByTaskId = new Map<
      string,
      QueuedDesktopTaskProgressBatch
    >();

    const flushQueuedProgress = (): void => {
      scheduledFlushId = null;
      scheduledFlushKind = null;

      if (queuedProgressByTaskId.size === 0) {
        return;
      }

      const batches = [...queuedProgressByTaskId.values()];

      queuedProgressByTaskId.clear();

      for (const batch of batches) {
        optionsRef.current.updateThinkingTrace(
          batch.sessionId,
          batch.taskId,
          (trace) => {
            let nextTrace = trace;

            for (const event of batch.events) {
              nextTrace = appendThinkingProgress(
                nextTrace,
                event.progress,
                event.timestamp,
              );
            }

            return nextTrace;
          },
        );
      }
    };

    const cancelScheduledFlush = (): void => {
      if (scheduledFlushId === null) {
        return;
      }

      if (
        scheduledFlushKind === "animation-frame" &&
        typeof window.cancelAnimationFrame === "function"
      ) {
        window.cancelAnimationFrame(scheduledFlushId);
      } else {
        window.clearTimeout(scheduledFlushId);
      }

      scheduledFlushId = null;
      scheduledFlushKind = null;
    };

    const scheduleQueuedProgressFlush = (): void => {
      if (scheduledFlushId !== null) {
        return;
      }

      if (typeof window.requestAnimationFrame === "function") {
        scheduledFlushKind = "animation-frame";
        scheduledFlushId = window.requestAnimationFrame(flushQueuedProgress);
        return;
      }

      scheduledFlushKind = "timeout";
      scheduledFlushId = window.setTimeout(flushQueuedProgress, 16);
    };

    const flushQueuedProgressForTask = (taskId: string): void => {
      const batch = queuedProgressByTaskId.get(taskId);

      if (!batch) {
        return;
      }

      queuedProgressByTaskId.delete(taskId);

      if (queuedProgressByTaskId.size === 0) {
        cancelScheduledFlush();
      }

      optionsRef.current.updateThinkingTrace(
        batch.sessionId,
        batch.taskId,
        (trace) => {
          let nextTrace = trace;

          for (const event of batch.events) {
            nextTrace = appendThinkingProgress(
              nextTrace,
              event.progress,
              event.timestamp,
            );
          }

          return nextTrace;
        },
      );
    };

    const queueProgressUpdate = (
      sessionId: string,
      taskId: string,
      progress: TaskExecutionProgress,
      timestamp: number,
    ): void => {
      const existingBatch = queuedProgressByTaskId.get(taskId);

      if (existingBatch) {
        existingBatch.sessionId = sessionId;
        existingBatch.events.push({ progress, timestamp });
      } else {
        queuedProgressByTaskId.set(taskId, {
          sessionId,
          taskId,
          events: [{ progress, timestamp }],
        });
      }

      scheduleQueuedProgressFlush();
    };

    void subscribeToDesktopTaskProgress((progressEvent) => {
      const currentOptions = optionsRef.current;
      let sessionId = currentOptions.activeDesktopTasksRef.current.get(
        progressEvent.taskId,
      );

      if (!sessionId) {
        sessionId =
          currentOptions.resolveSessionIdForTask?.(progressEvent.taskId) ??
          undefined;

        if (sessionId) {
          currentOptions.activeDesktopTasksRef.current.set(
            progressEvent.taskId,
            sessionId,
          );
        }
      }

      if (
        !sessionId ||
        currentOptions.ignoredDesktopTaskIdsRef.current.has(progressEvent.taskId)
      ) {
        return;
      }

      if (progressEvent.progress.cancellable) {
        queueProgressUpdate(
          sessionId,
          progressEvent.taskId,
          progressEvent.progress,
          progressEvent.timestamp,
        );
      } else {
        flushQueuedProgressForTask(progressEvent.taskId);
        currentOptions.updateThinkingTrace(
          sessionId,
          progressEvent.taskId,
          (trace) => {
            return appendThinkingProgress(
              trace,
              progressEvent.progress,
              progressEvent.timestamp,
            );
          },
        );
      }

      const progressHandler = currentOptions.progressHandlersRef?.current.get(
        progressEvent.taskId,
      );

      if (progressHandler) {
        progressHandler(progressEvent.progress, progressEvent.timestamp);
        return;
      }

      currentOptions.onUnhandledProgress?.(
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
      cancelScheduledFlush();
      queuedProgressByTaskId.clear();
      unsubscribe?.();
    };
  }, []);
};

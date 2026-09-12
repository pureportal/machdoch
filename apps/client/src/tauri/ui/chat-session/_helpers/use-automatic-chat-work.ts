import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import type { UserAgentLimitsSettings } from "../../../../core/runtime-contract.generated.js";
import {
  getActiveChatOperationIds,
  type ChatSessionRecord,
} from "../../chat-session.model";
import { loadActiveDesktopTasks } from "../../runtime";
import { startAutomaticWorkPump } from "../../app-shell/automatic-work-pump";
import {
  beginCrossWindowOperation,
  releaseCrossWindowOperation,
} from "../../lib/cross-window-operation";
import {
  createExecutionRetryPrompt,
  getPendingExecutionRetry,
} from "./execution-retry";
import type { ChatSessionShellStateController } from "./use-chat-session-shell-state";
import type { SubmitTaskToSessionOptions } from "./use-session-task-submission";

export interface AutomaticChatWorkOptions {
  ready: boolean;
  state: Pick<
    ChatSessionShellStateController,
    "shellState" | "getSessionById" | "flushPersistence"
  >;
  settings: UserAgentLimitsSettings;
  getUnsettledTaskId: (sessionId: string) => string | null;
  dispatchQueued: (session: ChatSessionRecord) => void;
  submit: (options: SubmitTaskToSessionOptions) => boolean;
}

export const processAutomaticChatWork = async (
  read: () => AutomaticChatWorkOptions,
): Promise<void> => {
  let options = read();
  if (!options.ready) return;
  const sessions = options.state.shellState.sessions.filter(
    (session) =>
      getPendingExecutionRetry(session, options.settings) ||
      options.state.shellState.queuedSessionMessages.some(
        (message) =>
          message.sessionId === session.id && message.status !== "failed",
      ),
  );
  if (!sessions.length) return;
  const nativeTasks = await loadActiveDesktopTasks();
  if (isTauri() && nativeTasks === null) return;
  for (const snapshot of sessions) {
    options = read();
    const session = options.state.getSessionById(snapshot.id);
    if (
      !options.ready ||
      !session ||
      options.getUnsettledTaskId(session.id) ||
      getActiveChatOperationIds(session).length ||
      nativeTasks?.some((task) => task.sessionId === session.id)
    )
      continue;
    const retry = getPendingExecutionRetry(session, options.settings);
    if (!retry) {
      options.dispatchQueued(session);
      continue;
    }
    if (Date.now() < retry.readyAt) continue;
    const lease = await beginCrossWindowOperation(
      `automatic-retry:${retry.attempt.previousTaskId}`,
    );
    if (!lease) continue;
    try {
      options = read();
      const latest = options.state.getSessionById(session.id);
      const pending =
        latest && getPendingExecutionRetry(latest, options.settings);
      if (
        !options.ready ||
        !latest ||
        pending?.taskId !== retry.taskId ||
        Date.now() < pending.readyAt ||
        options.getUnsettledTaskId(session.id) ||
        getActiveChatOperationIds(latest).length
      )
        continue;
      const submitted = options.submit({
        sessionSnapshot: latest,
        taskId: pending.taskId,
        executionAttempt: pending.attempt,
        task: createExecutionRetryPrompt(pending.attempt),
        contextAttachments: pending.source.contextAttachments ?? [],
        messageSettings: pending.source.settings,
        visibleMessageContent: pending.attempt.task,
        promptHistoryContent: pending.attempt.task,
        clearDraft: false,
        activateSession: false,
      });
      if (submitted) {
        await options.state.flushPersistence();
      }
    } finally {
      await releaseCrossWindowOperation(lease);
    }
  }
};

export const useAutomaticChatWork = (
  options: AutomaticChatWorkOptions,
): void => {
  const latest = useRef(options);
  latest.current = options;
  const pump = useRef<ReturnType<typeof startAutomaticWorkPump> | null>(null);
  useEffect(() => {
    pump.current = startAutomaticWorkPump(
      () => processAutomaticChatWork(() => latest.current),
      (error) => console.error("Failed to advance automatic chat work", error),
    );
    return () => {
      pump.current?.stop();
      pump.current = null;
    };
  }, []);
  useEffect(() => {
    pump.current?.wake();
  }, [options.ready, options.state.shellState, options.settings]);
};

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import {
  sessionDataCommands,
  sessionIndexPageSchema,
  sessionMessagePageSchema,
  sessionComposerTextSchema,
  type SessionDataCommand,
} from "@machdoch/fleet-protocol/session-data";
import {
  createVisibleConversationMessages,
  isQuickVoiceSession,
  type ChatSessionMessage,
  type ChatSessionRecord,
  type ShellPersistedState,
} from "../../chat-session.model";
import {
  createSessionExportPayload,
  createSessionHistoryIndex,
  filterSessionHistoryIndex,
  type SessionHistoryIndexEntryCache,
} from "./session-history-index";
import { getCurrentShellWindowLabel } from "@machdoch/media-studio/tauri/ui/lib/_helpers/shell-store-storage.helper.js";
import type {
  FleetShellMessageSnapshot,
  FleetShellSessionSnapshot,
  FleetShellAttachmentSnapshot,
} from "../../runtime";
import type { ChatSessionContextAttachment } from "@machdoch/client-ui/composer/model";
import { createFleetComposerText } from "./fleet-composer-text";
import { createExecutionThinkingTrace } from "./execution-message";
import { normalizeTaskExecutionFileChanges } from "@machdoch/fleet-protocol/task-file-change-normalization";
import {
  taskFileChangePageSchema,
  taskFileChangeHunkPageSchema,
} from "@machdoch/fleet-protocol/task-file-changes";

interface Options {
  hasHydrated: boolean;
  state: ShellPersistedState;
  projectSession: (session: ChatSessionRecord) => FleetShellSessionSnapshot;
  projectAttachment: (
    attachment: ChatSessionContextAttachment,
  ) => FleetShellAttachmentSnapshot;
  projectMessage: (
    message: ChatSessionMessage,
    messages: ChatSessionMessage[],
    workspace: string | null,
  ) => FleetShellMessageSnapshot;
  importSessionPayload: (payload: unknown) => number;
  flushPersistence: () => Promise<void>;
}

export function useFleetSessionData(options: Options): void {
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    if (getCurrentShellWindowLabel() !== "main") return;
    let disposed = false;
    let stop: (() => void) | undefined;
    const revisions = new WeakMap<ChatSessionMessage[], Promise<string>>();
    const indexCache: SessionHistoryIndexEntryCache = new Map();
    const revision = (messages: ChatSessionMessage[]): Promise<string> => {
      const previous = revisions.get(messages);
      if (previous) return previous;
      const history = messages.map(({ source, ...message }) => ({
        ...message,
        source:
          source?.kind === "thinking"
            ? { kind: source.kind }
            : source?.kind === "execution"
              ? { kind: source.kind, execution: source.execution }
              : source,
      }));
      const pending = crypto.subtle
        .digest("SHA-256", new TextEncoder().encode(JSON.stringify(history)))
        .then((bytes) =>
          [...new Uint8Array(bytes)]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join(""),
        );
      revisions.set(messages, pending);
      return pending;
    };
    const handle = async (request: {
      id: string;
      command: string;
      args: unknown;
    }): Promise<void> => {
      if (!Object.hasOwn(sessionDataCommands, request.command)) return;
      let result: unknown = null;
      let error: string | null = null;
      try {
        const current = latest.current;
        if (!current.hasHydrated)
          throw new Error("Session history is loading. Try again.");
        const command = request.command as SessionDataCommand;
        if (command === "import_session_export") {
          const prepared = request.args as { payload?: unknown };
          let imported = 0;
          flushSync(() => {
            imported = current.importSessionPayload(prepared.payload);
          });
          await current.flushPersistence();
          result = { imported };
        } else if (command === "get_session_export") {
          const args = sessionDataCommands.get_session_export.parse(
            request.args,
          );
          if (
            args.sessionIds.some(
              (id) =>
                !current.state.sessions.some(
                  (session) =>
                    session.id === id && !isQuickVoiceSession(session),
                ),
            )
          )
            throw new Error(
              "An exported session changed. Refresh the session list.",
            );
          result = createSessionExportPayload(current.state, args.sessionIds);
        } else if (command === "get_session_composer_text") {
          const args = sessionDataCommands.get_session_composer_text.parse(
            request.args,
          );
          const session = current.state.sessions.find(
            ({ id }) => id === args.sessionId,
          );
          if (!session)
            throw new Error("This session was removed. Refresh the device.");
          result = sessionComposerTextSchema.parse(
            createFleetComposerText(
              current.state,
              session,
              current.projectAttachment,
            ),
          );
        } else if (command === "get_session_index") {
          const args = sessionDataCommands.get_session_index.parse(
            request.args,
          );
          const index = createSessionHistoryIndex(
            current.state.sessions,
            indexCache,
          );
          const filtered = filterSessionHistoryIndex(index, {
            scope: args.scope,
            status: args.statuses,
            queuedSessionMessages: current.state.queuedSessionMessages,
            searchQuery: args.query,
            projectFilter: args.project,
            tagFilters: args.tags,
          }).sessions;
          const end = Math.min(filtered.length, args.offset + args.limit);
          result = sessionIndexPageSchema.parse({
            sessions: filtered
              .slice(args.offset, end)
              .map(current.projectSession),
            total: filtered.length,
            nextOffset: end < filtered.length ? end : null,
            sessionIds: filtered
              .filter((session) => !isQuickVoiceSession(session))
              .map(({ id }) => id),
            projects: index.projects,
            tags: index.tags,
            statuses: [
              ...new Set(
                current.state.sessions.flatMap((session) => {
                  const projected = current.projectSession(session);
                  return projected.unread === undefined
                    ? [projected.status]
                    : [projected.status, "unread"];
                }),
              ),
            ],
          });
        } else if (
          command === "get_session_file_change_files" ||
          command === "get_session_file_change_hunks"
        ) {
          const { sessionId, messageId, ...pageRequest } = sessionDataCommands[command].parse(request.args);
          const message = current.state.sessions
            .find(({ id }) => id === sessionId)
            ?.messages.find(({ id }) => id === messageId);
          if (
            message?.source?.kind !== "execution" ||
            message.source.execution.fileChanges?.changeSetId !==
              pageRequest.changeSetId
          )
            throw new Error(
              "These file changes are no longer in this conversation. Reload its history.",
            );
          const response = await invoke(
            command === "get_session_file_change_files"
              ? "get_task_file_change_files"
              : "get_task_file_change_hunks",
            { request: pageRequest },
          );
          result = (
            command === "get_session_file_change_files"
              ? taskFileChangePageSchema
              : taskFileChangeHunkPageSchema
          ).parse(response);
        } else {
          const args = sessionDataCommands.get_session_message_page.parse(
            request.args,
          );
          const session = current.state.sessions.find(
            ({ id }) => id === args.sessionId,
          );
          if (!session)
            throw new Error("This session was removed. Refresh the device.");
          const historyRevision = await revision(session.messages);
          if (
            args.expectedRevision &&
            args.expectedRevision !== historyRevision
          )
            throw new Error("The conversation changed. Reload its history.");
          const messages = createVisibleConversationMessages(session.messages);
          const end = args.beforeMessageId
            ? messages.findIndex(({ id }) => id === args.beforeMessageId)
            : messages.length;
          if (end < 0)
            throw new Error(
              "This message was removed. Reload the conversation.",
            );
          const start = Math.max(0, end - args.limit);
          result = sessionMessagePageSchema.parse({
            sessionId: session.id,
            revision: historyRevision,
            messages: messages.slice(start, end).map((message) => ({
              ...current.projectMessage(message, messages, session.workspace),
              ...(message.source?.kind === "thinking"
                ? { thinking: message.source.thinking }
                : message.source?.kind === "execution"
                  ? {
                      execution: {
                        task: message.source.execution.task,
                        status: message.source.execution.status,
                        fileChanges: normalizeTaskExecutionFileChanges(
                          message.source.execution.fileChanges,
                        ),
                        ...(message.source.execution.response
                          ? {
                              response: {
                                relatedFiles:
                                  message.source.execution.response
                                    .relatedFiles,
                                verification:
                                  message.source.execution.response
                                    .verification,
                              },
                            }
                          : {}),
                        ...(message.source.execution.autopilot
                          ? {
                              autopilot: {
                                continuationCount:
                                  message.source.execution.autopilot
                                    .continuationCount,
                              },
                            }
                          : {}),
                        ...(typeof message.source.execution.metadata
                          ?.instructionResolutionId === "string"
                          ? {
                              metadata: {
                                instructionResolutionId:
                                  message.source.execution.metadata
                                    .instructionResolutionId,
                                instructionSources:
                                  message.source.execution.metadata
                                    .instructionSources,
                              },
                            }
                          : {}),
                      },
                      thinking:
                        message.source.thinking ??
                        createExecutionThinkingTrace(message.source.execution),
                    }
                  : {}),
            })),
            total: messages.length,
            hasEarlier: start > 0,
          });
        }
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      await invoke("complete_fleet_client_request", {
        id: request.id,
        result,
        error,
      });
    };
    void listen<{ id: string; command: string; args: unknown }>(
      "machdoch://fleet-client-request",
      ({ payload }) => {
        void handle(payload).catch((error: unknown) =>
          console.error("Session data could not be confirmed", error),
        );
      },
    )
      .then((unsubscribe) => {
        if (disposed) unsubscribe();
        else stop = unsubscribe;
      })
      .catch((error: unknown) =>
        console.error("Session data could not be opened", error),
      );
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
}

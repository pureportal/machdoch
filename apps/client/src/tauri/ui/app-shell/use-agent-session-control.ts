import {
  APP_CONTROL_LEVEL,
  useAppControlView,
} from "@machdoch/media-studio/tauri/ui/app-control/use-app-control.js";
import {
  canArchiveSession,
  canRenameSession,
  getSessionOverviewStatus,
  type ChatSessionRecord,
  type ShellPersistedState,
} from "../chat-session.model";
import {
  createAgentSession,
  describeAgentSession,
  findAgentSession,
} from "../chat-session/_helpers/agent-session-requests";
import { findPendingAgentQuestion } from "../chat-session/_helpers/session-needs-input";
import type { ProviderChooserState } from "../chat-session/_helpers/session-shell-view-model";
import type { RunningTaskMessageAction } from "../lib/_helpers/shell-store-normalizers.helper";

const BUSY_ACTIONS = ["queue", "steer", "stop-and-send"] as const;
const sessionIdInput = { type: "string", minLength: 1 } as const;
const promptInput = { type: "string", minLength: 1, maxLength: 100_000 } as const;
const titleInput = { type: "string", minLength: 1, maxLength: 200 } as const;

export interface AgentSessionControlOptions {
  enabled: boolean;
  shellState: ShellPersistedState;
  providerChooserState: ProviderChooserState;
  onStartSession: (session: ChatSessionRecord, prompt: string) => string | null;
  onSendMessage: (input: {
    sessionId: string;
    prompt: string;
    runningAction: RunningTaskMessageAction;
  }) => boolean;
  onCancelSession: (session: ChatSessionRecord) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onArchiveSession: (sessionId: string) => void;
}

export function useAgentSessionControl({
  enabled,
  shellState,
  providerChooserState,
  onStartSession,
  onSendMessage,
  onCancelSession,
  onRenameSession,
  onArchiveSession,
}: AgentSessionControlOptions): void {
  useAppControlView(
    "agents",
    APP_CONTROL_LEVEL.app,
    enabled
      ? {
          location: [],
          actions: [
            {
              id: "agents.start_session",
              description:
                "Start a new background chat in a known workspace and send its first message.",
              effect: "write",
              input: {
                type: "object",
                properties: {
                  workspace: { type: "string", minLength: 1 },
                  prompt: promptInput,
                  title: titleInput,
                  provider: { type: "string", minLength: 1 },
                  model: { type: "string", minLength: 1, maxLength: 200 },
                  mode: { type: "string", enum: ["ask", "machdoch"] },
                },
                required: ["workspace", "prompt"],
              },
              run: (input) => {
                const session = createAgentSession(
                  shellState,
                  providerChooserState,
                  {
                    workspace: String(input.workspace),
                    ...(typeof input.title === "string"
                      ? { title: input.title }
                      : {}),
                    ...(typeof input.provider === "string"
                      ? { provider: input.provider }
                      : {}),
                    ...(typeof input.model === "string"
                      ? { model: input.model }
                      : {}),
                    ...(input.mode === "ask" || input.mode === "machdoch"
                      ? { mode: input.mode }
                      : {}),
                  },
                );
                const taskId = onStartSession(session, String(input.prompt));
                if (!taskId) throw new Error("The chat could not start.");
                return { ...describeAgentSession(session), taskId };
              },
            },
            {
              id: "agents.send_message",
              description:
                "Send a message to a chat. While it runs, the message answers a pending question, or is queued, steers the run, or stops it and sends.",
              effect: "write",
              input: {
                type: "object",
                properties: {
                  sessionId: sessionIdInput,
                  prompt: promptInput,
                  whenBusy: { type: "string", enum: BUSY_ACTIONS },
                },
                required: ["sessionId", "prompt"],
              },
              run: (input) => {
                const session = findAgentSession(
                  shellState.sessions,
                  String(input.sessionId),
                );
                const runningAction =
                  BUSY_ACTIONS.find((action) => action === input.whenBusy) ??
                  "queue";
                const delivery = findPendingAgentQuestion(session)
                  ? "answer"
                  : getSessionOverviewStatus(session) === "running"
                    ? runningAction
                    : "start";
                if (
                  !onSendMessage({
                    sessionId: session.id,
                    prompt: String(input.prompt),
                    runningAction,
                  })
                )
                  throw new Error("The message could not be sent.");
                return { sessionId: session.id, delivery };
              },
            },
            {
              id: "agents.cancel_task",
              description: "Stop the running task of a chat.",
              effect: "write",
              input: {
                type: "object",
                properties: { sessionId: sessionIdInput },
                required: ["sessionId"],
              },
              run: (input) => {
                const session = findAgentSession(
                  shellState.sessions,
                  String(input.sessionId),
                );
                if (getSessionOverviewStatus(session) !== "running")
                  throw new Error("This chat has no running task.");
                onCancelSession(session);
                return { sessionId: session.id, cancelled: true };
              },
            },
            {
              id: "agents.rename_session",
              description: "Rename a chat.",
              effect: "write",
              input: {
                type: "object",
                properties: { sessionId: sessionIdInput, title: titleInput },
                required: ["sessionId", "title"],
              },
              run: (input) => {
                const session = findAgentSession(
                  shellState.sessions,
                  String(input.sessionId),
                );
                if (!canRenameSession(session))
                  throw new Error("This chat cannot be renamed.");
                const title = String(input.title).trim();
                onRenameSession(session.id, title);
                return { sessionId: session.id, title };
              },
            },
            {
              id: "agents.archive_session",
              description: "Archive a chat.",
              effect: "write",
              input: {
                type: "object",
                properties: { sessionId: sessionIdInput },
                required: ["sessionId"],
              },
              run: (input) => {
                const session = findAgentSession(
                  shellState.sessions,
                  String(input.sessionId),
                );
                if (!canArchiveSession(session))
                  throw new Error("This chat cannot be archived.");
                onArchiveSession(session.id);
                return { sessionId: session.id, archived: true };
              },
            },
          ],
        }
      : null,
  );
}

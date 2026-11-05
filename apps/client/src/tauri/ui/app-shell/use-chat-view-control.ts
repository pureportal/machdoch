import {
  APP_CONTROL_LEVEL,
  useAppControlView,
} from "@machdoch/media-studio/tauri/ui/app-control/use-app-control.js";
import {
  getSessionOverviewStatus,
  getSessionTitle,
  type ChatSessionRecord,
} from "../chat-session.model";

const LISTED_SESSIONS = 12;
const STATE_DRAFT_CHARS = 1_000;

const describeSession = (session: ChatSessionRecord) => ({
  id: session.id,
  title: getSessionTitle(session),
  status: getSessionOverviewStatus(session),
  workspace: session.workspace,
});

export interface ChatViewControlOptions {
  enabled: boolean;
  activeSession: ChatSessionRecord;
  sessions: readonly ChatSessionRecord[];
  onActivateSession: (sessionId: string) => void;
  onCreateSession: () => void;
  onDraftChange: (draft: string) => void;
}

export function useChatViewControl({
  enabled,
  activeSession,
  sessions,
  onActivateSession,
  onCreateSession,
  onDraftChange,
}: ChatViewControlOptions): void {
  useAppControlView(
    "chat",
    APP_CONTROL_LEVEL.view,
    enabled
      ? {
          location: [getSessionTitle(activeSession)],
          workspaceRoot: activeSession.workspace,
          state: () => ({
            activeSession: {
              ...describeSession(activeSession),
              provider: activeSession.provider,
              model: activeSession.model,
              mode: activeSession.mode ?? null,
              messageCount: activeSession.messages.length,
              draft:
                activeSession.draft.length > STATE_DRAFT_CHARS
                  ? `${activeSession.draft.slice(0, STATE_DRAFT_CHARS)}…`
                  : activeSession.draft,
            },
            sessions: sessions.slice(0, LISTED_SESSIONS).map(describeSession),
          }),
          actions: [
            {
              id: "chat.open_session",
              description:
                "Show a chat session. Find ids in the view state or with list_chat_sessions.",
              effect: "write",
              input: {
                type: "object",
                properties: { sessionId: { type: "string", minLength: 1 } },
                required: ["sessionId"],
              },
              run: (input) => {
                const session = sessions.find(
                  ({ id }) => id === input.sessionId,
                );
                if (!session)
                  throw new Error("No visible chat session has that id.");
                onActivateSession(session.id);
                return describeSession(session);
              },
            },
            {
              id: "chat.new_session",
              description: "Start a new empty chat session and show it.",
              effect: "write",
              input: { type: "object", properties: {} },
              run: () => {
                onCreateSession();
                return { created: true };
              },
            },
            {
              id: "chat.set_draft",
              description:
                "Write text into the shown session's message box for the user to review and send.",
              effect: "write",
              input: {
                type: "object",
                properties: {
                  text: { type: "string", maxLength: 20_000 },
                },
                required: ["text"],
              },
              run: (input) => {
                onDraftChange(String(input.text));
                return { sessionId: activeSession.id };
              },
            },
          ],
        }
      : null,
  );
}

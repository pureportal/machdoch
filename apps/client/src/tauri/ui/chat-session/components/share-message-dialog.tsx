import { useMemo, type JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@machdoch/media-studio/tauri/ui/components/ui/dialog.js";
import { SearchableSelect } from "@machdoch/media-studio/tauri/ui/components/ui/searchable-select.js";
import {
  getSessionTitle,
  type ChatSessionRecord,
} from "../../chat-session.model";
import { getRenderedMessageContent } from "../_helpers/execution-message";
import {
  canReceiveSharedMessage,
  getShareableMessages,
  type MessageShareDraft,
} from "../_helpers/message-sharing";

const MESSAGE_LABEL_LENGTH = 90;

export interface ShareMessageDialogProps {
  draft: MessageShareDraft | null;
  sessions: readonly ChatSessionRecord[];
  onDraftChange: (draft: MessageShareDraft) => void;
  onClose: () => void;
  onSend: (draft: MessageShareDraft) => void;
}

const createMessageLabel = (content: string, role: "user" | "agent") => {
  const text = content.replace(/\s+/g, " ").trim();
  const excerpt =
    text.length > MESSAGE_LABEL_LENGTH
      ? `${text.slice(0, MESSAGE_LABEL_LENGTH - 1)}…`
      : text;
  return `${role === "agent" ? "Agent" : "You"}: ${excerpt}`;
};

export const ShareMessageDialog = ({
  draft,
  sessions,
  onDraftChange,
  onClose,
  onSend,
}: ShareMessageDialogProps): JSX.Element => {
  const sourceSession = draft
    ? sessions.find((session) => session.id === draft.sourceSessionId)
    : undefined;
  const messages = useMemo(
    () => (sourceSession ? getShareableMessages(sourceSession) : []),
    [sourceSession],
  );
  const messageOptions = useMemo(
    () =>
      messages
        .map((message) => ({
          value: message.id,
          label: createMessageLabel(
            getRenderedMessageContent(message),
            message.role,
          ),
        }))
        .reverse(),
    [messages],
  );
  const targetOptions = useMemo(
    () =>
      sessions
        .filter(
          (session) =>
            session.id !== draft?.sourceSessionId &&
            canReceiveSharedMessage(session),
        )
        .map((session) => ({
          value: session.id,
          label: getSessionTitle(session),
        })),
    [draft?.sourceSessionId, sessions],
  );
  const selectedMessage = messages.find(
    (message) => message.id === draft?.messageId,
  );
  const canSend = Boolean(
    draft &&
    selectedMessage &&
    targetOptions.some((option) => option.value === draft.targetSessionId),
  );

  return (
    <Dialog
      open={draft !== null && sourceSession !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className="app-share-message-dialog grid max-w-lg gap-4"
      >
        <DialogHeader>
          <DialogTitle className="text-base">Send to chat</DialogTitle>
        </DialogHeader>
        {draft ? (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (canSend) onSend(draft);
            }}
          >
            <div className="grid gap-1.5">
              <span
                aria-hidden="true"
                className="text-[13px] font-medium text-slate-300"
              >
                Message
              </span>
              <SearchableSelect
                label="Message"
                value={draft.messageId ?? ""}
                options={messageOptions}
                onChange={(messageId) => onDraftChange({ ...draft, messageId })}
              />
              {selectedMessage ? (
                <p className="line-clamp-4 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs leading-5 whitespace-pre-wrap text-slate-400">
                  {getRenderedMessageContent(selectedMessage).trim()}
                </p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <span
                aria-hidden="true"
                className="text-[13px] font-medium text-slate-300"
              >
                Chat
              </span>
              <SearchableSelect
                label="Chat"
                value={draft.targetSessionId ?? ""}
                options={targetOptions}
                onChange={(targetSessionId) =>
                  onDraftChange({ ...draft, targetSessionId })
                }
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!canSend}>
                Send
              </Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};

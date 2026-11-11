"use client";

import { useState } from "react";
import { Archive, Ellipsis, Pencil } from "lucide-react";
import type { ChatDetail } from "@/lib/cloud-chat-contract";
import { cloudRequest } from "../api-client";
import { PropertyMenu } from "../property-menu";
import { useToast } from "../toast";

async function updateChat(
  chatId: string,
  change: { title: string } | { archived: true },
) {
  const { chat } = await cloudRequest<ChatDetail>(`chats/${chatId}`);
  await cloudRequest(`chats/${chatId}/update`, {
    method: "POST",
    key: crypto.randomUUID(),
    body: { revision: chat.revision, ...change },
  });
}

export function AgentChatTitle({
  chatId,
  title,
  level,
  onRenamed,
  onArchived,
}: {
  chatId: string | null;
  title: string;
  level: "h1" | "h2";
  onRenamed: (title: string) => void;
  onArchived: () => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const Heading = level;
  if (editing && chatId)
    return (
      <form
        className="cloud-agent-title-form"
        onSubmit={(event) => {
          event.preventDefault();
          const value = draft.trim();
          setEditing(false);
          if (!value || value === title) return;
          void updateChat(chatId, { title: value })
            .then(() => onRenamed(value))
            .catch((reason: Error) => toast(reason.message, "error"));
        }}
      >
        <input
          aria-label="Conversation name"
          value={draft}
          maxLength={120}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onBlur={(event) => event.currentTarget.form?.requestSubmit()}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setDraft(title);
              setEditing(false);
            }
          }}
        />
      </form>
    );
  return (
    <>
      <Heading className="cloud-agent-title">{title}</Heading>
      {chatId && (
        <PropertyMenu
          label="Conversation"
          options={[
            { value: "rename", label: "Rename", icon: <Pencil size={14} /> },
            { value: "archive", label: "Archive", icon: <Archive size={14} /> },
          ]}
          onSelect={(value) => {
            if (value === "rename") {
              setDraft(title);
              setEditing(true);
              return;
            }
            void updateChat(chatId, { archived: true })
              .then(onArchived)
              .catch((reason: Error) => toast(reason.message, "error"));
          }}
        >
          <button
            type="button"
            className="cloud-icon-button"
            aria-label="Conversation actions"
          >
            <Ellipsis size={14} />
          </button>
        </PropertyMenu>
      )}
    </>
  );
}

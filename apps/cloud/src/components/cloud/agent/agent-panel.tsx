"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  History,
  Maximize2,
  Minus,
  Sparkles,
  SquarePen,
  X,
} from "lucide-react";
import type { CloudChat } from "@/lib/cloud-chat-contract";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import { cloudRequest } from "../api-client";
import { PropertyMenu } from "../property-menu";
import { AgentChatTitle } from "./agent-chat-title";
import { AgentConversation } from "./agent-conversation";
import { useAgentShell } from "./agent-shell";

const newChat = "new";

export function AgentDock({ workspace }: { workspace: CloudWorkspace }) {
  const shell = useAgentShell();
  const router = useRouter();
  const pathname = usePathname();
  const [chats, setChats] = useState<CloudChat[]>([]);
  const onAgentPage =
    pathname === "/cloud/chat" || pathname.startsWith("/cloud/chat/");
  const role = workspace.actor.role;
  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "j")
        return;
      event.preventDefault();
      if (shell.open) shell.minimizePanel();
      else shell.openPanel();
    };
    document.addEventListener("keydown", toggle);
    return () => document.removeEventListener("keydown", toggle);
  }, [shell]);
  useEffect(() => {
    if (!shell.open) return;
    const abort = new AbortController();
    void cloudRequest<{ chats: CloudChat[] }>("chats", { signal: abort.signal })
      .then((result) => setChats(result.chats))
      .catch(() => undefined);
    return () => abort.abort();
  }, [shell.open, shell.chatId]);
  if (onAgentPage) return null;
  return (
    <>
      {shell.open && (
        <section className="cloud-agent-panel" aria-label="Agent">
          <header className="cloud-agent-panel-header">
            <AgentChatTitle
              key={shell.chatId ?? "new"}
              chatId={shell.chatId}
              title={
                shell.chatId ? (shell.chatTitle ?? "Conversation") : "New chat"
              }
              level="h2"
              onRenamed={(title) => shell.selectChat(shell.chatId, title)}
              onArchived={() => shell.selectChat(null)}
            />
            <PropertyMenu
              label="Conversations"
              align="end"
              options={[
                { value: newChat, label: "New chat" },
                ...chats.map((chat) => ({
                  value: chat.id,
                  label: chat.title,
                  group: "Recent",
                })),
              ]}
              value={shell.chatId ?? newChat}
              onSelect={(value) =>
                shell.selectChat(
                  value === newChat ? null : value,
                  chats.find((chat) => chat.id === value)?.title ?? null,
                )
              }
            >
              <button type="button" aria-label="Conversations">
                <History size={14} />
              </button>
            </PropertyMenu>
            <button
              type="button"
              aria-label="New chat"
              onClick={() => shell.selectChat(null)}
            >
              <SquarePen size={14} />
            </button>
            <button
              type="button"
              aria-label="Open as page"
              onClick={() => {
                shell.minimizePanel();
                router.push(
                  shell.chatId ? `/cloud/chat/${shell.chatId}` : "/cloud/chat",
                );
              }}
            >
              <Maximize2 size={14} />
            </button>
            <button
              type="button"
              aria-label="Minimize"
              onClick={shell.minimizePanel}
            >
              <Minus size={14} />
            </button>
            <button type="button" aria-label="Close" onClick={shell.closePanel}>
              <X size={14} />
            </button>
          </header>
          <AgentConversation
            key={shell.chatId ?? newChat}
            workspace={workspace}
            chatId={shell.chatId}
            pageEntity={shell.pageEntity}
            writable={role !== "viewer"}
            canConfigure={role === "owner" || role === "admin"}
            variant="panel"
            initialPrompt={shell.draft}
            onPromptUsed={shell.clearDraft}
            onCreated={(id, title) => shell.selectChat(id, title)}
          />
        </section>
      )}
      <div className="cloud-agent-dock">
        {shell.chatId && !shell.open && (
          <button
            type="button"
            className="cloud-agent-dock-tab"
            onClick={() => shell.openPanel()}
          >
            {shell.chatTitle ?? "Conversation"}
          </button>
        )}
        <button
          type="button"
          className="cloud-agent-dock-button"
          aria-expanded={shell.open}
          aria-keyshortcuts="Control+j Meta+j"
          onClick={() =>
            shell.open ? shell.minimizePanel() : shell.openPanel()
          }
        >
          <Sparkles size={14} aria-hidden="true" />
          Agent
        </button>
      </div>
    </>
  );
}

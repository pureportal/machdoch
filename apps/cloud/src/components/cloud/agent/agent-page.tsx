"use client";

import { holderCan } from "@/lib/cloud-permissions";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { MessageSquare, SquarePen } from "lucide-react";
import type { ChatDetail, CloudChat } from "@/lib/cloud-chat-contract";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import { Button } from "@/components/ui/button";
import { cloudRequest } from "../api-client";
import { AgentChatTitle } from "./agent-chat-title";
import { AgentConversation } from "./agent-conversation";
import { useAgentShell } from "./agent-shell";

export function AgentPage({
  workspace,
  initialChats,
  initial,
}: {
  workspace: CloudWorkspace;
  initialChats: CloudChat[];
  initial?: ChatDetail;
}) {
  const router = useRouter();
  const shell = useAgentShell();
  const [chats, setChats] = useState(initialChats);
  const [more, setMore] = useState(initialChats.length === 50);
  useEffect(() => setChats(initialChats), [initialChats]);
  const chatId = initial?.chat.id ?? null;
  return (
    <div className="cloud-agent-page">
      <aside className="cloud-agent-history" aria-label="Conversations">
        <Button asChild variant="outline" size="sm">
          <Link href="/cloud/chat">
            <SquarePen />
            New chat
          </Link>
        </Button>
        <nav>
          {chats.map((chat) => (
            <Link
              key={chat.id}
              href={`/cloud/chat/${chat.id}`}
              aria-current={chat.id === chatId ? "page" : undefined}
            >
              <MessageSquare size={13} aria-hidden="true" />
              <span>{chat.title}</span>
            </Link>
          ))}
        </nav>
        {more && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              void cloudRequest<{ chats: CloudChat[] }>(
                `chats?beforeId=${chats.at(-1)!.id}`,
              ).then((result) => {
                setChats([...chats, ...result.chats]);
                setMore(result.chats.length === 50);
              })
            }
          >
            Older conversations
          </Button>
        )}
      </aside>
      <section className="cloud-agent-main" aria-label="Agent">
        <header className="cloud-agent-main-header">
          <AgentChatTitle
            chatId={chatId}
            title={initial?.chat.title ?? "Agent"}
            level="h1"
            onRenamed={() => router.refresh()}
            onArchived={() => {
              if (shell.chatId === chatId) shell.selectChat(null);
              router.push("/cloud/chat");
              router.refresh();
            }}
          />
        </header>
        <AgentConversation
          key={chatId ?? "new"}
          workspace={workspace}
          chatId={chatId}
          initial={initial}
          pageEntity={null}
          writable={holderCan(workspace.actor, "ai.chat")}
          canConfigure={holderCan(workspace.actor, "ai.manage")}
          variant="page"
          onCreated={(id, title) => {
            shell.selectChat(id, title);
            router.push(`/cloud/chat/${id}`);
            router.refresh();
          }}
        />
      </section>
    </div>
  );
}

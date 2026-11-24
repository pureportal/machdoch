"use client";

import { pollWhileVisible } from "@machdoch/product-ui/view-visibility";
import { History, LoaderCircle, Sparkles } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { AgentSession, AgentSessions } from "@/lib/cloud-chat-contract";
import { cloudRequest } from "../api-client";
import { PropertyMenu } from "../property-menu";
import { useAgentShell } from "./agent-shell";

const visibleTabs = 3;

export function AgentStatusBar() {
  const shell = useAgentShell();
  const router = useRouter();
  const pathname = usePathname();
  const [sessions, setSessions] = useState<AgentSessions>({
    running: [],
    recent: [],
  });
  const delay = useRef(10_000);
  const onAgentPage =
    pathname === "/cloud/chat" || pathname.startsWith("/cloud/chat/");
  useEffect(() => {
    const abort = new AbortController();
    const stop = pollWhileVisible(
      () =>
        cloudRequest<AgentSessions>("agent-sessions", {
          signal: abort.signal,
        })
          .then((value) => {
            if (abort.signal.aborted) return;
            setSessions(value);
            delay.current = value.running.length ? 2_000 : 10_000;
          })
          .catch(() => undefined),
      () => delay.current,
    );
    return () => {
      abort.abort();
      stop();
    };
  }, [shell.chatId, shell.open]);
  const all = [...sessions.running, ...sessions.recent];
  const reopen = (session: Pick<AgentSession, "id" | "title">) => {
    if (onAgentPage) {
      router.push(`/cloud/chat/${session.id}`);
      return;
    }
    shell.selectChat(session.id, session.title);
    shell.openPanel();
  };
  const minimized =
    !shell.open && !onAgentPage && shell.chatId
      ? {
          id: shell.chatId,
          title:
            all.find((session) => session.id === shell.chatId)?.title ??
            shell.chatTitle ??
            "Conversation",
        }
      : null;
  const tabs = [
    ...sessions.running.map((session) => ({ ...session, running: true })),
    ...(minimized &&
    !sessions.running.some((session) => session.id === minimized.id)
      ? [{ ...minimized, running: false }]
      : []),
  ].slice(0, visibleTabs);
  return (
    <footer className="cloud-statusbar">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className="cloud-session-tab"
          aria-pressed={shell.open && shell.chatId === tab.id}
          onClick={() =>
            shell.open && shell.chatId === tab.id
              ? shell.minimizePanel()
              : reopen(tab)
          }
        >
          {tab.running && (
            <LoaderCircle
              size={12}
              className="animate-spin"
              aria-label="Running"
            />
          )}
          <span>{tab.title}</span>
        </button>
      ))}
      {!onAgentPage && (
        <button
          type="button"
          className="cloud-agent-toggle"
          aria-label="Agent"
          aria-expanded={shell.open}
          aria-keyshortcuts="Control+j Meta+j"
          onClick={() =>
            shell.open ? shell.minimizePanel() : shell.openPanel()
          }
        >
          <Sparkles size={13} aria-hidden="true" />
          <span>Agent</span>
        </button>
      )}
      <PropertyMenu
        label="Agent sessions"
        align="end"
        options={all.map((session) => ({
          value: session.id,
          label: session.title,
          group: sessions.running.includes(session) ? "Running" : "Recent",
        }))}
        value={shell.chatId ?? undefined}
        onSelect={(id) => {
          const session = all.find((entry) => entry.id === id);
          if (session) reopen(session);
        }}
      >
        <button
          type="button"
          className="cloud-session-history"
          aria-label="Agent sessions"
          disabled={!all.length}
        >
          <History size={14} />
        </button>
      </PropertyMenu>
    </footer>
  );
}

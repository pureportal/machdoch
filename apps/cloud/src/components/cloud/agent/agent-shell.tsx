"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChatContextKind } from "@/lib/cloud-chat-contract";

export interface AgentPageEntity {
  kind: ChatContextKind;
  id: string;
  label: string;
  title: string | null;
}

interface AgentShellState {
  open: boolean;
  chatId: string | null;
  chatTitle: string | null;
  pageEntity: AgentPageEntity | null;
  draft: string;
  sendDraft: boolean;
  openPanel: (chatId?: string | null, draft?: string, send?: boolean) => void;
  clearDraft: () => void;
  closePanel: () => void;
  minimizePanel: () => void;
  selectChat: (chatId: string | null, title?: string | null) => void;
  setPageEntity: (entity: AgentPageEntity | null) => void;
}

const AgentShellContext = createContext<AgentShellState | null>(null);
const storageKey = "machdoch.cloud.agent.chat";

export function AgentShellProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [chat, setChat] = useState<{ id: string | null; title: string | null }>(
    { id: null, title: null },
  );
  const [pageEntity, setPageEntity] = useState<AgentPageEntity | null>(null);
  const [draft, setDraft] = useState("");
  const [sendDraft, setSendDraft] = useState(false);
  useEffect(() => {
    const stored = sessionStorage.getItem(storageKey);
    if (!stored) return;
    try {
      const value = JSON.parse(stored) as { id: string; title: string | null };
      setChat({ id: value.id, title: value.title });
    } catch {
      sessionStorage.removeItem(storageKey);
    }
  }, []);
  const selectChat = useCallback(
    (id: string | null, title: string | null = null) => {
      setChat({ id, title });
      if (id) sessionStorage.setItem(storageKey, JSON.stringify({ id, title }));
      else sessionStorage.removeItem(storageKey);
    },
    [],
  );
  const value = useMemo<AgentShellState>(
    () => ({
      open,
      chatId: chat.id,
      chatTitle: chat.title,
      pageEntity,
      draft,
      sendDraft,
      openPanel: (chatId, nextDraft, send = false) => {
        if (chatId !== undefined) selectChat(chatId);
        if (nextDraft) {
          setDraft(nextDraft);
          setSendDraft(send);
        }
        setOpen(true);
      },
      clearDraft: () => {
        setDraft("");
        setSendDraft(false);
      },
      closePanel: () => {
        setOpen(false);
        selectChat(null);
      },
      minimizePanel: () => setOpen(false),
      selectChat,
      setPageEntity,
    }),
    [open, chat, pageEntity, draft, sendDraft, selectChat],
  );
  return (
    <AgentShellContext.Provider value={value}>
      {children}
    </AgentShellContext.Provider>
  );
}

export function useAgentShell(): AgentShellState {
  const value = useContext(AgentShellContext);
  if (!value) throw new Error("Agent shell is unavailable.");
  return value;
}

export function useAgentPageEntity(entity: AgentPageEntity | null): void {
  const { setPageEntity } = useAgentShell();
  const latest = useRef(entity);
  latest.current = entity;
  const key = entity
    ? `${entity.kind}:${entity.id}:${entity.label}:${entity.title ?? ""}`
    : "";
  useEffect(() => {
    setPageEntity(latest.current);
    return () => setPageEntity(null);
  }, [key, setPageEntity]);
}

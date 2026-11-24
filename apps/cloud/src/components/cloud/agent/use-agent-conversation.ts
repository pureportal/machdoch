"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CloudProviderSettings } from "@machdoch/fleet-protocol/cloud-providers";
import { defaultAgentModel } from "@/lib/agent-personalization";
import type {
  AgentAction,
  ChatContextReference,
  ChatDetail,
  CloudChatTurn,
} from "@/lib/cloud-chat-contract";
import {
  CloudRequestError,
  cloudRequest,
  createCommandSender,
} from "../api-client";
import { triageChangedEvent } from "../events";
import { fetchAgentModelPreference } from "../use-agent-models";

const activeStates = ["queued", "running", "cancel_requested"];

function mergeTurns(
  previous: CloudChatTurn[],
  incoming: CloudChatTurn[],
): CloudChatTurn[] {
  const merged = new Map(previous.map((turn) => [turn.id, turn]));
  for (const turn of incoming)
    if (!merged.has(turn.id) || merged.get(turn.id)!.revision <= turn.revision)
      merged.set(turn.id, turn);
  return [...merged.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
}

export interface AgentConversation {
  detail: ChatDetail | null;
  settings: CloudProviderSettings | null;
  providerId: string;
  model: string;
  selectModel: (providerId: string, model: string) => void;
  active: boolean;
  pending: boolean;
  error: string;
  olderAvailable: boolean;
  loadingOlder: boolean;
  loadOlder: () => Promise<void>;
  send: (
    prompt: string,
    context: ChatContextReference[],
    attachmentIds: string[],
  ) => Promise<boolean>;
  cancel: (turn: CloudChatTurn) => Promise<void>;
  retry: (turn: CloudChatTurn) => Promise<void>;
  reload: () => Promise<void>;
  settleAction: (
    turn: CloudChatTurn,
    action: AgentAction,
    decision: "apply" | "dismiss",
  ) => Promise<AgentAction | null>;
}

export function useAgentConversation(
  chatId: string | null,
  onCreated: (chatId: string, title: string) => void,
  initial?: ChatDetail,
): AgentConversation {
  const router = useRouter();
  const [detail, setDetail] = useState<ChatDetail | null>(initial ?? null);
  const [settings, setSettings] = useState<CloudProviderSettings | null>(null);
  const [selection, setSelection] = useState({ providerId: "", model: "" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [olderAvailable, setOlderAvailable] = useState(
    initial?.turns.length === 20,
  );
  const [loadingOlder, setLoadingOlder] = useState(false);
  const sender = useRef(createCommandSender());
  const actions = useRef(createCommandSender());
  const sequence = useRef(0);
  const active =
    detail?.turns.some((turn) => activeStates.includes(turn.state)) ?? false;

  useEffect(() => {
    const abort = new AbortController();
    const load = () =>
      Promise.all([
        cloudRequest<CloudProviderSettings>("ai-providers", {
          signal: abort.signal,
        }),
        fetchAgentModelPreference(abort.signal),
      ])
        .then(([next, preference]) => {
          setSettings(next);
          setSelection((current) => {
            const valid = (choice: { providerId: string; model: string }) =>
              next.providers.some(
                (provider) =>
                  provider.id === choice.providerId &&
                  provider.models.includes(choice.model),
              );
            if (valid(current)) return current;
            return (
              defaultAgentModel(next.providers, preference) ?? {
                providerId: "",
                model: "",
              }
            );
          });
        })
        .catch((reason: Error) => {
          if (!abort.signal.aborted) setError(reason.message);
        });
    void load();
    window.addEventListener("focus", load);
    return () => {
      abort.abort();
      window.removeEventListener("focus", load);
    };
  }, []);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (!chatId) return;
      const current = ++sequence.current;
      const next = await cloudRequest<ChatDetail>(`chats/${chatId}`, {
        signal,
      });
      if (sequence.current !== current || signal?.aborted) return;
      setDetail((previous) => ({
        chat: next.chat,
        turns:
          previous?.chat.id === next.chat.id
            ? mergeTurns(previous.turns, next.turns)
            : next.turns,
      }));
      if (!initial || initial.chat.id !== chatId)
        setOlderAvailable((value) => value || next.turns.length === 20);
    },
    [chatId, initial],
  );

  useEffect(() => {
    if (!chatId) {
      setDetail(null);
      return;
    }
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      clearTimeout(timer);
      let stopped = false;
      try {
        if (!document.hidden) await refresh(abort.signal);
        setError("");
      } catch (reason) {
        if (abort.signal.aborted) return;
        setError((reason as Error).message);
        if (
          reason instanceof CloudRequestError &&
          [403, 404].includes(reason.status)
        ) {
          setDetail(null);
          stopped = true;
        }
      } finally {
        polling = false;
      }
      if (!stopped && !abort.signal.aborted)
        timer = setTimeout(() => void poll(), active ? 1000 : 5000);
    };
    const resume = () => {
      if (!document.hidden) void poll();
    };
    void poll();
    document.addEventListener("visibilitychange", resume);
    return () => {
      abort.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      sequence.current++;
    };
  }, [chatId, refresh, active]);

  const selectModel = useCallback((providerId: string, model: string) => {
    setSelection({ providerId, model });
  }, []);

  async function run<T>(operation: () => Promise<T>): Promise<T | null> {
    setPending(true);
    setError("");
    try {
      return await operation();
    } catch (reason) {
      setError((reason as Error).message);
      if (reason instanceof CloudRequestError && reason.status === 409)
        await refresh().catch(() => undefined);
      return null;
    } finally {
      setPending(false);
    }
  }

  return {
    detail: detail?.chat.id === chatId ? detail : null,
    settings,
    providerId: selection.providerId,
    model: selection.model,
    selectModel,
    active,
    pending,
    error,
    olderAvailable,
    loadingOlder,
    async loadOlder() {
      const first = detail?.turns[0];
      if (!detail || !first || loadingOlder) return;
      setLoadingOlder(true);
      try {
        const older = await cloudRequest<ChatDetail>(
          `chats/${detail.chat.id}?beforeSequence=${first.sequence}`,
        );
        setOlderAvailable(older.turns.length === 20);
        setDetail((current) =>
          current?.chat.id === older.chat.id
            ? { ...current, turns: mergeTurns(current.turns, older.turns) }
            : current,
        );
      } catch (reason) {
        setError((reason as Error).message);
      } finally {
        setLoadingOlder(false);
      }
    },
    async send(prompt, context, attachmentIds) {
      const result = await run(() =>
        sender.current<{ chatId: string }>("chats", {
          chatId: chatId ?? null,
          revision: chatId ? (detail?.chat.revision ?? null) : null,
          providerId: selection.providerId,
          model: selection.model,
          prompt,
          context,
          attachmentIds,
        }),
      );
      if (!result) return false;
      if (result.chatId !== chatId)
        onCreated(result.chatId, prompt.split("\n", 1)[0]!.slice(0, 120));
      else await refresh().catch(() => undefined);
      return true;
    },
    async cancel(turn) {
      await run(() =>
        actions.current(`chat-turns/${turn.id}/cancel`, {
          requestId: turn.requestId,
        }),
      );
      await refresh().catch(() => undefined);
    },
    async retry(turn) {
      await run(() =>
        actions.current(`chat-turns/${turn.id}/retry`, {
          revision: turn.revision,
          providerId: selection.providerId,
          model: selection.model,
        }),
      );
      await refresh().catch(() => undefined);
    },
    async reload() {
      await refresh().catch(() => undefined);
    },
    async settleAction(turn, action, decision) {
      const settled = await run(() =>
        cloudRequest<AgentAction>(
          `chat-turns/${turn.id}/actions/${action.id}/${decision}`,
          { method: "POST", key: crypto.randomUUID(), body: {} },
        ),
      );
      await refresh().catch(() => undefined);
      if (settled?.state === "applied") {
        if (settled.kind === "triage")
          window.dispatchEvent(new Event(triageChangedEvent));
        router.refresh();
      }
      return settled;
    },
  };
}

"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MessageSquare, Plus, Send, Sparkles } from "lucide-react";
import type {
  ChatDetail,
  CloudChat,
  CloudChatTurn,
} from "@/lib/cloud-chat-contract";
import type { CloudProviderSettings } from "@machdoch/fleet-protocol/cloud-providers";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  CloudRequestError,
  cloudRequest,
  createCommandSender,
} from "./api-client";
import { ChatMessages } from "./chat-messages";

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

export function CloudChatView({
  workspace,
  settings,
  initialChats,
  initial,
}: {
  workspace: CloudWorkspace;
  settings: CloudProviderSettings;
  initialChats: CloudChat[];
  initial?: ChatDetail;
}) {
  const router = useRouter();
  const [detail, setDetail] = useState<ChatDetail | null>(initial ?? null);
  const [chats, setChats] = useState(initialChats);
  const [moreChats, setMoreChats] = useState(initialChats.length === 50);
  const [available, setAvailable] = useState(settings);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [providerId, setProviderId] = useState(
    initial?.turns.at(-1)?.providerId ?? settings.providers[0]?.id ?? "",
  );
  const [model, setModel] = useState(
    initial?.turns.at(-1)?.model ?? settings.providers[0]?.models[0] ?? "",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [signInRequired, setSignInRequired] = useState(false);
  const [olderPending, setOlderPending] = useState(false);
  const [olderAvailable, setOlderAvailable] = useState(
    initial?.turns.length === 20,
  );
  const messages = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const sender = useRef(createCommandSender());
  const actions = useRef(createCommandSender());
  const sequence = useRef(0);
  const chatId = initial?.chat.id;
  const writable = workspace.actor.role !== "viewer";
  const provider = available.providers.find((entry) => entry.id === providerId);
  const active =
    detail?.turns.some((turn) =>
      ["queued", "running", "cancel_requested"].includes(turn.state),
    ) ?? false;
  const canSend =
    writable &&
    !pending &&
    !active &&
    Boolean(provider?.models.includes(model)) &&
    available.credentialStorageAvailable &&
    !signInRequired &&
    Boolean(prompt.trim());
  const needsProviders = [errorCode, detail?.turns.at(-1)?.errorCode].some(
    (code) =>
      [
        "not_found",
        "model_unavailable",
        "provider_model_unavailable",
        "credential_storage",
        "permission_changed",
      ].includes(code ?? ""),
  );
  const expireSession = useCallback((reason: unknown) => {
    if (reason instanceof CloudRequestError && reason.status === 401) {
      setSignInRequired(true);
      setConnectionError(reason.message);
      setDetail(null);
      setChats([]);
    }
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    let current = 0;
    const reload = async () => {
      const request = ++current;
      try {
        const next = await cloudRequest<CloudProviderSettings>("ai-providers", {
          signal: abort.signal,
        });
        if (abort.signal.aborted || request !== current) return;
        setAvailable(next);
        if (!chatId) {
          setSignInRequired(false);
          setConnectionError("");
        }
      } catch (reason) {
        if (!abort.signal.aborted && request === current) {
          expireSession(reason);
          setConnectionError((reason as Error).message);
        }
      }
    };
    void reload();
    const focus = () => void reload();
    window.addEventListener("focus", focus);
    return () => {
      abort.abort();
      window.removeEventListener("focus", focus);
    };
  }, [chatId, expireSession]);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (!chatId) return;
      const current = ++sequence.current;
      const next = await cloudRequest<ChatDetail>(`chats/${chatId}`, {
        signal,
      });
      if (sequence.current !== current || signal?.aborted) return;
      setDetail((previous) => {
        return {
          chat: next.chat,
          turns: mergeTurns(previous?.turns ?? [], next.turns),
        };
      });
      setConnectionError("");
      setSignInRequired(false);
    },
    [chatId],
  );
  useEffect(() => {
    if (!chatId) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let polling = false;
    async function poll() {
      if (polling || abort.signal.aborted) return;
      polling = true;
      clearTimeout(timer);
      try {
        if (!document.hidden) await refresh(abort.signal);
      } catch (reason) {
        if (abort.signal.aborted) return;
        if (
          reason instanceof CloudRequestError &&
          [403, 404].includes(reason.status)
        ) {
          setDetail(null);
          setChats([]);
        }
        expireSession(reason);
        setConnectionError((reason as Error).message);
      }
      polling = false;
      if (!abort.signal.aborted)
        timer = setTimeout(() => void poll(), active ? 1000 : 5000);
    }
    void poll();
    const onFocus = () => void poll();
    window.addEventListener("focus", onFocus);
    return () => {
      abort.abort();
      clearTimeout(timer);
      sequence.current++;
      window.removeEventListener("focus", onFocus);
    };
  }, [chatId, refresh, active, expireSession]);
  useEffect(() => {
    if (following.current && messages.current)
      messages.current.scrollTop = messages.current.scrollHeight;
  }, [detail]);

  async function turnAction(turn: CloudChatTurn, kind: "retry" | "cancel") {
    if (pending) return;
    if (kind === "retry" && !provider?.models.includes(model)) {
      setError("Choose an available provider and model.");
      setErrorCode("model_unavailable");
      return;
    }
    setPending(true);
    setError("");
    setErrorCode("");
    try {
      await actions.current(
        `chat-turns/${turn.id}/${kind}`,
        kind === "retry"
          ? { revision: turn.revision, providerId, model }
          : { requestId: turn.requestId },
      );
      await refresh();
    } catch (reason) {
      expireSession(reason);
      setError((reason as Error).message);
      setErrorCode(reason instanceof CloudRequestError ? reason.code : "");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="cloud-chat">
      <button
        className="cloud-chat-history-toggle"
        type="button"
        aria-expanded={historyOpen}
        aria-controls="chat-history"
        onClick={() => setHistoryOpen(!historyOpen)}
      >
        <MessageSquare size={17} />
        Conversations
      </button>
      <aside
        className="cloud-chat-history"
        id="chat-history"
        data-open={historyOpen}
      >
        <Button asChild variant="outline">
          <Link href="/cloud/chat">
            <Plus />
            New chat
          </Link>
        </Button>
        <nav aria-label="Conversations">
          {chats.map((chat) => (
            <Link
              key={chat.id}
              href={`/cloud/chat/${chat.id}`}
              onClick={() => setHistoryOpen(false)}
              aria-current={chat.id === chatId ? "page" : undefined}
            >
              <MessageSquare size={14} aria-hidden="true" />
              <span>{chat.title}</span>
            </Link>
          ))}
        </nav>
        {moreChats && (
          <Button
            variant="ghost"
            disabled={olderPending}
            onClick={() => {
              setOlderPending(true);
              void cloudRequest<{ chats: CloudChat[] }>(
                `chats?beforeId=${chats.at(-1)!.id}`,
              )
                .then((result) => {
                  setChats([...chats, ...result.chats]);
                  setMoreChats(result.chats.length === 50);
                })
                .catch((reason: Error) => setError(reason.message))
                .finally(() => setOlderPending(false));
            }}
          >
            Older conversations
          </Button>
        )}
      </aside>
      <section className="cloud-chat-main" aria-label="Chat">
        <header className="cloud-chat-header">
          <h1>Chat</h1>
          <div className="cloud-chat-models">
            <Select
              aria-label="AI provider"
              value={providerId}
              disabled={pending || active || !writable}
              onChange={(event) => {
                const selected = available.providers.find(
                  (entry) => entry.id === event.target.value,
                );
                setProviderId(event.target.value);
                setModel(selected?.models[0] ?? "");
              }}
            >
              {providerId && !provider && (
                <option value={providerId} disabled>
                  Provider unavailable
                </option>
              )}
              {!providerId && <option value="">Select provider</option>}
              {available.providers.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Model"
              value={model}
              disabled={pending || active || !writable || !provider}
              onChange={(event) => setModel(event.target.value)}
            >
              {model && !provider?.models.includes(model) && (
                <option value={model} disabled>
                  Model unavailable
                </option>
              )}
              {!model && <option value="">Select model</option>}
              {provider?.models.map((entry) => (
                <option key={entry}>{entry}</option>
              ))}
            </Select>
          </div>
        </header>
        {(!available.providers.length ||
          !available.credentialStorageAvailable) && (
          <p className="cloud-chat-unavailable">
            No AI providers are available.
            {["owner", "admin"].includes(workspace.actor.role) && (
              <>
                {" "}
                <Link href="/cloud/providers" className="underline">
                  Configure providers
                </Link>
              </>
            )}
          </p>
        )}
        <div
          className="cloud-chat-transcript"
          ref={messages}
          onScroll={(event) => {
            const element = event.currentTarget;
            following.current =
              element.scrollHeight - element.clientHeight - element.scrollTop <
              64;
          }}
        >
          {olderAvailable && detail && (
            <Button
              variant="ghost"
              disabled={olderPending}
              onClick={() => {
                setOlderPending(true);
                following.current = false;
                void cloudRequest<ChatDetail>(
                  `chats/${detail.chat.id}?beforeSequence=${detail.turns[0]!.sequence}`,
                )
                  .then((older) => {
                    setOlderAvailable(older.turns.length === 20);
                    setDetail((current) =>
                      current
                        ? {
                            ...current,
                            turns: mergeTurns(current.turns, older.turns),
                          }
                        : null,
                    );
                  })
                  .catch((reason: Error) => setError(reason.message))
                  .finally(() => setOlderPending(false));
              }}
            >
              Older messages
            </Button>
          )}
          {!detail && !chatId && (
            <div className="cloud-chat-welcome">
              <span className="cloud-icon-tile">
                <Sparkles size={24} strokeWidth={1.5} />
              </span>
              <h2>New conversation</h2>
            </div>
          )}
          {detail && (
            <ChatMessages
              turns={detail.turns}
              writable={writable}
              pending={pending}
              onCancel={(turn) => void turnAction(turn, "cancel")}
              onRetry={(turn) => void turnAction(turn, "retry")}
            />
          )}
        </div>
        {connectionError && (
          <div role="alert" className="cloud-error">
            <p>{connectionError}</p>
            {signInRequired && (
              <Link className="underline" href="/cloud/login">
                Sign in
              </Link>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="cloud-error">
            {error}
          </p>
        )}
        {needsProviders && (
          <Button
            className="self-start mb-3"
            variant="outline"
            onClick={() =>
              void cloudRequest<CloudProviderSettings>("ai-providers")
                .then(setAvailable)
                .catch((reason: Error) => setConnectionError(reason.message))
            }
          >
            Reload providers
          </Button>
        )}
        <form
          className="cloud-chat-composer"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSend) return;
            setPending(true);
            setError("");
            setErrorCode("");
            following.current = true;
            void sender
              .current<{ chatId: string }>("chats", {
                chatId: chatId ?? null,
                revision: detail?.chat.revision ?? null,
                providerId,
                model,
                prompt: prompt.trim(),
              })
              .then(async (result) => {
                setPrompt("");
                sender.current = createCommandSender();
                if (result.chatId !== chatId) {
                  router.push(`/cloud/chat/${result.chatId}`);
                  router.refresh();
                } else await refresh();
              })
              .catch(async (reason: Error) => {
                expireSession(reason);
                setError(reason.message);
                setErrorCode(
                  reason instanceof CloudRequestError ? reason.code : "",
                );
                if (
                  reason instanceof CloudRequestError &&
                  reason.status === 409
                )
                  await refresh().catch((failure: Error) =>
                    setConnectionError(failure.message),
                  );
              })
              .finally(() => setPending(false));
          }}
        >
          <Textarea
            aria-label="Message"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            maxLength={20000}
            disabled={pending || !writable}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <Button type="submit" disabled={!canSend}>
            <Send />
            Send
          </Button>
        </form>
      </section>
    </div>
  );
}

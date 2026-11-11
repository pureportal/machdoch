"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, Sparkles, X } from "lucide-react";
import {
  maximumChatContext,
  type ChatContextKind,
  type ChatDetail,
} from "@/lib/cloud-chat-contract";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import { Button } from "@/components/ui/button";
import { PropertyMenu } from "../property-menu";
import { AgentTurn, contextIcons } from "./agent-turn";
import { AgentContextPicker, contextKey } from "./agent-context-picker";
import type { AgentPageEntity } from "./agent-shell";
import { useAgentConversation } from "./use-agent-conversation";

const suggestions: Record<ChatContextKind | "workspace", string[]> = {
  workspace: [
    "What should I work on next?",
    "How is the current cycle going?",
    "Which issues are blocked?",
  ],
  issue: [
    "Summarize this issue",
    "What is missing before work can start?",
    "Draft sub-issues for this",
  ],
  project: [
    "How is this project going?",
    "What puts the target date at risk?",
    "Draft a status update",
  ],
  cycle: [
    "How is this cycle going?",
    "What will not finish in time?",
    "Who has the most open work?",
  ],
  team: [
    "What is the team working on?",
    "Which issues need attention?",
    "Summarize recent progress",
  ],
};

export function AgentConversation({
  workspace,
  chatId,
  initial,
  pageEntity,
  writable,
  canConfigure,
  variant,
  initialPrompt = "",
  onPromptUsed,
  onCreated,
}: {
  workspace: CloudWorkspace;
  chatId: string | null;
  initial?: ChatDetail;
  pageEntity: AgentPageEntity | null;
  writable: boolean;
  canConfigure: boolean;
  variant: "panel" | "page";
  initialPrompt?: string;
  onPromptUsed?: () => void;
  onCreated: (chatId: string, title: string) => void;
}) {
  const conversation = useAgentConversation(chatId, onCreated, initial);
  const { detail, settings, providerId, model, active, pending } = conversation;
  const [prompt, setPrompt] = useState(initialPrompt);
  const [excluded, setExcluded] = useState<string | null>(null);
  const [attached, setAttached] = useState<AgentPageEntity[]>([]);
  const [unseen, setUnseen] = useState(false);
  const transcript = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const known = new Set(detail?.chat.context.map(contextKey) ?? []);
  const pageContext =
    pageEntity &&
    !known.has(contextKey(pageEntity)) &&
    excluded !== contextKey(pageEntity)
      ? pageEntity
      : null;
  const pendingContext = [
    ...(pageContext ? [pageContext] : []),
    ...attached.filter(
      (entity) =>
        !known.has(contextKey(entity)) &&
        (!pageContext || contextKey(entity) !== contextKey(pageContext)),
    ),
  ];
  const provider = settings?.providers.find((entry) => entry.id === providerId);
  const available =
    !!settings?.credentialStorageAvailable && !!settings.providers.length;
  const canSend =
    writable &&
    available &&
    !pending &&
    !active &&
    !!provider?.models.includes(model) &&
    !!prompt.trim();
  const turns = detail?.turns ?? [];
  const lastTurn = turns.at(-1);

  useEffect(() => {
    const element = transcript.current;
    if (!element) return;
    if (following.current) element.scrollTop = element.scrollHeight;
    else setUnseen(true);
  }, [lastTurn?.revision, lastTurn?.answer, turns.length]);

  useEffect(() => {
    input.current?.focus();
  }, [chatId]);

  useEffect(() => {
    if (!initialPrompt) return;
    setPrompt(initialPrompt);
    onPromptUsed?.();
  }, [initialPrompt, onPromptUsed]);

  async function submit(text: string) {
    const value = text.trim();
    if (!value || !writable || !available || pending || active) return;
    following.current = true;
    const sent = await conversation.send(
      value,
      pendingContext.map(({ kind, id }) => ({ kind, id })),
    );
    if (!sent) return;
    setPrompt("");
    setAttached([]);
  }

  const modelOptions =
    settings?.providers.flatMap((entry) =>
      entry.models.map((name) => ({
        value: `${entry.id}::${name}`,
        label: name,
        group: entry.name,
      })),
    ) ?? [];

  return (
    <div className="cloud-agent-conversation" data-variant={variant}>
      <div
        className="cloud-agent-transcript"
        ref={transcript}
        onScroll={(event) => {
          const element = event.currentTarget;
          following.current =
            element.scrollHeight - element.clientHeight - element.scrollTop <
            48;
          if (following.current) setUnseen(false);
        }}
      >
        {conversation.olderAvailable && detail && (
          <Button
            variant="ghost"
            size="sm"
            className="self-center"
            onClick={() => {
              following.current = false;
              void conversation.loadOlder();
            }}
          >
            Earlier messages
          </Button>
        )}
        {!chatId && (
          <div className="cloud-agent-welcome">
            <span className="cloud-icon-tile">
              <Sparkles size={20} strokeWidth={1.5} />
            </span>
            {writable && available && (
              <div className="cloud-agent-suggestions">
                {suggestions[pageEntity?.kind ?? "workspace"].map(
                  (question) => (
                    <button
                      key={question}
                      type="button"
                      onClick={() => void submit(question)}
                      disabled={pending}
                    >
                      {question}
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
        )}
        {detail && (
          <ol className="cloud-agent-turns" aria-label="Conversation">
            {turns.map((turn, index) => {
              const next = turns[index + 1];
              return (
                <AgentTurn
                  key={turn.id}
                  turn={turn}
                  context={detail.chat.context}
                  latest={!next}
                  answeredWith={
                    turn.question && next?.prompt
                      ? (turn.question.options.find(
                          (option) => option === next.prompt,
                        ) ?? null)
                      : null
                  }
                  writable={writable}
                  pending={pending}
                  onAnswer={(option) => void submit(option)}
                  onCancel={() => void conversation.cancel(turn)}
                  onRetry={() => void conversation.retry(turn)}
                  onAction={(action, decision) =>
                    void conversation.settleAction(turn, action, decision)
                  }
                />
              );
            })}
          </ol>
        )}
        {unseen && (
          <button
            type="button"
            className="cloud-agent-new-reply"
            onClick={() => {
              following.current = true;
              setUnseen(false);
              transcript.current?.scrollTo({
                top: transcript.current.scrollHeight,
                behavior: "smooth",
              });
            }}
          >
            <ArrowDown size={13} aria-hidden="true" />
            New reply
          </button>
        )}
      </div>
      {conversation.error && (
        <p role="alert" className="cloud-error cloud-agent-error">
          {conversation.error}
        </p>
      )}
      {settings && !available && (
        <p className="cloud-agent-unavailable">
          No AI providers are available.
          {canConfigure && (
            <>
              {" "}
              <Link href="/cloud/providers" className="underline">
                Configure providers
              </Link>
            </>
          )}
        </p>
      )}
      <form
        className="cloud-agent-composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend) void submit(prompt);
        }}
      >
        {pendingContext.length > 0 && (
          <div className="cloud-agent-context-chips">
            {pendingContext.map((entity) => {
              const Icon = contextIcons[entity.kind];
              return (
                <div
                  key={contextKey(entity)}
                  className="cloud-agent-context-chip"
                >
                  <Icon size={12} aria-hidden="true" />
                  <span>
                    {entity.label}
                    {entity.title ? ` ${entity.title}` : ""}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${entity.label} from context`}
                    onClick={() =>
                      entity === pageContext
                        ? setExcluded(contextKey(entity))
                        : setAttached((current) =>
                            current.filter(
                              (entry) =>
                                contextKey(entry) !== contextKey(entity),
                            ),
                          )
                    }
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <textarea
          ref={input}
          aria-label="Message"
          placeholder={chatId ? "Reply…" : "Ask Agent…"}
          value={prompt}
          rows={variant === "page" ? 3 : 2}
          maxLength={20000}
          disabled={!writable}
          onChange={(event) => setPrompt(event.target.value)}
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
        <div className="cloud-agent-composer-footer">
          {modelOptions.length > 0 && (
            <PropertyMenu
              label="Model"
              options={modelOptions}
              value={`${providerId}::${model}`}
              onSelect={(value) => {
                const [nextProvider, ...rest] = value.split("::");
                conversation.selectModel(nextProvider!, rest.join("::"));
              }}
            >
              <button
                type="button"
                className="cloud-agent-model"
                disabled={pending || active || !writable}
              >
                <span>{model || "Model"}</span>
                <ChevronDown size={12} aria-hidden="true" />
              </button>
            </PropertyMenu>
          )}
          {writable && (
            <AgentContextPicker
              workspace={workspace}
              exclude={new Set([...known, ...pendingContext.map(contextKey)])}
              disabled={
                pending || active || pendingContext.length >= maximumChatContext
              }
              onAdd={(entity) => setAttached((current) => [...current, entity])}
            />
          )}
          <Button
            type="submit"
            size="icon"
            className="cloud-agent-send"
            aria-label="Send"
            disabled={!canSend}
          >
            <ArrowUp />
          </Button>
        </div>
      </form>
    </div>
  );
}

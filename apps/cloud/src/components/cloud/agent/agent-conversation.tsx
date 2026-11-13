"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  FileText,
  Paperclip,
  Sparkles,
  X,
} from "lucide-react";
import { maximumChatAttachments } from "@/lib/cloud-attachment-contract";
import {
  maximumChatContext,
  type ChatContextKind,
  type ChatDetail,
} from "@/lib/cloud-chat-contract";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import { sidebarItems } from "@/lib/cloud-sidebar-contract";
import { Button } from "@/components/ui/button";
import { PropertyMenu } from "../property-menu";
import { AgentTurn, contextIcons } from "./agent-turn";
import { AgentContextPicker, contextKey } from "./agent-context-picker";
import type { AgentPageEntity } from "./agent-shell";
import { useAgentConversation } from "./use-agent-conversation";
import { uploadAttachment } from "../attachment-upload";

interface ComposerFile {
  key: string;
  name: string;
  preview: string | null;
  id: string | null;
}

const agentDescription = sidebarItems.find(
  (item) => item.id === "agent",
)!.description;
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
  sendInitialPrompt = false,
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
  sendInitialPrompt?: boolean;
  onPromptUsed?: () => void;
  onCreated: (chatId: string, title: string) => void;
}) {
  const conversation = useAgentConversation(chatId, onCreated, initial);
  const { detail, settings, providerId, model, active, pending } = conversation;
  const [prompt, setPrompt] = useState(initialPrompt);
  const [excluded, setExcluded] = useState<string | null>(null);
  const [attached, setAttached] = useState<AgentPageEntity[]>([]);
  const [unseen, setUnseen] = useState(false);
  const [files, setFiles] = useState<ComposerFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const initialSent = useRef(false);
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
  const uploading = files.some((file) => !file.id);
  const ready =
    writable &&
    available &&
    !pending &&
    !active &&
    !uploading &&
    !!provider?.models.includes(model);
  const canSend = ready && !!prompt.trim();
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
    if (!initialPrompt || sendInitialPrompt) return;
    setPrompt(initialPrompt);
    onPromptUsed?.();
  }, [initialPrompt, sendInitialPrompt, onPromptUsed]);

  useEffect(() => {
    if (!initialPrompt || !sendInitialPrompt || !ready || initialSent.current)
      return;
    initialSent.current = true;
    onPromptUsed?.();
    void submit(initialPrompt);
  });

  function attach(selected: File[]) {
    const room = maximumChatAttachments - files.length;
    if (selected.length > room)
      setUploadError(
        `Attach up to ${maximumChatAttachments} files per message.`,
      );
    for (const file of selected.slice(0, Math.max(0, room))) {
      const key = crypto.randomUUID();
      const preview = file.type.startsWith("image/")
        ? URL.createObjectURL(file)
        : null;
      setFiles((current) => [
        ...current,
        { key, name: file.name || "file", preview, id: null },
      ]);
      void uploadAttachment(file, null)
        .then((attachment) =>
          setFiles((current) =>
            current.map((entry) =>
              entry.key === key ? { ...entry, id: attachment.id } : entry,
            ),
          ),
        )
        .catch((reason: Error) => {
          setUploadError(reason.message);
          setFiles((current) => current.filter((entry) => entry.key !== key));
        });
    }
  }

  function removeFile(key: string) {
    setFiles((current) => {
      const removed = current.find((entry) => entry.key === key);
      if (removed?.preview) URL.revokeObjectURL(removed.preview);
      return current.filter((entry) => entry.key !== key);
    });
  }

  async function submit(text: string) {
    const value = text.trim();
    if (!value || !ready) return;
    following.current = true;
    setUploadError("");
    const sent = await conversation.send(
      value,
      pendingContext.map(({ kind, id }) => ({ kind, id })),
      files.flatMap((file) => (file.id ? [file.id] : [])),
    );
    if (!sent) return;
    setPrompt("");
    setAttached([]);
    for (const file of files)
      if (file.preview) URL.revokeObjectURL(file.preview);
    setFiles([]);
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
            <h2>Ask Agent</h2>
            <p>{agentDescription}</p>
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
      {(conversation.error || uploadError) && (
        <p role="alert" className="cloud-error cloud-agent-error">
          {conversation.error || uploadError}
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
        data-dragging={dragging || undefined}
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend) void submit(prompt);
        }}
        onDragOver={(event) => {
          if (!writable || !event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          if (!writable || !event.dataTransfer.files.length) return;
          event.preventDefault();
          setDragging(false);
          attach([...event.dataTransfer.files]);
        }}
      >
        {files.length > 0 && (
          <ul className="cloud-agent-attachments" aria-label="Attached files">
            {files.map((file) => (
              <li
                key={file.key}
                className="cloud-agent-attachment"
                data-pending={!file.id || undefined}
              >
                {file.preview ? (
                  <img src={file.preview} alt="" />
                ) : (
                  <FileText size={18} aria-hidden="true" />
                )}
                <span title={file.name}>{file.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => removeFile(file.key)}
                >
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
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
          onPaste={(event) => {
            if (!event.clipboardData.files.length) return;
            event.preventDefault();
            attach([...event.clipboardData.files]);
          }}
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
            <>
              <button
                type="button"
                className="cloud-agent-attach"
                aria-label="Attach files"
                title="Attach files"
                disabled={
                  pending || active || files.length >= maximumChatAttachments
                }
                onClick={() => picker.current?.click()}
              >
                <Paperclip size={14} />
              </button>
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                onChange={(event) => {
                  attach([...(event.target.files ?? [])]);
                  event.target.value = "";
                }}
              />
            </>
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

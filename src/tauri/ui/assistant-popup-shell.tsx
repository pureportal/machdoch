import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowUpRight,
  Bot,
  BrainCircuit,
  LoaderCircle,
  Mic,
  Monitor,
  SendHorizonal,
  Sparkles,
  Square,
  WandSparkles,
  X,
  Zap,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type JSX,
  type KeyboardEvent,
} from "react";
import { revealMainWindow, showQuickVoiceWindow } from "./assistant-surface";
import { type ChatSessionMessage } from "./chat-session.model";
import { getRenderedMessageContent } from "./chat-session/_helpers/execution-message.tsx";
import { useChatSessionController } from "./chat-session/_helpers/use-chat-session-controller";
import { useNewestMessageScroll } from "./chat-session/_helpers/use-newest-message-scroll";
import {
  ContextAttachmentMenuButton,
  ContextAttachmentsList,
} from "./chat-session/components/context-attachments";
import { FileDropOverlay } from "./chat-session/components/file-drop-overlay";
import { MessageMarkdown } from "./chat-session/components/message-markdown";
import { ScrollToNewestButton } from "./chat-session/components/scroll-to-newest-button";
import { SessionModelPicker } from "./chat-session/components/session-model-picker";
import { Button } from "./components/ui/button";
import { ScrollArea } from "./components/ui/scroll-area";
import { Textarea } from "./components/ui/textarea";
import { cn } from "./lib/utils";

const QUICK_TASK_HISTORY_LIMIT = 6;
const QUICK_WINDOW_BLUR_HIDE_DELAY_MS = 100;

const QuickTaskMessage = ({
  message,
}: {
  message: ChatSessionMessage;
}): JSX.Element | null => {
  const renderedContent = getRenderedMessageContent(message).trim();

  if (message.role === "agent" && message.source?.kind === "thinking") {
    return (
      <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
        <div className="flex items-center gap-2">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          <span className="font-medium">Working in Quick Chat</span>
        </div>
      </div>
    );
  }

  if (!renderedContent) {
    return null;
  }

  const isUser = message.role === "user";

  return (
    <article
      className={cn(
        "rounded-2xl border px-4 py-3 text-sm leading-6",
        isUser
          ? "border-sky-400/20 bg-sky-400/10 text-sky-50"
          : "border-slate-800 bg-slate-900/75 text-slate-300",
      )}
    >
      <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold tracking-[0.22em] text-slate-500 uppercase">
        {isUser ? <Zap className="h-3 w-3" /> : <Bot className="h-3 w-3" />}
        {isUser ? "Quick Chat" : "Result"}
      </div>

      {isUser ? (
        <p className="whitespace-pre-wrap">{renderedContent}</p>
      ) : (
        <MessageMarkdown content={renderedContent} />
      )}
    </article>
  );
};

const QuickTaskActivity = ({
  quickTask,
}: {
  quickTask: ReturnType<typeof useChatSessionController>["quickTask"];
}): JSX.Element => {
  const recentMessages = useMemo(() => {
    return quickTask.visibleMessages
      .filter((message) => {
        if (message.role === "user") {
          return true;
        }

        return (
          message.source?.kind === "thinking" ||
          getRenderedMessageContent(message).trim().length > 0
        );
      })
      .slice(-QUICK_TASK_HISTORY_LIMIT);
  }, [quickTask.visibleMessages]);
  const newestMessageScroll = useNewestMessageScroll({
    resetKey: quickTask.session?.id ?? "quick-chat-empty",
    contentKey: recentMessages,
  });

  return (
    <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <ScrollArea className="min-h-0 flex-1">
        {recentMessages.length === 0 ? (
          <div className="flex min-h-full items-center justify-center px-6 py-10 text-center [@media(max-height:620px)]:py-5">
            <div className="grid gap-4 [@media(max-height:620px)]:gap-3">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-3xl border border-sky-400/20 bg-sky-400/10 text-sky-100 [@media(max-height:620px)]:h-12 [@media(max-height:620px)]:w-12 [@media(max-height:620px)]:rounded-2xl">
                <Sparkles className="h-6 w-6" />
              </div>
              <h2 className="text-base font-semibold text-white">
                Quick Chat, no planning board
              </h2>
            </div>
          </div>
        ) : (
          <div className="grid gap-3 px-5 py-5 [@media(max-height:620px)]:px-4 [@media(max-height:620px)]:py-3">
            {recentMessages.map((message) => (
              <QuickTaskMessage key={message.id} message={message} />
            ))}
            <div
              ref={newestMessageScroll.bottomRef}
              className="h-px shrink-0"
            />
          </div>
        )}
      </ScrollArea>
      <ScrollToNewestButton
        visible={newestMessageScroll.showScrollToNewestButton}
        onClick={newestMessageScroll.scrollToNewest}
        className="right-4 bottom-3 h-9 w-9"
      />
    </section>
  );
};

const QuickTaskComposer = ({
  controller,
}: {
  controller: ReturnType<typeof useChatSessionController>;
}): JSX.Element => {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const quickTaskComposer = controller.quickTaskComposer;
  const quickVoiceEnabled =
    controller.settingsDialog.desktopSetup.settings.quickVoiceEnabled;
  const canSend = quickTaskComposer.canSend;
  const sendQuickTask = useCallback((): void => {
    if (!quickTaskComposer.canSend) {
      return;
    }

    quickTaskComposer.onSend();
    inputRef.current?.focus();
  }, [quickTaskComposer]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <form
      className="grid gap-2.5 [@media(max-height:620px)]:gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        sendQuickTask();
      }}
    >
      <ContextAttachmentsList
        attachments={quickTaskComposer.contextAttachments}
        onRemove={quickTaskComposer.onRemoveContextAttachment}
        onClearAll={quickTaskComposer.onClearContextAttachments}
        compact
      />

      <div className="overflow-hidden rounded-2xl border border-slate-800/90 bg-slate-900/60 shadow-inner shadow-black/10 focus-within:border-sky-400/40 focus-within:ring-2 focus-within:ring-sky-500/20">
        <Textarea
          ref={inputRef}
          aria-label="Quick chat composer"
          value={quickTaskComposer.draft}
          onChange={(event) =>
            quickTaskComposer.onDraftChange(event.target.value)
          }
          onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              sendQuickTask();
            }
          }}
          placeholder="Quick Chat..."
          className="max-h-32 min-h-16 resize-none overflow-y-auto border-0 bg-transparent px-4 py-3 text-sm text-slate-100 shadow-none placeholder:text-slate-500 focus-visible:border-transparent focus-visible:ring-0 focus-visible:ring-offset-0 [@media(max-height:620px)]:max-h-20 [@media(max-height:620px)]:min-h-12 [@media(max-height:620px)]:py-2.5"
        />

        <div className="flex items-center gap-2 border-t border-slate-800/75 px-2.5 py-2">
          <ContextAttachmentMenuButton
            onSelectFiles={quickTaskComposer.onSelectContextFiles}
            onSelectFolders={quickTaskComposer.onSelectContextFolders}
            onSelectImages={quickTaskComposer.onSelectContextImages}
            imageInputDisabled={!quickTaskComposer.imageInputSupported}
            imageInputDisabledReason={
              quickTaskComposer.imageInputDisabledReason
            }
            menuSide="bottom"
            className="h-8 w-8 rounded-full border-slate-800 bg-slate-950/70 text-slate-300 shadow-none hover:bg-slate-900 hover:text-slate-100"
            iconClassName="h-3.5 w-3.5"
          />

          <div className="min-w-0 flex-1 [&>button]:h-8 [&>button]:w-full [&>button]:max-w-none [&>button]:justify-start">
            <SessionModelPicker
              chooserProviders={quickTaskComposer.chooserProviders}
              activeProvider={quickTaskComposer.provider}
              activeModel={quickTaskComposer.model}
              onSessionModelSelection={quickTaskComposer.onModelSelection}
            />
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              aria-label="Autopilot"
              title="Autopilot"
              aria-pressed={quickTaskComposer.autopilotEnabled}
              onClick={() =>
                quickTaskComposer.onAutopilotChange(
                  !quickTaskComposer.autopilotEnabled,
                )
              }
              className={cn(
                "h-8 w-8 rounded-full border-slate-800 bg-slate-950/70 p-0 text-slate-300 shadow-none hover:bg-slate-900 hover:text-slate-100",
                quickTaskComposer.autopilotEnabled &&
                  "border-violet-500/30 bg-violet-500/10 text-violet-100 hover:bg-violet-500/15 hover:text-white",
              )}
            >
              <WandSparkles className="h-3.5 w-3.5" />
            </Button>

            <Button
              type="button"
              variant="outline"
              aria-label="Global Memory"
              title="Memory"
              aria-pressed={quickTaskComposer.globalMemoryEnabled}
              disabled={!quickTaskComposer.globalMemoryAvailable}
              onClick={() =>
                quickTaskComposer.onGlobalMemoryChange(
                  !quickTaskComposer.globalMemoryEnabled,
                )
              }
              className={cn(
                "h-8 w-8 rounded-full border-slate-800 bg-slate-950/70 p-0 text-slate-300 shadow-none hover:bg-slate-900 hover:text-slate-100 disabled:cursor-not-allowed disabled:border-dashed disabled:bg-slate-950/40 disabled:text-slate-600 disabled:opacity-100",
                quickTaskComposer.globalMemoryEnabled &&
                  quickTaskComposer.globalMemoryAvailable &&
                  "border-sky-500/30 bg-sky-500/10 text-sky-100 hover:bg-sky-500/15 hover:text-white",
              )}
            >
              <BrainCircuit className="h-3.5 w-3.5" />
            </Button>

            <Button
              type="button"
              variant="outline"
              aria-label="UI Control"
              title="UI control"
              aria-pressed={quickTaskComposer.uiControlEnabled}
              disabled={!quickTaskComposer.uiControlAvailable}
              onClick={() =>
                quickTaskComposer.onUiControlChange(
                  !quickTaskComposer.uiControlEnabled,
                )
              }
              className={cn(
                "h-8 w-8 rounded-full border-slate-800 bg-slate-950/70 p-0 text-slate-300 shadow-none hover:bg-slate-900 hover:text-slate-100 disabled:cursor-not-allowed disabled:border-dashed disabled:bg-slate-950/40 disabled:text-slate-600 disabled:opacity-100",
                quickTaskComposer.uiControlEnabled &&
                  quickTaskComposer.uiControlAvailable &&
                  "border-violet-500/30 bg-violet-500/10 text-violet-100 hover:bg-violet-500/15 hover:text-white",
              )}
            >
              <Monitor className="h-3.5 w-3.5" />
            </Button>

            <Button
              type="button"
              variant="ghost"
              aria-label="Start quick voice command"
              title="Voice"
              disabled={!quickVoiceEnabled}
              onClick={() => {
                void showQuickVoiceWindow();
              }}
              className="h-8 w-8 rounded-full border border-violet-400/15 bg-violet-400/10 p-0 text-violet-100 hover:bg-violet-400/15 hover:text-white disabled:border-slate-800/80 disabled:bg-transparent disabled:text-slate-600 disabled:opacity-100"
            >
              <Mic className="h-4 w-4" />
            </Button>

            {quickTaskComposer.isExecuting ? (
              <Button
                type="button"
                variant="outline"
                aria-label="Cancel Quick Chat"
                title="Cancel"
                onClick={quickTaskComposer.onCancel}
                className="h-8 w-8 rounded-full border-rose-500/25 bg-rose-500/10 p-0 text-rose-100 shadow-none hover:bg-rose-500/15 hover:text-white"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
              </Button>
            ) : (
              <Button
                type="submit"
                variant="outline"
                aria-label="Send"
                disabled={!canSend}
                title={quickTaskComposer.sendDisabledReason ?? "Send"}
                className={cn(
                  "h-8 w-8 rounded-full border-slate-800/90 bg-slate-950/70 p-0 text-slate-500 shadow-none hover:bg-slate-800 hover:text-slate-100 disabled:bg-transparent disabled:text-slate-600 disabled:opacity-100",
                  canSend &&
                    "border-sky-400/30 bg-sky-400/15 text-sky-50 hover:bg-sky-400/20 hover:text-white",
                )}
              >
                <SendHorizonal className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </form>
  );
};

export const AssistantPopupShell = (): JSX.Element => {
  const controller = useChatSessionController({
    enableSessionAutoProfile: false,
    fileDropTarget: "quick-task",
  });

  useEffect(() => {
    if (!isTauri()) {
      return;
    }

    const currentWindow = getCurrentWindow();
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    let hideTimeoutId: number | undefined;

    const clearPendingHide = (): void => {
      if (hideTimeoutId === undefined) {
        return;
      }

      window.clearTimeout(hideTimeoutId);
      hideTimeoutId = undefined;
    };

    void currentWindow
      .onFocusChanged((event) => {
        clearPendingHide();

        if (event.payload) {
          return;
        }

        hideTimeoutId = window.setTimeout(() => {
          hideTimeoutId = undefined;

          if (disposed) {
            return;
          }

          void currentWindow.hide().catch(() => undefined);
        }, QUICK_WINDOW_BLUR_HIDE_DELAY_MS);
      })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }

        unsubscribe = unlisten;
      })
      .catch((error) => {
        console.error("Failed to subscribe to Quick Chat focus changes", error);
      });

    return () => {
      disposed = true;
      clearPendingHide();
      unsubscribe?.();
    };
  }, []);

  return (
    <>
      <div className="fixed inset-0 flex min-h-0 flex-col overflow-hidden rounded-3xl border border-slate-800 bg-slate-950/98 text-slate-100 shadow-none">
        <FileDropOverlay
          active={controller.fileDrop.isActive}
          label="Attach to Quick Chat"
          compact
        />

        <header className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-3 [@media(max-height:620px)]:py-2">
          <div className="min-w-0 flex items-center gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-sky-400/25 bg-sky-400/10 text-sky-100 [@media(max-height:620px)]:h-9 [@media(max-height:620px)]:w-9">
              <Zap className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-white">
                Quick Chat
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Open full app"
              onClick={() => {
                void revealMainWindow();
              }}
              className="h-9 w-9 rounded-2xl text-slate-400 hover:bg-slate-900 hover:text-slate-100"
            >
              <ArrowUpRight className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Hide quick chat"
              onClick={() => {
                void getCurrentWindow()
                  .hide()
                  .catch(() => undefined);
              }}
              className="h-9 w-9 rounded-2xl text-slate-400 hover:bg-slate-900 hover:text-slate-100"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </header>

        {controller.isDesktop && !controller.hasAnyProvider ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-3xl border border-sky-400/20 bg-sky-400/10 text-sky-100 [@media(max-height:620px)]:h-12 [@media(max-height:620px)]:w-12 [@media(max-height:620px)]:rounded-2xl">
              <Sparkles className="h-6 w-6" />
            </div>
            <p className="max-w-sm text-sm leading-6 text-slate-400">
              Add a model provider key before using Quick Chat.
            </p>
            <Button
              type="button"
              onClick={() => {
                void revealMainWindow();
              }}
              className="rounded-2xl bg-sky-600 px-5 text-white hover:bg-sky-500"
            >
              Open full app
            </Button>
          </div>
        ) : (
          <>
            <QuickTaskActivity
              quickTask={controller.quickTask}
            />

            <footer className="border-t border-slate-800/80 bg-slate-950/90 px-5 py-4 [@media(max-height:620px)]:px-4 [@media(max-height:620px)]:py-3">
              <QuickTaskComposer controller={controller} />
            </footer>
          </>
        )}
      </div>
    </>
  );
};

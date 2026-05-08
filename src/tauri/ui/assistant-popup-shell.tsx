import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowUpRight,
  Bot,
  BrainCircuit,
  LoaderCircle,
  Mic,
  Monitor,
  Sparkles,
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
} from "react";
import { revealMainWindow, showQuickVoiceWindow } from "./assistant-surface";
import { type ChatSessionMessage } from "./chat-session.model";
import { getRenderedMessageContent } from "./chat-session/_helpers/execution-message.tsx";
import { useChatSessionController } from "./chat-session/_helpers/use-chat-session-controller";
import { useNewestMessageScroll } from "./chat-session/_helpers/use-newest-message-scroll";
import { AgentComposer } from "./chat-session/components/agent-composer";
import { FileDropOverlay } from "./chat-session/components/file-drop-overlay";
import { MessageMarkdown } from "./chat-session/components/message-markdown";
import { ScrollToNewestButton } from "./chat-session/components/scroll-to-newest-button";
import { Button } from "./components/ui/button";
import { ScrollArea } from "./components/ui/scroll-area";
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
    <AgentComposer
      variant="quick"
      textareaRef={inputRef}
      draft={quickTaskComposer.draft}
      textareaLabel="Quick chat composer"
      placeholder="Quick Chat..."
      chooserProviders={quickTaskComposer.chooserProviders}
      activeProvider={quickTaskComposer.provider}
      activeModel={quickTaskComposer.model}
      contextAttachments={quickTaskComposer.contextAttachments}
      imageInputSupported={quickTaskComposer.imageInputSupported}
      imageInputDisabledReason={quickTaskComposer.imageInputDisabledReason}
      canSend={quickTaskComposer.canSend}
      sendDisabledReason={quickTaskComposer.sendDisabledReason}
      isExecuting={quickTaskComposer.isExecuting}
      toggles={[
        {
          id: "autopilot",
          label: "Autopilot",
          title: "Autopilot",
          icon: <WandSparkles className="h-3.5 w-3.5" />,
          pressed: quickTaskComposer.autopilotEnabled,
          onPressedChange: quickTaskComposer.onAutopilotChange,
          activeClassName:
            "border-violet-500/30 bg-violet-500/10 text-violet-100 hover:bg-violet-500/15 hover:text-white",
        },
        {
          id: "global-memory",
          label: "Global Memory",
          title: "Memory",
          icon: <BrainCircuit className="h-3.5 w-3.5" />,
          pressed: quickTaskComposer.globalMemoryEnabled,
          disabled: !quickTaskComposer.globalMemoryAvailable,
          onPressedChange: quickTaskComposer.onGlobalMemoryChange,
          activeClassName:
            "border-sky-500/30 bg-sky-500/10 text-sky-100 hover:bg-sky-500/15 hover:text-white",
        },
        {
          id: "ui-control",
          label: "UI Control",
          title: "UI control",
          icon: <Monitor className="h-3.5 w-3.5" />,
          pressed: quickTaskComposer.uiControlEnabled,
          disabled: !quickTaskComposer.uiControlAvailable,
          onPressedChange: quickTaskComposer.onUiControlChange,
          activeClassName:
            "border-violet-500/30 bg-violet-500/10 text-violet-100 hover:bg-violet-500/15 hover:text-white",
        },
      ]}
      actions={[
        {
          id: "quick-voice",
          label: "Start quick voice command",
          title: "Voice",
          icon: <Mic className="h-4 w-4" />,
          disabled: !quickVoiceEnabled,
          onClick: () => {
            void showQuickVoiceWindow();
          },
          className:
            "border border-violet-400/15 bg-violet-400/10 text-violet-100 hover:bg-violet-400/15 hover:text-white disabled:border-slate-800/80 disabled:bg-transparent disabled:text-slate-600 disabled:opacity-100",
        },
      ]}
      onModelSelection={quickTaskComposer.onModelSelection}
      onSelectContextFiles={quickTaskComposer.onSelectContextFiles}
      onSelectContextFolders={quickTaskComposer.onSelectContextFolders}
      onSelectContextImages={quickTaskComposer.onSelectContextImages}
      onRemoveContextAttachment={quickTaskComposer.onRemoveContextAttachment}
      onClearContextAttachments={quickTaskComposer.onClearContextAttachments}
      onDraftChange={quickTaskComposer.onDraftChange}
      onSend={sendQuickTask}
      onCancel={quickTaskComposer.onCancel}
    />
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

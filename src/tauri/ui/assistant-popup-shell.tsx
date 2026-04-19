import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowUpRight,
  Cog,
  LoaderCircle,
  Mic,
  SendHorizonal,
  Square,
  X,
} from "lucide-react";
import { useEffect, useMemo, type JSX, type KeyboardEvent } from "react";
import {
  getSessionOverviewStatus,
  getSessionTitle,
  isQuickVoiceSession,
} from "./chat-session.model";
import { revealMainWindow, showQuickVoiceWindow } from "./assistant-surface";
import { useChatSessionController } from "./chat-session/_helpers/use-chat-session-controller";
import { SESSION_STATUS_META } from "./chat-session/_helpers/session-shell";
import { ConversationFeed } from "./chat-session/components/conversation-feed";
import { SettingsDialog } from "./chat-session/components/settings-dialog";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import { ScrollArea } from "./components/ui/scroll-area";
import { Textarea } from "./components/ui/textarea";
import { cn } from "./lib/utils";

const CompactComposer = ({
  controller,
}: {
  controller: ReturnType<typeof useChatSessionController>;
}): JSX.Element => {
  const speechInputActionLabel = !controller.composer.speechInput.browserSupported
    ? "Speech input unavailable"
    : controller.composer.speechInput.transcribing
      ? "Transcribing speech"
      : controller.composer.speechInput.recording
        ? "Stop recording"
        : controller.composer.speechInput.enabled
          ? "Speak to text"
          : "Configure speak to text";

  return (
    <div className="grid gap-3 rounded-[1.25rem] border border-slate-800/80 bg-slate-950/92 p-3 shadow-none">
      <form
        className="flex items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          controller.composer.onSend();
        }}
      >
        <Textarea
          aria-label="Assistant popup composer"
          value={controller.composer.activeSession.draft}
          onChange={(event) => {
            controller.composer.onDraftChange(event.target.value);
          }}
          onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();

              if (controller.composer.canSendMessage) {
                controller.composer.onSend();
              }

              return;
            }

            controller.composer.onComposerHistoryNavigation(event);
          }}
          placeholder="Message machdoch…"
          className="max-h-44 min-h-16 resize-none rounded-2xl border-slate-800 bg-slate-900/70 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500"
        />

        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={speechInputActionLabel}
          title={speechInputActionLabel}
          disabled={
            !controller.composer.speechInput.browserSupported ||
            controller.composer.speechInput.transcribing
          }
          onClick={controller.composer.speechInput.onAction}
          className={cn(
            "h-11 w-11 shrink-0 rounded-2xl border-slate-800 bg-slate-900 text-slate-400 shadow-none hover:bg-slate-800 hover:text-slate-100 disabled:border-slate-800 disabled:bg-slate-900 disabled:text-slate-600 disabled:opacity-100",
            controller.composer.speechInput.recording &&
              "border-rose-500/20 bg-rose-500/10 text-rose-100 hover:bg-rose-500/15 hover:text-white",
            controller.composer.speechInput.transcribing &&
              "border-amber-500/20 bg-amber-500/10 text-amber-100 hover:bg-amber-500/10 hover:text-amber-100",
            !controller.composer.speechInput.recording &&
              !controller.composer.speechInput.transcribing &&
              controller.composer.speechInput.enabled &&
              "border-violet-500/20 bg-violet-500/10 text-violet-100 hover:bg-violet-500/15 hover:text-white",
          )}
        >
          {controller.composer.speechInput.transcribing ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : controller.composer.speechInput.recording ? (
            <Square className="h-4 w-4 fill-current" />
          ) : (
            <Mic className="h-4 w-4" />
          )}
        </Button>

        {controller.composer.isExecuting && !controller.composer.canSendMessage ? (
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Cancel task"
            onClick={controller.composer.onCancel}
            className="h-11 w-11 shrink-0 rounded-2xl border-rose-500/20 bg-rose-500/10 text-rose-100 shadow-none hover:bg-rose-500/15 hover:text-white"
          >
            <Square className="h-4 w-4 fill-current" />
          </Button>
        ) : (
          <Button
            type="submit"
            variant="outline"
            size="icon"
            aria-label="Send message"
            disabled={!controller.composer.canSendMessage}
            className={cn(
              "h-11 w-11 shrink-0 rounded-2xl border-slate-800 bg-slate-900 text-slate-400 shadow-none hover:bg-slate-800 hover:text-slate-100 disabled:border-slate-800 disabled:bg-slate-900 disabled:text-slate-600 disabled:opacity-100",
              controller.composer.canSendMessage &&
                "border-sky-500/20 bg-sky-500/10 text-sky-100 hover:bg-sky-500/15 hover:text-white",
            )}
          >
            <SendHorizonal className="h-4 w-4" />
          </Button>
        )}
      </form>

      {controller.composer.speechInput.statusText &&
      (controller.composer.speechInput.statusTone === "error" ||
        controller.composer.speechInput.transcribing) ? (
        <p
          aria-live="polite"
          className={cn(
            "px-1 text-xs leading-6",
            controller.composer.speechInput.statusTone === "error"
              ? "text-rose-300"
              : controller.composer.speechInput.statusTone === "success"
                ? "text-emerald-300"
                : "text-slate-400",
          )}
        >
          {controller.composer.speechInput.statusText}
        </p>
      ) : null}
    </div>
  );
};

export const AssistantPopupShell = (): JSX.Element => {
  const controller = useChatSessionController();
  const activeSessionStatus = getSessionOverviewStatus(
    controller.header.activeSession,
  );
  const activeSessionStatusMeta = SESSION_STATUS_META[activeSessionStatus];
  const ActiveSessionStatusIcon = activeSessionStatusMeta.icon;
  const popupSessions = useMemo(() => {
    const compactSessions = controller.sidebar.filteredSessions.filter(
      (session) => !isQuickVoiceSession(session),
    );
    const activeSession = compactSessions.find(
      (session) => session.id === controller.sidebar.activeSessionId,
    );

    if (!activeSession) {
      return compactSessions.slice(0, 6);
    }

    return [
      activeSession,
      ...compactSessions.filter((session) => session.id !== activeSession.id),
    ].slice(0, 6);
  }, [controller.sidebar.activeSessionId, controller.sidebar.filteredSessions]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (!focused) {
          void getCurrentWindow().hide().catch(() => undefined);
        }
      })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }

        unsubscribe = unlisten;
      });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  return (
    <Dialog
      open={controller.catalogOpen}
      onOpenChange={controller.setCatalogOpen}
    >
      <div className="fixed inset-0 flex flex-col overflow-hidden rounded-3xl border border-slate-800 bg-slate-950/98 text-slate-100 shadow-none">
        <header className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-sky-500/20 bg-sky-500/10 text-sky-100">
                <ActiveSessionStatusIcon
                  className={cn(
                    "h-3.5 w-3.5",
                    activeSessionStatusMeta.iconClassName,
                  )}
                />
              </span>
              <p className="truncate text-sm font-semibold text-white">
                {controller.header.currentSessionTitle}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Open Quick Voice"
              disabled={!controller.settingsDialog.desktopSetup.settings.quickVoiceEnabled}
              onClick={() => {
                void showQuickVoiceWindow();
              }}
              className="h-9 w-9 rounded-2xl text-slate-400 hover:bg-slate-900 hover:text-slate-100 disabled:text-slate-700 disabled:hover:bg-transparent disabled:hover:text-slate-700"
            >
              <Mic className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Open settings"
              onClick={controller.openProviderSettings}
              className="h-9 w-9 rounded-2xl text-slate-400 hover:bg-slate-900 hover:text-slate-100"
            >
              <Cog className="h-4 w-4" />
            </Button>
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
              aria-label="Hide popup"
              onClick={() => {
                void getCurrentWindow().hide().catch(() => undefined);
              }}
              className="h-9 w-9 rounded-2xl text-slate-400 hover:bg-slate-900 hover:text-slate-100"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </header>

        {controller.isDesktop && !controller.hasAnyProvider ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
            <p className="max-w-sm text-sm leading-6 text-slate-400">
              Add a model provider key to use the compact popup.
            </p>
            <Button
              type="button"
              onClick={controller.openProviderSettings}
              className="rounded-2xl bg-sky-600 px-5 text-white hover:bg-sky-500"
            >
              Open settings
            </Button>
          </div>
        ) : (
          <>
            <div className="border-b border-slate-800 px-3 py-3">
              <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {popupSessions.map((session) => {
                  const sessionStatus = getSessionOverviewStatus(session);
                  const sessionStatusMeta = SESSION_STATUS_META[sessionStatus];
                  const SessionStatusIcon = sessionStatusMeta.icon;
                  const isActive =
                    session.id === controller.sidebar.activeSessionId;

                  return (
                    <button
                      key={session.id}
                      type="button"
                      onClick={() => {
                        controller.sidebar.onActivateSession(session.id);
                      }}
                      className={cn(
                        "flex min-w-0 shrink-0 max-w-48 items-center gap-2 rounded-full border px-3 py-2 text-left text-xs transition-colors",
                        isActive
                          ? "border-sky-500/30 bg-sky-500/10 text-sky-50"
                          : "border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700 hover:bg-slate-900",
                      )}
                    >
                      <SessionStatusIcon
                        className={cn(
                          "h-3.5 w-3.5 shrink-0",
                          sessionStatusMeta.iconClassName,
                        )}
                      />
                      <span className="truncate">{getSessionTitle(session)}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <ScrollArea className="min-h-0 flex-1">
              <ConversationFeed {...controller.conversation} />
            </ScrollArea>

            <footer className="border-t border-slate-800 bg-slate-950/70 px-4 py-3">
              <CompactComposer controller={controller} />
            </footer>
          </>
        )}
      </div>

      <SettingsDialog
        settingsSection={controller.settingsDialog.settingsSection}
        onSettingsSectionChange={
          controller.settingsDialog.onSettingsSectionChange
        }
        providerSetup={controller.settingsDialog.providerSetup}
        webSearchSetup={controller.settingsDialog.webSearchSetup}
        memorySetup={controller.settingsDialog.memorySetup}
        desktopSetup={controller.settingsDialog.desktopSetup}
        voiceSetup={controller.settingsDialog.voiceSetup}
      />
    </Dialog>
  );
};

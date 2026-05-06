import { Cog, TerminalSquare } from "lucide-react";
import { Suspense, lazy, type JSX } from "react";
import { useChatSessionController } from "./chat-session/_helpers/use-chat-session-controller";
import { ConversationFeed } from "./chat-session/components/conversation-feed";
import { FileDropOverlay } from "./chat-session/components/file-drop-overlay";
import { ProviderEmptyState } from "./chat-session/components/provider-empty-state";
import { SessionComposer } from "./chat-session/components/session-composer";
import { SessionHeader } from "./chat-session/components/session-header";
import { SessionsSidebar } from "./chat-session/components/sessions-sidebar";
import { ShellTitlebar } from "./chat-session/components/shell-titlebar";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import { ScrollArea } from "./components/ui/scroll-area";
import { Separator } from "./components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./components/ui/tooltip";

const SettingsDialog = lazy(async () => {
  const module = await import("./chat-session/components/settings-dialog");

  return {
    default: module.SettingsDialog,
  };
});

export const ChatSession = (): JSX.Element => {
  const controller = useChatSessionController({
    fileDropTarget: "active-session",
  });

  return (
    <TooltipProvider delayDuration={250}>
      <Dialog
        open={controller.catalogOpen}
        onOpenChange={controller.setCatalogOpen}
      >
        <div className="dark relative flex h-screen w-full flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-950 font-sans text-slate-100 antialiased">
          <ShellTitlebar {...controller.titlebar} />

          <FileDropOverlay
            active={controller.fileDrop.isActive}
            label="Attach to task"
          />

          <div className="flex min-h-0 flex-1 w-full overflow-hidden bg-slate-950">
            <aside className="z-10 flex w-20 shrink-0 flex-col items-center justify-between border-r border-slate-900 bg-slate-950 py-6">
              <div className="flex flex-col items-center gap-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-slate-800 bg-slate-900 shadow-lg shadow-sky-500/10">
                  <TerminalSquare className="h-6 w-6 text-sky-400" />
                </div>

                <Separator className="w-10 bg-slate-900" />
              </div>

              <div className="flex flex-col items-center gap-3">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Settings"
                      onClick={controller.openProviderSettings}
                      className="h-12 w-12 rounded-2xl text-slate-400 hover:bg-slate-900 hover:text-slate-100"
                    >
                      <Cog className="h-5 w-5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">Settings</TooltipContent>
                </Tooltip>
              </div>
            </aside>

            <SessionsSidebar {...controller.sidebar} />

            {controller.isDesktop && !controller.hasAnyProvider ? (
              <ProviderEmptyState
                onOpenSettings={controller.openProviderSettings}
              />
            ) : (
              <main className="flex min-h-0 flex-1 flex-col bg-slate-950">
                <SessionHeader {...controller.header} />

                <ScrollArea className="min-h-0 flex-1" type="always">
                  <ConversationFeed {...controller.conversation} />
                </ScrollArea>

                <footer className="border-t border-slate-900/80 bg-slate-950/40 px-8 pb-5 pt-3 backdrop-blur-xl">
                  <div className="mx-auto w-full max-w-5xl">
                    <SessionComposer {...controller.composer} />
                  </div>
                </footer>
              </main>
            )}
          </div>
        </div>

        {controller.catalogOpen ? (
          <Suspense fallback={null}>
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
          </Suspense>
        ) : null}
      </Dialog>
    </TooltipProvider>
  );
};

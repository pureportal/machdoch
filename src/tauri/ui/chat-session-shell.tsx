import { Suspense, lazy, useEffect, useRef, useState, type JSX } from "react";
import {
  AppRail,
  type AppActivityState,
} from "./app-shell/app-rail";
import { useAppearanceSettings } from "./chat-session/_helpers/use-appearance-settings";
import { useChatSessionController } from "./chat-session/_helpers/use-chat-session-controller";
import { ConversationFeed } from "./chat-session/components/conversation-feed";
import { FileDropOverlay } from "./chat-session/components/file-drop-overlay";
import { MissionControlPanel } from "./chat-session/components/mission-control-panel";
import { OnboardingWizard } from "./chat-session/components/onboarding-wizard";
import { ProviderEmptyState } from "./chat-session/components/provider-empty-state";
import { SchedulerPanel } from "./chat-session/components/scheduler-panel";
import { ScrollToNewestButton } from "./chat-session/components/scroll-to-newest-button";
import { SessionComposer } from "./chat-session/components/session-composer";
import { SessionHeader } from "./chat-session/components/session-header";
import { SessionsSidebar } from "./chat-session/components/sessions-sidebar";
import { ShellTitlebar } from "./chat-session/components/shell-titlebar";
import { Dialog } from "./components/ui/dialog";
import { ScrollArea } from "./components/ui/scroll-area";
import { VoiceInputOverlay } from "./components/voice-input-overlay";
import {
  DEFAULT_APP_SHELL_STATE,
  loadAppShellState,
  loadOnboardingState,
  saveAppShellState,
  saveOnboardingState,
  type AppShellState,
  type MainAppId,
} from "./lib/shell-store";
import { cn } from "./lib/utils";
import { McpMarketplace } from "./marketplace/mcp-marketplace";
import { RalphApp } from "./ralph/ralph-app";
import { useRalphActivity } from "./ralph/use-ralph-activity";
import {
  runDueSchedulerJobs,
  syncScheduledPrompts,
} from "./runtime";
import { TooltipProvider } from "./components/ui/tooltip";

const SettingsDialog = lazy(async () => {
  const module = await import("./chat-session/components/settings-dialog");

  return {
    default: module.SettingsDialog,
  };
});

const isTestEnvironment = (): boolean => {
  return typeof process !== "undefined" && process.env.NODE_ENV === "test";
};

const toActivityState = (
  running: boolean,
  completed: boolean,
): AppActivityState => {
  if (running && completed) {
    return "running-and-completed";
  }

  if (running) {
    return "running";
  }

  return completed ? "completed" : "idle";
};

export const ChatSession = (): JSX.Element => {
  const controller = useChatSessionController({
    fileDropTarget: "active-session",
  });
  const appearance = useAppearanceSettings();
  const [appShellState, setAppShellState] = useState<AppShellState>(
    DEFAULT_APP_SHELL_STATE,
  );
  const [appShellLoaded, setAppShellLoaded] = useState(false);
  const [chatCompletedSinceView, setChatCompletedSinceView] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [schedulerOpen, setSchedulerOpen] = useState(false);
  const [ralphMounted, setRalphMounted] = useState(false);
  const previousChatRunningRef = useRef(false);
  const activeApp = appShellState.activeApp;
  const ralphActivity = useRalphActivity(activeApp);

  const chatRunning =
    controller.composer.isExecuting || controller.quickTask.status === "running";
  const chatActivity = toActivityState(chatRunning, chatCompletedSinceView);

  useEffect(() => {
    let cancelled = false;

    void loadAppShellState()
      .then((state) => {
        if (!cancelled) {
          setAppShellState(state);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setAppShellLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!appShellLoaded) {
      return;
    }

    void saveAppShellState(appShellState);
  }, [appShellLoaded, appShellState]);

  const selectApp = (nextApp: MainAppId): void => {
    setAppShellState((current) => ({
      version: 1,
      activeApp: nextApp,
      lastViewedAt: {
        ...current.lastViewedAt,
        [nextApp]: Date.now(),
      },
    }));
  };

  useEffect(() => {
    if (activeApp === "ralph") {
      setRalphMounted(true);
    }
  }, [activeApp]);

  useEffect(() => {
    if (activeApp === "chat") {
      setChatCompletedSinceView(false);
    }
  }, [activeApp]);

  useEffect(() => {
    if (
      previousChatRunningRef.current &&
      !chatRunning &&
      activeApp !== "chat"
    ) {
      setChatCompletedSinceView(true);
    }

    previousChatRunningRef.current = chatRunning;
  }, [activeApp, chatRunning]);

  useEffect(() => {
    if (isTestEnvironment()) {
      return;
    }

    let cancelled = false;

    void loadOnboardingState().then((state) => {
      if (cancelled) {
        return;
      }

      setOnboardingOpen(!state?.completedAt && !state?.skippedAt);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (isTestEnvironment()) {
      return;
    }

    const activeWorkspace = controller.composer.activeSession.workspace?.trim();

    if (!activeWorkspace) {
      return;
    }

    let stopped = false;
    let running = false;

    const tick = async (): Promise<void> => {
      if (stopped || running) {
        return;
      }

      running = true;

      try {
        await syncScheduledPrompts(activeWorkspace);
        await runDueSchedulerJobs(activeWorkspace);
      } catch (error) {
        console.error("Smart Scheduler tick failed", error);
      } finally {
        running = false;
      }
    };

    const initialTimer = window.setTimeout(() => {
      void tick();
    }, 5_000);
    const intervalTimer = window.setInterval(() => {
      void tick();
    }, 60_000);

    return () => {
      stopped = true;
      window.clearTimeout(initialTimer);
      window.clearInterval(intervalTimer);
    };
  }, [controller.composer.activeSession.workspace]);

  const closeOnboarding = async (skipped: boolean): Promise<void> => {
    const timestamp = Date.now();

    setOnboardingOpen(false);
    await saveOnboardingState({
      version: 1,
      completedAt: timestamp,
      ...(skipped ? { skippedAt: timestamp } : {}),
    });
  };

  return (
    <TooltipProvider delayDuration={300}>
      <Dialog
        open={controller.catalogOpen}
        onOpenChange={controller.setCatalogOpen}
      >
        <div className="app-shell relative flex h-screen w-full flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-950 font-sans text-slate-100 antialiased">
          <ShellTitlebar {...controller.titlebar} />

          <FileDropOverlay
            active={controller.fileDrop.isActive}
            label="Attach to task"
          />

          {onboardingOpen && !controller.catalogOpen ? (
            <OnboardingWizard
              activeSession={controller.composer.activeSession}
              chooserProviders={controller.composer.chooserProviders}
              hasAnyProvider={controller.hasAnyProvider}
              isUiControlAvailable={controller.composer.isUiControlAvailable}
              uiControlDescription={controller.composer.uiControlDescription}
              providerSetup={controller.settingsDialog.providerSetup}
              desktopSetup={controller.settingsDialog.desktopSetup}
              voiceSetup={controller.settingsDialog.voiceSetup}
              onSelectFolder={controller.composer.onSelectFolder}
              onSessionModelSelection={
                controller.composer.onSessionModelSelection
              }
              onSessionModeSelection={
                controller.composer.onSessionModeSelection
              }
              onUiControlEnabledChange={
                controller.composer.onUiControlEnabledChange
              }
              onFinish={() => {
                void closeOnboarding(false);
              }}
              onSkip={() => {
                void closeOnboarding(true);
              }}
            />
          ) : null}

          {controller.voiceInputOverlay.visible ? (
            <div className="absolute inset-0 z-50 overflow-hidden bg-slate-950/96 backdrop-blur-xl">
              <VoiceInputOverlay
                title="Voice input"
                recording={controller.voiceInputOverlay.recording}
                transcribing={controller.voiceInputOverlay.transcribing}
                level={controller.voiceInputOverlay.level}
                statusText={controller.voiceInputOverlay.statusText}
                statusTone={controller.voiceInputOverlay.statusTone}
                primaryActionDisabled={
                  controller.voiceInputOverlay.transcribing
                }
                onPrimaryAction={controller.voiceInputOverlay.onAction}
                className="rounded-xl border border-slate-800/70 bg-slate-950/96"
                headerClassName="px-8"
              />
            </div>
          ) : null}

          <div className="flex min-h-0 min-w-0 flex-1 w-full overflow-hidden bg-slate-950">
            <AppRail
              activeApp={activeApp}
              chatActivity={chatActivity}
              ralphActivity={ralphActivity}
              onSelectApp={selectApp}
              onOpenScheduler={() => setSchedulerOpen(true)}
              onOpenMissionControl={() => controller.missionControl.setOpen(true)}
              onOpenSettings={controller.openProviderSettings}
            />

            <div
              hidden={activeApp !== "chat"}
              className={cn(
                "min-h-0 min-w-0 flex-1 overflow-hidden",
                activeApp === "chat" ? "flex" : "hidden",
              )}
            >
                <SessionsSidebar {...controller.sidebar} />

                {controller.isDesktop && !controller.hasAnyProvider ? (
                  <ProviderEmptyState
                    onOpenSettings={controller.openProviderSettings}
                  />
                ) : (
                  <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-slate-950">
                    <SessionHeader {...controller.header} />

                    <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
                      <ScrollArea className="h-full min-w-0" type="always">
                        <ConversationFeed {...controller.conversation} />
                      </ScrollArea>
                      <ScrollToNewestButton
                        visible={
                          controller.conversation.showScrollToNewestButton
                        }
                        onClick={controller.conversation.onScrollToNewest}
                        className="bottom-4 left-1/2 -translate-x-1/2"
                      />
                    </div>

                    <footer className="app-session-footer min-w-0 border-t border-slate-900/80 bg-slate-950/40 px-8 pb-5 pt-3 backdrop-blur-xl">
                      <div className="mx-auto w-full max-w-5xl min-w-0">
                        <SessionComposer {...controller.composer} />
                      </div>
                    </footer>
                  </main>
                )}
            </div>

            <div
              hidden={activeApp !== "ralph"}
              className={cn(
                "min-h-0 min-w-0 flex-1 overflow-hidden",
                activeApp === "ralph" ? "flex" : "hidden",
              )}
            >
              {ralphMounted ? (
                <RalphApp
                  isActive={activeApp === "ralph"}
                  providerStatuses={controller.titlebar.providerStatuses}
                />
              ) : null}
            </div>

            <div
              hidden={activeApp !== "marketplace"}
              className={cn(
                "min-h-0 min-w-0 flex-1 overflow-hidden",
                activeApp === "marketplace" ? "flex" : "hidden",
              )}
            >
              {activeApp === "marketplace" ? (
                <McpMarketplace
                  workspaceRoot={controller.composer.activeSession.workspace}
                  onOpenSettings={() => {
                    controller.settingsDialog.onSettingsSectionChange("mcp");
                    controller.setCatalogOpen(true);
                  }}
                />
              ) : null}
            </div>
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
              workspaceSetup={controller.settingsDialog.workspaceSetup}
              instructionsSetup={controller.settingsDialog.instructionsSetup}
              webSearchSetup={controller.settingsDialog.webSearchSetup}
              mcpSetup={controller.settingsDialog.mcpSetup}
              agentLimitsSetup={controller.settingsDialog.agentLimitsSetup}
              appearanceSetup={appearance}
              memorySetup={controller.settingsDialog.memorySetup}
              desktopSetup={controller.settingsDialog.desktopSetup}
              voiceSetup={controller.settingsDialog.voiceSetup}
            />
          </Suspense>
        ) : null}
      </Dialog>

      <Dialog
        open={controller.missionControl.open}
        onOpenChange={controller.missionControl.setOpen}
      >
        <MissionControlPanel
          status={controller.missionControl.status}
          loading={controller.missionControl.loading}
          message={controller.missionControl.message}
          onEnable={controller.missionControl.onEnable}
          onDisable={controller.missionControl.onDisable}
          onOpenUrl={controller.missionControl.onOpenUrl}
          onSavePort={controller.missionControl.onSavePort}
          onForgetPairings={controller.missionControl.onForgetPairings}
        />
      </Dialog>

      <Dialog open={schedulerOpen} onOpenChange={setSchedulerOpen}>
        <SchedulerPanel
          workspaceRoot={controller.composer.activeSession.workspace}
        />
      </Dialog>
    </TooltipProvider>
  );
};

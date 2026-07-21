import {
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";
import {
  AppRail,
  type AppActivityState,
} from "./app-shell/app-rail";
import { useAppearanceSettings } from "./chat-session/_helpers/use-appearance-settings";
import { useChatSessionController } from "./chat-session/_helpers/use-chat-session-controller";
import { ConversationFeed } from "./chat-session/components/conversation-feed";
import { AttachmentImagePreviewDialog } from "./chat-session/components/attachment-image-preview-dialog";
import { ChatInterviewDialog } from "./chat-session/components/chat-interview-dialog";
import { ChatInputNeededDialog } from "./chat-session/components/chat-input-needed-dialog";
import { FileDropOverlay } from "./chat-session/components/file-drop-overlay";
import { FilePreviewDialogFallback } from "./chat-session/components/file-preview-dialog-fallback";
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
import { Button } from "./components/ui/button";
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
import { useRalphActivity } from "./ralph/use-ralph-activity";
import { useMediaActivity } from "./media/use-media-activity";
import { useMediaShutdownGuard } from "./media/use-media-shutdown-guard";
import {
  ensurePersistentSchedulerService,
  listSchedulerJobs,
  pollAllSchedulerWorkspaces,
  syncScheduledPrompts,
} from "./runtime";
import { TooltipProvider } from "./components/ui/tooltip";

const SettingsDialog = lazy(async () => {
  const module = await import("./chat-session/components/settings-dialog");

  return {
    default: module.SettingsDialog,
  };
});

const FilePreviewDialog = lazy(async () => {
  const module = await import("./chat-session/components/file-preview-dialog");

  return { default: module.FilePreviewDialog };
});

const McpMarketplace = lazy(async () => {
  const module = await import("./marketplace/mcp-marketplace");

  return { default: module.McpMarketplace };
});

const RalphApp = lazy(async () => {
  const module = await import("./ralph/ralph-app");

  return { default: module.RalphApp };
});

const MediaStudio = lazy(async () => {
  const module = await import("./media/media-studio");

  return { default: module.MediaStudio };
});

const appLoadingFallback = (
  <div
    role="status"
    className="grid h-full min-h-0 flex-1 place-items-center bg-slate-950 text-sm text-slate-500"
  >
    Loading...
  </div>
);

const retryAppShellStorageOperation = async <T,>(
  operation: () => Promise<T>,
): Promise<T> => {
  const delays = [0, 100, 400] as const;
  let lastError: unknown;

  for (const delay of delays) {
    if (delay > 0) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
    }

    try {
      return await operation();
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

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
  const [appShellLoadError, setAppShellLoadError] = useState<string | null>(null);
  const [appShellLoadAttempt, setAppShellLoadAttempt] = useState(0);
  const [chatCompletedSinceView, setChatCompletedSinceView] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [schedulerOpen, setSchedulerOpen] = useState(false);
  const [pendingMediaRunId, setPendingMediaRunId] = useState<string | null>(null);
  const [pendingMediaSection, setPendingMediaSection] = useState<
    "generate" | "library" | null
  >(null);
  const [pendingMediaAssetId, setPendingMediaAssetId] = useState<string | null>(
    null,
  );
  const [pendingMediaImportPath, setPendingMediaImportPath] = useState<
    string | null
  >(null);
  const [pendingMediaDraftPrompt, setPendingMediaDraftPrompt] = useState<
    string | null
  >(null);
  const previousChatRunningRef = useRef(false);
  const appShellInteractionRevisionRef = useRef(0);
  const appShellSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const appShellStateRef = useRef(appShellState);
  appShellStateRef.current = appShellState;
  const activeApp = appShellState.activeApp;
  const ralphActivity = useRalphActivity(activeApp);
  const mediaActivity = useMediaActivity(activeApp);
  useMediaShutdownGuard();

  const chatRunning = controller.hasRunningSession;
  const chatActivity = toActivityState(chatRunning, chatCompletedSinceView);

  useEffect(() => {
    let cancelled = false;
    const interactionRevision = appShellInteractionRevisionRef.current;
    setAppShellLoadError(null);

    void retryAppShellStorageOperation(loadAppShellState)
      .then((state) => {
        if (
          !cancelled &&
          appShellInteractionRevisionRef.current === interactionRevision
        ) {
          appShellStateRef.current = state;
          setAppShellState(state);
          setAppShellLoaded(true);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          console.error("Failed to load app shell state", error);
          setAppShellLoadError(
            "The saved app layout could not be loaded. Retry before continuing so it is not overwritten.",
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [appShellLoadAttempt]);

  useEffect(() => {
    if (!appShellLoaded) {
      return;
    }

    const save = appShellSaveQueueRef.current
      .catch(() => undefined)
      .then(() =>
        retryAppShellStorageOperation(() => saveAppShellState(appShellState)),
      )
      .catch((error: unknown) => {
        console.error("Failed to persist app shell state", error);
      });
    appShellSaveQueueRef.current = save;
  }, [appShellLoaded, appShellState]);

  useEffect(() => {
    return () => {
      if (appShellLoaded) {
        void retryAppShellStorageOperation(() =>
          saveAppShellState(appShellStateRef.current),
        ).catch((error: unknown) => {
          console.error("Failed to flush app shell state", error);
        });
      }
    };
  }, [appShellLoaded]);

  const selectApp = (nextApp: MainAppId): void => {
    appShellInteractionRevisionRef.current += 1;
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

  const schedulerWorkspaceSignature = controller.sidebar.sessionProjectFacets
    .flatMap((project) => project.path ? [project.path] : [])
    .sort((left, right) => left.localeCompare(right))
    .join("\u0000");
  const schedulerWorkspaceRoots = useMemo(
    () => schedulerWorkspaceSignature.split("\u0000").filter(Boolean),
    [schedulerWorkspaceSignature],
  );

  useEffect(() => {
    if (isTestEnvironment()) {
      return;
    }

    void Promise.all(
      schedulerWorkspaceRoots.map((workspaceRoot) =>
        listSchedulerJobs(workspaceRoot).catch((error) => {
          console.error(
            `Failed to register Smart Scheduler workspace ${workspaceRoot}`,
            error,
          );
        }),
      ),
    ).then((results) => {
      if (results.some((result) => result?.jobs.length)) {
        void ensurePersistentSchedulerService(null).catch((error) => {
          console.error("Persistent Smart Scheduler service failed to start", error);
        });
      }
    });
  }, [schedulerWorkspaceRoots]);

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
        const jobs = await listSchedulerJobs(activeWorkspace);

        if (jobs.jobs.length === 0) {
          return;
        }

        await ensurePersistentSchedulerService(activeWorkspace);
        await pollAllSchedulerWorkspaces(activeWorkspace);
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

    try {
      await retryAppShellStorageOperation(() =>
        saveOnboardingState({
          version: 1,
          completedAt: timestamp,
          ...(skipped ? { skippedAt: timestamp } : {}),
        }),
      );
      setOnboardingOpen(false);
    } catch (error) {
      console.error("Failed to persist onboarding completion", error);
    }
  };

  if (!appShellLoaded || !controller.hasHydrated) {
    return (
      <TooltipProvider delayDuration={300}>
        <div className="grid h-screen w-full place-items-center bg-slate-950 px-6 text-slate-100">
          <div className="grid max-w-md gap-4 text-center">
            <p className="text-sm text-slate-400">
              {appShellLoadError ?? "Loading your workspace layout..."}
            </p>
            {appShellLoadError ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => setAppShellLoadAttempt((attempt) => attempt + 1)}
              >
                Retry
              </Button>
            ) : null}
          </div>
        </div>
      </TooltipProvider>
    );
  }

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
              mediaActivity={mediaActivity}
              onSelectApp={selectApp}
              onOpenScheduler={() => setSchedulerOpen(true)}
              onOpenMissionControl={() => controller.missionControl.setOpen(true)}
              onOpenSettings={controller.openProviderSettings}
            />

            {activeApp === "chat" ? (
              <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
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
                        <ConversationFeed
                          key={controller.composer.activeSession.id}
                          {...controller.conversation}
                        />
                      </ScrollArea>
                      <ScrollToNewestButton
                        visible={
                          controller.conversation.showScrollToNewestButton
                        }
                        onClick={controller.conversation.onScrollToNewest}
                        className="bottom-4 right-4"
                      />
                    </div>

                    <footer className="app-session-footer min-w-0 border-t border-slate-900/80 bg-slate-950/40 px-8 pb-5 pt-3 backdrop-blur-xl">
                      <div className="mx-auto w-full max-w-5xl min-w-0">
                        <SessionComposer
                          key={controller.composer.activeSession.id}
                          {...controller.composer}
                          onBrowseMediaAssets={() => {
                            setPendingMediaSection("library");
                            selectApp("media");
                          }}
                          onCreateMediaAsset={(prompt) => {
                            setPendingMediaDraftPrompt(prompt);
                            setPendingMediaSection("generate");
                            selectApp("media");
                          }}
                        />
                      </div>
                    </footer>
                  </main>
                )}
              </div>
            ) : null}

            {activeApp === "ralph" ? (
              <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
                <Suspense fallback={appLoadingFallback}>
                  <RalphApp
                    isActive
                    providerStatuses={controller.titlebar.providerStatuses}
                    onOpenMediaRun={(runId) => {
                      setPendingMediaRunId(runId);
                      selectApp("media");
                    }}
                  />
                </Suspense>
              </div>
            ) : null}

            {activeApp === "media" ? (
              <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
                <Suspense fallback={appLoadingFallback}>
                  <MediaStudio
                    providerStatuses={controller.titlebar.providerStatuses}
                    onOpenProviderSettings={controller.openProviderSettings}
                    workspaceRoot={controller.composer.activeSession.workspace}
                    openRunId={pendingMediaRunId}
                    onOpenRunHandled={() => setPendingMediaRunId(null)}
                    openSection={pendingMediaSection}
                    onOpenSectionHandled={() => setPendingMediaSection(null)}
                    openAssetId={pendingMediaAssetId}
                    onOpenAssetHandled={() => setPendingMediaAssetId(null)}
                    importPath={pendingMediaImportPath}
                    onImportPathHandled={() => setPendingMediaImportPath(null)}
                    draftPrompt={pendingMediaDraftPrompt}
                    onDraftPromptHandled={() => setPendingMediaDraftPrompt(null)}
                    onSendAssetToChat={(reference) => {
                      if (controller.attachMediaAssetToChat(reference)) {
                        selectApp("chat");
                      }
                    }}
                  />
                </Suspense>
              </div>
            ) : null}

            <div
              hidden={activeApp !== "marketplace"}
              className={cn(
                "min-h-0 min-w-0 flex-1 overflow-hidden",
                activeApp === "marketplace" ? "flex" : "hidden",
              )}
            >
              {activeApp === "marketplace" ? (
                <Suspense fallback={appLoadingFallback}>
                  <McpMarketplace
                    workspaceRoot={controller.composer.activeSession.workspace}
                    onOpenSettings={() => {
                      controller.settingsDialog.onSettingsSectionChange("mcp");
                      controller.setCatalogOpen(true);
                    }}
                  />
                </Suspense>
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
              onClose={() => controller.setCatalogOpen(false)}
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

      {schedulerOpen ? (
        <Dialog open onOpenChange={setSchedulerOpen}>
          <SchedulerPanel
            workspaceRoot={controller.composer.activeSession.workspace}
          />
        </Dialog>
      ) : null}

      <AttachmentImagePreviewDialog
        preview={controller.attachmentImagePreview.preview}
        onOpenChange={controller.attachmentImagePreview.onOpenChange}
        onEditMediaAsset={(attachment) => {
          controller.attachmentImagePreview.onOpenChange(false);
          setPendingMediaAssetId(attachment.assetId);
          selectApp("media");
        }}
        onSaveToMediaLibrary={(attachment) => {
          controller.attachmentImagePreview.onOpenChange(false);
          setPendingMediaImportPath(attachment.path);
          selectApp("media");
        }}
      />

      {controller.filePreview.preview ? (
        <Suspense
          fallback={
            <FilePreviewDialogFallback
              preview={controller.filePreview.preview}
              onOpenChange={controller.filePreview.onOpenChange}
              onOpenExternal={controller.filePreview.onOpenExternal}
            />
          }
        >
          <FilePreviewDialog
            preview={controller.filePreview.preview}
            onOpenChange={controller.filePreview.onOpenChange}
            onOpenExternal={controller.filePreview.onOpenExternal}
          />
        </Suspense>
      ) : null}

      <ChatInputNeededDialog {...controller.inputNeeded} />

      <ChatInterviewDialog {...controller.chatInterview} />
    </TooltipProvider>
  );
};

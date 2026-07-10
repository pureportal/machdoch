import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { MessageSquareMore, Mic, Zap } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { getSessionOverviewStatus } from "./chat-session.model";
import {
  hideAssistantPopup,
  isAssistantPopupVisible,
  resolveAssistantSurfaceLayout,
  resolveMonitorTopologyKey,
  setWindowSize,
  setWindowPosition,
  showAssistantPopup,
  showQuickVoiceWindow,
  syncAssistantPopupPosition,
  toggleAssistantPopup,
} from "./assistant-surface";
import { useUserDesktopSettings } from "./_helpers/use-user-desktop-settings";
import { useAppearanceSettings } from "./chat-session/_helpers/use-appearance-settings";
import { useChatSessionShellState } from "./chat-session/_helpers/use-chat-session-shell-state";
import {
  ASSISTANT_POPUP_WINDOW_LABEL,
  QUICK_CHAT_DROP_EVENT,
  detectFullscreenWindowOnMonitor,
} from "./runtime";
import {
  useSessionFileDrops,
  type SessionDropPayload,
} from "./chat-session/_helpers/use-session-file-drops";

const BUBBLE_SYNC_INTERVAL_MS = 2500;
const BUBBLE_EVENT_SYNC_DEBOUNCE_MS = 100;
const WINDOW_GEOMETRY_TOLERANCE_PX = 1;

const isNearWindowValue = (actual: number, expected: number): boolean => {
  return Math.abs(actual - expected) <= WINDOW_GEOMETRY_TOLERANCE_PX;
};

export const AssistantBubbleShell = () => {
  const state = useChatSessionShellState({
    persistActiveSession: false,
    trackSessionReads: false,
  });
  const desktopSettings = useUserDesktopSettings();
  const appearance = useAppearanceSettings();
  const [popupOpen, setPopupOpen] = useState(false);
  const temporarilyHiddenUntilRef = useRef<number>(0);
  const suppressPrimaryActionUntilRef = useRef<number>(0);
  const lastVisibilityRef = useRef<boolean | null>(null);
  const lastBubbleSizeRef = useRef<string | null>(null);
  const lastBubblePositionRef = useRef<string | null>(null);
  const lastMonitorTopologyKeyRef = useRef<string | null>(null);
  const syncGenerationRef = useRef(0);
  const togglePopupInFlightRef = useRef(false);
  const popupStateRequestRef = useRef(0);
  const popupMutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const windowSyncQueueRef = useRef<Promise<void>>(Promise.resolve());

  const enqueuePopupMutation = useCallback(<T,>(
    mutation: () => Promise<T>,
  ): Promise<T> => {
    const operation = popupMutationQueueRef.current
      .catch(() => undefined)
      .then(mutation);
    popupMutationQueueRef.current = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }, []);

  const emitQuickChatDrop = useCallback(
    async (payload: SessionDropPayload): Promise<void> => {
      if (!isTauri()) {
        return;
      }

      const requestId = popupStateRequestRef.current + 1;
      popupStateRequestRef.current = requestId;
      const shown = await enqueuePopupMutation(showAssistantPopup);

      if (popupStateRequestRef.current !== requestId) {
        return;
      }

      if (shown) {
        setPopupOpen(true);
      }

      await getCurrentWindow().emitTo(
        ASSISTANT_POPUP_WINDOW_LABEL,
        QUICK_CHAT_DROP_EVENT,
        payload,
      );
    },
    [enqueuePopupMutation],
  );

  const bubbleFileDrop = useSessionFileDrops({
    fileDropTarget: "quick-task",
    isDesktop: isTauri(),
    onAttachPaths: async (paths) => {
      await emitQuickChatDrop({ paths });
    },
    onAttachReferences: async (references) => {
      await emitQuickChatDrop({ references });
    },
    onAppendText: async (text) => {
      await emitQuickChatDrop({ text });
    },
  });

  const activeSessionSummary = useMemo(() => {
    let runningCount = 0;

    for (const session of state.shellState.sessions) {
      const status = getSessionOverviewStatus(session);

      if (status === "running") {
        runningCount += 1;
      }
    }

    return {
      runningCount,
      pendingCount: runningCount,
    };
  }, [state.shellState.sessions]);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }

    const currentWindow = getCurrentWindow();
    const syncGeneration = syncGenerationRef.current + 1;
    syncGenerationRef.current = syncGeneration;
    let disposed = false;
    let eventSyncTimeoutId: number | null = null;
    const eventUnlisteners: Array<() => void> = [];
    const isCurrentSync = (): boolean =>
      !disposed && syncGenerationRef.current === syncGeneration;

    const setBubbleVisibility = async (visible: boolean): Promise<void> => {
      if (!isCurrentSync() || lastVisibilityRef.current === visible) {
        return;
      }

      if (visible) {
        const isVisible = await currentWindow.isVisible();

        if (!isCurrentSync()) {
          return;
        }

        if (!isVisible) {
          try {
            await currentWindow.show();
          } catch {
            // ignore transient show failures while syncing
            return;
          }
        }

        if (isCurrentSync()) {
          lastVisibilityRef.current = true;
        }
        return;
      }

      try {
        await currentWindow.hide();
        if (isCurrentSync()) {
          lastVisibilityRef.current = false;
        }
      } catch {
        // ignore no-op hide failures while syncing
      }
    };

    const isBubbleSizeCurrent = async (size: {
      width: number;
      height: number;
    }): Promise<boolean> => {
      try {
        const currentSize = await currentWindow.innerSize();

        return (
          isNearWindowValue(currentSize.width, size.width) &&
          isNearWindowValue(currentSize.height, size.height)
        );
      } catch {
        return false;
      }
    };

    const isBubblePositionCurrent = async (position: {
      x: number;
      y: number;
    }): Promise<boolean> => {
      try {
        const currentPosition = await currentWindow.outerPosition();

        return (
          isNearWindowValue(currentPosition.x, position.x) &&
          isNearWindowValue(currentPosition.y, position.y)
        );
      } catch {
        return false;
      }
    };

    const syncBubbleWindow = async (): Promise<void> => {
      if (!isCurrentSync()) {
        return;
      }

      try {
        if (!desktopSettings.assistantBubbleEnabled) {
          await setBubbleVisibility(false);
          return;
        }

        const topologyKey = await resolveMonitorTopologyKey();
        if (!isCurrentSync()) {
          return;
        }
        const topologyChanged =
          topologyKey !== null && topologyKey !== lastMonitorTopologyKeyRef.current;

        if (topologyKey !== null) {
          lastMonitorTopologyKeyRef.current = topologyKey;
        }

        const layout = await resolveAssistantSurfaceLayout();

        if (!layout || !isCurrentSync()) {
          return;
        }

        const shouldHideTemporarily =
          Date.now() < temporarilyHiddenUntilRef.current;
        const shouldHideForFullscreen =
          desktopSettings.assistantBubbleHideWhenFullscreen &&
          (await detectFullscreenWindowOnMonitor(layout.monitorBounds));
        if (!isCurrentSync()) {
          return;
        }
        const shouldShow = !shouldHideTemporarily && !shouldHideForFullscreen;
        const nextSizeKey = `${layout.bubbleSize.width}:${layout.bubbleSize.height}`;
        const nextPositionKey = `${layout.bubblePosition.x}:${layout.bubblePosition.y}`;

        const sizeIsCurrent = await isBubbleSizeCurrent(layout.bubbleSize);
        if (!isCurrentSync()) {
          return;
        }
        const shouldSyncSize =
          topologyChanged ||
          nextSizeKey !== lastBubbleSizeRef.current ||
          !sizeIsCurrent;

        if (shouldSyncSize && (await setWindowSize(currentWindow, layout.bubbleSize))) {
          lastBubbleSizeRef.current = nextSizeKey;
        }

        const positionIsCurrent = await isBubblePositionCurrent(
          layout.bubblePosition,
        );
        if (!isCurrentSync()) {
          return;
        }
        const shouldSyncPosition =
          topologyChanged ||
          nextPositionKey !== lastBubblePositionRef.current ||
          !positionIsCurrent;

        if (
          shouldSyncPosition &&
          (await setWindowPosition(currentWindow, layout.bubblePosition))
        ) {
          lastBubblePositionRef.current = nextPositionKey;
          await syncAssistantPopupPosition();
        }

        await setBubbleVisibility(shouldShow);
      } finally {
        // The shared queue starts the next geometry reconciliation only after
        // this generation has either completed or observed that it is stale.
      }
    };

    const runSyncBubbleWindow = (): void => {
      const operation = windowSyncQueueRef.current
        .catch(() => undefined)
        .then(syncBubbleWindow);
      windowSyncQueueRef.current = operation.then(
        () => undefined,
        () => undefined,
      );
      void operation.catch((error) => {
        console.error("Failed to sync assistant bubble window", error);
      });
    };

    const scheduleSyncBubbleWindow = (): void => {
      if (disposed) {
        return;
      }

      if (eventSyncTimeoutId !== null) {
        window.clearTimeout(eventSyncTimeoutId);
      }

      eventSyncTimeoutId = window.setTimeout(() => {
        eventSyncTimeoutId = null;
        runSyncBubbleWindow();
      }, BUBBLE_EVENT_SYNC_DEBOUNCE_MS);
    };

    runSyncBubbleWindow();
    const subscribeToWindowEvents = async (): Promise<void> => {
      const subscribe = [
        () => currentWindow.onScaleChanged(scheduleSyncBubbleWindow),
        () => currentWindow.onMoved(scheduleSyncBubbleWindow),
        () => currentWindow.onResized(scheduleSyncBubbleWindow),
      ];

      for (const createUnlistener of subscribe) {
        let unlisten: (() => void) | undefined;

        try {
          unlisten = await createUnlistener();
        } catch (error) {
          console.error("Failed to subscribe to assistant bubble window events", error);
          continue;
        }

        if (disposed) {
          unlisten();
        } else {
          eventUnlisteners.push(unlisten);
        }
      }
    };

    void subscribeToWindowEvents();

    const intervalId = window.setInterval(() => {
      runSyncBubbleWindow();
    }, BUBBLE_SYNC_INTERVAL_MS);

    return () => {
      disposed = true;
      if (eventSyncTimeoutId !== null) {
        window.clearTimeout(eventSyncTimeoutId);
      }

      for (const unlisten of eventUnlisteners) {
        unlisten();
      }

      window.clearInterval(intervalId);
    };
  }, [
    desktopSettings.assistantBubbleEnabled,
    desktopSettings.assistantBubbleHideWhenFullscreen,
  ]);

  const handleTemporarilyHide = (event: MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    suppressPrimaryActionUntilRef.current = Date.now() + 800;
    lastVisibilityRef.current = false;
    temporarilyHiddenUntilRef.current =
      Date.now() +
      desktopSettings.assistantBubbleTemporarilyHideSeconds * 1000;
    popupStateRequestRef.current += 1;
    setPopupOpen(false);
    void enqueuePopupMutation(hideAssistantPopup).catch((error) => {
      console.error("Failed to hide assistant popup", error);
    });

    if (isTauri()) {
      void getCurrentWindow().hide().catch(() => undefined);
    }
  };

  const handleBubbleMouseDown = (event: MouseEvent<HTMLButtonElement>): void => {
    if (event.button !== 2) {
      return;
    }

    handleTemporarilyHide(event);
  };

  const handleBubbleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    if (Date.now() < suppressPrimaryActionUntilRef.current) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (togglePopupInFlightRef.current) {
      return;
    }

    togglePopupInFlightRef.current = true;
    const requestId = popupStateRequestRef.current + 1;
    popupStateRequestRef.current = requestId;
    void enqueuePopupMutation(toggleAssistantPopup)
      .then((nextPopupOpen) => {
        if (popupStateRequestRef.current === requestId) {
          setPopupOpen(nextPopupOpen);
        }
      })
      .catch((error) => {
        console.error("Failed to toggle assistant popup", error);
        if (popupStateRequestRef.current === requestId) {
          setPopupOpen(false);
        }
      })
      .finally(() => {
        togglePopupInFlightRef.current = false;
      });
  };

  const bubbleVisualState = popupOpen
    ? "open"
    : activeSessionSummary.runningCount > 0
      ? "running"
      : activeSessionSummary.pendingCount > 0
        ? "attention"
        : "idle";

  return (
    <div className="quick-chat-bubble-shell fixed inset-0 flex items-center justify-center overflow-visible bg-transparent select-none">
      <div className="quick-chat-bubble-wrap relative">
        <button
          type="button"
          aria-label="Open Quick Chat"
          aria-expanded={popupOpen}
          aria-haspopup="dialog"
          title="Open Quick Chat"
          data-style={appearance.settings.quickChatBubbleStyle}
          data-state={bubbleVisualState}
          data-running={activeSessionSummary.runningCount > 0 ? "true" : "false"}
          data-has-notification={
            activeSessionSummary.pendingCount > 0 ? "true" : "false"
          }
          data-voice-enabled={
            desktopSettings.quickVoiceEnabled ? "true" : "false"
          }
          data-drop-active={bubbleFileDrop.isActive ? "true" : "false"}
          onClick={handleBubbleClick}
          onFocus={() => {
            const requestId = popupStateRequestRef.current + 1;
            popupStateRequestRef.current = requestId;
            void isAssistantPopupVisible()
              .then((visible) => {
                if (popupStateRequestRef.current === requestId) {
                  setPopupOpen(visible);
                }
              })
              .catch((error) => {
                console.error("Failed to inspect assistant popup visibility", error);
              });
          }}
          onMouseDown={handleBubbleMouseDown}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          className="quick-chat-bubble group relative flex h-17 w-17 items-center justify-center rounded-[1.35rem] border border-sky-400/25 bg-slate-950/95 text-slate-100 shadow-none transition-colors duration-150 hover:border-sky-300/45 hover:bg-slate-900/95"
        >
          <span aria-hidden="true" className="quick-chat-bubble-aura" />
          <span aria-hidden="true" className="quick-chat-bubble-surface" />
          <MessageSquareMore className="quick-chat-bubble-icon relative z-10 h-6 w-6 text-sky-100 transition-colors group-hover:text-white" />
          <Zap className="quick-chat-bubble-zap absolute right-3 top-3 z-10 h-3 w-3 text-sky-300" />
        </button>

        <button
          type="button"
          aria-label="Start quick voice command"
          title="Start quick voice command"
          disabled={!desktopSettings.quickVoiceEnabled}
          onClick={() => {
            void showQuickVoiceWindow().catch((error) => {
              console.error("Failed to show Quick Voice window", error);
            });
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          className="quick-chat-voice-button absolute bottom-4 left-8 z-20 flex h-8 w-8 items-center justify-center rounded-full border border-violet-300/45 bg-violet-500 text-white shadow-none transition-colors duration-150 hover:bg-violet-400 disabled:cursor-not-allowed disabled:border-slate-700 disabled:bg-slate-800 disabled:text-slate-500 disabled:hover:bg-slate-800"
        >
          <Mic className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
};

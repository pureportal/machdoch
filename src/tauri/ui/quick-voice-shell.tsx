import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowUpRight, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";
import {
  revealMainWindow,
  resolveAssistantSurfaceLayout,
  setWindowPosition,
} from "./assistant-surface";
import { useAppearanceSettings } from "./chat-session/_helpers/use-appearance-settings";
import { useChatSessionController } from "./chat-session/_helpers/use-chat-session-controller";
import {
  getConfiguredSpeechToTextProvider,
  getRecordingErrorMessage,
  NO_SPEECH_DETECTED_MESSAGE,
} from "./chat-session/_helpers/speech-audio";
import { useSpeechRecorder } from "./chat-session/_helpers/use-speech-recorder";
import { useSpeechTranscription } from "./chat-session/_helpers/use-speech-transcription";
import {
  ASSISTANT_SURFACE_READY_EVENT,
  QUICK_VOICE_START_EVENT,
  type UserSpeechToTextSettings,
} from "./runtime";
import { Button } from "./components/ui/button";
import { VoiceInputOverlay } from "./components/voice-input-overlay";

const VOICE_ACTIVITY_THRESHOLD = 0.012;
const VOICE_ACTIVITY_FRAME_COUNT = 2;

export const QuickVoiceShell = (): JSX.Element => {
  useAppearanceSettings();
  const controller = useChatSessionController({
    enableBackgroundMaintenance: false,
    enableTaskProgress: false,
    includeHistoryContent: false,
    persistActiveSession: false,
    trackSessionReads: false,
  });

  useEffect(() => {
    if (isTauri()) {
      void getCurrentWindow().emit(ASSISTANT_SURFACE_READY_EVENT, {
        label: getCurrentWindow().label,
      });
    }
  }, []);
  const submitQuickVoiceCommand = controller.submitQuickVoiceCommand;
  const speechToTextSettings = useMemo<UserSpeechToTextSettings>(() => {
    return {
      activeProvider: controller.settingsDialog.voiceSetup.speechToTextProvider,
      inputDeviceId: controller.settingsDialog.voiceSetup.speechInputDeviceId,
      providerAvailability:
        controller.settingsDialog.voiceSetup.speechToTextProviderAvailability,
    };
  }, [
    controller.settingsDialog.voiceSetup.speechInputDeviceId,
    controller.settingsDialog.voiceSetup.speechToTextProvider,
    controller.settingsDialog.voiceSetup.speechToTextProviderAvailability,
  ]);
  const desktopSettings = controller.settingsDialog.desktopSetup.settings;
  const configuredProvider = useMemo(() => {
    return getConfiguredSpeechToTextProvider(speechToTextSettings);
  }, [speechToTextSettings]);
  const {
    browserSupported,
    recording,
    level,
    levelTick,
    startRecording: startSpeechRecording,
    stopRecording,
    cancelRecording,
  } = useSpeechRecorder();
  const { transcribing, transcribeRecording } = useSpeechTranscription();
  const [statusText, setStatusText] = useState<string | null>(null);
  const [finalizing, setFinalizing] = useState(false);
  const recordingStartedAtRef = useRef(0);
  const lastSpeechTimestampRef = useRef(0);
  const speechFrameCountRef = useRef(0);
  const detectedSpeechRef = useRef(false);
  const finalizingRef = useRef(false);
  const operationSequenceRef = useRef(0);
  const startInFlightRef = useRef<number | null>(null);
  const recordingActiveRef = useRef(false);
  const pendingStartRequestRef = useRef(false);
  const hideTimeoutRef = useRef<number | null>(null);

  const clearHideTimeout = useCallback((): void => {
    if (hideTimeoutRef.current !== null) {
      window.clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
  }, []);

  const resetVoiceActivity = useCallback((): void => {
    recordingStartedAtRef.current = 0;
    lastSpeechTimestampRef.current = 0;
    speechFrameCountRef.current = 0;
    detectedSpeechRef.current = false;
  }, []);

  const hideWindowSoon = useCallback(
    (delay = 900): void => {
      clearHideTimeout();
      hideTimeoutRef.current = window.setTimeout(() => {
        void controller.flushPersistence()
          .catch((error) => {
            console.error("Failed to flush Quick Voice state", error);
          })
          .finally(() => {
            void getCurrentWindow().close().catch(() => undefined);
          });
      }, delay);
    },
    [clearHideTimeout, controller.flushPersistence],
  );

  const syncQuickVoiceWindowPosition = useCallback(async (): Promise<void> => {
    const layout = await resolveAssistantSurfaceLayout();

    if (!layout) {
      return;
    }

    await setWindowPosition(getCurrentWindow(), layout.quickVoicePosition);
  }, []);

  const cancelRecordingWithStatus = useCallback(
    (message: string): void => {
      operationSequenceRef.current += 1;
      startInFlightRef.current = null;
      finalizingRef.current = false;
      recordingActiveRef.current = false;
      cancelRecording();
      resetVoiceActivity();
      setFinalizing(false);
      setStatusText(message);
    },
    [cancelRecording, resetVoiceActivity],
  );

  const finalizeRecording = useCallback(async (): Promise<void> => {
    if (
      (!recording && !recordingActiveRef.current) ||
      !configuredProvider ||
      finalizingRef.current
    ) {
      return;
    }

    const operationSequence = operationSequenceRef.current + 1;
    operationSequenceRef.current = operationSequence;
    finalizingRef.current = true;
    recordingActiveRef.current = false;
    const provider = configuredProvider;
    setFinalizing(true);
    setStatusText("Transcribing...");

    try {
      const recordedBlob = await stopRecording();

      if (
        !recordedBlob ||
        operationSequenceRef.current !== operationSequence
      ) {
        return;
      }

      const transcriptText = await transcribeRecording({
        blob: recordedBlob,
        provider,
      });

      if (operationSequenceRef.current !== operationSequence) {
        return;
      }

      submitQuickVoiceCommand(transcriptText);
      setStatusText("Sent.");
      hideWindowSoon(500);
    } catch (error) {
      if (operationSequenceRef.current !== operationSequence) {
        return;
      }
      cancelRecording();
      setStatusText(
        error instanceof Error
          ? error.message
          : "Quick voice transcription failed.",
      );
    } finally {
      if (operationSequenceRef.current === operationSequence) {
        resetVoiceActivity();
        finalizingRef.current = false;
        setFinalizing(false);
      }
    }
  }, [
    cancelRecording,
    configuredProvider,
    hideWindowSoon,
    recording,
    resetVoiceActivity,
    stopRecording,
    submitQuickVoiceCommand,
    transcribeRecording,
  ]);

  const startRecording = useCallback(async (): Promise<void> => {
    if (
      recording ||
      recordingActiveRef.current ||
      startInFlightRef.current !== null ||
      finalizingRef.current ||
      transcribing
    ) {
      return;
    }

    if (!controller.quickVoiceSettingsLoaded) {
      pendingStartRequestRef.current = true;
      setStatusText("Loading Quick Voice settings...");
      return;
    }

    pendingStartRequestRef.current = false;

    if (!desktopSettings.quickVoiceEnabled) {
      setStatusText("Quick Voice is currently disabled in Desktop settings.");
      return;
    }

    if (!browserSupported) {
      setStatusText("This WebView does not expose microphone recording APIs.");
      return;
    }

    if (!configuredProvider) {
      setStatusText(
        "Choose and configure a speech-to-text provider before using Quick Voice.",
      );
      return;
    }

    cancelRecording();
    resetVoiceActivity();
    const operationSequence = operationSequenceRef.current + 1;
    operationSequenceRef.current = operationSequence;
    startInFlightRef.current = operationSequence;

    try {
      const started = await startSpeechRecording({
        inputDeviceId: speechToTextSettings.inputDeviceId,
      });
      if (!started || operationSequenceRef.current !== operationSequence) {
        return;
      }
      recordingStartedAtRef.current = Date.now();
      lastSpeechTimestampRef.current = recordingStartedAtRef.current;
      recordingActiveRef.current = true;
      setStatusText("Listening...");
    } catch (error) {
      if (operationSequenceRef.current !== operationSequence) {
        return;
      }
      cancelRecording();
      resetVoiceActivity();
      recordingActiveRef.current = false;
      setStatusText(getRecordingErrorMessage(error));
    } finally {
      if (startInFlightRef.current === operationSequence) {
        startInFlightRef.current = null;
      }
    }
  }, [
    browserSupported,
    cancelRecording,
    configuredProvider,
    controller.quickVoiceSettingsLoaded,
    desktopSettings.quickVoiceEnabled,
    recording,
    resetVoiceActivity,
    speechToTextSettings.inputDeviceId,
    startSpeechRecording,
    transcribing,
  ]);

  useEffect(() => {
    if (
      controller.quickVoiceSettingsLoaded &&
      pendingStartRequestRef.current
    ) {
      pendingStartRequestRef.current = false;
      void startRecording();
    }
  }, [controller.quickVoiceSettingsLoaded, startRecording]);

  useEffect(() => {
    if (!recording || finalizingRef.current) {
      return;
    }

    const now = Date.now();

    if (level >= VOICE_ACTIVITY_THRESHOLD) {
      speechFrameCountRef.current += 1;
      detectedSpeechRef.current =
        speechFrameCountRef.current >= VOICE_ACTIVITY_FRAME_COUNT;
      lastSpeechTimestampRef.current = now;
      return;
    }

    speechFrameCountRef.current = 0;

    const silenceThresholdMs = Math.max(
      800,
      desktopSettings.quickVoiceSilenceSeconds * 1000,
    );
    const noSpeechTimeoutMs = Math.max(5_000, silenceThresholdMs * 2);

    if (
      detectedSpeechRef.current &&
      now - lastSpeechTimestampRef.current >= silenceThresholdMs
    ) {
      void finalizeRecording();
      return;
    }

    if (
      !detectedSpeechRef.current &&
      now - recordingStartedAtRef.current >= noSpeechTimeoutMs
    ) {
      cancelRecordingWithStatus(NO_SPEECH_DETECTED_MESSAGE);
    }
  }, [
    cancelRecordingWithStatus,
    desktopSettings.quickVoiceSilenceSeconds,
    finalizeRecording,
    level,
    levelTick,
    recording,
  ]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    const startQuickVoice = (): void => {
      const requestSequence = operationSequenceRef.current;
      void (async () => {
        try {
          await syncQuickVoiceWindowPosition();
        } catch (error) {
          console.error("Failed to position Quick Voice window", error);
        }

        const isVisible = await getCurrentWindow().isVisible().catch(() => false);

        if (
          !disposed &&
          isVisible &&
          operationSequenceRef.current === requestSequence
        ) {
          await startRecording();
        }
      })().catch((error) => {
        console.error("Failed to start Quick Voice recording", error);
      });
    };

    void getCurrentWindow()
      .listen(QUICK_VOICE_START_EVENT, () => {
        startQuickVoice();
      })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }

        unsubscribe = unlisten;
        void getCurrentWindow()
          .isVisible()
          .then((isVisible) => {
            if (!disposed && isVisible) {
              startQuickVoice();
            }
          })
          .catch(() => undefined);
      })
      .catch((error) => {
        console.error("Failed to subscribe to Quick Voice events", error);
      });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [startRecording, syncQuickVoiceWindowPosition]);

  useEffect(() => {
    return () => {
      operationSequenceRef.current += 1;
      pendingStartRequestRef.current = false;
      startInFlightRef.current = null;
      finalizingRef.current = false;
      recordingActiveRef.current = false;
      cancelRecording();
      clearHideTimeout();
      resetVoiceActivity();
    };
  }, [cancelRecording, clearHideTimeout, resetVoiceActivity]);

  const hideQuickVoice = useCallback((): void => {
    operationSequenceRef.current += 1;
    pendingStartRequestRef.current = false;
    startInFlightRef.current = null;
    finalizingRef.current = false;
    recordingActiveRef.current = false;
    cancelRecording();
    resetVoiceActivity();
    clearHideTimeout();
    setFinalizing(false);
    setStatusText(null);
    void controller.flushPersistence()
      .catch((error) => {
        console.error("Failed to flush Quick Voice state", error);
      })
      .finally(() => {
        void getCurrentWindow().close().catch(() => undefined);
      });
  }, [
    cancelRecording,
    clearHideTimeout,
    controller.flushPersistence,
    resetVoiceActivity,
  ]);

  useEffect(() => {
    void syncQuickVoiceWindowPosition().catch((error) => {
      console.error("Failed to position Quick Voice window", error);
    });
  }, [syncQuickVoiceWindowPosition]);

  const idleBadgeText = !desktopSettings.quickVoiceEnabled
    ? "Disabled"
    : !browserSupported
      ? "Mic unavailable"
      : !configuredProvider
        ? "STT required"
        : desktopSettings.quickVoiceShortcut;

  return (
    <div
      className="app-shell fixed inset-0 overflow-hidden bg-transparent"
      style={{ background: "transparent" }}
    >
      <VoiceInputOverlay
        title="Quick Voice"
        recording={recording}
        transcribing={finalizing || transcribing}
        level={level}
        statusText={statusText}
        idleBadgeText={idleBadgeText}
        showIdleStartAction
        primaryActionDisabled={finalizing || transcribing}
        onPrimaryAction={() => {
          if (recording) {
            void finalizeRecording();
            return;
          }

          void startRecording();
        }}
        className="rounded-3xl border border-slate-800"
        headerActions={
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Open full app"
              onClick={() => {
                void revealMainWindow().catch((error) => {
                  console.error("Failed to reveal main window", error);
                });
              }}
              className="h-9 w-9 rounded-2xl text-slate-400 hover:bg-slate-900 hover:text-slate-100"
            >
              <ArrowUpRight className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Hide quick voice"
              onClick={hideQuickVoice}
              className="h-9 w-9 rounded-2xl text-slate-400 hover:bg-slate-900 hover:text-slate-100"
            >
              <X className="h-4 w-4" />
            </Button>
          </>
        }
      />
    </div>
  );
};

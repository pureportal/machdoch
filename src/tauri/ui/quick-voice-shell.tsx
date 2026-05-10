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
import { QUICK_VOICE_START_EVENT, type UserSpeechToTextSettings } from "./runtime";
import { Button } from "./components/ui/button";
import { VoiceInputOverlay } from "./components/voice-input-overlay";

const VOICE_ACTIVITY_THRESHOLD = 0.012;
const VOICE_ACTIVITY_FRAME_COUNT = 2;

export const QuickVoiceShell = (): JSX.Element => {
  useAppearanceSettings();
  const controller = useChatSessionController({
    enableSessionAutoProfile: false,
  });
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
    finalizingRef.current = false;
  }, []);

  const hideWindowSoon = useCallback(
    (delay = 900): void => {
      clearHideTimeout();
      hideTimeoutRef.current = window.setTimeout(() => {
        void getCurrentWindow().hide().catch(() => undefined);
      }, delay);
    },
    [clearHideTimeout],
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
      cancelRecording();
      resetVoiceActivity();
      setStatusText(message);
    },
    [cancelRecording, resetVoiceActivity],
  );

  const finalizeRecording = useCallback(async (): Promise<void> => {
    if (!recording || !configuredProvider || finalizingRef.current) {
      return;
    }

    finalizingRef.current = true;
    setFinalizing(true);
    setStatusText("Transcribing...");

    try {
      const recordedBlob = await stopRecording();

      if (!recordedBlob) {
        return;
      }

      const transcriptText = await transcribeRecording({
        blob: recordedBlob,
        provider: configuredProvider,
      });

      submitQuickVoiceCommand(transcriptText);
      setStatusText("Sent.");
      hideWindowSoon(500);
    } catch (error) {
      cancelRecording();
      setStatusText(
        error instanceof Error
          ? error.message
          : "Quick voice transcription failed.",
      );
    } finally {
      resetVoiceActivity();
      finalizingRef.current = false;
      setFinalizing(false);
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
    if (recording || finalizingRef.current || transcribing) {
      return;
    }

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

    try {
      await startSpeechRecording({
        inputDeviceId: speechToTextSettings.inputDeviceId,
      });
      recordingStartedAtRef.current = Date.now();
      lastSpeechTimestampRef.current = recordingStartedAtRef.current;
      setStatusText("Listening...");
    } catch (error) {
      cancelRecording();
      resetVoiceActivity();
      setStatusText(getRecordingErrorMessage(error));
    }
  }, [
    browserSupported,
    cancelRecording,
    configuredProvider,
    desktopSettings.quickVoiceEnabled,
    recording,
    resetVoiceActivity,
    speechToTextSettings.inputDeviceId,
    startSpeechRecording,
    transcribing,
  ]);

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
      void (async () => {
        try {
          await syncQuickVoiceWindowPosition();
        } catch (error) {
          console.error("Failed to position Quick Voice window", error);
        }

        await startRecording();
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
      cancelRecording();
      clearHideTimeout();
      resetVoiceActivity();
    };
  }, [cancelRecording, clearHideTimeout, resetVoiceActivity]);

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
              onClick={() => {
                void getCurrentWindow().hide().catch(() => undefined);
              }}
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

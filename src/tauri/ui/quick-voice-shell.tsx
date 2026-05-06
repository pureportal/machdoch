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
import { useChatSessionController } from "./chat-session/_helpers/use-chat-session-controller";
import {
  canUseSpeechInput,
  assertRecordedSpeechDetected,
  convertBlobToBase64,
  createSpeechInputAudioConstraints,
  getConfiguredSpeechToTextProvider,
  getRecordingErrorMessage,
  NO_SPEECH_DETECTED_MESSAGE,
  normalizeAudioMimeType,
  prepareAudioBlob,
  resolveRecorderMimeType,
  stopMediaStream,
} from "./chat-session/_helpers/speech-audio";
import {
  QUICK_VOICE_START_EVENT,
  transcribeUserSpeechAudio,
  type UserSpeechToTextSettings,
} from "./runtime";
import { Button } from "./components/ui/button";
import { VoiceInputOverlay } from "./components/voice-input-overlay";

const VOICE_ACTIVITY_THRESHOLD = 0.012;
const VOICE_ACTIVITY_FRAME_COUNT = 2;

export const QuickVoiceShell = (): JSX.Element => {
  const controller = useChatSessionController({
    enableSessionAutoProfile: false,
  });
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
  const browserSupported = canUseSpeechInput();
  const configuredProvider = useMemo(() => {
    return getConfiguredSpeechToTextProvider(speechToTextSettings);
  }, [speechToTextSettings]);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const monitoringIntervalRef = useRef<number | null>(null);
  const recordingStartedAtRef = useRef(0);
  const lastSpeechTimestampRef = useRef(0);
  const speechFrameCountRef = useRef(0);
  const detectedSpeechRef = useRef(false);
  const finalizingRef = useRef(false);
  const hideTimeoutRef = useRef<number | null>(null);

  const clearMonitoring = useCallback((): void => {
    if (monitoringIntervalRef.current !== null) {
      window.clearInterval(monitoringIntervalRef.current);
      monitoringIntervalRef.current = null;
    }

    if (hideTimeoutRef.current !== null) {
      window.clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }

    setLevel(0);
    analyserRef.current = null;

    if (audioContextRef.current) {
      void audioContextRef.current.close().catch(() => undefined);
      audioContextRef.current = null;
    }
  }, []);

  const cleanupRecording = useCallback((): void => {
    clearMonitoring();
    stopMediaStream(streamRef.current);
    recorderRef.current = null;
    streamRef.current = null;
    chunksRef.current = [];
    speechFrameCountRef.current = 0;
    detectedSpeechRef.current = false;
    finalizingRef.current = false;
  }, [clearMonitoring]);

  const hideWindowSoon = useCallback((delay = 900): void => {
    if (hideTimeoutRef.current !== null) {
      window.clearTimeout(hideTimeoutRef.current);
    }

    hideTimeoutRef.current = window.setTimeout(() => {
      void getCurrentWindow().hide().catch(() => undefined);
    }, delay);
  }, []);

  const syncQuickVoiceWindowPosition = useCallback(async (): Promise<void> => {
    const layout = await resolveAssistantSurfaceLayout();

    if (!layout) {
      return;
    }

    await setWindowPosition(getCurrentWindow(), layout.quickVoicePosition);
  }, []);

  const cancelRecordingWithStatus = useCallback(
    (message: string): void => {
      const recorder = recorderRef.current;

      if (recorder && recorder.state !== "inactive") {
        recorder.ondataavailable = null;
        recorder.onerror = null;

        try {
          recorder.stop();
        } catch {
          // Ignore stop races while cancelling a silent recording.
        }
      }

      cleanupRecording();
      setRecording(false);
      setTranscribing(false);
      setStatusText(message);
    },
    [cleanupRecording],
  );

  const finalizeRecording = useCallback(async (): Promise<void> => {
    const recorder = recorderRef.current;
    const stream = streamRef.current;

    if (!recorder || !stream || !configuredProvider || finalizingRef.current) {
      return;
    }

    finalizingRef.current = true;
    clearMonitoring();
    setRecording(false);
    setTranscribing(true);
    setStatusText("Transcribing…");

    try {
      const recordedBlob = await new Promise<Blob>((resolve, reject) => {
        recorder.onstop = () => {
          const mimeType = normalizeAudioMimeType(recorder.mimeType);
          const blob = new Blob(chunksRef.current, {
            type: mimeType || recorder.mimeType || "audio/webm",
          });
          resolve(blob);
        };
        recorder.onerror = () => {
          reject(recorder.error ?? new Error("Recording failed."));
        };

        recorder.stop();
      });

      stopMediaStream(stream);
      recorderRef.current = null;
      streamRef.current = null;
      chunksRef.current = [];
      await assertRecordedSpeechDetected(recordedBlob);
      const preparedBlob = await prepareAudioBlob(
        recordedBlob,
        configuredProvider,
      );
      const transcription = await transcribeUserSpeechAudio({
        provider: configuredProvider,
        audioBase64: await convertBlobToBase64(preparedBlob),
        mimeType: normalizeAudioMimeType(preparedBlob.type) || "audio/wav",
      });
      const transcriptText = transcription.text.trim();

      if (!transcriptText) {
        throw new Error("No speech was detected in the recording.");
      }

      controller.submitQuickVoiceCommand(transcriptText);
      setStatusText("Sent.");
      hideWindowSoon(500);
    } catch (error) {
      cleanupRecording();
      setStatusText(
        error instanceof Error
          ? error.message
          : "Quick voice transcription failed.",
      );
    } finally {
      setTranscribing(false);
      finalizingRef.current = false;
    }
  }, [
    cleanupRecording,
    clearMonitoring,
    configuredProvider,
    controller,
    hideWindowSoon,
  ]);

  const startRecording = useCallback(async (): Promise<void> => {
    if (recording || transcribing) {
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

    cleanupRecording();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: createSpeechInputAudioConstraints(
          speechToTextSettings.inputDeviceId,
        ),
      });
      const recorderMimeType = resolveRecorderMimeType();
      const recorder = recorderMimeType
        ? new MediaRecorder(stream, {
            mimeType: recorderMimeType,
            audioBitsPerSecond: 128_000,
          })
        : new MediaRecorder(stream);

      chunksRef.current = [];
      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.85;
      const source = audioContext.createMediaStreamSource(stream);

      source.connect(analyser);

      recorderRef.current = recorder;
      streamRef.current = stream;
      audioContextRef.current = audioContext;
      analyserRef.current = analyser;
      recordingStartedAtRef.current = Date.now();
      lastSpeechTimestampRef.current = recordingStartedAtRef.current;
      speechFrameCountRef.current = 0;
      detectedSpeechRef.current = false;
      finalizingRef.current = false;
      setRecording(true);
      setStatusText("Listening…");
      recorder.start();

      const analyserData = new Uint8Array(analyser.fftSize);
      const silenceThresholdMs = Math.max(
        800,
        desktopSettings.quickVoiceSilenceSeconds * 1000,
      );
      const noSpeechTimeoutMs = Math.max(5_000, silenceThresholdMs * 2);

      monitoringIntervalRef.current = window.setInterval(() => {
        if (!analyserRef.current || finalizingRef.current) {
          return;
        }

        analyserRef.current.getByteTimeDomainData(analyserData);

        let sumSquares = 0;

        for (const sample of analyserData) {
          const normalizedSample = sample / 128 - 1;
          sumSquares += normalizedSample * normalizedSample;
        }

        const rms = Math.sqrt(sumSquares / analyserData.length);
        setLevel(rms);

        if (rms >= VOICE_ACTIVITY_THRESHOLD) {
          speechFrameCountRef.current += 1;
          detectedSpeechRef.current =
            speechFrameCountRef.current >= VOICE_ACTIVITY_FRAME_COUNT;
          lastSpeechTimestampRef.current = Date.now();
          return;
        }

        speechFrameCountRef.current = 0;
        const now = Date.now();

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
      }, 120);
    } catch (error) {
      cleanupRecording();
      setRecording(false);
      setTranscribing(false);
      setStatusText(getRecordingErrorMessage(error));
    }
  }, [
    browserSupported,
    cleanupRecording,
    cancelRecordingWithStatus,
    configuredProvider,
    desktopSettings.quickVoiceEnabled,
    desktopSettings.quickVoiceSilenceSeconds,
    finalizeRecording,
    recording,
    speechToTextSettings.inputDeviceId,
    transcribing,
  ]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void getCurrentWindow()
      .listen(QUICK_VOICE_START_EVENT, () => {
        void syncQuickVoiceWindowPosition().finally(() => {
          void startRecording();
        });
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
  }, [startRecording]);

  useEffect(() => {
    return () => {
      cleanupRecording();
    };
  }, [cleanupRecording]);

  useEffect(() => {
    void syncQuickVoiceWindowPosition();
  }, [syncQuickVoiceWindowPosition]);

  const idleBadgeText = !desktopSettings.quickVoiceEnabled
    ? "Disabled"
    : !browserSupported
      ? "Mic unavailable"
      : !configuredProvider
        ? "STT required"
        : desktopSettings.quickVoiceShortcut;

  return (
    <div className="fixed inset-0 overflow-hidden bg-transparent">
      <VoiceInputOverlay
        title="Quick Voice"
        recording={recording}
        transcribing={transcribing}
        level={level}
        statusText={statusText}
        idleBadgeText={idleBadgeText}
        showIdleStartAction
        primaryActionDisabled={transcribing}
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

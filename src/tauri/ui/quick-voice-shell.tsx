import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowUpRight,
  AudioWaveform,
  LoaderCircle,
  Mic,
  Square,
  X,
} from "lucide-react";
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
  convertBlobToBase64,
  getConfiguredSpeechToTextProvider,
  getRecordingErrorMessage,
  getSpeechInputLanguageCode,
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
import { cn } from "./lib/utils";

const VOICE_ACTIVITY_THRESHOLD = 0.035;

export const QuickVoiceShell = (): JSX.Element => {
  const controller = useChatSessionController({
    isolateActiveSession: false,
  });
  const speechToTextSettings = useMemo<UserSpeechToTextSettings>(() => {
    return {
      activeProvider: controller.settingsDialog.voiceSetup.speechToTextProvider,
      providerAvailability:
        controller.settingsDialog.voiceSetup.speechToTextProviderAvailability,
    };
  }, [
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
      const preparedBlob = await prepareAudioBlob(recordedBlob, configuredProvider);
      const transcription = await transcribeUserSpeechAudio({
        provider: configuredProvider,
        audioBase64: await convertBlobToBase64(preparedBlob),
        mimeType: normalizeAudioMimeType(preparedBlob.type) || "audio/wav",
        languageCode: getSpeechInputLanguageCode(),
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
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
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
          detectedSpeechRef.current = true;
          lastSpeechTimestampRef.current = Date.now();
          return;
        }

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
          void finalizeRecording();
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
    configuredProvider,
    desktopSettings.quickVoiceEnabled,
    desktopSettings.quickVoiceSilenceSeconds,
    finalizeRecording,
    recording,
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
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (!focused && !recording && !transcribing) {
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
  }, [recording, transcribing]);

  useEffect(() => {
    return () => {
      cleanupRecording();
    };
  }, [cleanupRecording]);

  useEffect(() => {
    void syncQuickVoiceWindowPosition();
  }, [syncQuickVoiceWindowPosition]);

  const compactStatus =
    statusText ??
    (transcribing
      ? "Transcribing…"
      : recording
        ? "Listening…"
        : null);
  const idleBadgeText = !desktopSettings.quickVoiceEnabled
    ? "Disabled"
    : !browserSupported
      ? "Mic unavailable"
      : !configuredProvider
        ? "STT required"
        : desktopSettings.quickVoiceShortcut;
  const compactStatusTone =
    statusText &&
    (/failed|disabled|unavailable|required|no speech|error/i.test(statusText)
      ? "error"
      : /sent/i.test(statusText)
        ? "success"
        : "info");

  return (
    <div className="fixed inset-0 overflow-hidden bg-transparent">
      <div className="flex h-full w-full flex-col overflow-hidden rounded-3xl border border-slate-800 bg-slate-950/98 text-slate-100 shadow-none">
        <header className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-sky-400" />
            <p className="text-sm font-semibold text-white">Quick Voice</p>
          </div>

          <div className="flex items-center gap-2">
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
          </div>
        </header>

        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-4 text-center">
          <button
            type="button"
            aria-label={recording ? "Stop recording" : "Start recording"}
            disabled={transcribing}
            onClick={() => {
              if (recording) {
                void finalizeRecording();
                return;
              }

              void startRecording();
            }}
            className={cn(
              "relative flex h-24 w-24 items-center justify-center rounded-full border border-slate-700 bg-slate-900 text-sky-100 shadow-none outline-none transition-colors duration-150 focus-visible:ring-0",
              recording && "border-rose-500/40 bg-rose-500/10 text-rose-200",
              transcribing && "border-amber-500/30 bg-amber-500/10 text-amber-100",
              !recording && !transcribing && "hover:border-sky-500/40 hover:bg-slate-800",
            )}
          >
            <span
              className={cn(
                "absolute h-full w-full rounded-full bg-sky-500/6 transition-transform duration-150",
                recording && "animate-ping",
              )}
            />
            <span
              className="absolute rounded-full bg-sky-500/10 transition-all duration-150"
              style={{
                width: `${72 + Math.min(level, 0.2) * 140}px`,
                height: `${72 + Math.min(level, 0.2) * 140}px`,
              }}
            />
            <span className="relative z-10 flex h-16 w-16 items-center justify-center rounded-full bg-slate-950/90">
              {transcribing ? (
                <LoaderCircle className="h-6 w-6 animate-spin" />
              ) : recording ? (
                <Square className="h-5 w-5 fill-current" />
              ) : (
                <AudioWaveform className="h-6 w-6" />
              )}
            </span>
          </button>

          <div className="grid gap-2">
            <p className="text-base font-semibold text-white">
              {transcribing
                ? "Transcribing"
                : recording
                  ? "Listening"
                  : "Ready"}
            </p>

            {compactStatus ? (
              <p
                className={cn(
                  "max-w-xs text-sm",
                  compactStatusTone === "error"
                    ? "text-rose-300"
                    : compactStatusTone === "success"
                      ? "text-emerald-300"
                      : "text-slate-400",
                )}
              >
                {compactStatus}
              </p>
            ) : null}

            {!recording && !transcribing ? (
              <div className="flex items-center justify-center">
                <span className="rounded-full border border-slate-800 bg-slate-900/80 px-3 py-1 text-xs text-slate-400">
                  {idleBadgeText}
                </span>
              </div>
            ) : null}
          </div>

          {!recording && !transcribing ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                void startRecording();
              }}
              className="rounded-full border border-slate-800 bg-slate-900/70 px-4 text-slate-200 hover:bg-slate-800 hover:text-white"
            >
              <Mic className="h-4 w-4" />
              Start
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
};

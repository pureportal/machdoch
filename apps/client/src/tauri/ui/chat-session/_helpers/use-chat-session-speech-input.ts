import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isLocalSpeechProvider } from "../../../../shared/local-speech";
import type {
  SpeechToTextProvider,
  UserSpeechToTextProvider,
  UserSpeechToTextSettings,
} from "../../runtime";
import { processUserSpeechText } from "../../speech-text-processing";
import {
  resolveAppNotificationDismissMs,
  scheduleAppNotificationDismiss,
} from "@machdoch/media-studio/tauri/ui/components/ui/notification-lifecycle.js";
import {
  getConfiguredSpeechToTextProvider,
  getRecordingErrorMessage,
  getSpeechInputAvailabilityDescription,
} from "./speech-audio";
import { useSpeechRecorder } from "./use-speech-recorder";
import { useSpeechTranscription } from "./use-speech-transcription";

export type SpeechInputStatusTone = "success" | "error" | "info";

export interface UseChatSessionSpeechInputOptions {
  activeSessionId: string;
  settings: UserSpeechToTextSettings;
  onTranscript: (sessionId: string, transcript: string) => void;
}

export interface ChatSessionSpeechInputController {
  browserSupported: boolean;
  enabled: boolean;
  selectedProvider: SpeechToTextProvider;
  configuredProvider: UserSpeechToTextProvider | null;
  recording: boolean;
  starting: boolean;
  transcribing: boolean;
  level: number;
  statusText: string | null;
  statusTone: SpeechInputStatusTone | null;
  availabilityDescription: string;
  toggleRecording: () => void;
  setRecording: (recording: boolean) => Promise<void>;
  cancelSpeechInput: () => void;
  dismissStatus: () => void;
}

export const useChatSessionSpeechInput = (
  options: UseChatSessionSpeechInputOptions,
): ChatSessionSpeechInputController => {
  const recorder = useSpeechRecorder();
  const transcription = useSpeechTranscription();
  const configuredProvider = useMemo(() => {
    return getConfiguredSpeechToTextProvider(options.settings);
  }, [options.settings]);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [statusTone, setStatusTone] = useState<SpeechInputStatusTone | null>(
    null,
  );
  const [finalizing, setFinalizing] = useState(false);
  const [starting, setStarting] = useState(false);
  const operationAbortRef = useRef<AbortController | null>(null);
  const recordingSessionIdRef = useRef<string>(options.activeSessionId);
  const recordingInputRef = useRef<{
    provider: UserSpeechToTextProvider;
    settings: UserSpeechToTextSettings;
  } | null>(null);
  const operationSequenceRef = useRef(0);
  const startInFlightRef = useRef<number | null>(null);
  const finalizingRef = useRef(false);

  const dismissStatus = useCallback((): void => {
    setStatusText(null);
    setStatusTone(null);
  }, []);

  const cancelSpeechInput = useCallback((): void => {
    operationSequenceRef.current += 1;
    operationAbortRef.current?.abort();
    operationAbortRef.current = null;
    startInFlightRef.current = null;
    finalizingRef.current = false;
    recordingInputRef.current = null;
    recorder.cancelRecording();
    transcription.cancelTranscription();
    setStarting(false);
    setFinalizing(false);
    dismissStatus();
  }, [
    dismissStatus,
    recorder.cancelRecording,
    transcription.cancelTranscription,
  ]);

  useEffect(() => {
    if (!statusText || statusTone !== "success") {
      return;
    }

    return scheduleAppNotificationDismiss(
      dismissStatus,
      resolveAppNotificationDismissMs("success"),
    );
  }, [dismissStatus, statusText, statusTone]);

  const availabilityDescription = useMemo(() => {
    return getSpeechInputAvailabilityDescription(
      recorder.browserSupported,
      options.settings,
      configuredProvider,
    );
  }, [configuredProvider, options.settings, recorder.browserSupported]);

  const finalizeRecording = useCallback(async (): Promise<void> => {
    const recordingInput = recordingInputRef.current;

    if (!recordingInput || finalizingRef.current) {
      return;
    }
    const { provider, settings: speechSettings } = recordingInput;

    const operationSequence = operationSequenceRef.current + 1;
    operationSequenceRef.current = operationSequence;
    finalizingRef.current = true;
    const recordingSessionId = recordingSessionIdRef.current;
    const signal = operationAbortRef.current?.signal;
    setFinalizing(true);
    setStatusTone("info");
    setStatusText("Transcribing...");

    try {
      const recordedBlob = await recorder.stopRecording();

      if (!recordedBlob || operationSequenceRef.current !== operationSequence) {
        return;
      }

      const transcriptText = await transcription.transcribeRecording({
        blob: recordedBlob,
        provider,
        keyTerms: speechSettings.keyTerms,
        speechContext: speechSettings.speechContext,
        autoTranslateToEnglish: speechSettings.autoTranslateToEnglish,
        signal,
      });

      if (operationSequenceRef.current !== operationSequence) {
        return;
      }

      let draftText = transcriptText;
      let processingError: string | null = null;
      if (
        !isLocalSpeechProvider(provider) &&
        (speechSettings.autoTranslateToEnglish || speechSettings.autoFormat)
      ) {
        setStatusText("Processing speech...");
        try {
          draftText = await processUserSpeechText({
            provider,
            text: transcriptText,
            autoTranslateToEnglish: speechSettings.autoTranslateToEnglish,
            autoFormat: speechSettings.autoFormat,
            signal,
          });
        } catch (error) {
          processingError =
            error instanceof Error ? error.message : String(error);
        }
      }

      if (operationSequenceRef.current !== operationSequence) {
        return;
      }
      options.onTranscript(recordingSessionId, draftText);
      setStatusTone(processingError ? "error" : "success");
      setStatusText(
        processingError
          ? `Text processing failed: ${processingError} Original transcript added to the draft.`
          : "Transcript added to the draft.",
      );
    } catch (error) {
      if (operationSequenceRef.current !== operationSequence) {
        return;
      }
      recorder.cancelRecording();
      setStatusTone("error");
      setStatusText(
        error instanceof Error
          ? error.message
          : "Speech-to-text failed for this recording.",
      );
    } finally {
      if (operationSequenceRef.current === operationSequence) {
        recordingInputRef.current = null;
        finalizingRef.current = false;
        setFinalizing(false);
      }
    }
  }, [options, recorder, transcription]);

  const startRecording = useCallback(async (): Promise<boolean> => {
    if (
      startInFlightRef.current !== null ||
      finalizingRef.current ||
      recordingInputRef.current !== null
    ) {
      return false;
    }

    if (!recorder.browserSupported) {
      setStatusTone("error");
      setStatusText("This WebView does not expose microphone recording APIs.");
      return false;
    }

    if (!configuredProvider) {
      setStatusTone("info");
      setStatusText("Choose and configure a speak-to-text provider first.");
      return false;
    }

    const operationSequence = operationSequenceRef.current + 1;
    operationSequenceRef.current = operationSequence;
    startInFlightRef.current = operationSequence;
    operationAbortRef.current = new AbortController();
    setStarting(true);
    setStatusTone("info");
    setStatusText("Starting microphone...");
    const recordingSessionId = options.activeSessionId;
    const speechSettings = {
      ...options.settings,
      keyTerms: [...options.settings.keyTerms],
    };

    try {
      const started = await recorder.startRecording({
        inputDeviceId: speechSettings.inputDeviceId,
      });

      if (!started || operationSequenceRef.current !== operationSequence) {
        return false;
      }

      recordingSessionIdRef.current = recordingSessionId;
      recordingInputRef.current = {
        provider: configuredProvider,
        settings: speechSettings,
      };
      setStatusTone("info");
      setStatusText("Listening...");
      return true;
    } catch (error) {
      if (operationSequenceRef.current !== operationSequence) {
        return false;
      }
      recorder.cancelRecording();
      recordingInputRef.current = null;
      setStatusTone("error");
      setStatusText(getRecordingErrorMessage(error));
      return false;
    } finally {
      if (startInFlightRef.current === operationSequence) {
        startInFlightRef.current = null;
        setStarting(false);
      }
    }
  }, [configuredProvider, options.activeSessionId, options.settings, recorder]);

  const toggleRecording = useCallback((): void => {
    if (
      finalizingRef.current ||
      startInFlightRef.current !== null ||
      transcription.transcribing
    ) {
      return;
    }

    if (recorder.recording) {
      void finalizeRecording();
      return;
    }

    void startRecording();
  }, [
    finalizeRecording,
    finalizing,
    recorder.recording,
    startRecording,
    transcription.transcribing,
  ]);

  const setRecording = useCallback(
    async (recording: boolean): Promise<void> => {
      if (
        finalizingRef.current ||
        startInFlightRef.current !== null ||
        transcription.transcribing
      ) {
        throw new Error("Speech input is busy. Wait for it to finish.");
      }
      if (recording === recorder.recording) return;
      if (!recording) {
        await finalizeRecording();
        return;
      }
      if (!(await startRecording())) {
        throw new Error(
          "The device microphone could not start. Check speech input settings on the device.",
        );
      }
    },
    [
      finalizeRecording,
      recorder.recording,
      startRecording,
      transcription.transcribing,
    ],
  );

  useEffect(() => {
    return cancelSpeechInput;
  }, [cancelSpeechInput]);

  return {
    browserSupported: recorder.browserSupported,
    enabled: configuredProvider !== null,
    selectedProvider: options.settings.activeProvider,
    configuredProvider,
    recording: recorder.recording,
    starting,
    transcribing: finalizing || transcription.transcribing,
    level: recorder.level,
    statusText,
    statusTone,
    availabilityDescription,
    toggleRecording,
    setRecording,
    cancelSpeechInput,
    dismissStatus,
  };
};

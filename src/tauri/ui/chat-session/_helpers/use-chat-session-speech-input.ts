import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  SpeechToTextProvider,
  UserSpeechToTextProvider,
  UserSpeechToTextSettings,
} from "../../runtime";
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
  transcribing: boolean;
  level: number;
  statusText: string | null;
  statusTone: SpeechInputStatusTone | null;
  availabilityDescription: string;
  toggleRecording: () => void;
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
  const recordingSessionIdRef = useRef<string>(options.activeSessionId);
  const recordingProviderRef = useRef<UserSpeechToTextProvider | null>(null);

  const availabilityDescription = useMemo(() => {
    return getSpeechInputAvailabilityDescription(
      recorder.browserSupported,
      options.settings,
      configuredProvider,
    );
  }, [configuredProvider, options.settings, recorder.browserSupported]);

  const finalizeRecording = useCallback(async (): Promise<void> => {
    const provider = recordingProviderRef.current;

    if (!provider) {
      return;
    }

    setFinalizing(true);
    setStatusTone("info");
    setStatusText("Transcribing...");

    try {
      const recordedBlob = await recorder.stopRecording();

      if (!recordedBlob) {
        return;
      }

      const transcriptText = await transcription.transcribeRecording({
        blob: recordedBlob,
        provider,
      });

      options.onTranscript(recordingSessionIdRef.current, transcriptText);
      setStatusTone("success");
      setStatusText("Transcript added to the draft.");
    } catch (error) {
      recorder.cancelRecording();
      setStatusTone("error");
      setStatusText(
        error instanceof Error
          ? error.message
          : "Speech-to-text failed for this recording.",
      );
    } finally {
      recordingProviderRef.current = null;
      setFinalizing(false);
    }
  }, [options, recorder, transcription]);

  const startRecording = useCallback(async (): Promise<void> => {
    if (!recorder.browserSupported) {
      setStatusTone("error");
      setStatusText(
        "This WebView does not expose microphone recording APIs.",
      );
      return;
    }

    if (!configuredProvider) {
      setStatusTone("info");
      setStatusText("Choose and configure a speak-to-text provider first.");
      return;
    }

    try {
      await recorder.startRecording({
        inputDeviceId: options.settings.inputDeviceId,
      });
      recordingSessionIdRef.current = options.activeSessionId;
      recordingProviderRef.current = configuredProvider;
      setStatusTone("info");
      setStatusText("Listening...");
    } catch (error) {
      recorder.cancelRecording();
      recordingProviderRef.current = null;
      setStatusTone("error");
      setStatusText(getRecordingErrorMessage(error));
    }
  }, [
    configuredProvider,
    options.activeSessionId,
    options.settings.inputDeviceId,
    recorder,
  ]);

  const toggleRecording = useCallback((): void => {
    if (finalizing || transcription.transcribing) {
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

  useEffect(() => {
    return () => {
      recordingProviderRef.current = null;
    };
  }, []);

  return {
    browserSupported: recorder.browserSupported,
    enabled: configuredProvider !== null,
    selectedProvider: options.settings.activeProvider,
    configuredProvider,
    recording: recorder.recording,
    transcribing: finalizing || transcription.transcribing,
    level: recorder.level,
    statusText,
    statusTone,
    availabilityDescription,
    toggleRecording,
  };
};

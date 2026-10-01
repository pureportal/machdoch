import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { awaitSpeechOperation } from "../../speech-operation";
import {
  transcribeUserSpeechAudio,
  type UserSpeechToTextProvider,
} from "../../runtime";
import {
  convertBlobToBase64,
  normalizeAudioMimeType,
  prepareAudioBlob,
} from "./speech-audio";

export interface SpeechTranscriptionOptions {
  blob: Blob;
  provider: UserSpeechToTextProvider;
  languageCode?: string;
  keyTerms: string[];
  speechContext: string;
  autoTranslateToEnglish: boolean;
  signal?: AbortSignal;
}

export interface SpeechTranscriptionController {
  transcribing: boolean;
  transcribeRecording: (options: SpeechTranscriptionOptions) => Promise<string>;
  cancelTranscription: () => void;
}

export const useSpeechTranscription = (): SpeechTranscriptionController => {
  const [transcribing, setTranscribing] = useState(false);
  const activeTranscriptionRef = useRef<AbortController | null>(null);

  const cancelTranscription = useCallback((): void => {
    activeTranscriptionRef.current?.abort();
    activeTranscriptionRef.current = null;
    setTranscribing(false);
  }, []);

  useEffect(() => cancelTranscription, [cancelTranscription]);

  const transcribeRecording = useCallback(
    async (options: SpeechTranscriptionOptions): Promise<string> => {
      cancelTranscription();
      const controller = new AbortController();
      activeTranscriptionRef.current = controller;
      const cancel = (): void => controller.abort(options.signal?.reason);
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) {
        cancel();
      }
      const { signal } = controller;
      const preparationTimeout = window.setTimeout(() => {
        controller.abort(
          new Error("Audio preparation timed out. Try recording again."),
        );
      }, 30_000);
      let transcriptionTimeout: number | undefined;
      setTranscribing(true);

      try {
        signal.throwIfAborted();
        const preparedBlob = await awaitSpeechOperation(
          prepareAudioBlob(options.blob, options.provider, signal),
          signal,
        );
        const audioBase64 = await awaitSpeechOperation(
          convertBlobToBase64(preparedBlob, signal),
          signal,
        );
        signal.throwIfAborted();
        window.clearTimeout(preparationTimeout);
        const transcriptionTimeoutMs =
          options.provider === "whisper"
            ? Math.min(900, 30 + preparedBlob.size / 16_000) * 1000 + 5_000
            : 60_000;
        transcriptionTimeout = window.setTimeout(() => {
          controller.abort(
            new Error("Speech transcription timed out. Try recording again."),
          );
        }, transcriptionTimeoutMs);
        const transcription = await awaitSpeechOperation(
          transcribeUserSpeechAudio({
            provider: options.provider,
            audioBase64,
            mimeType: normalizeAudioMimeType(preparedBlob.type) || "audio/wav",
            keyTerms: options.keyTerms,
            speechContext: options.speechContext,
            autoTranslateToEnglish: options.autoTranslateToEnglish,
            signal,
            ...(options.languageCode
              ? { languageCode: options.languageCode }
              : {}),
          }),
          signal,
        );
        signal.throwIfAborted();
        const transcriptText = transcription.text.trim();

        if (!transcriptText) {
          throw new Error("No speech was detected in the recording.");
        }

        return transcriptText;
      } finally {
        window.clearTimeout(preparationTimeout);
        window.clearTimeout(transcriptionTimeout);
        options.signal?.removeEventListener("abort", cancel);
        if (activeTranscriptionRef.current === controller) {
          activeTranscriptionRef.current = null;
          setTranscribing(false);
        }
      }
    },
    [cancelTranscription],
  );

  return useMemo(
    () => ({
      transcribing,
      transcribeRecording,
      cancelTranscription,
    }),
    [cancelTranscription, transcribeRecording, transcribing],
  );
};

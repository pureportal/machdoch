import { useCallback, useMemo, useRef, useState } from "react";
import {
  transcribeUserSpeechAudio,
  type UserSpeechToTextProvider,
} from "../../runtime";
import {
  assertRecordedSpeechDetected,
  convertBlobToBase64,
  normalizeAudioMimeType,
  prepareAudioBlob,
} from "./speech-audio";

export interface SpeechTranscriptionOptions {
  blob: Blob;
  provider: UserSpeechToTextProvider;
  languageCode?: string;
}

export interface SpeechTranscriptionController {
  transcribing: boolean;
  transcribeRecording: (options: SpeechTranscriptionOptions) => Promise<string>;
}

export const useSpeechTranscription = (): SpeechTranscriptionController => {
  const [transcribing, setTranscribing] = useState(false);
  const activeTranscriptionCountRef = useRef(0);

  const transcribeRecording = useCallback(
    async (options: SpeechTranscriptionOptions): Promise<string> => {
      activeTranscriptionCountRef.current += 1;
      setTranscribing(true);

      try {
        await assertRecordedSpeechDetected(options.blob);

        const preparedBlob = await prepareAudioBlob(
          options.blob,
          options.provider,
        );
        const transcription = await transcribeUserSpeechAudio({
          provider: options.provider,
          audioBase64: await convertBlobToBase64(preparedBlob),
          mimeType: normalizeAudioMimeType(preparedBlob.type) || "audio/wav",
          ...(options.languageCode ? { languageCode: options.languageCode } : {}),
        });
        const transcriptText = transcription.text.trim();

        if (!transcriptText) {
          throw new Error("No speech was detected in the recording.");
        }

        return transcriptText;
      } finally {
        activeTranscriptionCountRef.current = Math.max(
          0,
          activeTranscriptionCountRef.current - 1,
        );
        if (activeTranscriptionCountRef.current === 0) {
          setTranscribing(false);
        }
      }
    },
    [],
  );

  return useMemo(
    () => ({
      transcribing,
      transcribeRecording,
    }),
    [transcribeRecording, transcribing],
  );
};

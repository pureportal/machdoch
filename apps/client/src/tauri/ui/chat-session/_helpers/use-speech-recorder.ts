import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  canUseSpeechInput,
  createSpeechInputAudioConstraints,
  normalizeAudioMimeType,
  resolveRecorderMimeType,
  stopMediaStream,
} from "./speech-audio";

const DEFAULT_LEVEL_MONITOR_INTERVAL_MS = 120;
const RECORDER_AUDIO_BITS_PER_SECOND = 128_000;

export interface SpeechRecorderStartOptions {
  inputDeviceId?: string | null;
}

export interface SpeechRecorderController {
  browserSupported: boolean;
  recording: boolean;
  level: number;
  levelTick: number;
  startRecording: (options?: SpeechRecorderStartOptions) => Promise<boolean>;
  stopRecording: () => Promise<Blob | null>;
  cancelRecording: () => void;
}

const createRecorder = (stream: MediaStream): MediaRecorder => {
  const recorderMimeType = resolveRecorderMimeType();

  return recorderMimeType
    ? new MediaRecorder(stream, {
        mimeType: recorderMimeType,
        audioBitsPerSecond: RECORDER_AUDIO_BITS_PER_SECOND,
      })
    : new MediaRecorder(stream);
};

const createBlobFromRecorder = (
  recorder: MediaRecorder,
  chunks: Blob[],
): Blob => {
  const mimeType = normalizeAudioMimeType(recorder.mimeType);

  return new Blob(chunks, {
    type: mimeType || recorder.mimeType || "audio/webm",
  });
};

const getRecorderEventError = (event: Event): unknown => {
  const eventError = "error" in event ? event.error : undefined;

  return eventError instanceof Error ||
    (typeof DOMException !== "undefined" && eventError instanceof DOMException)
    ? eventError
    : new Error("Recording failed.");
};

export const useSpeechRecorder = (): SpeechRecorderController => {
  const browserSupported = canUseSpeechInput();
  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [levelTick, setLevelTick] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const monitoringIntervalRef = useRef<number | null>(null);
  const operationSequenceRef = useRef(0);
  const pendingStopResolversRef = useRef(
    new Map<MediaRecorder, () => void>(),
  );

  const clearMonitoring = useCallback((): void => {
    if (monitoringIntervalRef.current !== null) {
      window.clearInterval(monitoringIntervalRef.current);
      monitoringIntervalRef.current = null;
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
    setRecording(false);
  }, [clearMonitoring]);

  const startLevelMonitoring = useCallback(
    (stream: MediaStream): void => {
      clearMonitoring();

      if (typeof AudioContext === "undefined") {
        return;
      }

      try {
        const audioContext = new AudioContext();
        const analyser = audioContext.createAnalyser();
        const source = audioContext.createMediaStreamSource(stream);

        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.85;
        const analyserData = new Uint8Array(analyser.fftSize);

        source.connect(analyser);
        audioContextRef.current = audioContext;
        analyserRef.current = analyser;

        monitoringIntervalRef.current = window.setInterval(() => {
          if (!analyserRef.current) {
            return;
          }

          analyserRef.current.getByteTimeDomainData(analyserData);

          let sumSquares = 0;

          for (const sample of analyserData) {
            const normalizedSample = sample / 128 - 1;
            sumSquares += normalizedSample * normalizedSample;
          }

          setLevel(Math.sqrt(sumSquares / analyserData.length));
          setLevelTick((currentTick) => currentTick + 1);
        }, DEFAULT_LEVEL_MONITOR_INTERVAL_MS);
      } catch {
        clearMonitoring();
      }
    },
    [clearMonitoring],
  );

  const startRecording = useCallback(
    async (options: SpeechRecorderStartOptions = {}): Promise<boolean> => {
      if (!browserSupported) {
        throw new Error(
          "This WebView does not expose microphone recording APIs.",
        );
      }

      const operationSequence = operationSequenceRef.current + 1;
      operationSequenceRef.current = operationSequence;
      cleanupRecording();

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: createSpeechInputAudioConstraints(options.inputDeviceId),
      });

      if (operationSequenceRef.current !== operationSequence) {
        stopMediaStream(stream);
        return false;
      }

      streamRef.current = stream;

      try {
        const recorder = createRecorder(stream);
        const chunks: Blob[] = [];

        chunksRef.current = chunks;
        recorder.ondataavailable = (event: BlobEvent) => {
          if (event.data.size > 0) {
            chunks.push(event.data);
          }
        };
        recorder.onstop = () => {
          if (
            recorderRef.current === recorder &&
            !pendingStopResolversRef.current.has(recorder)
          ) {
            cleanupRecording();
          }
        };
        recorder.onerror = () => {
          if (recorderRef.current === recorder) {
            cleanupRecording();
          }
        };

        recorderRef.current = recorder;
        setLevelTick((currentTick) => currentTick + 1);
        startLevelMonitoring(stream);
        recorder.start();
        setRecording(true);
        return true;
      } catch (error) {
        if (operationSequenceRef.current === operationSequence) {
          cleanupRecording();
        } else {
          stopMediaStream(stream);
        }
        throw error;
      }
    },
    [browserSupported, cleanupRecording, startLevelMonitoring],
  );

  const stopRecording = useCallback(async (): Promise<Blob | null> => {
    const recorder = recorderRef.current;
    const stream = streamRef.current;

    if (!recorder || !stream) {
      return null;
    }

    const operationSequence = operationSequenceRef.current + 1;
    operationSequenceRef.current = operationSequence;
    const chunks = chunksRef.current;

    clearMonitoring();
    setRecording(false);

    try {
      const recordedBlob = await new Promise<Blob | null>((resolve, reject) => {
        pendingStopResolversRef.current.set(recorder, () => resolve(null));
        recorder.onstop = () => {
          pendingStopResolversRef.current.delete(recorder);
          resolve(createBlobFromRecorder(recorder, chunks));
        };
        recorder.onerror = (event) => {
          pendingStopResolversRef.current.delete(recorder);
          reject(getRecorderEventError(event));
        };

        if (recorder.state === "inactive") {
          pendingStopResolversRef.current.delete(recorder);
          resolve(createBlobFromRecorder(recorder, chunks));
          return;
        }

        try {
          recorder.stop();
        } catch (error) {
          pendingStopResolversRef.current.delete(recorder);
          reject(error);
        }
      });

      if (
        operationSequenceRef.current === operationSequence &&
        recorderRef.current === recorder
      ) {
        cleanupRecording();
      } else {
        stopMediaStream(stream);
      }
      return recordedBlob;
    } catch (error) {
      if (
        operationSequenceRef.current === operationSequence &&
        recorderRef.current === recorder
      ) {
        cleanupRecording();
      } else {
        stopMediaStream(stream);
      }
      throw error;
    }
  }, [cleanupRecording, clearMonitoring]);

  const cancelRecording = useCallback((): void => {
    operationSequenceRef.current += 1;
    const recorder = recorderRef.current;

    for (const [pendingRecorder, resolvePendingStop] of
      pendingStopResolversRef.current) {
      pendingRecorder.onstop = null;
      pendingRecorder.onerror = null;
      resolvePendingStop();
    }
    pendingStopResolversRef.current.clear();

    if (recorder && recorder.state !== "inactive") {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;

      try {
        recorder.stop();
      } catch {
        // Ignore races while tearing down a recorder that is already stopping.
      }
    }

    cleanupRecording();
  }, [cleanupRecording]);

  useEffect(() => {
    return () => {
      cancelRecording();
    };
  }, [cancelRecording]);

  return useMemo(
    () => ({
      browserSupported,
      recording,
      level,
      levelTick,
      startRecording,
      stopRecording,
      cancelRecording,
    }),
    [
      browserSupported,
      cancelRecording,
      level,
      levelTick,
      recording,
      startRecording,
      stopRecording,
    ],
  );
};

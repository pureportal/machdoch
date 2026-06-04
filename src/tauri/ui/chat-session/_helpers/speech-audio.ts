import { getProviderLabel } from "../../model-catalog";
import type {
  UserSpeechToTextProvider,
  UserSpeechToTextSettings,
} from "../../runtime";

const GOOGLE_SUPPORTED_MIME_TYPES = new Set([
  "audio/wav",
  "audio/mp3",
  "audio/aiff",
  "audio/aac",
  "audio/ogg",
  "audio/flac",
]);

const RECORDING_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/ogg",
] as const;
const MIN_RECORDED_AUDIO_BYTES = 512;
const MIN_RECORDED_AUDIO_DURATION_SECONDS = 0.25;
const MIN_RECORDED_SPEECH_RMS = 0.0035;
const MIN_RECORDED_SPEECH_PEAK = 0.025;

export const NO_SPEECH_DETECTED_MESSAGE =
  "No voice was detected. Check the selected microphone and try again.";

export interface SpeechInputDeviceOption {
  deviceId: string;
  label: string;
}

export const canUseSpeechInput = (): boolean => {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined"
  );
};

export const canEnumerateSpeechInputDevices = (): boolean => {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.enumerateDevices === "function"
  );
};

export const normalizeAudioMimeType = (
  mimeType: string | null | undefined,
): string => {
  return mimeType?.split(";")[0]?.trim().toLowerCase() ?? "";
};

export const createSpeechInputAudioConstraints = (
  inputDeviceId?: string | null,
): MediaTrackConstraints => {
  const constraints: MediaTrackConstraints = {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  const normalizedInputDeviceId = inputDeviceId?.trim();

  if (normalizedInputDeviceId) {
    constraints.deviceId = { exact: normalizedInputDeviceId };
  }

  return constraints;
};

export const listSpeechInputDevices = async (): Promise<
  SpeechInputDeviceOption[]
> => {
  if (!canEnumerateSpeechInputDevices()) {
    return [];
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const seenDeviceIds = new Set<string>();
  let audioInputIndex = 0;

  return devices.flatMap((device) => {
    if (device.kind !== "audioinput") {
      return [];
    }

    const deviceId = device.deviceId.trim();

    if (!deviceId || deviceId === "default" || seenDeviceIds.has(deviceId)) {
      return [];
    }

    seenDeviceIds.add(deviceId);
    audioInputIndex += 1;

    return [
      {
        deviceId,
        label: device.label.trim() || `Microphone ${audioInputIndex}`,
      },
    ];
  });
};

export const getSpeechInputLanguageCode = (): string | undefined => {
  const candidate =
    typeof navigator !== "undefined" ? navigator.language?.trim() : "";

  if (!candidate) {
    return undefined;
  }

  const primaryLanguageCode = candidate.split(/[-_]/u)[0]?.trim();
  return primaryLanguageCode || undefined;
};

export const getConfiguredSpeechToTextProvider = (
  settings: UserSpeechToTextSettings,
): UserSpeechToTextProvider | null => {
  if (settings.activeProvider === "none") {
    return null;
  }

  return settings.providerAvailability.some(
    (entry) =>
      entry.provider === settings.activeProvider && entry.configured,
  )
    ? settings.activeProvider
    : null;
};

export const getSpeechInputAvailabilityDescription = (
  browserSupported: boolean,
  settings: UserSpeechToTextSettings,
  configuredProvider: UserSpeechToTextProvider | null,
): string => {
  if (!browserSupported) {
    return "This WebView does not expose microphone recording APIs, so speak-to-text is unavailable here.";
  }

  if (settings.activeProvider === "none") {
    return "Choose an AI provider to turn short microphone recordings into editable draft text.";
  }

  const providerLabel = getProviderLabel(settings.activeProvider);

  if (configuredProvider) {
    return `${providerLabel} is ready for push-to-talk transcription. New recordings are inserted into the current draft as plain text.`;
  }

  return `${providerLabel} is selected for speak-to-text, but it is not configured yet. Add its API key first.`;
};

export const resolveRecorderMimeType = (): string | undefined => {
  for (const candidate of RECORDING_MIME_CANDIDATES) {
    if (typeof MediaRecorder.isTypeSupported !== "function") {
      return candidate;
    }

    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }

  return undefined;
};

export const stopMediaStream = (stream: MediaStream | null): void => {
  stream?.getTracks().forEach((track) => {
    track.stop();
  });
};

const encodeWav = (samples: Float32Array, sampleRate: number): ArrayBuffer => {
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);

  const writeString = (offset: number, value: string): void => {
    for (const [index, character] of Array.from(value).entries()) {
      view.setUint8(offset + index, character.charCodeAt(0));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * bytesPerSample, true);

  let offset = 44;

  for (const sample of samples) {
    const normalizedSample = Math.max(-1, Math.min(1, sample));
    view.setInt16(
      offset,
      normalizedSample < 0
        ? normalizedSample * 0x8000
        : normalizedSample * 0x7fff,
      true,
    );
    offset += bytesPerSample;
  }

  return buffer;
};

const mixDownToMono = (audioBuffer: AudioBuffer): Float32Array => {
  if (audioBuffer.numberOfChannels === 1) {
    return audioBuffer.getChannelData(0);
  }

  const mixed = new Float32Array(audioBuffer.length);

  for (
    let channelIndex = 0;
    channelIndex < audioBuffer.numberOfChannels;
    channelIndex += 1
  ) {
    const channelData = audioBuffer.getChannelData(channelIndex);

    for (
      let sampleIndex = 0;
      sampleIndex < channelData.length;
      sampleIndex += 1
    ) {
      mixed[sampleIndex] +=
        channelData[sampleIndex] / audioBuffer.numberOfChannels;
    }
  }

  return mixed;
};

const convertBlobToWav = async (blob: Blob): Promise<Blob> => {
  if (typeof AudioContext === "undefined") {
    throw new Error(
      "This WebView cannot convert the recorded audio to WAV for the selected provider.",
    );
  }

  const audioContext = new AudioContext();

  try {
    const audioData = await blob.arrayBuffer();
    const decodedAudio = await audioContext.decodeAudioData(audioData.slice(0));
    const monoSamples = mixDownToMono(decodedAudio);
    const wavBuffer = encodeWav(monoSamples, decodedAudio.sampleRate);

    return new Blob([wavBuffer], { type: "audio/wav" });
  } finally {
    void audioContext.close().catch(() => undefined);
  }
};

export const prepareAudioBlob = async (
  blob: Blob,
  provider: UserSpeechToTextProvider,
): Promise<Blob> => {
  if (provider !== "google") {
    return blob;
  }

  const mimeType = normalizeAudioMimeType(blob.type);

  if (GOOGLE_SUPPORTED_MIME_TYPES.has(mimeType)) {
    return blob;
  }

  return convertBlobToWav(blob);
};

const isNoSpeechDetectedError = (error: unknown): boolean => {
  return (
    error instanceof Error && error.message === NO_SPEECH_DETECTED_MESSAGE
  );
};

export const assertRecordedSpeechDetected = async (
  blob: Blob,
): Promise<void> => {
  if (blob.size < MIN_RECORDED_AUDIO_BYTES) {
    throw new Error(NO_SPEECH_DETECTED_MESSAGE);
  }

  if (typeof AudioContext === "undefined") {
    return;
  }

  const audioContext = new AudioContext();

  try {
    const audioData = await blob.arrayBuffer();
    const decodedAudio = await audioContext.decodeAudioData(audioData.slice(0));

    if (decodedAudio.duration < MIN_RECORDED_AUDIO_DURATION_SECONDS) {
      throw new Error(NO_SPEECH_DETECTED_MESSAGE);
    }

    let peak = 0;
    let sampleCount = 0;
    let sumSquares = 0;

    for (
      let channelIndex = 0;
      channelIndex < decodedAudio.numberOfChannels;
      channelIndex += 1
    ) {
      const channelData = decodedAudio.getChannelData(channelIndex);

      for (const sample of channelData) {
        const absoluteSample = Math.abs(sample);

        peak = Math.max(peak, absoluteSample);
        sumSquares += sample * sample;
        sampleCount += 1;
      }
    }

    const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;

    if (
      rms < MIN_RECORDED_SPEECH_RMS &&
      peak < MIN_RECORDED_SPEECH_PEAK
    ) {
      throw new Error(NO_SPEECH_DETECTED_MESSAGE);
    }
  } catch (error) {
    if (isNoSpeechDetectedError(error)) {
      throw error;
    }
  } finally {
    void audioContext.close().catch(() => undefined);
  }
};

export const convertBlobToBase64 = async (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => {
      reject(reader.error ?? new Error("Failed to read the recorded audio."));
    };

    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Failed to read the recorded audio."));
        return;
      }

      const encoded = reader.result.split(",")[1]?.trim();

      if (!encoded) {
        reject(new Error("Failed to encode the recorded audio."));
        return;
      }

      resolve(encoded);
    };

    reader.readAsDataURL(blob);
  });
};

export const getRecordingErrorMessage = (error: unknown): string => {
  if (error instanceof DOMException) {
    switch (error.name) {
      case "NotAllowedError":
        return "Microphone access was denied. Allow microphone access and try again.";
      case "NotFoundError":
        return "No microphone was found for this device.";
      case "NotReadableError":
        return "The microphone is already in use by another app or could not be started.";
      case "OverconstrainedError":
        return "The requested microphone settings are not available on this device.";
      default:
        return error.message || "The microphone could not be started.";
    }
  }

  return error instanceof Error
    ? error.message
    : "The microphone could not be started.";
};

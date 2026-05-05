import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertRecordedSpeechDetected,
  NO_SPEECH_DETECTED_MESSAGE,
} from "./speech-audio";

const createAudioBuffer = (samples: Float32Array): AudioBuffer => {
  return {
    duration: 1,
    length: samples.length,
    numberOfChannels: 1,
    sampleRate: samples.length,
    getChannelData: () => samples,
  } as AudioBuffer;
};

const stubAudioContext = (audioBuffer: AudioBuffer): void => {
  class AudioContextMock {
    close = vi.fn(async () => undefined);

    decodeAudioData = vi.fn(async () => audioBuffer);
  }

  vi.stubGlobal("AudioContext", AudioContextMock);
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("speech audio helpers", () => {
  it("rejects empty recordings before transcription", async () => {
    await expect(
      assertRecordedSpeechDetected(new Blob([], { type: "audio/webm" })),
    ).rejects.toThrow(NO_SPEECH_DETECTED_MESSAGE);
  });

  it("rejects decoded recordings that contain only silence", async () => {
    stubAudioContext(createAudioBuffer(new Float32Array(48_000)));

    await expect(
      assertRecordedSpeechDetected(
        new Blob([new Uint8Array(2_048)], { type: "audio/webm" }),
      ),
    ).rejects.toThrow(NO_SPEECH_DETECTED_MESSAGE);
  });

  it("allows decoded recordings with meaningful speech energy", async () => {
    const samples = new Float32Array(48_000);

    samples.fill(0.05, 4_000, 12_000);
    stubAudioContext(createAudioBuffer(samples));

    await expect(
      assertRecordedSpeechDetected(
        new Blob([new Uint8Array(2_048)], { type: "audio/webm" }),
      ),
    ).resolves.toBeUndefined();
  });
});

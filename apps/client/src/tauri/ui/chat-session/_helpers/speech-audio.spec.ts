// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_SPEECH_DETECTED_MESSAGE, prepareAudioBlob } from "./speech-audio";
import { LOCAL_SPEECH_PROVIDERS } from "../../../../shared/local-speech";

const samples = new Float32Array(16_000).fill(0.1);
const decoded = {
  duration: 1,
  length: 16_000,
  sampleRate: 16_000,
  numberOfChannels: 1,
  getChannelData: () => samples,
};
const decode = vi.fn();
const close = vi.fn();

beforeEach(() => {
  decode.mockReset().mockResolvedValue(decoded);
  close.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal(
    "AudioContext",
    class {
      decodeAudioData = decode;
      close = close;
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("speech audio preparation", () => {
  const audio = () =>
    ({
      size: 1024,
      type: "audio/webm",
      arrayBuffer: async () => new ArrayBuffer(1024),
    }) as Blob;

  it.each(LOCAL_SPEECH_PROVIDERS)(
    "converts %s audio with a single decode",
    async (provider) => {
      const prepared = await prepareAudioBlob(audio(), provider);
      expect(decode).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(prepared.type).toBe("audio/wav");
      expect(prepared.size).toBe(44 + 16_000 * 2);
    },
  );

  it("resamples microphone audio to 16 kHz mono PCM", async () => {
    decode.mockResolvedValueOnce({
      ...decoded,
      sampleRate: 48_000,
      length: 48_000,
    });
    const createOffline = vi.fn();
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        destination = {};
        constructor(...args: unknown[]) {
          createOffline(...args);
        }
        createBufferSource = () => ({
          connect: vi.fn(),
          start: vi.fn(),
          buffer: null,
        });
        startRendering = async () => decoded;
      },
    );
    const prepared = await prepareAudioBlob(audio(), "whisper");
    expect(createOffline).toHaveBeenCalledWith(1, 16_000, 16_000);
    expect(prepared.size).toBe(44 + 16_000 * 2);
    expect(decode).toHaveBeenCalledOnce();
  });

  it("rejects silence before loading the Whisper model", async () => {
    decode.mockResolvedValueOnce({
      ...decoded,
      getChannelData: () => new Float32Array(16_000),
    });
    await expect(prepareAudioBlob(audio(), "whisper")).rejects.toThrow(
      NO_SPEECH_DETECTED_MESSAGE,
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports corrupt audio instead of continuing to inference", async () => {
    decode.mockRejectedValueOnce(new Error("Invalid audio"));
    await expect(prepareAudioBlob(audio(), "whisper")).rejects.toThrow(
      "Invalid audio",
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("cancels a stalled audio decoder", async () => {
    decode.mockImplementationOnce(() => new Promise(() => {}));
    const controller = new AbortController();
    const prepared = prepareAudioBlob(audio(), "whisper", controller.signal);
    const rejected = expect(prepared).rejects.toMatchObject({
      name: "AbortError",
    });
    await Promise.resolve();
    controller.abort();
    await rejected;
    expect(close).toHaveBeenCalled();
  });
});

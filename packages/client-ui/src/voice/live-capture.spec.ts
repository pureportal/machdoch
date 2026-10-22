import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { encodeVoicePcm, voiceProcessorSource } from "./live-capture";

type WorkletMessage =
  | { kind: "speech-start" | "speech-end" }
  | { kind: "audio"; audio: Float32Array };

interface WorkletProcessor {
  process(inputs: Float32Array[][]): boolean;
}

function createWorklet(sampleRate: number) {
  const messages: WorkletMessage[] = [];
  const registered: { processor?: WorkletProcessor } = {};
  const registerProcessor = vi.fn(
    (_name: string, Processor: new () => WorkletProcessor) => {
      registered.processor = new Processor();
    },
  );
  class MockAudioWorkletProcessor {
    port = { postMessage: (message: WorkletMessage) => messages.push(message) };
  }

  runInNewContext(voiceProcessorSource, {
    sampleRate,
    AudioWorkletProcessor: MockAudioWorkletProcessor,
    registerProcessor,
  });

  if (!registered.processor)
    throw new Error("The voice processor was not registered");
  const capture = registered.processor;
  const frameLength = 128;
  return {
    messages,
    registerProcessor,
    processor: capture,
    frameLength,
    framesFor: (seconds: number) =>
      Math.ceil((sampleRate * seconds) / frameLength),
    feedFrames(value: number, count: number): void {
      for (let index = 0; index < count; index++) {
        capture.process([[new Float32Array(frameLength).fill(value)]]);
      }
    },
  };
}

function audioSamples(messages: WorkletMessage[]): number[] {
  return messages.flatMap((message) =>
    message.kind === "audio" ? Array.from(message.audio) : [],
  );
}

describe("encodeVoicePcm", () => {
  it("clips and rounds float samples into signed little-endian PCM16", () => {
    const encoded = encodeVoicePcm(
      new Float32Array([
        -2,
        -1,
        -0.5,
        -1 / 32768,
        0,
        1 / 32767,
        0.5,
        1,
        2,
        0.1,
        -0.1,
      ]),
    );

    expect(
      Array.from(atob(encoded), (character) => character.charCodeAt(0)),
    ).toEqual([
      0x00, 0x80, 0x00, 0x80, 0x00, 0xc0, 0xff, 0xff, 0x00, 0x00, 0x01, 0x00,
      0x00, 0x40, 0xff, 0x7f, 0xff, 0x7f, 0xcd, 0x0c, 0x33, 0xf3,
    ]);
  });

  it("encodes an empty frame as an empty string", () => {
    expect(encodeVoicePcm(new Float32Array())).toBe("");
  });
});

describe.each([16000, 24000])("voice worklet at %i Hz", (sampleRate) => {
  it("registers the processor and tolerates missing input without messages", () => {
    const { processor, messages, registerProcessor } =
      createWorklet(sampleRate);

    expect(registerProcessor).toHaveBeenCalledExactlyOnceWith(
      "machdoch-live-voice",
      expect.any(Function),
    );
    expect(processor.process([])).toBe(true);
    expect(processor.process([[]])).toBe(true);
    expect(messages).toEqual([]);
  });

  it("sends no audio or speech events for sustained silence", () => {
    const { messages, feedFrames, framesFor } = createWorklet(sampleRate);

    feedFrames(0, framesFor(2));
    feedFrames(0.001, framesFor(2));

    expect(messages).toEqual([]);
  });

  it("preserves leading audio and sends speech-start before the first audio frame", () => {
    const { messages, processor, feedFrames, framesFor, frameLength } =
      createWorklet(sampleRate);
    feedFrames(0.001, framesFor(0.5));
    const expectedSpeech: number[] = [];
    const onsetFrames = framesFor(0.08);

    for (let index = 0; index < onsetFrames; index++) {
      const frame = new Float32Array(frameLength).fill(0.1 + index * 0.001);
      expectedSpeech.push(...frame);
      expect(processor.process([[frame]])).toBe(true);
      frame.fill(0);
      if (index < onsetFrames - 1) expect(messages).toEqual([]);
    }

    expect(messages.map((message) => message.kind)).toEqual([
      "speech-start",
      "audio",
    ]);
    const audio = audioSamples(messages);
    expect(audio.slice(-expectedSpeech.length)).toEqual(expectedSpeech);
    const leadingAudio = audio.slice(0, -expectedSpeech.length);
    expect(leadingAudio.length).toBeGreaterThan(0);
    expect(leadingAudio.every((sample) => sample === Math.fround(0.001))).toBe(
      true,
    );
    expect(audio.length).toBeLessThanOrEqual(sampleRate * 0.25 + frameLength);
  });

  it("ends speech after sustained silence and flushes audio before speech-end", () => {
    const { messages, feedFrames, framesFor, frameLength } =
      createWorklet(sampleRate);
    const speechFrames = framesFor(0.16);
    const silenceFrames = framesFor(0.7);
    feedFrames(0.2, speechFrames);

    expect(messages[0]?.kind).toBe("speech-start");
    feedFrames(0, silenceFrames - 1);
    expect(messages.some((message) => message.kind === "speech-end")).toBe(
      false,
    );

    feedFrames(0, 1);

    expect(
      messages.filter((message) => message.kind === "speech-end"),
    ).toHaveLength(1);
    expect(messages.at(-1)?.kind).toBe("speech-end");
    expect(messages.at(-2)?.kind).toBe("audio");
    const audio = audioSamples(messages);
    expect(audio).toHaveLength((speechFrames + silenceFrames) * frameLength);
    expect(
      audio.slice(speechFrames * frameLength).every((sample) => sample === 0),
    ).toBe(true);

    const messageCount = messages.length;
    feedFrames(0, framesFor(1));
    expect(messages).toHaveLength(messageCount);
  });

  it("bounds continuous speech segments to 25 seconds and starts subsequent segments", () => {
    const { messages, feedFrames, framesFor } = createWorklet(sampleRate);
    feedFrames(0.2, framesFor(51));

    let active = false;
    let segmentSamples = 0;
    const completedSegments: number[] = [];
    for (const message of messages) {
      if (message.kind === "speech-start") {
        expect(active).toBe(false);
        active = true;
        segmentSamples = 0;
      } else if (message.kind === "audio") {
        expect(active).toBe(true);
        segmentSamples += message.audio.length;
      } else {
        expect(active).toBe(true);
        completedSegments.push(segmentSamples);
        active = false;
      }
    }

    expect(completedSegments).toHaveLength(2);
    for (const length of completedSegments) {
      expect(length).toBeGreaterThanOrEqual(sampleRate * 24.9);
      expect(length).toBeLessThanOrEqual(sampleRate * 25);
    }
    expect(
      messages.filter((message) => message.kind === "speech-start"),
    ).toHaveLength(3);
    expect(active).toBe(true);
    expect(segmentSamples).toBeGreaterThan(0);
  });
});

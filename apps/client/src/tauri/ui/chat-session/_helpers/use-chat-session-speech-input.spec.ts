// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  UserSpeechToTextProvider,
  UserSpeechToTextSettings,
} from "../../runtime";
import { LOCAL_SPEECH_PROVIDERS } from "../../../../shared/local-speech";
import { useChatSessionSpeechInput } from "./use-chat-session-speech-input";

const mocks = vi.hoisted(() => ({
  recorder: {
    browserSupported: true,
    recording: false,
    level: 0,
    levelTick: 0,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    cancelRecording: vi.fn(),
  },
  transcribe: vi.fn(),
  prepare: vi.fn(),
  process: vi.fn(),
  encode: vi.fn(),
}));

vi.mock("./use-speech-recorder", () => ({
  useSpeechRecorder: () => mocks.recorder,
}));
vi.mock("../../runtime", () => ({
  transcribeUserSpeechAudio: mocks.transcribe,
}));
vi.mock("../../speech-text-processing", () => ({
  processUserSpeechText: mocks.process,
}));
vi.mock("./speech-audio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./speech-audio")>()),
  prepareAudioBlob: mocks.prepare,
  convertBlobToBase64: mocks.encode,
}));

const settings: UserSpeechToTextSettings = {
  activeProvider: "whisper",
  inputDeviceId: null,
  keyTerms: [],
  speechContext: "",
  autoTranslateToEnglish: false,
  autoFormat: false,
  providerAvailability: [{ provider: "whisper", configured: true }],
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.recorder.recording = false;
  mocks.recorder.startRecording.mockResolvedValue(true);
  mocks.recorder.stopRecording.mockResolvedValue(new Blob(["audio"]));
  mocks.prepare.mockResolvedValue(new Blob(["wav"], { type: "audio/wav" }));
  mocks.transcribe.mockResolvedValue({ text: "Open the file." });
  mocks.process.mockResolvedValue("Edited text.");
  mocks.encode.mockResolvedValue("audio");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("speech input cancellation", () => {
  const setup = (
    autoFormat = false,
    provider: UserSpeechToTextProvider = "whisper",
  ) => {
    const onTranscript = vi.fn();
    const hook = renderHook(() =>
      useChatSessionSpeechInput({
        activeSessionId: "session",
        settings: {
          ...settings,
          activeProvider: provider,
          providerAvailability: [{ provider, configured: true }],
          autoFormat,
        },
        onTranscript,
      }),
    );
    const start = async () => {
      act(() => hook.result.current.toggleRecording());
      await waitFor(() => expect(hook.result.current.starting).toBe(false));
      mocks.recorder.recording = true;
      hook.rerender();
    };
    const cancel = () => {
      mocks.recorder.recording = false;
      act(() => hook.result.current.cancelSpeechInput());
      expect(hook.result.current.starting).toBe(false);
      expect(hook.result.current.transcribing).toBe(false);
      expect(hook.result.current.recording).toBe(false);
      expect(hook.result.current.statusText).toBeNull();
    };
    return { ...hook, start, cancel, onTranscript };
  };

  it("reports a failed remote recording request without claiming recording started", async () => {
    mocks.recorder.startRecording.mockResolvedValueOnce(false);
    const hook = setup();
    await act(async () => {
      await expect(hook.result.current.setRecording(true)).rejects.toThrow(
        "could not start",
      );
    });
    expect(hook.result.current.recording).toBe(false);
    expect(hook.onTranscript).not.toHaveBeenCalled();
  });

  it("rejects a second recording command while the microphone request is pending", async () => {
    const pending = deferred<boolean>();
    mocks.recorder.startRecording.mockReturnValueOnce(pending.promise);
    const hook = setup();
    let started!: Promise<void>;
    act(() => {
      started = hook.result.current.setRecording(true);
    });
    await expect(hook.result.current.setRecording(true)).rejects.toThrow(
      "busy",
    );
    await act(async () => {
      pending.resolve(true);
      await started;
    });
    expect(mocks.recorder.startRecording).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending microphone request", async () => {
    const pending = deferred<boolean>();
    mocks.recorder.startRecording.mockReturnValueOnce(pending.promise);
    const hook = setup();
    act(() => hook.result.current.toggleRecording());
    expect(hook.result.current.starting).toBe(true);
    hook.cancel();
    await act(async () => pending.resolve(true));
    expect(hook.result.current.statusText).toBeNull();
    expect(mocks.recorder.cancelRecording).toHaveBeenCalled();
  });

  it("discards a recording without starting transcription", async () => {
    const hook = setup();
    await hook.start();
    hook.cancel();
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(hook.onTranscript).not.toHaveBeenCalled();
  });

  it("cancels audio preparation before native inference starts", async () => {
    const preparation = deferred<Blob>();
    mocks.prepare.mockReturnValueOnce(preparation.promise);
    const hook = setup();
    await hook.start();
    act(() => hook.result.current.toggleRecording());
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalled());
    hook.cancel();
    await act(async () => preparation.resolve(new Blob(["wav"])));
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(hook.onTranscript).not.toHaveBeenCalled();
  });

  it("discards audio that arrives after cancelling a pending stop", async () => {
    const stopped = deferred<Blob>();
    mocks.recorder.stopRecording.mockReturnValueOnce(stopped.promise);
    const hook = setup();
    await hook.start();
    act(() => hook.result.current.toggleRecording());
    expect(hook.result.current.transcribing).toBe(true);
    hook.cancel();
    await act(async () => stopped.resolve(new Blob(["old audio"])));
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(hook.onTranscript).not.toHaveBeenCalled();
  });

  it("returns to the normal view when audio preparation stalls", async () => {
    mocks.prepare.mockImplementationOnce(() => new Promise(() => {}));
    const hook = setup();
    await hook.start();
    vi.useFakeTimers();
    await act(async () => hook.result.current.toggleRecording());
    expect(hook.result.current.transcribing).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(hook.result.current.transcribing).toBe(false);
    expect(hook.result.current.statusText).toContain(
      "Audio preparation timed out",
    );
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(hook.onTranscript).not.toHaveBeenCalled();
  });

  it.each(LOCAL_SPEECH_PROVIDERS)(
    "returns to the normal view when %s stops responding",
    async (provider) => {
      mocks.transcribe.mockImplementationOnce(() => new Promise(() => {}));
      const hook = setup(false, provider);
      await hook.start();
      vi.useFakeTimers();
      await act(async () => hook.result.current.toggleRecording());
      expect(mocks.transcribe).toHaveBeenCalledOnce();
      const signal = mocks.transcribe.mock.calls[0]?.[0].signal as AbortSignal;
      await act(async () => vi.advanceTimersByTimeAsync(40_000));
      expect(signal.aborted).toBe(false);
      expect(hook.result.current.transcribing).toBe(true);
      await act(async () =>
        vi.advanceTimersByTimeAsync(provider === "phonon2" ? 266_000 : 56_000),
      );
      expect(signal.aborted).toBe(true);
      expect(hook.result.current.transcribing).toBe(false);
      expect(hook.result.current.statusText).toContain(
        "Speech transcription timed out",
      );
      expect(hook.onTranscript).not.toHaveBeenCalled();
    },
  );

  it("aborts inference and permits another recording immediately", async () => {
    const pending = deferred<{ text: string }>();
    mocks.transcribe.mockReturnValueOnce(pending.promise);
    const hook = setup();
    await hook.start();
    act(() => hook.result.current.toggleRecording());
    await waitFor(() => expect(mocks.transcribe).toHaveBeenCalledOnce());
    const signal = mocks.transcribe.mock.calls[0]?.[0].signal as AbortSignal;
    hook.cancel();
    expect(signal.aborted).toBe(true);
    await hook.start();
    act(() => hook.result.current.toggleRecording());
    await waitFor(() =>
      expect(hook.onTranscript).toHaveBeenCalledWith(
        "session",
        "Open the file.",
      ),
    );
    await act(async () => pending.resolve({ text: "Cancelled text." }));
    expect(hook.onTranscript).toHaveBeenCalledTimes(1);
  });

  it("discards late text processing results", async () => {
    const processing = deferred<string>();
    mocks.process.mockReturnValueOnce(processing.promise);
    const hook = setup(true, "google");
    await hook.start();
    act(() => hook.result.current.toggleRecording());
    await waitFor(() => expect(mocks.process).toHaveBeenCalledOnce());
    const signal = mocks.process.mock.calls[0]?.[0].signal as AbortSignal;
    hook.cancel();
    expect(signal.aborted).toBe(true);
    await act(async () => processing.resolve("Cancelled edits."));
    expect(hook.onTranscript).not.toHaveBeenCalled();
  });

  it.each([
    { provider: "phonon2" as const, nextProvider: "whistle" as const },
    { provider: "whisper" as const, nextProvider: "phonon2" as const },
  ])(
    "retains $provider settings when the model changes during recording",
    async ({ provider, nextProvider }) => {
      const onTranscript = vi.fn();
      const initialSpeechSettings: UserSpeechToTextSettings = {
        ...settings,
        activeProvider: provider,
        keyTerms: ["country"],
        providerAvailability: [{ provider, configured: true }],
      };
      const hook = renderHook(
        ({ speechSettings }: { speechSettings: UserSpeechToTextSettings }) =>
          useChatSessionSpeechInput({
            activeSessionId: "session",
            settings: speechSettings,
            onTranscript,
          }),
        {
          initialProps: {
            speechSettings: initialSpeechSettings,
          },
        },
      );
      act(() => hook.result.current.toggleRecording());
      await waitFor(() => expect(hook.result.current.starting).toBe(false));
      mocks.recorder.recording = true;
      hook.rerender({
        speechSettings: {
          ...settings,
          activeProvider: nextProvider,
          keyTerms: Array.from({ length: 100 }, (_, index) => `term${index}`),
          autoTranslateToEnglish: true,
          autoFormat: true,
          providerAvailability: [{ provider: nextProvider, configured: true }],
        },
      });
      act(() => hook.result.current.toggleRecording());
      await waitFor(() =>
        expect(onTranscript).toHaveBeenCalledWith("session", "Open the file."),
      );
      expect(mocks.transcribe).toHaveBeenCalledWith(
        expect.objectContaining({
          provider,
          keyTerms: ["country"],
          autoTranslateToEnglish: false,
        }),
      );
      expect(mocks.process).not.toHaveBeenCalled();
    },
  );

  it.each(LOCAL_SPEECH_PROVIDERS)(
    "adds %s transcripts without cloud processing",
    async (provider) => {
      const hook = setup(true, provider);
      await hook.start();
      act(() => hook.result.current.toggleRecording());
      await waitFor(() =>
        expect(hook.onTranscript).toHaveBeenCalledWith(
          "session",
          "Open the file.",
        ),
      );
      expect(mocks.process).not.toHaveBeenCalled();
      expect(mocks.transcribe).toHaveBeenCalledWith(
        expect.objectContaining({
          provider,
          speechContext: "",
          autoTranslateToEnglish: false,
        }),
      );
    },
  );
});

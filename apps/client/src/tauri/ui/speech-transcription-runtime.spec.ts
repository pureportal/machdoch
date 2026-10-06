import { beforeEach, describe, expect, it, vi } from "vitest";
import { transcribeUserSpeechAudio } from "./runtime";
import { LOCAL_SPEECH_PROVIDERS } from "../../shared/local-speech";

const native = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock("@tauri-apps/api/core", () => native);

const options = {
  provider: "whisper" as const,
  audioBase64: "audio",
  mimeType: "audio/wav",
  keyTerms: [],
  speechContext: "",
  autoTranslateToEnglish: false,
};
beforeEach(() =>
  native.invoke.mockReset().mockResolvedValue({ text: "Transcript" }),
);

describe("speech transcription requests", () => {
  it.each(LOCAL_SPEECH_PROVIDERS)(
    "registers and releases %s requests",
    async (provider) => {
      await transcribeUserSpeechAudio({ ...options, provider });
      expect(native.invoke.mock.calls.map(([command]) => command)).toEqual([
        "begin_user_speech_transcription",
        "transcribe_user_speech_audio",
        "cancel_user_speech_transcription",
      ]);
      const requestId = native.invoke.mock.calls[0]?.[1].requestId;
      expect(native.invoke.mock.calls[1]?.[1].requestId).toBe(requestId);
      expect(native.invoke.mock.calls[2]?.[1].requestId).toBe(requestId);
    },
  );

  it("handles cancellation while registration is pending without starting inference", async () => {
    let register!: () => void;
    native.invoke.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          register = resolve;
        }),
    );
    const controller = new AbortController();
    const transcription = transcribeUserSpeechAudio({
      ...options,
      signal: controller.signal,
    });
    const rejection = expect(transcription).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    register();
    await rejection;
    expect(native.invoke.mock.calls.map(([command]) => command)).toEqual([
      "begin_user_speech_transcription",
      "cancel_user_speech_transcription",
    ]);
  });

  it("sends cancellation to an active inference request", async () => {
    let rejectInference!: (error: string) => void;
    native.invoke.mockImplementation((command: string) =>
      command === "transcribe_user_speech_audio"
        ? new Promise((_resolve, reject) => {
            rejectInference = reject;
          })
        : Promise.resolve(),
    );
    const controller = new AbortController();
    const transcription = transcribeUserSpeechAudio({
      ...options,
      signal: controller.signal,
    });
    const rejection = expect(transcription).rejects.toThrow("cancelled");
    await Promise.resolve();
    controller.abort();
    expect(native.invoke).toHaveBeenCalledWith(
      "cancel_user_speech_transcription",
      expect.objectContaining({ requestId: expect.any(String) }),
    );
    rejectInference("Speech transcription was cancelled.");
    await rejection;
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { runInternalDesktopTask } from "./internal-task-model";
import { processUserSpeechText } from "./speech-text-processing";
import type { UserSpeechToTextProvider } from "./runtime";
import { LOCAL_SPEECH_PROVIDERS } from "../../shared/local-speech";

const cancelTask = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("./runtime", () => ({ cancelDesktopTask: cancelTask }));

vi.mock("./internal-task-model", () => ({
  runInternalDesktopTask: vi.fn(),
}));

const runTask = vi.mocked(runInternalDesktopTask);

beforeEach(() => {
  runTask.mockReset();
  runTask.mockResolvedValue({
    execution: {
      status: "executed",
      summary: "Done.",
      response: {
        markdown:
          "<machdoch_speech_text>\n- Update the README.\n- Run the tests.\n</machdoch_speech_text>",
      },
    },
  } as Awaited<ReturnType<typeof runInternalDesktopTask>>);
});

describe("speech text processing", () => {
  it.each<UserSpeechToTextProvider>(["openai", "google"])(
    "uses the internal task model to format %s transcripts",
    async (provider) => {
      const text = await processUserSpeechText({
        provider,
        text: "update readme and run tests",
        autoTranslateToEnglish: false,
        autoFormat: true,
      });

      expect(text).toBe("- Update the README.\n- Run the tests.");
      expect(runTask).toHaveBeenCalledOnce();
      expect(runTask).toHaveBeenCalledWith(
        null,
        expect.stringContaining(
          "Organize distinct requested changes as a Markdown list",
        ),
        { mode: "ask", taskId: expect.any(String) },
        expect.any(AbortSignal),
      );
    },
  );

  it("uses the internal task model to translate cloud transcripts", async () => {
    await processUserSpeechText({
      provider: "google",
      text: "Datei öffnen",
      autoTranslateToEnglish: true,
      autoFormat: false,
    });

    expect(runTask).toHaveBeenCalledWith(
      null,
      expect.stringContaining(
        "Translate non-English speech into natural English",
      ),
      { mode: "ask", taskId: expect.any(String) },
      expect.any(AbortSignal),
    );
  });

  it.each(LOCAL_SPEECH_PROVIDERS)(
    "keeps %s transcripts local with processing enabled",
    async (provider) => {
      await expect(
        processUserSpeechText({
          provider,
          text: "Open the file.",
          autoTranslateToEnglish: true,
          autoFormat: true,
        }),
      ).resolves.toBe("Open the file.");

      expect(runTask).not.toHaveBeenCalled();
    },
  );

  it("rejects a response without edited text", async () => {
    runTask.mockResolvedValueOnce({
      execution: { status: "executed", summary: "Done." },
    } as Awaited<ReturnType<typeof runInternalDesktopTask>>);

    await expect(
      processUserSpeechText({
        provider: "google",
        text: "open the file",
        autoTranslateToEnglish: false,
        autoFormat: true,
      }),
    ).rejects.toThrow("Text processing did not return an edited transcript.");
  });

  it("cancels pending text processing and its desktop task", async () => {
    runTask.mockImplementationOnce(() => new Promise(() => {}));
    const controller = new AbortController();
    const processing = processUserSpeechText({
      provider: "google",
      text: "open file",
      autoTranslateToEnglish: false,
      autoFormat: true,
      signal: controller.signal,
    });
    const rejection = expect(processing).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await rejection;
    expect(cancelTask).toHaveBeenCalledWith(runTask.mock.calls[0]?.[2]?.taskId);
  });

  it("does not start processing after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      processUserSpeechText({
        provider: "google",
        text: "open file",
        autoTranslateToEnglish: false,
        autoFormat: true,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(runTask).not.toHaveBeenCalled();
  });

  it("reports a stalled processing task instead of waiting forever", async () => {
    vi.useFakeTimers();
    try {
      runTask.mockImplementationOnce(() => new Promise(() => {}));
      const processing = processUserSpeechText({
        provider: "google",
        text: "open file",
        autoTranslateToEnglish: false,
        autoFormat: true,
      });
      const rejection = expect(processing).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(120_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});

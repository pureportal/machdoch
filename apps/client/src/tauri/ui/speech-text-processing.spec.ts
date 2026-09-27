import { beforeEach, describe, expect, it, vi } from "vitest";
import { runInternalDesktopTask } from "./internal-task-model";
import { processUserSpeechText } from "./speech-text-processing";
import type { UserSpeechToTextProvider } from "./runtime";

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
  it.each<UserSpeechToTextProvider>(["openai", "google", "whisper"])(
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
        { mode: "ask" },
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
      { mode: "ask" },
    );
  });

  it("keeps Whisper's local translation without a second model request", async () => {
    await expect(
      processUserSpeechText({
        provider: "whisper",
        text: "Open the file.",
        autoTranslateToEnglish: true,
        autoFormat: false,
      }),
    ).resolves.toBe("Open the file.");

    expect(runTask).not.toHaveBeenCalled();
  });

  it("rejects a response without edited text", async () => {
    runTask.mockResolvedValueOnce({
      execution: { status: "executed", summary: "Done." },
    } as Awaited<ReturnType<typeof runInternalDesktopTask>>);

    await expect(
      processUserSpeechText({
        provider: "whisper",
        text: "open the file",
        autoTranslateToEnglish: false,
        autoFormat: true,
      }),
    ).rejects.toThrow("Text processing did not return an edited transcript.");
  });
});

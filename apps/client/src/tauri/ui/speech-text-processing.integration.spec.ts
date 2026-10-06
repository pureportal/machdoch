import { beforeEach, describe, expect, it, vi } from "vitest";
import { processUserSpeechText } from "./speech-text-processing";

const runtime = vi.hoisted(() => ({
  loadGlobalProviderAvailability: vi.fn(),
  loadProviderModelCatalog: vi.fn(),
  loadUserInternalTaskModelSettings: vi.fn(),
  runDesktopTask: vi.fn(),
  saveUserInternalTaskModelSettings: vi.fn(),
}));

vi.mock("./runtime", () => runtime);

beforeEach(() => {
  vi.clearAllMocks();
  runtime.loadUserInternalTaskModelSettings.mockResolvedValue({
    provider: "anthropic",
    model: "claude-sonnet-5",
    reasoning: "high",
  });
  runtime.loadGlobalProviderAvailability.mockResolvedValue([
    { provider: "anthropic", configured: true },
  ]);
  runtime.loadProviderModelCatalog.mockResolvedValue({
    generatedAt: 1,
    providers: [
      {
        provider: "anthropic",
        available: true,
        models: [{ id: "claude-sonnet-5", label: "Claude Sonnet 5" }],
      },
    ],
  });
  runtime.runDesktopTask.mockResolvedValue({
    execution: {
      status: "executed",
      response: {
        markdown: "<machdoch_speech_text>Open the file.</machdoch_speech_text>",
      },
    },
  });
});

describe("speech text processing with the internal task model", () => {
  it("improves a cloud transcript with the configured model", async () => {
    await expect(
      processUserSpeechText({
        provider: "google",
        text: "open file",
        autoTranslateToEnglish: false,
        autoFormat: true,
      }),
    ).resolves.toBe("Open the file.");

    expect(runtime.runDesktopTask).toHaveBeenCalledWith(
      null,
      expect.stringContaining('Transcript: "open file"'),
      {
        mode: "ask",
        provider: "anthropic",
        model: "claude-sonnet-5",
        reasoning: "high",
        taskId: expect.any(String),
      },
    );
  });
});

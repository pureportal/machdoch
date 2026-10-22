import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { speechEditingPrompt } from "../shared/speech-text.js";
import { runLiveVoiceRequest } from "./live-voice.js";
import type { RuntimeConfig } from "./runtime-contract.generated.js";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetch>(),
  loadUserConfigFile: vi.fn(),
  loadRuntimeEnvironment: vi.fn(),
  loadRuntimeConfig: vi.fn(),
  executeInternalTaskModelInference: vi.fn(),
}));

vi.mock("./env.js", () => ({
  loadUserConfigFile: mocks.loadUserConfigFile,
  loadRuntimeEnvironment: mocks.loadRuntimeEnvironment,
}));
vi.mock("./config.js", () => ({
  loadRuntimeConfig: mocks.loadRuntimeConfig,
}));
vi.mock("./internal-task-model.js", () => ({
  executeInternalTaskModelInference: mocks.executeInternalTaskModelInference,
}));

const workspaceRoot = "C:/workspace";
const now = Date.parse("2026-10-22T12:00:00.000Z");
const openaiKey = "test-openai-durable-secret";
const googleKey = "test-google-durable-secret";
const speech = {
  activeProvider: "openai",
  autoFormat: false,
  autoTranslateToEnglish: false,
  keyTerms: ["Machdoch", "Vitest"],
  speechContext: "Discuss changes to the workspace.",
};
const runtime: RuntimeConfig = {
  workspaceRoot,
  mode: "machdoch",
  provider: "openai",
  model: "gpt-primary",
  reasoning: "default",
  contextWindow: "default",
  offline: false,
  compatibility: { discoverGithubCustomizations: false },
  providerAvailability: [
    { provider: "openai", configured: true },
    { provider: "anthropic", configured: true },
  ],
  webSearch: { activeProvider: "none", providerAvailability: [] },
  reviewModel: { mode: "base" },
  internalTaskModel: {
    provider: "anthropic",
    model: "claude-internal",
    reasoning: "low",
  },
};

describe("runLiveVoiceRequest", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", mocks.fetch);
    vi.spyOn(Date, "now").mockReturnValue(now);
    mocks.fetch.mockRejectedValue(new Error("Unexpected fetch call."));
    mocks.loadUserConfigFile.mockResolvedValue({
      config: { speechToText: { ...speech } },
    });
    mocks.loadRuntimeEnvironment.mockResolvedValue({
      OPENAI_API_KEY: openaiKey,
      GOOGLE_API_KEY: googleKey,
    });
    mocks.loadRuntimeConfig.mockResolvedValue(runtime);
    mocks.executeInternalTaskModelInference.mockResolvedValue({
      text: "<machdoch_speech_text>Edited transcript.</machdoch_speech_text>",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns only OpenAI ephemeral credentials and requests a 60-second transcription session", async () => {
    const expiresAt = now + 60_000;
    mocks.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          value: "test-openai-ephemeral-token",
          expires_at: expiresAt / 1000,
          api_key: openaiKey,
          session: { api_key: openaiKey },
        }),
      ),
    );

    const result = await runLiveVoiceRequest(workspaceRoot, {
      action: "session",
    });

    expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(
      "https://api.openai.com/v1/realtime/client_secrets",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + openaiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expires_after: { anchor: "created_at", seconds: 60 },
          session: {
            type: "transcription",
            audio: {
              input: {
                format: { type: "audio/pcm", rate: 24000 },
                transcription: {
                  model: "gpt-live-transcribe",
                  keywords: speech.keyTerms,
                  prompt: speech.speechContext,
                },
                turn_detection: null,
              },
            },
          },
        }),
        signal: expect.any(AbortSignal),
        redirect: "error",
      },
    );
    expect(result).toEqual({
      provider: "openai",
      token: "test-openai-ephemeral-token",
      expiresAt,
      sampleRate: 24000,
    });
    expect(JSON.stringify(result)).not.toContain(openaiKey);
    expect(JSON.stringify(result)).not.toContain(googleKey);
    expect(mocks.loadRuntimeEnvironment).toHaveBeenCalledTimes(1);
    expect(mocks.loadRuntimeConfig).not.toHaveBeenCalled();
    expect(mocks.executeInternalTaskModelInference).not.toHaveBeenCalled();
  });

  it("requests single-use Google authorization scoped to the returned live setup", async () => {
    mocks.loadUserConfigFile.mockResolvedValue({
      config: { speechToText: { ...speech, activeProvider: "google" } },
    });
    mocks.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          name: "auth_tokens/test-google-ephemeral-token",
          api_key: googleKey,
        }),
      ),
    );
    const expiresAt = now + 30 * 60_000;
    const setup = {
      model: "models/gemini-3.5-transcribe-live",
      generationConfig: { responseModalities: ["TEXT"] },
      inputAudioTranscription: { customVocabulary: speech.keyTerms },
      realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
    };

    const result = await runLiveVoiceRequest(workspaceRoot, {
      action: "session",
    });

    expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(
      "https://generativelanguage.googleapis.com/v1beta/auth_tokens",
      {
        method: "POST",
        headers: {
          "x-goog-api-key": googleKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          uses: 1,
          expireTime: new Date(expiresAt).toISOString(),
          newSessionExpireTime: new Date(now + 60_000).toISOString(),
          bidiGenerateContentSetup: setup,
        }),
        signal: expect.any(AbortSignal),
        redirect: "error",
      },
    );
    expect(result).toEqual({
      provider: "google",
      token: "auth_tokens/test-google-ephemeral-token",
      expiresAt,
      sampleRate: 16000,
      setup,
    });
    expect(JSON.stringify(result)).not.toContain(googleKey);
    expect(JSON.stringify(result)).not.toContain(openaiKey);
    expect(mocks.loadRuntimeEnvironment).toHaveBeenCalledTimes(1);
    expect(mocks.loadRuntimeConfig).not.toHaveBeenCalled();
    expect(mocks.executeInternalTaskModelInference).not.toHaveBeenCalled();
  });

  it.each(["anthropic", "groq", "none", undefined])(
    "rejects unsupported or unset speech provider %s explicitly",
    async (activeProvider) => {
      mocks.loadUserConfigFile.mockResolvedValue({
        config: { speechToText: { activeProvider } },
      });

      await expect(
        runLiveVoiceRequest(workspaceRoot, { action: "session" }),
      ).rejects.toThrow(
        "Select OpenAI or Google speech input in Settings to use live voice.",
      );
      await expect(
        runLiveVoiceRequest(workspaceRoot, {
          action: "process",
          text: "Keep this transcript.",
        }),
      ).rejects.toThrow(
        "Select OpenAI or Google speech input in Settings to use live voice.",
      );
      expect(mocks.loadRuntimeEnvironment).not.toHaveBeenCalled();
      expect(mocks.loadRuntimeConfig).not.toHaveBeenCalled();
      expect(mocks.executeInternalTaskModelInference).not.toHaveBeenCalled();
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      provider: "openai",
      name: "OpenAI",
      environment: { GOOGLE_API_KEY: googleKey },
    },
    {
      provider: "google",
      name: "Google",
      environment: { OPENAI_API_KEY: openaiKey },
    },
  ])(
    "requires the selected $name API key",
    async ({ provider, name, environment }) => {
      mocks.loadUserConfigFile.mockResolvedValue({
        config: { speechToText: { ...speech, activeProvider: provider } },
      });
      mocks.loadRuntimeEnvironment.mockResolvedValue(environment);

      await expect(
        runLiveVoiceRequest(workspaceRoot, { action: "session" }),
      ).rejects.toThrow(
        "Configure the " +
          name +
          " API key in Settings before starting live voice.",
      );
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { autoFormat: true, autoTranslateToEnglish: false },
    { autoFormat: false, autoTranslateToEnglish: true },
    { autoFormat: true, autoTranslateToEnglish: true },
  ])(
    "processes speech with the configured internal model and shared options %j",
    async (options) => {
      const transcript =
        "Bitte korrigiere die Datei. Keep src/main.ts unchanged.";
      mocks.loadUserConfigFile.mockResolvedValue({
        config: { speechToText: { ...speech, ...options } },
      });
      mocks.loadRuntimeEnvironment.mockResolvedValue({});
      mocks.executeInternalTaskModelInference.mockResolvedValue({
        text: "Edited:\n<machdoch_speech_text>\nCorrect the file. Keep src/main.ts unchanged.\n</machdoch_speech_text>\nDone.",
      });

      const result = await runLiveVoiceRequest(workspaceRoot, {
        action: "process",
        text: "  " + transcript + "\n",
      });

      expect(mocks.loadRuntimeConfig).toHaveBeenCalledExactlyOnceWith(
        workspaceRoot,
      );
      expect(
        mocks.executeInternalTaskModelInference,
      ).toHaveBeenCalledExactlyOnceWith(runtime, {
        systemPrompt: speechEditingPrompt(transcript, options),
        userPrompt: "Return the edited transcript.",
        signal: expect.any(AbortSignal),
      });
      expect(result).toEqual({
        text: "Correct the file. Keep src/main.ts unchanged.",
      });
      expect(mocks.loadRuntimeEnvironment).not.toHaveBeenCalled();
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );

  it.each([{ autoFormat: false, autoTranslateToEnglish: false }, {}])(
    "bypasses transcript editing when both flags are disabled or absent: %j",
    async (options) => {
      mocks.loadUserConfigFile.mockResolvedValue({
        config: { speechToText: { activeProvider: "google", ...options } },
      });

      await expect(
        runLiveVoiceRequest(workspaceRoot, {
          action: "process",
          text: "  Keep this wording.\nKeep this line.  ",
        }),
      ).resolves.toEqual({ text: "Keep this wording.\nKeep this line." });
      expect(mocks.loadRuntimeConfig).not.toHaveBeenCalled();
      expect(mocks.executeInternalTaskModelInference).not.toHaveBeenCalled();
      expect(mocks.loadRuntimeEnvironment).not.toHaveBeenCalled();
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { provider: "openai", status: 401 },
    { provider: "google", status: 403 },
  ])(
    "reports $provider authorization failure without exposing upstream secrets",
    async ({ provider, status }) => {
      mocks.loadUserConfigFile.mockResolvedValue({
        config: { speechToText: { ...speech, activeProvider: provider } },
      });
      const response = new Response(
        JSON.stringify({
          error: { message: "Rejected keys: " + openaiKey + ", " + googleKey },
        }),
        { status },
      );
      const readBody = vi.spyOn(response, "text");
      mocks.fetch.mockResolvedValue(response);

      const result = runLiveVoiceRequest(workspaceRoot, { action: "session" });

      await expect(result).rejects.toEqual(
        new Error(
          "Live voice authorization failed (" +
            status +
            "). Check the speech provider's API key and model access.",
        ),
      );
      await expect(result).rejects.not.toThrow(openaiKey);
      await expect(result).rejects.not.toThrow(googleKey);
      expect(readBody).not.toHaveBeenCalled();
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["openai", "google"])(
    "rejects a %s response without an ephemeral token",
    async (provider) => {
      mocks.loadUserConfigFile.mockResolvedValue({
        config: { speechToText: { ...speech, activeProvider: provider } },
      });
      mocks.fetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            api_key: provider === "openai" ? openaiKey : googleKey,
            expires_at: (now + 60_000) / 1000,
          }),
        ),
      );

      await expect(
        runLiveVoiceRequest(workspaceRoot, { action: "session" }),
      ).rejects.toThrow();
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { name: "null", input: null },
    { name: "missing action", input: {} },
    { name: "unknown action", input: { action: "connect" } },
    {
      name: "extra session fields",
      input: { action: "session", token: "injected" },
    },
    { name: "missing transcript", input: { action: "process" } },
    { name: "blank transcript", input: { action: "process", text: " \n " } },
    { name: "non-string transcript", input: { action: "process", text: 42 } },
    {
      name: "oversized transcript",
      input: { action: "process", text: "x".repeat(20_001) },
    },
    {
      name: "extra process fields",
      input: { action: "process", text: "Hello", provider: "google" },
    },
  ])(
    "rejects invalid input before loading configuration: $name",
    async ({ input }) => {
      await expect(runLiveVoiceRequest(workspaceRoot, input)).rejects.toThrow();
      expect(mocks.loadUserConfigFile).not.toHaveBeenCalled();
      expect(mocks.loadRuntimeEnvironment).not.toHaveBeenCalled();
      expect(mocks.loadRuntimeConfig).not.toHaveBeenCalled();
      expect(mocks.executeInternalTaskModelInference).not.toHaveBeenCalled();
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );
});

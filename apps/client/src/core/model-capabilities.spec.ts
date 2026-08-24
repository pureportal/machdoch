import {
  getModelCapabilityProfile,
  getModelContextWindowTokens,
  getImageInputMediaTypeForPath,
  getSupportedImageInputExtensions,
  modelSupportsReasoning,
  modelSupportsStreaming,
  modelSupportsToolUse,
  modelSupportsVoice,
  modelSupportsImageInput,
  providerSupportsImageInputMediaType,
  replaceDiscoveredModelCapabilities,
} from "./model-capabilities.js";

describe("model image input capabilities", () => {
  it("detects supported image media types from paths", () => {
    expect(getImageInputMediaTypeForPath("C:/workspace/mockup.PNG")).toBe(
      "image/png",
    );
    expect(getImageInputMediaTypeForPath("/tmp/photo.jpeg")).toBe("image/jpeg");
    expect(getImageInputMediaTypeForPath("/tmp/archive")).toBeUndefined();
  });

  it("keeps provider-specific image formats explicit", () => {
    expect(providerSupportsImageInputMediaType("openai", "image/png")).toBe(
      true,
    );
    expect(providerSupportsImageInputMediaType("openai", "image/heic")).toBe(
      false,
    );
    expect(providerSupportsImageInputMediaType("google", "image/heic")).toBe(
      true,
    );
    expect(
      providerSupportsImageInputMediaType("copilot-cli", "image/heic"),
    ).toBe(true);
    expect(getSupportedImageInputExtensions("anthropic")).toContain("webp");
  });

  it("uses discovered model-specific image formats and token limits", () => {
    replaceDiscoveredModelCapabilities("copilot-cli", [
      {
        id: "sdk-model",
        capabilities: {
          imageInput: true,
          contextWindowTokens: 200_000,
          supportedImageMediaTypes: ["image/png", "image/jpeg", "text/plain"],
        },
      },
    ]);

    expect(
      providerSupportsImageInputMediaType(
        "copilot-cli",
        "image/png",
        "sdk-model",
      ),
    ).toBe(true);
    expect(
      providerSupportsImageInputMediaType(
        "copilot-cli",
        "image/webp",
        "sdk-model",
      ),
    ).toBe(false);
    expect(
      getSupportedImageInputExtensions("copilot-cli", "sdk-model"),
    ).toEqual(["jpeg", "jpg", "png"]);
    expect(getModelContextWindowTokens("copilot-cli", "sdk-model")).toBe(
      200_000,
    );
  });

  it("recognizes configured vision-capable runtime models", () => {
    expect(modelSupportsImageInput("openai", "gpt-5.5")).toBe(true);
    expect(modelSupportsImageInput("openai", "gpt-5.5-pro")).toBe(true);
    expect(modelSupportsImageInput("anthropic", "claude-sonnet-5")).toBe(true);
    expect(modelSupportsImageInput("google", "gemini-2.5-flash")).toBe(true);
    expect(modelSupportsImageInput("google", "gemini-3.7-flash")).toBe(true);
    expect(modelSupportsImageInput("langdock", "gpt-5.6-terra")).toBe(true);
    expect(modelSupportsImageInput("copilot-cli", "gpt-5.6-terra")).toBe(true);
    expect(modelSupportsImageInput("openai", "gpt-3.5-turbo")).toBe(false);
  });

  it("honors explicit text-only Copilot model metadata", () => {
    replaceDiscoveredModelCapabilities("copilot-cli", [
      {
        id: "text-only-model",
        capabilities: { imageInput: false },
      },
    ]);

    expect(modelSupportsImageInput("copilot-cli", "text-only-model")).toBe(
      false,
    );
  });

  it("uses documented OpenAI capabilities when the Models API is sparse", () => {
    expect(getModelContextWindowTokens("openai", "gpt-5.5-pro")).toBe(
      1_050_000,
    );
    expect(getModelContextWindowTokens("openai", "gpt-5.2")).toBe(400_000);
    expect(getModelCapabilityProfile("openai", "gpt-5-pro")).toMatchObject({
      maxOutputTokens: 272_000,
      reasoning: true,
      toolUse: true,
    });
  });

  it("exposes model capability profiles from the catalog", () => {
    const profile = getModelCapabilityProfile("google", "gemini-2.5-flash");

    expect(profile).toMatchObject({
      provider: "google",
      model: "gemini-2.5-flash",
      imageInput: true,
      toolUse: true,
      reasoning: true,
      streaming: true,
      contextWindowTokens: 1_000_000,
    });
    expect(profile?.providerModes).toContain("gemini-function-calling-any");
    expect(getModelContextWindowTokens("anthropic", "claude-sonnet-5")).toBe(
      1_000_000,
    );
  });

  it("keeps unknown models conservative until provider metadata is registered", () => {
    expect(modelSupportsToolUse("openai", "gpt-6")).toBe(false);
    expect(modelSupportsReasoning("openai", "gpt-6")).toBe(false);
    expect(modelSupportsStreaming("anthropic", "claude-3-5-sonnet")).toBe(
      false,
    );
    expect(modelSupportsVoice("openai", "gpt-4o-realtime-preview")).toBe(false);
    expect(modelSupportsImageInput("google", "gemini-embedding-001")).toBe(
      false,
    );
  });
});

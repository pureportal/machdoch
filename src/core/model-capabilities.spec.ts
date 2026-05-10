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
} from "./model-capabilities.js";

describe("model image input capabilities", () => {
  it("detects supported image media types from paths", () => {
    expect(getImageInputMediaTypeForPath("C:/workspace/mockup.PNG")).toBe(
      "image/png",
    );
    expect(getImageInputMediaTypeForPath("/tmp/photo.jpeg")).toBe(
      "image/jpeg",
    );
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
    expect(getSupportedImageInputExtensions("anthropic")).toContain("webp");
  });

  it("recognizes configured vision-capable runtime models", () => {
    expect(modelSupportsImageInput("openai", "gpt-5.5")).toBe(true);
    expect(modelSupportsImageInput("anthropic", "claude-sonnet-4-6")).toBe(
      true,
    );
    expect(modelSupportsImageInput("google", "gemini-2.5-flash")).toBe(true);
    expect(modelSupportsImageInput("openai", "gpt-3.5-turbo")).toBe(false);
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
    expect(getModelContextWindowTokens("anthropic", "claude-sonnet-4-6")).toBe(
      1_000_000,
    );
  });

  it("keeps unknown models conservative until provider metadata is registered", () => {
    expect(modelSupportsToolUse("openai", "gpt-5.2")).toBe(false);
    expect(modelSupportsReasoning("openai", "gpt-5.2")).toBe(false);
    expect(modelSupportsStreaming("anthropic", "claude-3-5-sonnet")).toBe(
      false,
    );
    expect(modelSupportsVoice("openai", "gpt-4o-realtime-preview")).toBe(false);
    expect(modelSupportsImageInput("google", "gemini-embedding-001")).toBe(
      false,
    );
  });
});

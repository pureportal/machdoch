import {
  getImageInputMediaTypeForPath,
  getSupportedImageInputExtensions,
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
});

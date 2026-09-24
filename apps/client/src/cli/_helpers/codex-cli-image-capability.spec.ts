import { describe, expect, it } from "vitest";
import { parseCodexCliImageInput } from "./codex-cli-image-capability.js";

describe("Codex CLI image capability", () => {
  it("reads image input from the CLI model catalog", () => {
    const catalog = JSON.stringify({
      models: [
        { slug: "gpt-6-sol", input_modalities: ["text", "image"] },
        { slug: "text-only", input_modalities: ["text"] },
      ],
    });

    expect(parseCodexCliImageInput(catalog, "GPT-6-SOL")).toBe(true);
    expect(parseCodexCliImageInput(catalog, "text-only")).toBe(false);
    expect(parseCodexCliImageInput(catalog, "unlisted-model")).toBeUndefined();
  });

  it("leaves missing capability metadata to the provider", () => {
    const catalog = JSON.stringify({ models: [{ slug: "gpt-6-sol" }] });

    expect(parseCodexCliImageInput(catalog, "gpt-6-sol")).toBeUndefined();
  });
});

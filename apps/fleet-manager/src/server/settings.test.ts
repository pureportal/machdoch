import { describe, expect, it } from "vitest";
import type { FleetManagerConfig } from "./config";
import {
  emptySettingsDocument,
  isSecretId,
  validateSettingsDocument,
} from "./settings";

const limits: FleetManagerConfig["settingsManager"]["limits"] = {
  maximumProfiles: 64,
  maximumInstructionsPerProfile: 128,
  maximumPacksPerProfile: 128,
  maximumPromptsPerProfile: 128,
  maximumRevisionsPerProfile: 100,
  maximumDocumentBytes: 1024 * 1024,
  maximumSecretBytes: 8192,
};

describe("managed settings", () => {
  it("accepts complete documents and rejects duplicate identities", () => {
    const document = emptySettingsDocument();
    document.defaults.provider = "codex-cli";
    document.instructions.push({
      id: crypto.randomUUID(),
      name: "Global standards",
      body: "Use the current architecture.",
      enabled: true,
      global: true,
      tags: ["engineering"],
    });
    expect(validateSettingsDocument(document, limits)).toEqual(document);

    document.instructions.push({
      ...document.instructions[0]!,
      name: "Duplicate",
    });
    expect(() => validateSettingsDocument(document, limits)).toThrow(/unique/i);
  });

  it("accepts only supported secret identifiers", () => {
    expect(isSecretId("openai")).toBe(true);
    expect(isSecretId("custom.github-token")).toBe(false);
    expect(isSecretId("github-token")).toBe(false);
    expect(isSecretId("custom.GitHub")).toBe(false);
  });

  it("validates prompt paths and case-insensitive uniqueness", () => {
    const document = emptySettingsDocument();
    document.prompts.push({
      id: crypto.randomUUID(),
      relativePath: "reviews/security.prompt.md",
      content: "Review this change.",
    });
    expect(validateSettingsDocument(document, limits)).toEqual(document);

    document.prompts.push({
      id: crypto.randomUUID(),
      relativePath: "REVIEWS/security.prompt.md",
      content: "Duplicate path.",
    });
    expect(() => validateSettingsDocument(document, limits)).toThrow(/unique/i);

    document.prompts[1]!.relativePath = "../outside.prompt.md";
    expect(() => validateSettingsDocument(document, limits)).toThrow(/path/i);
  });

  it("requires providers for managed models", () => {
    const document = emptySettingsDocument();
    document.defaults.model = "gpt-5.6";
    expect(() => validateSettingsDocument(document, limits)).toThrow(
      /default model requires a provider/u,
    );
    document.defaults.model = null;
    document.contextPacks.push({
      id: crypto.randomUUID(),
      name: "Review",
      instructions: "Review carefully.",
      prompt: "",
      provider: "openai",
      model: null,
      mode: null,
      reasoning: null,
      variables: [],
      triggerPhrases: [],
      pathPatterns: [],
      promptEnhancementMode: null,
      interviewEnabled: null,
      sessionMemoryEnabled: null,
      useGlobalMemory: null,
      uiControlEnabled: null,
    });

    expect(() => validateSettingsDocument(document, limits)).toThrow(
      /provider and model/u,
    );
  });
});

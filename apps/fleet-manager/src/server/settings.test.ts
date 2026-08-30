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
  maximumRevisionsPerProfile: 100,
  maximumDocumentBytes: 1024 * 1024,
  maximumSecretBytes: 8192,
};

describe("managed settings", () => {
  it("accepts complete documents and rejects duplicate identities", () => {
    const document = emptySettingsDocument();
    document.defaults.preferredToolingAgent = "codex-cli";
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

  it("accepts bounded custom secret identifiers", () => {
    expect(isSecretId("openai")).toBe(true);
    expect(isSecretId("custom.github-token")).toBe(true);
    expect(isSecretId("github-token")).toBe(false);
    expect(isSecretId("custom.GitHub")).toBe(false);
  });
});

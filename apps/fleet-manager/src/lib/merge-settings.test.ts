import { describe, expect, it } from "vitest";
import {
  emptySettingsDocument,
  validateSettingsDocument,
} from "../server/settings";
import { mergeSettings } from "./merge-settings";

const instruction = (id: string, body: string) => ({
  id,
  name: "Review",
  body,
  enabled: true,
  global: true,
  tags: [],
});
const firstId = "123e4567-e89b-42d3-a456-426614174000";
const secondId = "123e4567-e89b-42d3-a456-426614174001";

describe("Enrollment settings merge", () => {
  it("preserves populated settings and requires choices for conflicting values", () => {
    const profile = emptySettingsDocument();
    const device = emptySettingsDocument();
    profile.defaults = {
      ...profile.defaults,
      provider: "openai",
      model: "gpt-5.4",
      mode: "ask",
    };
    device.defaults = {
      ...device.defaults,
      provider: "anthropic",
      model: "claude-opus-4-6",
      mode: "machdoch",
      theme: "dark",
    };
    profile.instructions = [instruction(firstId, "Review carefully.")];
    device.instructions = [instruction(secondId, "Review and run tests.")];
    const preview = mergeSettings(profile, device);
    expect(preview.document.defaults).toMatchObject({
      provider: "openai",
      model: "gpt-5.4",
      mode: "ask",
      theme: "dark",
    });
    expect(preview.conflicts.map((conflict) => conflict.key)).toEqual([
      "defaults.model",
      "defaults.mode",
      `instructions.${firstId}`,
    ]);
    const resolved = mergeSettings(profile, device, {
      "defaults.model": "device",
      "defaults.mode": "profile",
      [`instructions.${firstId}`]: "device",
    });
    expect(resolved.document.defaults).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-4-6",
      mode: "ask",
    });
    expect(resolved.document.instructions).toEqual([
      instruction(firstId, "Review and run tests."),
    ]);
    expect(profile.instructions).toEqual([
      instruction(firstId, "Review carefully."),
    ]);
  });

  it("combines disjoint entries and treats prompt path case as one identity", () => {
    const profile = emptySettingsDocument();
    const device = emptySettingsDocument();
    profile.prompts = [
      { id: firstId, relativePath: "review.prompt.md", content: "Review" },
    ];
    device.prompts = [
      {
        id: secondId,
        relativePath: "Review.prompt.md",
        content: "Review and verify",
      },
    ];
    device.contextPacks = [
      {
        id: secondId,
        name: "Testing",
        instructions: "Run tests",
        prompt: "",
        provider: null,
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
      },
    ];
    const result = mergeSettings(profile, device, {
      [`prompts.${firstId}`]: "device",
    });
    expect(result.document.prompts).toEqual([
      {
        id: firstId,
        relativePath: "Review.prompt.md",
        content: "Review and verify",
      },
    ]);
    expect(result.document.contextPacks).toHaveLength(1);
    expect(result.additions).toHaveLength(1);
  });

  it("does not erase settings with unspecified device values or duplicate equivalent entries", () => {
    const profile = emptySettingsDocument();
    profile.instructions = [instruction(firstId, "Review")];
    profile.defaults.theme = "dark";
    const device = emptySettingsDocument();
    device.instructions = [instruction(secondId, "Review")];
    expect(mergeSettings(profile, device)).toEqual({
      document: profile,
      conflicts: [],
      additions: [],
    });
  });

  it("keeps provider and model together when accepting an unspecified device model", () => {
    const profile = emptySettingsDocument();
    const device = emptySettingsDocument();
    profile.defaults.provider = "openai";
    profile.defaults.model = "gpt-5.4";
    device.defaults.provider = "anthropic";
    const result = mergeSettings(profile, device, {
      "defaults.model": "device",
    });
    expect(result.document.defaults).toMatchObject({
      provider: "anthropic",
      model: null,
    });
    expect(() =>
      validateSettingsDocument(result.document, {
        maximumDocumentBytes: 1024 * 1024,
        maximumInstructionsPerProfile: 128,
        maximumPacksPerProfile: 128,
        maximumPromptsPerProfile: 128,
      } as Parameters<typeof validateSettingsDocument>[1]),
    ).not.toThrow();
  });
});

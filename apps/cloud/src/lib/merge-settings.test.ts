import { describe, expect, it } from "vitest";
import {
  emptySettingsDocument,
  validateSettingsDocument,
} from "../server/settings";
import { diffLines, mergeSettings } from "./merge-settings";

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

  it("treats names and paths that differ only in case as the same content", () => {
    const profile = emptySettingsDocument();
    profile.instructions = [instruction(firstId, "Never log secrets.")];
    profile.prompts = [
      { id: firstId, relativePath: "review.prompt.md", content: "Review" },
    ];
    const device = emptySettingsDocument();
    device.instructions = [
      { ...instruction(secondId, "Never log secrets."), name: "review" },
    ];
    device.prompts = [
      { id: secondId, relativePath: "Review.prompt.md", content: "Review" },
    ];
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

  it("merges identical items from several devices silently and groups conflicting variants", () => {
    const profile = emptySettingsDocument();
    const laptop = emptySettingsDocument();
    const desktop = emptySettingsDocument();
    const tablet = emptySettingsDocument();
    laptop.instructions = [instruction(firstId, "Shared rule")];
    desktop.instructions = [instruction(secondId, "Shared rule")];
    laptop.defaults.theme = "dark";
    desktop.defaults.theme = "light";
    tablet.defaults.theme = "dark";
    const sources = [
      { name: "Laptop", document: laptop },
      { name: "Desktop", document: desktop },
      { name: "Tablet", document: tablet },
    ];
    const preview = mergeSettings(profile, sources);
    expect(preview.additions).toEqual([
      {
        key: "instructions.new:review",
        label: "Instruction: Review",
        value: instruction(firstId, "Shared rule"),
        sources: ["Laptop", "Desktop"],
      },
    ]);
    expect(preview.conflicts).toHaveLength(1);
    expect(preview.conflicts[0]).toMatchObject({
      key: "defaults.theme",
      profileValue: null,
      variants: [
        { value: "dark", sources: ["Laptop", "Tablet"] },
        { value: "light", sources: ["Desktop"] },
      ],
    });
    expect(
      mergeSettings(profile, sources, { "defaults.theme": "device:1" }).document
        .defaults.theme,
    ).toBe("light");
    expect(
      mergeSettings(profile, sources, { "defaults.theme": "profile" }).document
        .defaults.theme,
    ).toBeNull();
  });

  it("keeps both versions under a new name or uses an edited value", () => {
    const profile = emptySettingsDocument();
    profile.instructions = [instruction(firstId, "Profile rule")];
    const device = emptySettingsDocument();
    device.instructions = [
      { ...instruction(secondId, "Device rule"), tags: ["team"] },
    ];
    const preview = mergeSettings(profile, device);
    expect(preview.conflicts[0]).toMatchObject({
      key: `instructions.${firstId}`,
      kind: "instruction",
      differences: ["body", "tags"],
      resolved: false,
    });
    const both = mergeSettings(profile, device, {
      [`instructions.${firstId}`]: "both",
    }).document.instructions;
    expect(both.map((item) => item.name)).toEqual(["Review", "Review (2)"]);
    expect(both[1]!.id).not.toBe(firstId);
    expect(both[1]!.id).not.toBe(secondId);
    expect(
      mergeSettings({ ...profile, instructions: both }, device).conflicts,
    ).toEqual([]);
    expect(() =>
      validateSettingsDocument({ ...profile, instructions: both }, {
        maximumDocumentBytes: 1024 * 1024,
        maximumInstructionsPerProfile: 128,
        maximumPacksPerProfile: 128,
        maximumPromptsPerProfile: 128,
      } as Parameters<typeof validateSettingsDocument>[1]),
    ).not.toThrow();
    const edited = mergeSettings(profile, device, {
      [`instructions.${firstId}`]: {
        edit: { ...instruction(secondId, "Merged rule"), tags: ["team"] },
      },
    }).document.instructions;
    expect(edited).toEqual([
      { ...instruction(firstId, "Merged rule"), tags: ["team"] },
    ]);
  });

  it("merges MCP servers by id and ignores key order when comparing", () => {
    const server = {
      id: "github",
      title: "GitHub",
      enabled: true,
      transport: {
        type: "stdio" as const,
        command: "npx",
        args: ["server-github"],
        env: { GITHUB_TOKEN: "{{secret:mcp_github}}" },
      },
    };
    const profile = emptySettingsDocument();
    profile.mcpServers = [server];
    const same = emptySettingsDocument();
    same.mcpServers = [
      {
        transport: {
          env: { GITHUB_TOKEN: "{{secret:mcp_github}}" },
          args: ["server-github"],
          command: "npx",
          type: "stdio",
        },
        enabled: true,
        title: "GitHub",
        id: "github",
      },
    ];
    expect(mergeSettings(profile, same).conflicts).toEqual([]);
    const changed = emptySettingsDocument();
    changed.mcpServers = [{ ...server, enabled: false }];
    const result = mergeSettings(profile, changed, {
      "mcpServers.github": "both",
    });
    expect(result.conflicts[0]?.differences).toEqual(["enabled"]);
    expect(result.document.mcpServers?.map((item) => item.id)).toEqual([
      "github",
      "github-2",
    ]);
  });

  it("marks choices that no longer match a conflict as unresolved", () => {
    const profile = emptySettingsDocument();
    const laptop = emptySettingsDocument();
    const desktop = emptySettingsDocument();
    laptop.defaults.theme = "dark";
    desktop.defaults.theme = "light";
    const sources = [
      { name: "Laptop", document: laptop },
      { name: "Desktop", document: desktop },
    ];
    expect(
      mergeSettings(profile, sources, { "defaults.theme": "device:1" })
        .conflicts[0]?.resolved,
    ).toBe(true);
    // Once the profile holds the laptop value, only one variant differs.
    profile.defaults.theme = "dark";
    const stale = mergeSettings(profile, sources, {
      "defaults.theme": "device:1",
    });
    expect(stale.conflicts[0]).toMatchObject({
      variants: [{ value: "light", sources: ["Desktop"] }],
      resolved: false,
    });
    expect(stale.document.defaults.theme).toBe("dark");
    expect(
      mergeSettings(profile, sources, { "defaults.theme": "both" }).conflicts[0]
        ?.resolved,
    ).toBe(false);
    expect(
      mergeSettings(profile, sources, { "defaults.theme": "profile" })
        .conflicts[0]?.resolved,
    ).toBe(true);
  });

  it("keys additions by identity so equal titles stay distinct", () => {
    const server = (id: string) => ({
      id,
      title: "GitHub",
      enabled: true,
      transport: {
        type: "streamable-http" as const,
        url: `https://mcp.example.test/${id}`,
        headers: {},
      },
    });
    const device = emptySettingsDocument();
    device.mcpServers = [server("github"), server("github-enterprise")];
    device.defaults.provider = "openai";
    const { additions, conflicts } = mergeSettings(
      emptySettingsDocument(),
      device,
    );
    expect(conflicts).toEqual([]);
    expect(additions.map((addition) => addition.label)).toEqual([
      "Provider and model",
      "MCP server: GitHub",
      "MCP server: GitHub",
    ]);
    expect(new Set(additions.map((addition) => addition.key)).size).toBe(3);
  });

  it("renames new items that collide with a kept copy", () => {
    const profile = emptySettingsDocument();
    profile.instructions = [instruction(firstId, "Profile rule")];
    const laptop = emptySettingsDocument();
    laptop.instructions = [instruction(secondId, "Laptop rule")];
    const desktop = emptySettingsDocument();
    desktop.instructions = [
      {
        ...instruction("123e4567-e89b-42d3-a456-426614174002", "Desktop rule"),
        name: "Review (2)",
      },
    ];
    const result = mergeSettings(
      profile,
      [
        { name: "Laptop", document: laptop },
        { name: "Desktop", document: desktop },
      ],
      { [`instructions.${firstId}`]: "both" },
    );
    const names = result.document.instructions.map((item) => item.name);
    expect(names).toEqual(["Review", "Review (2)", "Review (2) (2)"]);
    expect(
      new Set(result.document.instructions.map((item) => item.id)).size,
    ).toBe(names.length);
  });

  it("diffs text line by line", () => {
    expect(diffLines("a\nb\nc", "a\nB\nc")).toEqual([
      { type: "same", text: "a" },
      { type: "removed", text: "b" },
      { type: "added", text: "B" },
      { type: "same", text: "c" },
    ]);
  });
});

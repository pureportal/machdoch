import { describe, expect, it } from "vitest";
import type { SmartContextPack } from "../../chat-session.model";
import {
  applySmartContextPackToComposer,
  createContextPackSummary,
  getSmartContextPacksForWorkspace,
} from "./smart-context-packs";

const createPack = (
  overrides: Partial<SmartContextPack> = {},
): SmartContextPack => {
  return {
    id: "pack-1",
    workspace: "C:\\Project",
    name: "Review PR",
    instructions: "Focus on regressions.",
    prompt: "Review the staged changes.",
    contextAttachments: [
      {
        id: "plan",
        path: "C:\\Project\\plan.md",
        kind: "file",
        name: "plan.md",
      },
    ],
    provider: "openai",
    model: "gpt-5.5",
    mode: "machdoch",
    createdAt: 1,
    updatedAt: 2,
    useCount: 0,
    ...overrides,
  };
};

describe("smart context packs", () => {
  it("matches Windows workspaces across casing and separators", () => {
    const packs = [
      createPack({ id: "windows-pack", workspace: "C:\\Project\\" }),
      createPack({ id: "other-pack", workspace: "C:\\Other" }),
      createPack({ id: "null-pack", workspace: null }),
    ];

    expect(
      getSmartContextPacksForWorkspace(packs, "c:/project").map(
        (pack) => pack.id,
      ),
    ).toEqual(["windows-pack"]);
    expect(
      getSmartContextPacksForWorkspace(packs, null).map((pack) => pack.id),
    ).toEqual(["null-pack"]);
  });

  it("puts reusable instructions before the current task", () => {
    const result = applySmartContextPackToComposer(
      "Check the latest diff",
      [],
      createPack(),
    );

    expect(result.draft).toBe(
      [
        "## Context Pack: Review PR",
        "",
        "### Instructions",
        "Focus on regressions.",
        "",
        "### Prompt",
        "Review the staged changes.",
        "",
        "## Current Task",
        "Check the latest diff",
      ].join("\n"),
    );
    expect(result.contextAttachments).toMatchObject([
      {
        path: "C:\\Project\\plan.md",
        kind: "file",
        name: "plan.md",
      },
    ]);
  });

  it("summarizes attachments in a single pass with correct plurals", () => {
    expect(createContextPackSummary(createPack())).toEqual([
      "prompt",
      "instructions",
      "1 file",
      "Machdoch",
      "OpenAI / gpt-5.5",
    ]);
  });
});

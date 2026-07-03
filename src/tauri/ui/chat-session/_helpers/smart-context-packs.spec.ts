import { describe, expect, it } from "vitest";
import {
  createInitialShellState,
  type SmartContextPack,
} from "../../chat-session.model";
import {
  applySmartContextPackToComposer,
  createContextPackSummary,
  createSmartContextPackExportPayload,
  createSmartContextPackPreview,
  doesSmartContextPackMatchComposer,
  extractSmartContextPackVariables,
  getSmartContextPackMissingVariableNames,
  getSmartContextPacksForWorkspace,
  importSmartContextPacksIntoShellState,
  parseSmartContextPackListInput,
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
    variables: [],
    trigger: {
      phrases: [],
      pathPatterns: [],
      autoApply: false,
    },
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

  it("substitutes variables when applying a pack", () => {
    const result = applySmartContextPackToComposer(
      "",
      [],
      createPack({
        instructions: "Review {target_file}.",
        prompt: "Run {test_command}.",
        contextAttachments: [],
        variables: [
          { name: "target_file" },
          { name: "test_command", defaultValue: "npm test" },
        ],
      }),
      { target_file: "src/App.tsx" },
    );

    expect(result.draft).toBe(
      [
        "## Context Pack: Review PR",
        "",
        "### Instructions",
        "Review src/App.tsx.",
        "",
        "### Prompt",
        "Run npm test.",
      ].join("\n"),
    );
  });

  it("preserves input-needed placeholders when applying a pack", () => {
    const result = applySmartContextPackToComposer(
      "",
      [],
      createPack({
        instructions: "Review [[SCOPE]] with {test_command}.",
        prompt: "Then update [[ scope ]].",
        contextAttachments: [],
        variables: [
          { name: "SCOPE", defaultValue: "docs" },
          { name: "test_command", defaultValue: "npm test" },
        ],
      }),
    );

    expect(result.draft).toBe(
      [
        "## Context Pack: Review PR",
        "",
        "### Instructions",
        "Review [[SCOPE]] with npm test.",
        "",
        "### Prompt",
        "Then update [[ scope ]].",
      ].join("\n"),
    );
  });

  it("reports only variables without values or defaults", () => {
    expect(
      getSmartContextPackMissingVariableNames(
        createPack({
          variables: [
            { name: "target_file" },
            { name: "test_command", defaultValue: "npm test" },
            { name: "ticket_id" },
          ],
        }),
        { ticket_id: "BUG-123" },
      ),
    ).toEqual(["target_file"]);
  });

  it("parses variables and list inputs with deduplication", () => {
    expect(
      extractSmartContextPackVariables(
        "Review {target_file} then {target_file} for {ticket_id}.",
        "Submit {{SCOPE}} later.",
      ),
    ).toEqual(["target_file", "ticket_id"]);
    expect(parseSmartContextPackListInput("frontend qa, debug build\nfrontend qa")).toEqual([
      "frontend qa",
      "debug build",
    ]);
  });

  it("matches composer text and attached paths against triggers", () => {
    const pack = createPack({
      trigger: {
        phrases: ["frontend qa"],
        pathPatterns: ["*.tsx", "src/ui/**"],
        autoApply: true,
      },
    });

    expect(
      doesSmartContextPackMatchComposer(pack, {
        draft: "Please run FRONTEND QA before release",
        contextAttachments: [],
      }),
    ).toBe(true);
    expect(
      doesSmartContextPackMatchComposer(pack, {
        draft: "",
        contextAttachments: [
          {
            id: "app",
            path: "C:\\Project\\src\\App.tsx",
            kind: "file",
            name: "App.tsx",
          },
        ],
      }),
    ).toBe(true);
    expect(
      doesSmartContextPackMatchComposer(pack, {
        draft: "",
        contextAttachments: [
          {
            id: "button",
            path: "C:\\Project\\src\\ui\\button.css",
            kind: "file",
            name: "button.css",
          },
        ],
      }),
    ).toBe(true);
    expect(
      doesSmartContextPackMatchComposer(pack, {
        draft: "Investigate release notes",
        contextAttachments: [],
      }),
    ).toBe(false);
  });

  it("previews budget and path health warnings", () => {
    const preview = createSmartContextPackPreview(
      createPack({
        contextAttachments: [
          {
            id: "secret",
            path: "C:\\Project\\.env",
            kind: "file",
            name: ".env",
          },
          {
            id: "screens",
            path: "C:\\Project\\screens",
            kind: "directory",
            name: "screens",
          },
          {
            id: "image",
            path: "C:\\Project\\layout.png",
            kind: "image",
            name: "layout.png",
          },
        ],
        variables: [{ name: "target_file" }],
        trigger: {
          phrases: ["frontend qa"],
          pathPatterns: [],
          autoApply: true,
        },
      }),
      { imageInputSupported: false },
    );

    expect(preview.attachmentCount).toBe(3);
    expect(preview.estimatedTokens).toBeGreaterThan(1);
    expect(preview.warnings).toEqual([
      "1 variable",
      "image model required",
      "sensitive paths",
      "folder size unknown",
      "auto-apply",
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

  it("exports and imports packs into the target workspace", () => {
    const existingPack = createPack({ id: "pack-1", name: "Existing" });
    const exportedPack = createPack({
      id: "pack-1",
      name: "Imported",
      workspace: "C:\\Source",
      useCount: 4,
      lastUsedAt: 10,
    });
    const payload = createSmartContextPackExportPayload([exportedPack], 15);
    const state = importSmartContextPacksIntoShellState(
      {
        ...createInitialShellState(),
        contextPacks: [existingPack],
      },
      payload,
      "C:\\Imported",
      20,
    );

    expect(state.contextPacks).toHaveLength(2);
    expect(state.contextPacks[0]).toMatchObject({
      name: "Imported",
      workspace: "C:\\Imported",
      createdAt: 20,
      updatedAt: 20,
      useCount: 0,
    });
    expect(state.contextPacks[0]?.id).not.toBe("pack-1");
    expect(state.contextPacks[1]?.name).toBe("Existing");
  });
});

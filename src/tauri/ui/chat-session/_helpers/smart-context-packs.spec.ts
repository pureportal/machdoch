import { describe, expect, it } from "vitest";
import {
  createInitialShellState,
  type SmartContextPack,
} from "../../chat-session.model";
import {
  applySmartContextPackToComposer,
  applySmartContextPackSettingsToComposer,
  applySmartContextPackSettingsToSession,
  applySmartContextPackSettingsToShellDefaults,
  createSmartContextPackExportPayload,
  doesSmartContextPackMatchComposer,
  extractSmartContextPackVariables,
  filterSmartContextPacksByScope,
  getSmartContextPackModelSelection,
  getSmartContextPackMissingVariableNames,
  getSmartContextPacksForWorkspace,
  importSmartContextPacksIntoShellState,
  parseSmartContextPackListInput,
  parseSmartContextPackVariableInput,
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
  it("matches global packs and Windows workspaces across casing and separators", () => {
    const packs = [
      createPack({ id: "windows-pack", workspace: "C:\\Project\\" }),
      createPack({ id: "other-pack", workspace: "C:\\Other" }),
      createPack({ id: "null-pack", workspace: null }),
    ];

    expect(
      getSmartContextPacksForWorkspace(packs, "c:/project").map(
        (pack) => pack.id,
      ),
    ).toEqual(["windows-pack", "null-pack"]);
    expect(
      getSmartContextPacksForWorkspace(packs, null).map((pack) => pack.id),
    ).toEqual(["null-pack"]);
    expect(
      filterSmartContextPacksByScope(packs, "global").map((pack) => pack.id),
    ).toEqual(["null-pack"]);
    expect(
      filterSmartContextPacksByScope(packs, "workspace").map((pack) => pack.id),
    ).toEqual(["windows-pack", "other-pack"]);
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

  it("keeps current settings when a pack has no saved overrides", () => {
    const state = {
      ...createInitialShellState(),
      lastSelectedSessionMemoryEnabled: true,
      lastSelectedUseGlobalMemory: false,
      lastSelectedUiControlEnabled: true,
    };
    const session = {
      ...state.sessions[0],
      sessionMemoryEnabled: true,
      useGlobalMemory: false,
      uiControlEnabled: true,
    };
    const pack = createPack({
      provider: undefined,
      model: undefined,
      mode: undefined,
      reasoning: undefined,
    });

    const nextSession = applySmartContextPackSettingsToSession(
      session,
      pack,
      null,
    );
    const nextDefaults = applySmartContextPackSettingsToShellDefaults(
      state,
      pack,
      null,
    );
    const nextComposer = applySmartContextPackSettingsToComposer(
      {
        promptEnhancementMode: "web-search",
        interviewEnabled: true,
      },
      pack,
    );

    expect(nextSession).toMatchObject({
      sessionMemoryEnabled: true,
      useGlobalMemory: false,
      uiControlEnabled: true,
    });
    expect(nextDefaults).toMatchObject({
      lastSelectedSessionMemoryEnabled: true,
      lastSelectedUseGlobalMemory: false,
      lastSelectedUiControlEnabled: true,
    });
    expect(nextComposer).toEqual({
      promptEnhancementMode: "web-search",
      interviewEnabled: true,
    });
  });

  it.each([
    {
      label: "enabled",
      promptEnhancementMode: "simple" as const,
      interviewEnabled: true,
    },
    {
      label: "disabled",
      promptEnhancementMode: "off" as const,
      interviewEnabled: false,
    },
  ])(
    "applies explicitly $label Prompt Enhancer and interview overrides",
    ({ promptEnhancementMode, interviewEnabled }) => {
      expect(
        applySmartContextPackSettingsToComposer(
          {
            promptEnhancementMode:
              promptEnhancementMode === "off" ? "simple" : "off",
            interviewEnabled: !interviewEnabled,
          },
          createPack({
            promptEnhancementMode,
            interviewEnabled,
          }),
        ),
      ).toEqual({
        promptEnhancementMode,
        interviewEnabled,
      });
    },
  );

  it("applies saved session settings and remembers them for new chats", () => {
    const state = createInitialShellState();
    const session = {
      ...state.sessions[0],
      provider: "openai" as const,
      model: "gpt-5.5",
      mode: "machdoch" as const,
      reasoning: "high" as const,
      sessionMemoryEnabled: true,
      useGlobalMemory: false,
      uiControlEnabled: true,
    };
    const pack = createPack({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      mode: "ask",
      reasoning: "default",
      sessionMemoryEnabled: false,
      useGlobalMemory: true,
      uiControlEnabled: false,
    });
    const modelSelection = getSmartContextPackModelSelection(pack, [
      "openai",
      "anthropic",
    ]);
    const nextSession = applySmartContextPackSettingsToSession(
      session,
      pack,
      modelSelection,
    );
    const nextDefaults = applySmartContextPackSettingsToShellDefaults(
      state,
      pack,
      modelSelection,
    );

    expect(nextSession).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      mode: "ask",
      sessionMemoryEnabled: false,
      useGlobalMemory: true,
      uiControlEnabled: false,
    });
    expect(nextSession.reasoning).toBeUndefined();
    expect(nextDefaults).toMatchObject({
      lastSelectedProvider: "anthropic",
      lastSelectedModelByProvider: {
        anthropic: "claude-sonnet-4-6",
      },
      lastSelectedMode: "ask",
      lastSelectedSessionMemoryEnabled: false,
      lastSelectedUseGlobalMemory: true,
      lastSelectedUiControlEnabled: false,
    });
    expect(nextDefaults.lastSelectedReasoning).toBeUndefined();
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

  it("summarizes prompt and skill files when applying a pack", () => {
    const result = applySmartContextPackToComposer(
      "Use the saved workflow",
      [],
      createPack({
        instructions: "Prefer reusable workflow files.",
        prompt: "",
        contextAttachments: [
          {
            id: "prompt-file",
            path: "C:\\Project\\.machdoch\\prompts\\debug-build.prompt.md",
            kind: "file",
            name: "debug-build.prompt.md",
          },
          {
            id: "skill-file",
            path: "C:\\Project\\.machdoch\\skills\\browser\\SKILL.md",
            kind: "file",
            name: "SKILL.md",
          },
        ],
      }),
    );

    expect(result.draft).toContain("### Prompt files\n- /debug-build");
    expect(result.draft).toContain("### Skill files\n- browser");
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
    expect(
      parseSmartContextPackVariableInput(
        "target_file, test_command=npm test\ntarget_file=ignored",
      ),
    ).toEqual([
      { name: "target_file" },
      { name: "test_command", defaultValue: "npm test" },
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

  it("exports and imports packs into the target workspace", () => {
    const existingPack = createPack({ id: "pack-1", name: "Existing" });
    const exportedPack = createPack({
      id: "pack-1",
      name: "Imported",
      workspace: "C:\\Source",
      useCount: 4,
      lastUsedAt: 10,
      promptEnhancementMode: "simple",
      interviewEnabled: false,
      sessionMemoryEnabled: true,
      useGlobalMemory: false,
      uiControlEnabled: true,
    });
    const payload = createSmartContextPackExportPayload([exportedPack], 15);
    const state = importSmartContextPacksIntoShellState(
      {
        ...createInitialShellState(),
        contextPacks: [existingPack],
      },
      payload,
      "C:\\Imported",
      "workspace",
      20,
    );

    expect(state.contextPacks).toHaveLength(2);
    expect(state.contextPacks[0]).toMatchObject({
      name: "Imported",
      workspace: "C:\\Imported",
      createdAt: 20,
      updatedAt: 20,
      useCount: 0,
      promptEnhancementMode: "simple",
      interviewEnabled: false,
      sessionMemoryEnabled: true,
      useGlobalMemory: false,
      uiControlEnabled: true,
    });
    expect(state.contextPacks[0]?.id).not.toBe("pack-1");
    expect(state.contextPacks[1]?.name).toBe("Existing");
  });

  it("imports packs into global scope when requested", () => {
    const exportedPack = createPack({
      id: "imported-global-pack",
      name: "Imported Global",
      workspace: "C:\\Source",
    });
    const payload = createSmartContextPackExportPayload([exportedPack], 15);
    const state = importSmartContextPacksIntoShellState(
      createInitialShellState(),
      payload,
      "C:\\Imported",
      "global",
      20,
    );

    expect(state.contextPacks[0]).toMatchObject({
      name: "Imported Global",
      workspace: null,
      useCount: 0,
    });
  });
});

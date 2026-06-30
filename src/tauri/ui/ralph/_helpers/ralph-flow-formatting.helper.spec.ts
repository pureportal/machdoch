import type {
  RalphBlockSettings,
  RalphFlowBlock,
  RalphFlowSummary,
} from "../../../../core/ralph.js";
import {
  compactPreviewText,
  formatCatalogModelLabel,
  formatFlowSubtitle,
  formatMaxBytes,
  formatProviderOptionLabel,
  formatRouteOptionTargetLabel,
  formatRouteTargetLabel,
  formatSeconds,
  formatUnconnectedRouteLabel,
  formatUtilityConditionSummary,
  formatUtilityTypeLabel,
  formatValidationScopeLabel,
  titleFromId,
} from "./format-ralph-flow-labels.helper";
import {
  getBlockTone,
  getBlockVisual,
  getUtilityTone,
} from "./get-ralph-block-visual.helper";
import {
  getBlockNodePreview,
  getBlockSettingsPreviewChips,
  getPromptLikeText,
  getUtilityNodePreview,
} from "./get-ralph-node-preview.helper";

const createSummary = (
  overrides: Partial<RalphFlowSummary> = {},
): RalphFlowSummary => ({
  id: "review-flow",
  name: "Review Flow",
  path: "review-flow.json",
  blockCount: 2,
  edgeCount: 1,
  variableCount: 0,
  ...overrides,
});

const startBlock: RalphFlowBlock = {
  id: "start",
  type: "START",
  title: "Start",
};

const promptBlock = (
  overrides: Partial<Extract<RalphFlowBlock, { type: "PROMPT" }>> = {},
): Extract<RalphFlowBlock, { type: "PROMPT" }> => ({
  id: "prompt",
  type: "PROMPT",
  title: "Draft",
  prompt: "Write the draft",
  ...overrides,
});

describe("Ralph flow formatting helpers", () => {
  it("formats flow, route, provider, utility, and catalog labels", () => {
    expect(formatFlowSubtitle(createSummary({ alias: "daily-review" }))).toBe(
      "daily-review",
    );
    expect(formatFlowSubtitle(createSummary())).toBe("review-flow");
    expect(formatRouteTargetLabel(startBlock)).toBe("Start [START]");
    expect(formatRouteOptionTargetLabel(startBlock, startBlock)).toBe(
      "Self (Start [START])",
    );
    expect(formatRouteOptionTargetLabel(startBlock, promptBlock())).toBe(
      "Draft [PROMPT]",
    );
    expect(formatProviderOptionLabel("default")).toBe("Default");
    expect(formatProviderOptionLabel("openai")).toBe("OpenAI");
    expect(formatUtilityTypeLabel("HTTP_FETCH")).toBe("HTTP Fetch");
    expect(
      formatCatalogModelLabel([{ id: "model-a", label: "Model A" }], "model-a"),
    ).toBe("Model A");
    expect(formatCatalogModelLabel([], "missing-model")).toBe("missing-model");
  });

  it.each([
    ["sinceLastValidator", "Since last validator"],
    ["previousBlock", "Previous block"],
    ["selectedBlocks", "Selected blocks"],
    ["wholeFlow", "Whole flow"],
  ] as const)("formats validation scope %s", (mode, label) => {
    expect(formatValidationScopeLabel(mode)).toBe(label);
  });

  it("formats route fallback labels for validator retry routes", () => {
    const validator: RalphFlowBlock = {
      id: "validate",
      type: "VALIDATOR",
      title: "Validate",
      prompt: "Check output",
    };

    expect(formatUnconnectedRouteLabel(validator, "RETRY")).toBe(
      "Auto retry group",
    );
    expect(formatUnconnectedRouteLabel(validator, "ERROR")).toBe("Unconnected");
    expect(formatUnconnectedRouteLabel(startBlock, "SUCCESS")).toBe(
      "Unconnected",
    );
  });

  it("titles ids and falls back for empty input", () => {
    expect(titleFromId("previous-block")).toBe("Previous Block");
    expect(titleFromId("  spaced   words ")).toBe("Spaced Words");
    expect(titleFromId("")).toBe("Ralph Flow");
  });

  it("compacts preview text and handles empty, null, and undefined values", () => {
    expect(compactPreviewText("  hello\n\nworld\t ", "fallback")).toBe(
      "hello world",
    );
    expect(compactPreviewText("", "fallback")).toBe("fallback");
    expect(compactPreviewText("   ", "fallback")).toBe("fallback");
    expect(compactPreviewText(null, "fallback")).toBe("fallback");
    expect(compactPreviewText(undefined, "fallback")).toBe("fallback");
  });

  it("formats second and byte boundaries", () => {
    expect(formatSeconds(undefined)).toBe("not set");
    expect(formatSeconds(null)).toBe("not set");
    expect(formatSeconds(Number.POSITIVE_INFINITY)).toBe("not set");
    expect(formatSeconds(0)).toBe("0s");
    expect(formatSeconds(59)).toBe("59s");
    expect(formatSeconds(60)).toBe("1m");
    expect(formatSeconds(90)).toBe("90s");

    expect(formatMaxBytes(undefined)).toBe("unlimited output");
    expect(formatMaxBytes(null)).toBe("unlimited output");
    expect(formatMaxBytes(0)).toBe("unlimited output");
    expect(formatMaxBytes(Number.NaN)).toBe("unlimited output");
    expect(formatMaxBytes(999)).toBe("999 B output");
    expect(formatMaxBytes(1_500)).toBe("1.5 KB output");
    expect(formatMaxBytes(1_500_000)).toBe("1.5 MB output");
  });

  it("formats utility conditions across styles and missing values", () => {
    expect(formatUtilityConditionSummary(undefined)).toBe(
      "No condition configured",
    );
    expect(
      formatUtilityConditionSummary({
        style: "simple",
        expression: " status == 200 ",
      }),
    ).toBe("When status == 200");
    expect(
      formatUtilityConditionSummary({
        style: "javascript",
        expression: "",
      }),
    ).toBe("JS No expression");
    expect(
      formatUtilityConditionSummary({
        style: "json-path",
        path: "",
      }),
    ).toBe("JSON $ Matches");
    expect(
      formatUtilityConditionSummary({
        style: "json-path",
        path: "$.state",
        operator: "not-equals",
        value: "done",
      }),
    ).toBe("JSON $.state Not Equals done");
  });

  it("derives utility previews for defaults, boundaries, and error-route states", () => {
    expect(
      getUtilityNodePreview({ type: "WAIT", mode: "delay", delaySeconds: 0 }),
    ).toEqual({
      primary: "Delay for 0s",
      secondary: "Pauses the flow, then continues.",
      chips: ["single success route"],
    });
    expect(
      getUtilityNodePreview({ type: "WAIT", mode: "poll", intervalSeconds: 60 }),
    ).toMatchObject({
      primary: "Poll until condition passes",
      secondary: "No condition configured",
      chips: ["every 1m"],
    });
    expect(
      getUtilityNodePreview({
        type: "HTTP_FETCH",
        method: "POST",
        url: "",
        maxOutputBytes: 0,
      }),
    ).toMatchObject({
      primary: "POST URL not set",
      chips: ["30s timeout", "unlimited output"],
    });
    expect(
      getUtilityNodePreview({
        type: "POLL",
        method: "GET",
        url: "https://example.test",
        maxAttempts: null,
      }),
    ).toMatchObject({
      primary: "GET https://example.test",
      chips: ["every 30s", "endless"],
    });
    expect(getUtilityNodePreview({ type: "RUN_CHECK", command: "" })).toEqual({
      primary: "Check command not set",
      secondary: "Failed exit codes route to FAILED.",
      chips: ["2m timeout"],
    });
    expect(
      getUtilityNodePreview({
        type: "UI_ANALYZE",
        adapter: "auto",
      }),
    ).toMatchObject({
      primary: "Target URL not set",
      secondary: "Server: existing",
      chips: ["auto", "4 viewport(s)", "30s timeout"],
    });
  });

  it("derives block setting chips without default settings noise", () => {
    expect(getBlockSettingsPreviewChips(undefined)).toEqual([]);
    expect(
      getBlockSettingsPreviewChips({
        provider: "default",
        model: "default",
        reasoning: "default",
      }),
    ).toEqual([]);

    const settings: RalphBlockSettings = {
      provider: "openai",
      model: "gpt-test",
      reasoning: "high",
      webAccess: false,
      fileAccess: false,
      attachments: [
        { id: "one", source: "path", value: "a.png", kind: "image" },
        { id: "two", source: "variable", value: "screenshot", kind: "image" },
      ],
    };

    expect(getBlockSettingsPreviewChips(settings)).toEqual([
      "OpenAI",
      "gpt-test",
      "High reasoning",
      "no web",
      "no files",
      "2 attachments",
    ]);
  });

  it("derives block preview text for prompt, visual, MCP, and terminal blocks", () => {
    expect(getBlockNodePreview(startBlock)).toEqual({
      primary: "Start execution",
      secondary: "Entry point for this flow.",
      chips: ["single start"],
    });
    expect(getBlockNodePreview(promptBlock({ prompt: "" }))).toEqual({
      primary: "prompt",
      chips: [],
    });
    expect(
      getBlockNodePreview({
        id: "note",
        type: "NOTE",
        title: "Note",
        text: "",
        tags: ["release"],
      }),
    ).toMatchObject({
      primary: "Empty note",
      secondary: "Canvas annotation",
      chips: ["slate", "release"],
    });
    expect(
      getBlockNodePreview({
        id: "group",
        type: "GROUP",
        title: "Group",
        childBlockIds: ["a", "b"],
        collapsed: true,
      }),
    ).toMatchObject({
      primary: "Visual group",
      secondary: "2 child block(s)",
      chips: ["slate", "collapsed", "freeform"],
    });
    expect(
      getBlockNodePreview({
        id: "tool",
        type: "MCP_TOOL",
        title: "Tool",
        serverId: "server",
        toolName: "run",
        arguments: { ok: true },
      }),
    ).toEqual({
      primary: "server.run",
      secondary: "Calls an MCP server tool.",
      chips: ["arguments"],
    });
    expect(
      getBlockNodePreview({
        id: "end",
        type: "END",
        title: "End",
        status: "failure",
      }),
    ).toMatchObject({ primary: "Failure end" });
  });

  it("returns prompt-like text for every non-terminal content source", () => {
    expect(getPromptLikeText(promptBlock())).toBe("Write the draft");
    expect(
      getPromptLikeText({
        id: "utility",
        type: "UTILITY",
        title: "HTTP",
        utility: { type: "HTTP_FETCH", url: "https://example.test" },
      }),
    ).toBe("HTTP Fetch");
    expect(
      getPromptLikeText({
        id: "resource",
        type: "MCP_RESOURCE",
        title: "Resource",
        serverId: "",
        uri: "file://context.md",
      }),
    ).toBe("file://context.md");
  });

  it("selects visual tone metadata for block and utility types", () => {
    expect(getBlockTone("PROMPT")).toMatchObject({
      badgeLabel: "PROMPT",
      miniMapColor: "#38bdf8",
    });
    expect(getUtilityTone("RUN_COMMAND")).toMatchObject({
      badgeLabel: "COMMAND",
      miniMapColor: "#a1a1aa",
    });
    expect(
      getBlockVisual({
        id: "fetch",
        type: "UTILITY",
        title: "Fetch",
        utility: { type: "HTTP_FETCH", url: "https://example.test" },
      }),
    ).toMatchObject({ badgeLabel: "FETCH" });
  });
});

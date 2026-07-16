import type {
  RalphFlow,
  RalphFlowBlock,
  RalphFlowSummary,
} from "../../../../core/ralph.js";
import type { ProviderModelCatalogSnapshot } from "../../model-catalog";
import { createFlowAlias } from "./create-flow-alias.helper";
import {
  getBlockOutputs,
  isExecutableRalphCanvasBlock,
  isVisualRalphCanvasBlock,
} from "./get-block-outputs.helper";
import {
  RALPH_NOTE_MIN_SIZE,
  validateFlowLocally,
} from "./validate-flow-locally.helper";

const createConnectedFlow = (overrides: Partial<RalphFlow> = {}): RalphFlow => ({
  schemaVersion: 1,
  id: "review-flow",
  alias: "review-flow",
  name: "Review Flow",
  blocks: [
    { id: "start", type: "START", title: "Start" },
    { id: "end", type: "END", title: "End", status: "success" },
  ],
  edges: [
    {
      id: "start-success-end",
      from: "start",
      fromOutput: "SUCCESS",
      to: "end",
    },
  ],
  ...overrides,
});

const createSummary = (
  summary: Partial<RalphFlowSummary> = {},
): RalphFlowSummary => ({
  id: "other-flow",
  alias: "other-flow",
  name: "Other Flow",
  path: "other-flow.json",
  blockCount: 2,
  edgeCount: 1,
  variableCount: 0,
  ...summary,
});

const issueMessages = (
  flow: RalphFlow,
  summaries: RalphFlowSummary[] = [],
  catalog: ProviderModelCatalogSnapshot | null = null,
): string[] => validateFlowLocally(flow, catalog, summaries, "workspace").map(
  (issue) => issue.message,
);

describe("Ralph flow editor local validation helpers", () => {
  it("normalizes flow aliases for empty, punctuation-heavy, and long input", () => {
    expect(createFlowAlias("  Review: PR #42!  ")).toBe("review-pr-42");
    expect(createFlowAlias("!!!")).toBe("");
    expect(createFlowAlias("a".repeat(100))).toHaveLength(80);
  });

  it("derives block outputs for utility, decision, visual, and terminal blocks", () => {
    const pollWithLimit: RalphFlowBlock = {
      id: "poll",
      type: "UTILITY",
      title: "Poll",
      utility: { type: "POLL", maxAttempts: 3 },
    };
    const pollWithoutLimit: RalphFlowBlock = {
      id: "poll-open",
      type: "UTILITY",
      title: "Poll",
      utility: { type: "POLL", maxAttempts: null },
    };
    const decision: RalphFlowBlock = {
      id: "decision",
      type: "DECISION",
      title: "Decision",
      prompt: "Choose.",
      labels: ["APPROVE", "APPROVE", "REJECT"],
    };
    const note: RalphFlowBlock = {
      id: "note",
      type: "NOTE",
      title: "Note",
      text: "Read me.",
    };

    expect(getBlockOutputs(pollWithLimit)).toEqual([
      "SUCCESS",
      "TIMEOUT",
      "ERROR",
    ]);
    expect(getBlockOutputs(pollWithoutLimit)).toEqual(["SUCCESS", "ERROR"]);
    expect(getBlockOutputs(decision)).toEqual(["APPROVE", "REJECT", "ERROR"]);
    expect(getBlockOutputs(note)).toEqual([]);
    expect(isVisualRalphCanvasBlock(note)).toBe(true);
    expect(isExecutableRalphCanvasBlock(decision)).toBe(true);
  });

  it("accepts a connected minimal flow with an empty catalog and undefined optional fields", () => {
    expect(issueMessages(createConnectedFlow({ variables: undefined }))).toEqual([]);
  });

  it("validates pinned Media Studio identity and typed bindings before save", () => {
    const flow = createConnectedFlow({
      variables: [{ name: "assetId", type: "string", required: false }],
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          id: "media-flow",
          type: "MEDIA_FLOW",
          title: "Generate assets",
          flowId: "",
          revisionId: "",
          inputBindings: {
            prompt: { source: "variable", variableName: "missingPrompt" },
          },
          outputBindings: {
            result: { source: "first-asset-id", variableName: "missingOutput" },
          },
          runPolicy: "submit-and-continue",
          approvalPolicy: "inherit-workspace",
        },
        { id: "end", type: "END", title: "End", status: "success" },
      ],
      edges: [
        {
          id: "start-media",
          from: "start",
          fromOutput: "SUCCESS",
          to: "media-flow",
        },
        {
          id: "media-end",
          from: "media-flow",
          fromOutput: "SUCCESS",
          to: "end",
        },
      ],
    });

    const messages = issueMessages(flow);
    expect(messages).toContain(
      "Generate assets requires a pinned Media Studio flow id.",
    );
    expect(messages).toContain(
      "Generate assets requires a pinned Media Studio revision id.",
    );
    expect(messages).toContain(
      "Generate assets input binding prompt is incomplete or references an undeclared Ralph variable.",
    );
    expect(messages).toContain(
      "Generate assets output result requires a declared Ralph variable.",
    );
    expect(messages).toContain(
      "Generate assets cannot bind outputs while using submit-and-continue.",
    );
  });

  it("flags duplicate aliases only inside the selected scope and outside the current flow", () => {
    const flow = createConnectedFlow({
      id: "review-flow",
      alias: "Review Flow",
    });

    expect(
      issueMessages(flow, [
        createSummary({ id: "global-review", alias: "review-flow", scope: "user" }),
        createSummary({ id: "review-flow", alias: "review-flow" }),
      ]),
    ).toEqual([]);
    expect(
      issueMessages(flow, [
        createSummary({ id: "other-review", alias: "review-flow" }),
      ]),
    ).toContain("Flow alias review-flow is already used by another flow.");
  });

  it("reports structural errors for missing starts, duplicate ids, bad edges, and visual routes", () => {
    const note: RalphFlowBlock = {
      id: "note",
      type: "NOTE",
      title: "Note",
      text: "Context",
    };
    const messages = issueMessages(
      createConnectedFlow({
        blocks: [
          { id: "end", type: "END", title: "End" },
          { id: "end", type: "END", title: "Duplicate End" },
          note,
        ],
        edges: [
          {
            id: "missing-to-note",
            from: "missing",
            fromOutput: "SUCCESS",
            to: "note",
          },
          {
            id: "note-to-missing",
            from: "note",
            fromOutput: "SUCCESS",
            to: "missing-target",
          },
        ],
      }),
    );

    expect(messages).toContain("Flow must contain exactly one START block.");
    expect(messages).toContain("Block id end is duplicated.");
    expect(messages).toContain("Edge missing-to-note references missing source missing.");
    expect(messages).toContain(
      "Edge note-to-missing references missing target missing-target.",
    );
    expect(messages).toContain("Route missing-to-note cannot target visual block Note.");
    expect(messages).toContain("Route note-to-missing cannot start from visual block Note.");
  });

  it("validates prompt-like blocks, selected validator scope, and route coverage", () => {
    const messages = issueMessages(
      createConnectedFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          { id: "prompt", type: "PROMPT", title: "Prompt", prompt: " " },
          {
            id: "validator",
            type: "VALIDATOR",
            title: "Validator",
            prompt: "Check result.",
            validationScope: { mode: "selectedBlocks", blockIds: [] },
          },
          {
            id: "decision",
            type: "DECISION",
            title: "Decision",
            prompt: "Choose.",
            labels: [],
          },
          { id: "end", type: "END", title: "End" },
        ],
        edges: [
          {
            id: "start-success-prompt",
            from: "start",
            fromOutput: "SUCCESS",
            to: "prompt",
          },
        ],
      }),
    );

    expect(messages).toContain("Prompt has an empty prompt.");
    expect(messages).toContain("Validator validates selected blocks but none are selected.");
    expect(messages).toContain("Decision needs at least one decision label.");
    expect(messages).toContain("Prompt does not route SUCCESS.");
    expect(messages).toContain("Prompt does not route ERROR.");
    expect(messages).toContain("Validator is unreachable from START.");
  });

  it("checks annotation boundary sizes at and below the configured minimums", () => {
    const atBoundary = issueMessages(
      createConnectedFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "note",
            type: "NOTE",
            title: "Note",
            text: "Context",
            size: { ...RALPH_NOTE_MIN_SIZE },
          },
          { id: "end", type: "END", title: "End" },
        ],
      }),
    );
    const belowBoundary = issueMessages(
      createConnectedFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "note",
            type: "NOTE",
            title: "Note",
            text: "",
            size: {
              width: RALPH_NOTE_MIN_SIZE.width - 1,
              height: RALPH_NOTE_MIN_SIZE.height,
            },
          },
          { id: "end", type: "END", title: "End" },
        ],
      }),
    );

    expect(atBoundary).not.toContain("Note is smaller than the note minimum size.");
    expect(belowBoundary).toContain("Note is empty.");
    expect(belowBoundary).toContain("Note is smaller than the note minimum size.");
  });

  it("warns for cycles without maxTransitions and errors for invalid maxTransitions", () => {
    const cyclicFlow = createConnectedFlow({
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          id: "prompt",
          type: "PROMPT",
          title: "Prompt",
          prompt: "Loop once.",
        },
        { id: "end", type: "END", title: "End" },
      ],
      edges: [
        {
          id: "start-success-prompt",
          from: "start",
          fromOutput: "SUCCESS",
          to: "prompt",
        },
        {
          id: "prompt-success-prompt",
          from: "prompt",
          fromOutput: "SUCCESS",
          to: "prompt",
        },
        {
          id: "prompt-error-end",
          from: "prompt",
          fromOutput: "ERROR",
          to: "end",
        },
      ],
    });

    expect(issueMessages(cyclicFlow)).toContain(
      "Flow contains a cycle but does not define settings.maxTransitions; runs can continue until manually stopped.",
    );
    expect(issueMessages({ ...cyclicFlow, settings: { maxTransitions: 1 } })).not.toContain(
      "Flow contains a cycle but does not define settings.maxTransitions; runs can continue until manually stopped.",
    );
    expect(issueMessages({ ...cyclicFlow, settings: { maxTransitions: 0 } })).toContain(
      "Flow settings.maxTransitions must be an integer >= 1.",
    );
  });

  it("warns about unavailable block providers and models when catalog data is present", () => {
    const catalog: ProviderModelCatalogSnapshot = {
      generatedAt: 1,
      providers: [
        { provider: "openai", available: false, models: [] },
        {
          provider: "anthropic",
          available: true,
          models: [{ id: "claude-opus-4-1" }],
        },
      ],
    };
    const messages = issueMessages(
      createConnectedFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "prompt-openai",
            type: "PROMPT",
            title: "OpenAI Prompt",
            prompt: "Run.",
            settings: { provider: "openai", model: "gpt-5.5" },
          },
          {
            id: "prompt-anthropic",
            type: "PROMPT",
            title: "Anthropic Prompt",
            prompt: "Run.",
            settings: { provider: "anthropic", model: "missing-model" },
          },
          { id: "end", type: "END", title: "End" },
        ],
        edges: [
          {
            id: "start-success-openai",
            from: "start",
            fromOutput: "SUCCESS",
            to: "prompt-openai",
          },
        ],
      }),
      [],
      catalog,
    );

    expect(messages).toContain("OpenAI Prompt uses unavailable provider openai.");
    expect(messages).toContain("Anthropic Prompt uses unavailable model missing-model.");
  });
});

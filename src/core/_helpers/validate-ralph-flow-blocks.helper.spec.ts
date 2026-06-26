import type {
  RalphFlow,
  RalphFlowBlock,
  RalphValidationIssue,
} from "../ralph.ts";
import { createFlow, runtimeConfig } from "../__test__/ralph-test-helpers.ts";
import { validateRalphFlowBlocks } from "./validate-ralph-flow-blocks.helper.ts";

interface ValidationResult {
  blockIds: Set<string>;
  startBlocks: RalphFlowBlock[];
  errors: RalphValidationIssue[];
  warnings: RalphValidationIssue[];
}

const validateBlocks = (
  flow: RalphFlow,
  options: { withConfig?: boolean } = {},
): ValidationResult => {
  const errors: RalphValidationIssue[] = [];
  const warnings: RalphValidationIssue[] = [];
  const result = options.withConfig
    ? validateRalphFlowBlocks({
        flow,
        config: runtimeConfig,
        errors,
        warnings,
      })
    : validateRalphFlowBlocks({
        flow,
        errors,
        warnings,
      });

  return { ...result, errors, warnings };
};

const codes = (issues: readonly RalphValidationIssue[]): string[] => {
  return issues.map((issue) => issue.code);
};

describe("validateRalphFlowBlocks", () => {
  it("accepts a valid block set and returns discovered block ids and starts", () => {
    const validation = validateBlocks(createFlow());

    expect(validation.errors).toEqual([]);
    expect(validation.warnings).toEqual([]);
    expect([...validation.blockIds]).toEqual([
      "start",
      "fix-tsc",
      "validate",
      "success",
    ]);
    expect(validation.startBlocks).toEqual([
      { id: "start", type: "START", title: "Start" },
    ]);
  });

  it("reports empty block collections as missing START", () => {
    const validation = validateBlocks(createFlow({ blocks: [] }));

    expect(codes(validation.errors)).toEqual(["missing-start"]);
    expect(validation.blockIds.size).toBe(0);
    expect(validation.startBlocks).toEqual([]);
  });

  it("reports duplicate START blocks and duplicate block ids", () => {
    const validation = validateBlocks(
      createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          { id: "start", type: "START", title: "Start again" },
        ],
      }),
    );

    expect(codes(validation.errors)).toEqual(
      expect.arrayContaining(["multiple-start", "block-id-duplicate"]),
    );
    expect(validation.startBlocks).toHaveLength(2);
  });

  it("allows confirm-only ask-user blocks without fields", () => {
    const validation = validateBlocks(
      createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "confirm",
            type: "ASK_USER",
            title: "Confirm",
            mode: "confirmOnly",
            fields: [],
          },
        ],
      }),
    );

    expect(codes(validation.errors)).not.toContain("input-fields-required");
  });

  it("validates block id, title, size, prompt, and decision label requirements", () => {
    const validation = validateBlocks(
      createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "",
            type: "PROMPT",
            title: "",
            prompt: "",
            size: { width: 0, height: Number.NaN },
          },
          {
            id: "Bad ID",
            type: "DECISION",
            title: "Decision",
            prompt: " ",
            labels: [],
          },
        ],
      }),
    );

    expect(codes(validation.errors)).toEqual(
      expect.arrayContaining([
        "block-id-required",
        "block-id-invalid",
        "block-title-required",
        "block-size-invalid",
        "block-prompt-required",
        "decision-labels-required",
      ]),
    );
  });

  it("enforces note and group size boundaries while allowing collapsed groups", () => {
    const validation = validateBlocks(
      createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "note",
            type: "NOTE",
            title: "Note",
            text: " ",
            size: { width: 179, height: 120 },
          },
          {
            id: "group",
            type: "GROUP",
            title: "Group",
            childBlockIds: [],
            size: { width: 280, height: 179 },
          },
          {
            id: "collapsed",
            type: "GROUP",
            title: "Collapsed",
            childBlockIds: [],
            collapsed: true,
            size: { width: 1, height: 1 },
          },
        ],
      }),
    );

    expect(codes(validation.errors)).toEqual(
      expect.arrayContaining(["note-size-invalid", "group-size-invalid"]),
    );
    expect(codes(validation.warnings)).toContain("note-empty");
    expect(validation.errors).not.toContainEqual(
      expect.objectContaining({ blockId: "collapsed" }),
    );
  });

  it("reports pack metadata warnings and missing block result references", () => {
    const validation = validateBlocks(
      createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          { id: "empty-pack", type: "PACK", title: "Empty pack", packIds: [] },
          {
            id: "pack",
            type: "PACK",
            title: "Pack",
            packIds: ["docs"],
            settings: { packs: ["runtime-docs"] },
          },
          {
            id: "prompt",
            type: "PROMPT",
            title: "Prompt",
            prompt: "Use {{result:missing-block}} and {{bad:unsupported}}.",
          },
        ],
      }),
    );

    expect(codes(validation.warnings)).toEqual(
      expect.arrayContaining([
        "pack-empty",
        "pack-runtime-not-implemented",
        "settings-packs-runtime-not-implemented",
        "missing-result-reference",
      ]),
    );
    expect(codes(validation.errors)).toContain("invalid-placeholder");
  });

  it("validates block settings boundaries and unavailable providers", () => {
    const validation = validateBlocks(
      createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "too-low",
            type: "PROMPT",
            title: "Too low",
            prompt: "Run.",
            settings: {
              maxIterations: 0,
              retry: { mode: "finite", maxRetries: null },
            },
          },
          {
            id: "too-high",
            type: "PROMPT",
            title: "Too high",
            prompt: "Run.",
            settings: {
              maxIterations: 101,
              provider: "anthropic",
            },
          },
          {
            id: "boundary",
            type: "PROMPT",
            title: "Boundary",
            prompt: "Run.",
            settings: {
              maxIterations: 100,
              retry: { mode: "finite", maxRetries: 0 },
              provider: "default",
            },
          },
        ],
      }),
      { withConfig: true },
    );

    expect(codes(validation.errors)).toEqual(
      expect.arrayContaining([
        "max-iterations-invalid",
        "retry-invalid",
        "provider-unavailable",
      ]),
    );
    expect(validation.errors).not.toContainEqual(
      expect.objectContaining({ blockId: "boundary" }),
    );
  });

  it("validates MCP block required fields without loading config for templated servers", () => {
    const validation = validateBlocks(
      createFlow({
        blocks: [
          { id: "start", type: "START", title: "Start" },
          {
            id: "tool",
            type: "MCP_TOOL",
            title: "Tool",
            serverId: "",
            toolName: "",
          },
          {
            id: "resource",
            type: "MCP_RESOURCE",
            title: "Resource",
            serverId: "{{serverId}}",
            uri: "",
          },
          {
            id: "prompt",
            type: "MCP_PROMPT",
            title: "Prompt",
            serverId: "{{serverId}}",
            promptName: "",
          },
        ],
      }),
      { withConfig: true },
    );

    expect(codes(validation.errors)).toEqual(
      expect.arrayContaining([
        "mcp-server-required",
        "mcp-tool-required",
        "mcp-resource-uri-required",
        "mcp-prompt-required",
      ]),
    );
    expect(codes(validation.errors)).not.toContain("mcp-config-invalid");
  });
});

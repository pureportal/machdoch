import { coerceRalphFlowBlockRecord } from "./coerce-ralph-flow-block-record.helper.ts";

describe("coerceRalphFlowBlockRecord", () => {
  it("normalizes common block base fields and settings", () => {
    const block = coerceRalphFlowBlockRecord({
      id: "prompt",
      type: "PROMPT",
      title: "Prompt",
      prompt: "Do work.",
      position: { x: 10, y: 20 },
      size: { width: 320, height: 180 },
      locked: true,
      parentGroupId: "group",
      groupBoundary: true,
      settings: {
        workspace: { mode: "default" },
        provider: "default",
        model: "gpt-5",
        reasoning: "default",
        webAccess: false,
        fileAccess: true,
        attachments: [{ source: "path", value: "README.md", kind: "file" }],
        packs: ["core", null, "docs"],
        maxIterations: 5,
        timeoutSeconds: 120,
        temperature: 0.1,
        retry: { mode: "finite", maxRetries: 2, delaySeconds: 3 },
      },
    });

    expect(block).toMatchObject({
      id: "prompt",
      type: "PROMPT",
      title: "Prompt",
      prompt: "Do work.",
      position: { x: 10, y: 20 },
      size: { width: 320, height: 180 },
      locked: true,
      parentGroupId: "group",
      groupBoundary: true,
      settings: {
        workspace: { mode: "default" },
        provider: "default",
        model: "gpt-5",
        reasoning: "default",
        webAccess: false,
        fileAccess: true,
        attachments: [{ source: "path", value: "README.md", kind: "file" }],
        packs: ["core", "docs"],
        maxIterations: 5,
        timeoutSeconds: 120,
        temperature: 0.1,
        retry: { mode: "finite", maxRetries: 2, delaySeconds: 3 },
      },
    });
  });

  it("coerces input field defaults, options, validation, and timeout boundaries", () => {
    const block = coerceRalphFlowBlockRecord({
      id: "input",
      type: "INPUT",
      title: "Input",
      prompt: "Choose values.",
      timeoutSeconds: null,
      fields: [
        {
          id: "choice",
          label: "Choice",
          type: "select",
          required: true,
          defaultValue: ["alpha", 1, "beta"],
          options: [
            "alpha",
            { value: "beta", label: "Beta" },
            { value: "", label: "Ignored" },
            42,
          ],
          validation: {
            min: 1,
            max: Number.POSITIVE_INFINITY,
            maxLength: 20,
            pattern: "^[a-z]+$",
          },
          variableName: "selectedChoice",
        },
        null,
        { id: 1, label: false, type: "unsupported", options: "bad" },
      ],
    });

    expect(block).toMatchObject({
      id: "input",
      type: "INPUT",
      title: "Input",
      prompt: "Choose values.",
      timeoutSeconds: null,
      fields: [
        {
          id: "choice",
          label: "Choice",
          type: "select",
          required: true,
          defaultValue: ["alpha", "beta"],
          options: [
            { value: "alpha", label: "alpha" },
            { value: "beta", label: "Beta" },
          ],
          validation: {
            min: 1,
            maxLength: 20,
            pattern: "^[a-z]+$",
          },
          variableName: "selectedChoice",
        },
        {
          id: "",
          label: "",
          type: "text",
          options: [],
        },
      ],
    });
  });

  it("uses safe defaults for malformed block variants", () => {
    expect(
      coerceRalphFlowBlockRecord({
        id: 123,
        type: "UNKNOWN",
        title: false,
        prompt: 7,
        position: { x: 1 },
        size: { width: 100 },
        settings: null,
      }),
    ).toEqual({
      id: "",
      title: "",
      type: "PROMPT",
      prompt: "",
    });

    expect(
      coerceRalphFlowBlockRecord({
        id: "group",
        type: "GROUP",
        title: "Group",
        tone: "invalid",
        childBlockIds: [1, "child"],
        maxDepth: 2.9,
        layoutMode: "grid",
        executionBoundary: { mode: "unsupported", blockId: "child" },
      }),
    ).toMatchObject({
      id: "group",
      type: "GROUP",
      childBlockIds: ["child"],
      maxDepth: 2,
      layoutMode: "freeform",
      executionBoundary: { mode: "none", blockId: "child" },
    });

    expect(
      coerceRalphFlowBlockRecord({
        id: "end",
        type: "END",
        title: "End",
        status: "unsupported",
      }),
    ).toEqual({
      id: "end",
      title: "End",
      type: "END",
      status: "success",
    });
  });

  it.each([undefined, null, [], "bad"])(
    "drops non-record MCP arguments for %#",
    (value) => {
      expect(
        coerceRalphFlowBlockRecord({
          id: "tool",
          type: "MCP_TOOL",
          title: "Tool",
          serverId: "github",
          toolName: "get_issue",
          arguments: value,
        }),
      ).toEqual({
        id: "tool",
        title: "Tool",
        type: "MCP_TOOL",
        serverId: "github",
        toolName: "get_issue",
      });
    },
  );
});

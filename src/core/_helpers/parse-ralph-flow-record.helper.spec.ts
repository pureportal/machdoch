import { parseRalphFlowRecord } from "./parse-ralph-flow-record.helper.ts";

describe("parseRalphFlowRecord", () => {
  it.each([undefined, null, [], "flow", 42])(
    "rejects non-object flow input %#",
    (value) => {
      expect(() => parseRalphFlowRecord(value)).toThrow(
        "Expected Ralph flow JSON to be an object.",
      );
    },
  );

  it("normalizes a representative flow record", () => {
    const flow = parseRalphFlowRecord({
      schemaVersion: 1,
      id: "refactor-flow",
      alias: "refactor",
      name: "Refactor flow",
      description: "Improve the code.",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      settings: { maxTransitions: 10.9 },
      variables: [
        { name: "scope", type: "path", default: "ALL" },
        { name: "fallback", type: "unsupported", required: false },
        "ignored",
      ],
      blocks: [
        {
          id: "start",
          type: "START",
          title: "Start",
          position: { x: 1, y: 2 },
          size: { width: 320, height: 180 },
          settings: {
            workspace: { mode: "custom", path: "." },
            provider: "default",
            model: "gpt-5",
            reasoning: "default",
            webAccess: true,
            fileAccess: false,
            attachments: [{ source: "path", value: "README.md", kind: "file" }],
            packs: ["core", 123, "ui"],
            maxIterations: 4,
            timeoutSeconds: 60,
            temperature: 0.2,
            internalValidatorEnabled: true,
            retry: { mode: "finite", maxRetries: 2, delaySeconds: 5 },
          },
        },
        {
          id: "decide",
          type: "DECISION",
          title: "Decide",
          prompt: "Pick a route.",
          labels: ["DONE", false, "RETRY"],
        },
        {
          id: "utility",
          type: "UTILITY",
          title: "Utility",
          utility: { type: "READ_FILE", path: "package.json" },
        },
        {
          id: "tool",
          type: "MCP_TOOL",
          title: "Tool",
          serverId: "github",
          toolName: "get_issue",
          arguments: { owner: "local", count: 1 },
        },
        {
          id: "note",
          type: "NOTE",
          title: "Note",
          text: " ",
          content: "Use this note body.",
          tone: "rose",
          tags: ["risk", 1],
          collapsed: true,
          pinnedBlockIds: ["start", 2],
        },
        {
          id: "group",
          type: "GROUP",
          title: "Group",
          description: "Section",
          childBlockIds: ["decide", 3],
          collapsed: false,
          locked: true,
          moveChildren: false,
          maxDepth: 2.8,
          layoutMode: "stack",
          executionBoundary: {
            mode: "selectedChild",
            blockId: "decide",
          },
        },
        {
          id: "end",
          type: "END",
          title: "End",
          status: "review",
        },
      ],
      edges: [
        { id: "start-to-decide", from: "start", fromOutput: "SUCCESS", to: "decide" },
        "ignored",
      ],
      annotationLinks: [
        { id: "link-1", from: "note", to: "group", kind: "evidence" },
      ],
    });

    expect(flow).toMatchObject({
      schemaVersion: 1,
      id: "refactor-flow",
      alias: "refactor",
      name: "Refactor flow",
      description: "Improve the code.",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      settings: { maxTransitions: 10 },
      variables: [
        { name: "scope", type: "path", default: "ALL", required: false },
        { name: "fallback", type: "string", required: false },
      ],
      edges: [
        { id: "start-to-decide", from: "start", fromOutput: "SUCCESS", to: "decide" },
      ],
      annotationLinks: [
        { id: "link-1", from: "note", to: "group", kind: "evidence" },
      ],
    });
    expect(flow.blocks).toHaveLength(7);
    expect(flow.blocks[0]).toMatchObject({
      id: "start",
      type: "START",
      title: "Start",
      position: { x: 1, y: 2 },
      size: { width: 320, height: 180 },
      settings: {
        workspace: { mode: "custom", path: "." },
        provider: "default",
        model: "gpt-5",
        reasoning: "default",
        webAccess: true,
        fileAccess: false,
        attachments: [{ source: "path", value: "README.md", kind: "file" }],
        packs: ["core", "ui"],
        maxIterations: 4,
        timeoutSeconds: 60,
        temperature: 0.2,
        internalValidatorEnabled: true,
        retry: { mode: "finite", maxRetries: 2, delaySeconds: 5 },
      },
    });
    expect(flow.blocks[1]).toMatchObject({
      id: "decide",
      type: "DECISION",
      labels: ["DONE", "RETRY"],
    });
    expect(flow.blocks[2]).toMatchObject({
      id: "utility",
      type: "UTILITY",
      utility: { type: "READ_FILE", path: "package.json" },
    });
    expect(flow.blocks[3]).toMatchObject({
      id: "tool",
      type: "MCP_TOOL",
      arguments: { owner: "local", count: 1 },
    });
    expect(flow.blocks[4]).toMatchObject({
      id: "note",
      type: "NOTE",
      text: "Use this note body.",
      tone: "rose",
      tags: ["risk"],
      collapsed: true,
      pinnedBlockIds: ["start"],
    });
    expect(flow.blocks[5]).toMatchObject({
      id: "group",
      type: "GROUP",
      childBlockIds: ["decide"],
      maxDepth: 2,
      layoutMode: "stack",
      executionBoundary: { mode: "selectedChild", blockId: "decide" },
    });
    expect(flow.blocks[6]).toMatchObject({
      id: "end",
      type: "END",
      status: "review",
    });
  });

  it("preserves parser defaults for malformed optional fields", () => {
    const flow = parseRalphFlowRecord({
      schemaVersion: null,
      id: 123,
      name: false,
      settings: { maxTransitions: Number.POSITIVE_INFINITY },
      variables: [null, { name: 1, type: "path" }],
      blocks: [
        null,
        {
          id: 123,
          type: "UNKNOWN",
          title: false,
          prompt: 7,
        },
        {
          id: "group",
          type: "GROUP",
          title: "Group",
          childBlockIds: [1],
          maxDepth: 3.9,
          layoutMode: "grid",
          executionBoundary: { mode: "unsupported", blockId: "child" },
        },
        {
          id: "end",
          type: "END",
          title: "End",
          status: "unsupported",
        },
      ],
      edges: [null, { id: 1, from: 2, fromOutput: 3, to: 4 }],
      annotationLinks: [null, { id: 1, from: 2, to: 3, kind: "unsupported" }],
    });

    expect(flow).toEqual({
      schemaVersion: 1,
      id: "",
      name: "",
      variables: [{ name: "", type: "path", required: true }],
      blocks: [
        { id: "", title: "", type: "PROMPT", prompt: "" },
        {
          id: "group",
          title: "Group",
          type: "GROUP",
          childBlockIds: [],
          maxDepth: 3,
          layoutMode: "freeform",
          executionBoundary: { mode: "none", blockId: "child" },
        },
        { id: "end", title: "End", type: "END", status: "success" },
      ],
      edges: [{ id: "", from: "", fromOutput: "", to: "" }],
      annotationLinks: [{ id: "", from: "", to: "", kind: "explains" }],
    });
  });
});

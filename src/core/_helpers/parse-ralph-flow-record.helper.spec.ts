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
      source: {
        kind: "starter",
        id: "autonomous-refactoring-flow",
        version: 2.9,
        importedAt: "2026-01-01T00:00:00.000Z",
        templateFingerprint: "sha256:starter-v2",
        templateVariableDefaults: {
          scope: "ALL",
          newlyAdded: null,
          ignored: 42,
        },
      },
      settings: {
        maxTransitions: 10.9,
        autonomy: {
          enabled: true,
          maxRecoveryAttempts: 4.8,
          recoveryExhaustion: "defer",
          transitionExhaustion: "checkpoint",
          deferToBlockId: "utility",
          backoff: {
            initialDelaySeconds: 0,
            multiplier: 2,
            maxDelaySeconds: 10,
          },
        },
      },
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
    });

    expect(flow).toMatchObject({
      schemaVersion: 1,
      id: "refactor-flow",
      alias: "refactor",
      name: "Refactor flow",
      description: "Improve the code.",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      source: {
        kind: "starter",
        id: "autonomous-refactoring-flow",
        version: 2,
        importedAt: "2026-01-01T00:00:00.000Z",
        templateFingerprint: "sha256:starter-v2",
        templateVariableDefaults: {
          scope: "ALL",
          newlyAdded: undefined,
        },
      },
      settings: {
        maxTransitions: 10,
        autonomy: {
          enabled: true,
          maxRecoveryAttempts: 4,
          recoveryExhaustion: "defer",
          transitionExhaustion: "checkpoint",
          deferToBlockId: "utility",
          backoff: {
            initialDelaySeconds: 0,
            multiplier: 2,
            maxDelaySeconds: 10,
          },
        },
      },
      variables: [
        { name: "scope", type: "path", default: "ALL", required: false },
        { name: "fallback", type: "string", required: false },
      ],
      edges: [
        { id: "start-to-decide", from: "start", fromOutput: "SUCCESS", to: "decide" },
      ],
    });
    expect(flow.blocks).toHaveLength(5);
    expect(flow.blocks[0]).toMatchObject({
      id: "start",
      type: "START",
      title: "Start",
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
      id: "end",
      type: "END",
      status: "review",
    });
  });

  it("keeps a malformed schema version invalid while coercing optional fields", () => {
    const flow = parseRalphFlowRecord({
      schemaVersion: null,
      id: 123,
      name: false,
      settings: { maxTransitions: Number.POSITIVE_INFINITY },
      source: {
        kind: "unsupported",
        id: "autonomous-refactoring-flow",
        version: "2",
      },
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
          id: "end",
          type: "END",
          title: "End",
          status: "unsupported",
        },
      ],
      edges: [null, { id: 1, from: 2, fromOutput: 3, to: 4 }],
    });

    expect(flow).toEqual({
      schemaVersion: Number.NaN,
      id: "",
      name: "",
      variables: [{ name: "", type: "path", required: true }],
      blocks: [
        { id: "", title: "", type: "PROMPT", prompt: "" },
        { id: "end", title: "End", type: "END" },
      ],
      edges: [{ id: "", from: "", fromOutput: "", to: "" }],
    });
  });

  it("preserves templated numeric utility limits while parsing stored flows", () => {
    const flow = parseRalphFlowRecord({
      schemaVersion: 1,
      id: "bounded-flow",
      name: "Bounded flow",
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          id: "counter",
          type: "UTILITY",
          title: "Counter",
          utility: {
            type: "LOOP_COUNTER",
            maxAttempts: "{{maxPasses:number=3}}",
            maxDepth: "{{maxDepth:number=4}}",
            maxResults: "{{maxResults:number=200}}",
          },
        },
      ],
      edges: [],
    });

    expect(flow.blocks[1]).toMatchObject({
      type: "UTILITY",
      utility: {
        maxAttempts: "{{maxPasses:number=3}}",
        maxDepth: "{{maxDepth:number=4}}",
        maxResults: "{{maxResults:number=200}}",
      },
    });
  });
});

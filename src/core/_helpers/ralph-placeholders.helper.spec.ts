import type { RalphFlow } from "../ralph.ts";
import {
  discoverRalphFlowVariables as discoverPublicRalphFlowVariables,
  RALPH_FLOW_SCHEMA_VERSION,
} from "../ralph.ts";
import {
  collectRalphTemplateTexts,
  discoverRalphFlowVariables,
  extractRalphPlaceholders,
  getRalphAttachmentTemplateTexts,
  getRalphPromptLikeTexts,
  hasRalphPlaceholders,
  isPlainRalphVariableReference,
  parseRalphPlaceholderContent,
} from "./ralph-placeholders.helper.ts";

const createFlow = (overrides: Partial<RalphFlow> = {}): RalphFlow => ({
  schemaVersion: RALPH_FLOW_SCHEMA_VERSION,
  id: "flow",
  name: "Flow",
  variables: [],
  blocks: [],
  edges: [],
  ...overrides,
});

describe("parseRalphPlaceholderContent", () => {
  it.each([
    ["lastResult"],
    ["lastResultSummary"],
    ["lastError"],
    ["lastData"],
    ["runLog"],
  ] as const)("parses builtin placeholder %s", (content) => {
    expect(parseRalphPlaceholderContent(`{{${content}}}`, content)).toEqual({
      raw: `{{${content}}}`,
      content,
      builtin: content,
    });
  });

  it.each([
    [
      "result:fetch-data",
      { kind: "result", blockId: "fetch-data" },
    ],
    [
      "data:fetch-data:items[0].name",
      { kind: "data", blockId: "fetch-data", path: "items[0].name" },
    ],
  ] as const)("parses block reference placeholder %s", (content, blockReference) => {
    expect(parseRalphPlaceholderContent(`{{${content}}}`, content)).toEqual({
      raw: `{{${content}}}`,
      content,
      blockReference,
    });
  });

  it.each([
    [
      "name",
      { name: "name", type: "string", required: true },
    ],
    [
      "count:number=3",
      { name: "count", type: "number", default: "3", required: false },
    ],
    [
      "empty:string=",
      { name: "empty", type: "string", default: "", required: false },
    ],
  ] as const)("parses variable placeholder %s", (content, variable) => {
    expect(parseRalphPlaceholderContent(`{{${content}}}`, content)).toEqual({
      raw: `{{${content}}}`,
      content,
      variable,
    });
  });

  it.each([
    ["", "invalid Ralph variable syntax"],
    ["1bad", "invalid Ralph variable syntax"],
    ["name:unsupported", "unsupported variable type `unsupported`"],
  ] as const)("returns an invalid placeholder for %j", (content, message) => {
    expect(parseRalphPlaceholderContent(`{{${content}}}`, content).invalid).toContain(
      message,
    );
  });
});

describe("extractRalphPlaceholders", () => {
  it("extracts and trims placeholders from text", () => {
    expect(extractRalphPlaceholders("Hello {{ name }} and {{count:number=3}}")).toEqual([
      {
        raw: "{{ name }}",
        content: "name",
        variable: { name: "name", type: "string", required: true },
      },
      {
        raw: "{{count:number=3}}",
        content: "count:number=3",
        variable: { name: "count", type: "number", default: "3", required: false },
      },
    ]);
  });

  it.each(["", "plain text", "{not a placeholder}"] as const)(
    "returns no placeholders for %j",
    (text) => {
      expect(extractRalphPlaceholders(text)).toEqual([]);
    },
  );

  it("returns an invalid placeholder for empty placeholder content", () => {
    expect(extractRalphPlaceholders("{{ }}")).toEqual([
      {
        raw: "{{ }}",
        content: "",
        invalid: "placeholder `{{ }}` has invalid Ralph variable syntax.",
      },
    ]);
  });
});

describe("hasRalphPlaceholders", () => {
  it.each([
    ["{{name}}", true],
    ["before {{ name }} after", true],
    ["", false],
    ["plain text", false],
    ["{{ }}", true],
  ] as const)("returns %s for %j", (text, expected) => {
    expect(hasRalphPlaceholders(text)).toBe(expected);
  });
});

describe("collectRalphTemplateTexts", () => {
  it("collects nested strings and skips non-string leaves", () => {
    expect(
      collectRalphTemplateTexts({
        a: "{{one}}",
        b: ["{{two}}", 3, null, { c: "{{three}}" }],
        d: undefined,
      }),
    ).toEqual(["{{one}}", "{{two}}", "{{three}}"]);
  });

  it.each([null, undefined, 42, true] as const)(
    "returns no texts for non-template input %#",
    (value) => {
      expect(collectRalphTemplateTexts(value)).toEqual([]);
    },
  );
});

describe("getRalphPromptLikeTexts", () => {
  it("collects prompt and nested utility template text", () => {
    expect(
      getRalphPromptLikeTexts({
        id: "prompt",
        title: "Prompt",
        type: "PROMPT",
        prompt: "Hello {{name}}",
      }),
    ).toEqual(["Hello {{name}}"]);

    expect(
      getRalphPromptLikeTexts({
        id: "utility",
        title: "Utility",
        type: "UTILITY",
        utility: {
          type: "HTTP_FETCH",
          url: "{{baseUrl}}/health",
          headers: { Authorization: "Bearer {{token}}" },
        },
      }),
    ).toEqual(["HTTP_FETCH", "{{baseUrl}}/health", "Bearer {{token}}"]);
  });
});

describe("getRalphAttachmentTemplateTexts", () => {
  it("treats plain variable attachments as file placeholders", () => {
    expect(
      getRalphAttachmentTemplateTexts({
        id: "prompt",
        title: "Prompt",
        type: "PROMPT",
        prompt: "",
        settings: {
          attachments: [
            { source: "variable", value: " SCREENSHOT_PATH " },
            { source: "path", value: "{{artifactPath:file}}" },
          ],
        },
      }),
    ).toEqual(["{{SCREENSHOT_PATH:file}}", "{{artifactPath:file}}"]);
  });
});

describe("isPlainRalphVariableReference", () => {
  it.each([
    ["SCREENSHOT_PATH", true],
    [" screenshot-path ", true],
    ["{{SCREENSHOT_PATH}}", false],
    ["path/to/file", false],
    ["", false],
  ] as const)("returns %s for %j", (value, expected) => {
    expect(isPlainRalphVariableReference(value)).toBe(expected);
  });
});

describe("discoverRalphFlowVariables", () => {
  const flow = createFlow({
    variables: [
      { name: "shared", type: "boolean", default: "true", required: false },
      { name: "   ", type: "string", required: true },
    ],
    blocks: [
      {
        id: "prompt",
        title: "Prompt",
        type: "PROMPT",
        prompt:
          "Hello {{ name }} {{ shared:string=from-prompt }} {{ count:number=3 }} {{bad:unsupported}}",
        settings: {
          attachments: [{ source: "variable", value: " SCREENSHOT_PATH " }],
        },
      },
      {
        id: "tool",
        title: "Tool",
        type: "MCP_TOOL",
        serverId: "server",
        toolName: "tool",
        arguments: {
          url: "{{targetUrl:url=https://example.com}}",
          flags: ["{{enabled:boolean=false}}", 1],
        },
      },
      {
        id: "set-variable",
        title: "Set variable",
        type: "UTILITY",
        utility: {
          type: "SET_VARIABLE",
          variableName: " runtimeValue ",
          value: "done",
        },
      },
    ],
  });

  it("discovers declared variables, placeholders, attachment variables, and set-variable outputs", () => {
    const variables = discoverRalphFlowVariables(flow);
    const byName = new Map(variables.map((variable) => [variable.name, variable]));

    expect([...byName.keys()]).toEqual([
      "count",
      "enabled",
      "name",
      "runtimeValue",
      "SCREENSHOT_PATH",
      "shared",
      "targetUrl",
    ]);
    expect(byName.get("count")).toEqual({
      name: "count",
      type: "number",
      default: "3",
      required: false,
    });
    expect(byName.get("SCREENSHOT_PATH")).toEqual({
      name: "SCREENSHOT_PATH",
      type: "file",
      required: true,
    });
    expect(byName.get("runtimeValue")).toEqual({
      name: "runtimeValue",
      type: "string",
      required: false,
    });
  });

  it("preserves declared variable type, default, and required flag over placeholders", () => {
    expect(discoverRalphFlowVariables(flow)).toContainEqual({
      name: "shared",
      type: "boolean",
      default: "true",
      required: false,
    });
  });

  it("preserves the public export from ralph.ts", () => {
    expect(discoverPublicRalphFlowVariables(flow)).toEqual(
      discoverRalphFlowVariables(flow),
    );
  });
});

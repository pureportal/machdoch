import type {
  RalphFlow,
  RalphInputField,
  RalphPromptBlock,
} from "../../../../core/ralph.js";
import type { RalphGenerationInterviewSession } from "../../../../core/ralph-generation.js";
import type { ProviderModelCatalogSnapshot } from "../../model-catalog";
import {
  createLocalGenerationInterviewPrompt,
  createPromptBlockGenerationPrompt,
  getEffectiveProvider,
  getPreferredModelForProvider,
  getProviderOption,
  getTrimmedGenerationInterviewAnswerComments,
  isRalphPromptBlock,
  parseJsonDraft,
  parseNumberList,
  parseStringRecordDraft,
} from "./ralph-generation-formatting.helper";

describe("ralph-generation-formatting helper", () => {
  it("parses JSON drafts into unknown values and typed records", () => {
    expect(parseJsonDraft('{"enabled":true}')).toEqual({ enabled: true });
    expect(parseJsonDraft("{")).toBeUndefined();
    expect(parseStringRecordDraft('{"a":"one","b":2}')).toEqual({ a: "one" });
    expect(parseStringRecordDraft("[]")).toBeUndefined();
  });

  it("parses comma separated number lists", () => {
    expect(parseNumberList("200, 404, nope, 500")).toEqual([200, 404, 500]);
    expect(parseNumberList("nope")).toBeUndefined();
  });

  it("normalizes provider defaults and preferred models", () => {
    const snapshot: ProviderModelCatalogSnapshot = {
      generatedAt: 1,
      providers: [
        {
          provider: "openai",
          available: true,
          models: [{ id: "unsupported-openai-model" }],
        },
      ],
    };

    expect(getProviderOption("openai")).toBe("openai");
    expect(getProviderOption("not-a-provider" as never)).toBe("default");
    expect(getEffectiveProvider("default", "openai")).toBe("openai");
    expect(getPreferredModelForProvider("openai", snapshot)).toBe("gpt-5.5");
  });

  it("detects prompt blocks and creates prompt block generation prompts", () => {
    const block: RalphPromptBlock = {
      id: "prompt-1",
      type: "PROMPT",
      title: "Draft",
      prompt: "Write the response.",
    };
    const flow: RalphFlow = {
      schemaVersion: 1,
      id: "flow",
      name: "Flow",
      blocks: [block],
      edges: [],
    };

    expect(isRalphPromptBlock(flow.blocks[0])).toBe(true);
    expect(createPromptBlockGenerationPrompt("Make it shorter.", block)).toContain(
      '"prompt": "Write the response."',
    );
  });

  it("formats interview context with trimmed answer comments", () => {
    const fields: RalphInputField[] = [
      { id: "scope", label: "Scope", type: "text" },
    ];
    const session: RalphGenerationInterviewSession = {
      id: "session-1",
      prompt: "Build a flow",
      scope: "workspace",
      target: "flow",
      turn: 1,
      maxTurns: 5,
      contextSummary: "Need a project flow.",
      findings: [],
      assumptions: [],
      relevantFiles: [],
      transcript: [
        {
          turn: 1,
          questions: fields,
          answers: [
            {
              fieldId: "scope",
              label: "Scope",
              type: "text",
              value: "src",
              comment: "Focus source",
            },
          ],
          createdAt: "2026-06-30T00:00:00.000Z",
        },
      ],
    };

    const comments = getTrimmedGenerationInterviewAnswerComments({
      scope: "  keep tests focused  ",
      empty: "  ",
    });

    expect(comments).toEqual({ scope: "keep tests focused" });
    expect(
      createLocalGenerationInterviewPrompt(
        {
          generationPrompt: "Generate flow.",
          userPrompt: "Build a flow",
        },
        session,
        fields,
        { scope: "src" },
        comments,
      ),
    ).toContain("Comment: keep tests focused");
  });

});

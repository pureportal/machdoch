import { normalizeRalphInterviewGeneration } from "./normalize-ralph-interview-generation.helper.ts";

describe("normalizeRalphInterviewGeneration", () => {
  it("normalizes generated interview fields and trims optional metadata", () => {
    const result = normalizeRalphInterviewGeneration(
      {
        complete: false,
        summary: "  Need account details.  ",
        questions: [
          {
            id: "  123 account name!  ",
            label: "  Account name?  ",
            type: "string",
            placeholder: "  Acme  ",
            help: "  Used for setup  ",
          },
          {
            id: "plan",
            label: "Plan?",
            type: "single-choice",
            options: [
              " Basic ",
              { value: "pro", label: " Pro plan " },
            ],
          },
        ],
      },
      { questionsPerTurn: 5 },
    );

    expect(result).toEqual({
      complete: false,
      summary: "Need account details.",
      fields: [
        {
          id: "_account_name_",
          label: "Account name?",
          type: "text",
          required: false,
          skippable: true,
          placeholder: "Acme",
          help: "Used for setup",
        },
        {
          id: "plan",
          label: "Plan?",
          type: "select",
          required: false,
          skippable: true,
          options: [
            { value: "Basic", label: "Basic" },
            { value: "pro", label: "Pro plan" },
          ],
        },
      ],
    });
  });

  it("uses question text, fallback ids, default type, and default question limit", () => {
    const result = normalizeRalphInterviewGeneration(
      {
        complete: true,
        summary: "   ",
        questions: [
          { question: "First?", type: null },
          { question: "Second?", id: "123" },
          { question: "Third?", type: "url" },
          { question: "Fourth?" },
        ],
      },
      {},
    );

    expect(result).toEqual({
      complete: true,
      fields: [
        {
          id: "q_1",
          label: "First?",
          type: "textarea",
          required: false,
          skippable: true,
        },
        {
          id: "q_2",
          label: "Second?",
          type: "textarea",
          required: false,
          skippable: true,
        },
        {
          id: "q_3",
          label: "Third?",
          type: "url",
          required: false,
          skippable: true,
        },
      ],
    });
  });

  it("rejects non-object responses and ignores malformed questions", () => {
    expect(() => normalizeRalphInterviewGeneration(null, {})).toThrow(
      "Interview AI response must be a JSON object.",
    );

    expect(
      normalizeRalphInterviewGeneration(
        {
          questions: [
            null,
            "question",
            { label: "   " },
            { label: "Missing options", type: "multiselect" },
            { label: "Valid boolean", type: "checkbox" },
          ],
        },
        { questionsPerTurn: 10 },
      ),
    ).toEqual({
      complete: false,
      fields: [
        {
          id: "q_5",
          label: "Valid boolean",
          type: "boolean",
          required: false,
          skippable: true,
        },
      ],
    });
  });

  it("filters blank options and caps option lists", () => {
    const result = normalizeRalphInterviewGeneration(
      {
        questions: [
          {
            label: "Choose many",
            type: "checkboxes",
            options: [
              "",
              { value: "   ", label: "Blank" },
              ...Array.from({ length: 25 }, (_, index) => `option-${index + 1}`),
            ],
          },
        ],
      },
      { questionsPerTurn: 1 },
    );

    expect(result.fields).toHaveLength(1);
    expect(result.fields[0]?.type).toBe("multiselect");
    expect(result.fields[0]?.options).toHaveLength(20);
    expect(result.fields[0]?.options?.[0]).toEqual({
      value: "option-1",
      label: "option-1",
    });
    expect(result.fields[0]?.options?.[19]).toEqual({
      value: "option-20",
      label: "option-20",
    });
  });

  it("treats missing and non-array question lists as empty", () => {
    expect(normalizeRalphInterviewGeneration({}, {})).toEqual({
      complete: false,
      fields: [],
    });
    expect(
      normalizeRalphInterviewGeneration({ questions: "not an array" }, {}),
    ).toEqual({
      complete: false,
      fields: [],
    });
  });
});

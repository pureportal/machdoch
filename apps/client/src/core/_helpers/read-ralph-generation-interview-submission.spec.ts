import { describe, expect, it } from "vitest";
import {
  RALPH_GENERATION_INTERVIEW_SECTION_TITLE,
  normalizeRalphGenerationInterviewSubmission,
  readRalphGenerationInterviewSubmission,
} from "./read-ralph-generation-interview-submission.helper.js";
import type { TaskExecutionResult } from "../types.js";

const createResult = (
  overrides: Partial<TaskExecutionResult> = {},
): TaskExecutionResult =>
  ({
    task: "interview",
    mode: "machdoch",
    status: "completed",
    summary: "",
    executedTools: [],
    outputSections: [],
    ...overrides,
  }) as TaskExecutionResult;

describe("normalizeRalphGenerationInterviewSubmission", () => {
  it("normalizes a complete interview contract", () => {
    const submission = normalizeRalphGenerationInterviewSubmission({
      complete: true,
      summary: "  Ready to build. ",
      questionScope: "  scope ",
      contextSummary: " context ",
      findings: [" first ", "", 3, "second"],
      assumptions: ["A"],
      relevantFiles: [" src/app.ts "],
      questions: [
        {
          id: " User Need? ",
          label: "  User need ",
          type: "single-choice",
          required: true,
          skippable: false,
          placeholder: " choose ",
          help: " Keep   it concise. ",
          default: "A",
          variableName: " need ",
          options: [" A ", { value: "B", label: " Bee " }, "", { label: "No value" }],
          validation: { minLength: 2, maxLength: 20, pattern: " ^[A-Z]$ " },
        },
      ],
    });

    expect(submission).toEqual({
      complete: true,
      summary: "Ready to build.",
      questionScope: "scope",
      contextSummary: "context",
      findings: ["first", "second"],
      assumptions: ["A"],
      relevantFiles: ["src/app.ts"],
      fields: [
        {
          id: "user-need",
          label: "User need",
          type: "select",
          required: true,
          skippable: false,
          placeholder: "choose",
          help: "Keep it concise.",
          defaultValue: "A",
          options: [
            { value: "A", label: "A" },
            { value: "B", label: "Bee" },
          ],
          validation: { minLength: 2, maxLength: 20, pattern: "^[A-Z]$" },
          variableName: "need",
        },
      ],
    });
  });

  it("drops invalid questions and bounds the field count", () => {
    const questions = [
      null,
      { label: "" },
      { label: "No options", type: "select" },
      ...Array.from({ length: 7 }, (_, index) => ({
        question: `Question ${index + 1}`,
        type: index % 2 === 0 ? "text-area" : "integer",
      })),
    ];

    const submission = normalizeRalphGenerationInterviewSubmission({
      questions,
      findings: null,
      assumptions: undefined,
      relevantFiles: "not an array",
    });

    expect(submission.complete).toBe(false);
    expect(submission.fields).toHaveLength(6);
    expect(submission.fields[0]).toMatchObject({
      id: "question_4",
      label: "Question 1",
      type: "textarea",
      required: false,
      skippable: true,
    });
    expect(submission.fields[1]?.type).toBe("number");
    expect(submission.findings).toEqual([]);
    expect(submission.assumptions).toEqual([]);
    expect(submission.relevantFiles).toEqual([]);
  });

  it("normalizes null, boolean, number, and string-array default values", () => {
    const submission = normalizeRalphGenerationInterviewSubmission({
      questions: [
        { label: "Null defaultValue", defaultValue: null },
        { label: "Null default", default: null },
        { label: "Boolean", defaultValue: false },
        { label: "Number", defaultValue: 0 },
        { label: "Array", defaultValue: ["a", 1, "b"] },
        { label: "Invalid", defaultValue: { value: "x" } },
      ],
    });

    expect(submission.fields.map((field) => field.defaultValue)).toEqual([
      undefined,
      null,
      false,
      0,
      ["a", "b"],
      undefined,
    ]);
  });

  it("throws for null, arrays, and primitive contracts", () => {
    expect(() => normalizeRalphGenerationInterviewSubmission(null)).toThrow(
      "Interview response must be a JSON object.",
    );
    expect(() => normalizeRalphGenerationInterviewSubmission([])).toThrow(
      "Interview response must be a JSON object.",
    );
    expect(() => normalizeRalphGenerationInterviewSubmission("text")).toThrow(
      "Interview response must be a JSON object.",
    );
  });
});

describe("readRalphGenerationInterviewSubmission", () => {
  it("prefers the dedicated interview output section", () => {
    const submission = readRalphGenerationInterviewSubmission(
      createResult({
        summary: JSON.stringify({ complete: false, questions: [] }),
        response: {
          markdown: JSON.stringify({ complete: false, summary: "markdown" }),
          highlights: [],
          relatedFiles: [],
          verification: [],
          followUps: [],
        },
        outputSections: [
          {
            title: RALPH_GENERATION_INTERVIEW_SECTION_TITLE,
            audience: "internal",
            lines: [
              "<ralph_generation_interview>",
              JSON.stringify({ complete: true, summary: "section" }),
              "</ralph_generation_interview>",
            ],
          },
        ],
      }),
    );

    expect(submission).toMatchObject({ complete: true, summary: "section" });
  });

  it("falls back across fenced, narrative, and summary candidates", () => {
    const submission = readRalphGenerationInterviewSubmission(
      createResult({
        response: {
          markdown: "```json\nnot-json\n```",
          highlights: [],
          relatedFiles: [],
          verification: [],
          followUps: [],
        },
        outputSections: [
          {
            title: "Other",
            audience: "internal",
            lines: ['Narrative before {"complete": true, "summary": "inline"} after'],
          },
        ],
        summary: JSON.stringify({ complete: false, summary: "summary" }),
      }),
    );

    expect(submission).toMatchObject({ complete: true, summary: "inline" });
  });

  it("throws when no candidate contains a valid contract object", () => {
    expect(() =>
      readRalphGenerationInterviewSubmission(
        createResult({
          summary: "No JSON here",
          outputSections: [{ title: "Other", audience: "internal", lines: ["[]"] }],
        }),
      ),
    ).toThrow("The interviewer did not return a valid interview contract.");
  });
});

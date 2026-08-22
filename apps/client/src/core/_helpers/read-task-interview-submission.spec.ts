import { describe, expect, it } from "vitest";
import {
  TASK_INTERVIEW_SECTION_TITLE,
  normalizeTaskInterviewSubmission,
  readTaskInterviewSubmission,
} from "./read-task-interview-submission.helper.js";
import type { TaskExecutionResult } from "../types.js";

const createExecutionResult = (
  markdown: string,
): TaskExecutionResult => ({
  task: "interview",
  mode: "ask",
  status: "executed",
  summary: "done",
  executedTools: [],
  outputSections: [],
  response: {
    markdown,
    highlights: [],
    relatedFiles: [],
    verification: [],
    followUps: [],
  },
});

describe("normalizeTaskInterviewSubmission", () => {
  it("normalizes a task interview question contract", () => {
    const submission = normalizeTaskInterviewSubmission({
      complete: false,
      summary: "Need scope.",
      questionScope: "Scope",
      contextSummary: "Build a settings panel.",
      findings: ["React app"],
      assumptions: ["Keep existing styles"],
      relevantFiles: ["src/app.tsx"],
      questions: [
        {
          id: " Feature scope ",
          question: "Which settings?",
          type: "choice",
          options: ["Provider", { value: "voice", label: "Voice" }],
          required: true,
          validation: { minLength: 2, pattern: " ^[a-z]+$ " },
        },
      ],
    });

    expect(submission).toMatchObject({
      complete: false,
      summary: "Need scope.",
      questionScope: "Scope",
      contextSummary: "Build a settings panel.",
      findings: ["React app"],
      assumptions: ["Keep existing styles"],
      relevantFiles: ["src/app.tsx"],
      fields: [
        {
          id: "feature-scope",
          label: "Which settings?",
          type: "select",
          required: true,
          skippable: true,
          options: [
            { value: "Provider", label: "Provider" },
            { value: "voice", label: "Voice" },
          ],
          validation: { minLength: 2, pattern: "^[a-z]+$" },
        },
      ],
    });
  });
});

describe("readTaskInterviewSubmission", () => {
  it("prefers the dedicated task interview output section", () => {
    const result = createExecutionResult("{}");
    result.outputSections = [
      {
        title: TASK_INTERVIEW_SECTION_TITLE,
        lines: [
          JSON.stringify({
            complete: true,
            summary: "Ready.",
            contextSummary: "Enough context.",
            findings: [],
            assumptions: [],
            relevantFiles: [],
            questions: [],
          }),
        ],
      },
    ];

    expect(readTaskInterviewSubmission(result)).toMatchObject({
      complete: true,
      summary: "Ready.",
      contextSummary: "Enough context.",
      fields: [],
    });
  });

  it("parses tagged JSON fallback from model text", () => {
    const submission = readTaskInterviewSubmission(
      createExecutionResult([
        "<machdoch_task_interview>",
        JSON.stringify({
          complete: true,
          summary: "Ready.",
          contextSummary: "Ready to start.",
          findings: [],
          assumptions: [],
          relevantFiles: [],
          questions: [],
        }),
        "</machdoch_task_interview>",
      ].join("\n")),
    );

    expect(submission.complete).toBe(true);
    expect(submission.summary).toBe("Ready.");
  });
});

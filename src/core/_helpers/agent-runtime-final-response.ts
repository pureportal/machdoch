import type {
  AgentModelToolResult,
  AgentModelToolSpec,
  TaskExecutionNarrative,
  TaskExecutionSection,
} from "../types.js";
import {
  coerceFileReferenceArray,
  coerceString,
  coerceStringArray,
} from "./agent-runtime-shared.js";
import {
  MAX_FINAL_RESPONSE_ITEMS,
  type TaskFinalResponsePayload,
} from "./agent-runtime-types.js";
import { createTextSection, limitText } from "./runtime-text.js";

export const FINAL_RESPONSE_TOOL_NAME = "submit_final_response";

export const createFinalResponseTool = (): AgentModelToolSpec => {
  return {
    name: FINAL_RESPONSE_TOOL_NAME,
    description:
      "Submit the final user-facing response when the task is either completed or blocked by a real limitation. Call this exactly once, as the only tool in the turn, when no further execution is possible or required.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: {
          type: "string",
          description:
            "A concise plain-text completion summary for the activity feed and task card.",
        },
        status: {
          type: "string",
          enum: ["completed", "blocked"],
          description:
            "Use `completed` only when the task is actually satisfied. Use `blocked` when execution cannot continue because user input, tool availability, provider, runtime limits, or Ask mode's read-only surface prevent completion.",
        },
        blockerReason: {
          type: "string",
          description:
            "When status is `blocked`, explain the concrete blocker and the next required action. Use an empty string when status is `completed`.",
        },
        markdown: {
          type: "string",
          description:
            "A compact GitHub-flavored Markdown answer for the user. Keep it brief, scannable, and grounded in actual tool results.",
        },
        highlights: {
          type: "array",
          items: { type: "string" },
          maxItems: MAX_FINAL_RESPONSE_ITEMS,
          description:
            "Short insight bullets that add value beyond the summary. Use an empty array when no extra highlights are needed.",
        },
        relatedFiles: {
          type: "array",
          maxItems: MAX_FINAL_RESPONSE_ITEMS,
          description:
            "Workspace-relative files that were changed or are especially relevant to the result.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              path: {
                type: "string",
                description: "Workspace-relative file path.",
              },
              description: {
                type: "string",
                description: "Short explanation of why the file matters.",
              },
            },
            required: ["path", "description"],
          },
        },
        verification: {
          type: "array",
          items: { type: "string" },
          maxItems: MAX_FINAL_RESPONSE_ITEMS,
          description:
            "Concrete checks or evidence used to verify the result. Use an empty array when verification was not possible.",
        },
        followUps: {
          type: "array",
          items: { type: "string" },
          maxItems: MAX_FINAL_RESPONSE_ITEMS,
          description:
            "Short remaining caveats or next steps. Use an empty array when none remain.",
        },
      },
      required: [
        "summary",
        "status",
        "blockerReason",
        "markdown",
        "highlights",
        "relatedFiles",
        "verification",
        "followUps",
      ],
    },
  };
};

export const parseFinalResponsePayload = (
  record: Record<string, unknown>,
): TaskFinalResponsePayload | undefined => {
  const summary = coerceString(record, "summary");
  const status = record.status;
  const blockerReason =
    typeof record.blockerReason === "string"
      ? record.blockerReason.trim()
      : undefined;
  const markdown = coerceString(record, "markdown");
  const highlights = coerceStringArray(record, "highlights");
  const relatedFiles = coerceFileReferenceArray(record, "relatedFiles");
  const verification = coerceStringArray(record, "verification");
  const followUps = coerceStringArray(record, "followUps");

  if (
    !summary ||
    (status !== "completed" && status !== "blocked") ||
    blockerReason === undefined ||
    (status === "blocked" && blockerReason.length === 0) ||
    !markdown ||
    !highlights ||
    !relatedFiles ||
    !verification ||
    !followUps
  ) {
    return undefined;
  }

  return {
    status,
    blockerReason,
    summary,
    markdown,
    highlights,
    relatedFiles,
    verification,
    followUps,
  };
};

const createNarrativeSection = (
  section: TaskExecutionSection,
): TaskExecutionSection => {
  return section;
};

export const createFinalResponseSections = (
  response: TaskExecutionNarrative,
): TaskExecutionSection[] => {
  return [
    ...(response.highlights.length > 0
      ? [
          createNarrativeSection({
            title: "Highlights",
            tone: "info",
            lines: response.highlights,
          }),
        ]
      : []),
    ...(response.relatedFiles.length > 0
      ? [
          createNarrativeSection({
            title: "Related files",
            tone: "info",
            lines: response.relatedFiles.map(
              (fileReference) =>
                `${fileReference.path} — ${fileReference.description}`,
            ),
          }),
        ]
      : []),
    ...(response.verification.length > 0
      ? [
          createNarrativeSection({
            title: "Verification",
            tone: "success",
            lines: response.verification,
          }),
        ]
      : []),
    ...(response.followUps.length > 0
      ? [
          createNarrativeSection({
            title: "Follow-up",
            tone: "warning",
            lines: response.followUps,
          }),
        ]
      : []),
  ];
};

export const createFinalResponseToolResult = (
  callId: string,
  output: string,
  isError = false,
): AgentModelToolResult => {
  return {
    callId,
    name: FINAL_RESPONSE_TOOL_NAME,
    output,
    ...(isError ? { isError: true } : {}),
  };
};

export const createAssistantAnswerSection = (
  text: string,
): TaskExecutionSection => {
  return createTextSection("Agent answer", limitText(text));
};

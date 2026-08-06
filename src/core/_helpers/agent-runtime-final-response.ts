import type {
  AgentModelToolResult,
  AgentModelToolSpec,
  TaskExecutionNarrative,
  TaskExecutionSection,
  TaskExecutionControl,
  TaskResultProtocol,
} from "../types.js";
import { coerceString } from "./agent-runtime-shared.js";
import {
  MAX_FINAL_RESPONSE_ITEMS,
  type TaskFinalResponsePayload,
} from "./agent-runtime-types.js";
import { createTextSection, limitText } from "./runtime-text.js";

export const FINAL_RESPONSE_TOOL_NAME = "submit_final_response";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean => {
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
};

const validateResultProtocol = (
  value: unknown,
): TaskResultProtocol | undefined => {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return undefined;
  }

  if (value.kind === "ralph-iteration") {
    return hasExactKeys(value, ["kind"])
      ? { kind: "ralph-iteration" }
      : undefined;
  }
  if (value.kind === "ralph-validator") {
    return hasExactKeys(value, ["kind"])
      ? { kind: "ralph-validator" }
      : undefined;
  }
  if (
    value.kind === "ralph-route" &&
    hasExactKeys(value, ["kind", "labels"]) &&
    Array.isArray(value.labels) &&
    value.labels.length > 0 &&
    value.labels.every(
      (label, index, labels) =>
        typeof label === "string" &&
        label.length > 0 &&
        label.trim() === label &&
        labels.indexOf(label) === index,
    )
  ) {
    return { kind: "ralph-route", labels: [...value.labels] };
  }

  return undefined;
};

const createControlSchema = (
  rawProtocol: TaskResultProtocol,
): Record<string, unknown> => {
  const protocol = validateResultProtocol(rawProtocol);
  if (!protocol) {
    throw new Error("The structured result protocol is missing or invalid.");
  }

  switch (protocol.kind) {
    case "ralph-iteration":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { const: "ralph-iteration" },
          decision: { type: "string", enum: ["DONE", "CONTINUE"] },
        },
        required: ["kind", "decision"],
      };
    case "ralph-validator":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { const: "ralph-validator" },
          decision: {
            type: "string",
            enum: ["DONE", "CONTINUE", "RETRY", "ERROR"],
          },
        },
        required: ["kind", "decision"],
      };
    case "ralph-route": {
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { const: "ralph-route" },
          label: { type: "string", enum: protocol.labels },
        },
        required: ["kind", "label"],
      };
    }
  }
};

export const createFinalResponseTool = (
  resultProtocol?: TaskResultProtocol,
): AgentModelToolSpec => {
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
        ...(resultProtocol
          ? {
              control: createControlSchema(resultProtocol),
            }
          : {}),
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
        ...(resultProtocol ? ["control"] : []),
      ],
    },
  };
};

const parseControl = (
  value: unknown,
  protocol: TaskResultProtocol,
): TaskExecutionControl | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, ["decision", "kind"]) && protocol.kind !== "ralph-route") {
    return undefined;
  }
  if (protocol.kind === "ralph-route" && !hasExactKeys(record, ["kind", "label"])) {
    return undefined;
  }

  switch (protocol.kind) {
    case "ralph-iteration":
      return record.kind === "ralph-iteration" &&
        (record.decision === "DONE" || record.decision === "CONTINUE")
        ? { kind: "ralph-iteration", decision: record.decision }
        : undefined;
    case "ralph-validator":
      return record.kind === "ralph-validator" &&
        (record.decision === "DONE" ||
          record.decision === "CONTINUE" ||
          record.decision === "RETRY" ||
          record.decision === "ERROR")
        ? { kind: "ralph-validator", decision: record.decision }
        : undefined;
    case "ralph-route":
      return record.kind === "ralph-route" &&
        typeof record.label === "string" &&
        protocol.labels.includes(record.label)
        ? { kind: "ralph-route", label: record.label }
        : undefined;
  }
};

const readExactStringArray = (
  record: Record<string, unknown>,
  field: string,
): string[] | undefined => {
  const value = record[field];
  if (
    !Array.isArray(value) ||
    value.length > MAX_FINAL_RESPONSE_ITEMS ||
    value.some(
      (entry) => typeof entry !== "string" || entry.trim().length === 0,
    )
  ) {
    return undefined;
  }

  return value.map((entry) => entry.trim());
};

const readExactFileReferences = (
  record: Record<string, unknown>,
): TaskExecutionNarrative["relatedFiles"] | undefined => {
  const value = record.relatedFiles;
  if (!Array.isArray(value) || value.length > MAX_FINAL_RESPONSE_ITEMS) {
    return undefined;
  }

  const references: TaskExecutionNarrative["relatedFiles"] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !hasExactKeys(entry, ["description", "path"])) {
      return undefined;
    }
    const path = coerceString(entry, "path");
    const description = coerceString(entry, "description");
    if (!path || !description) {
      return undefined;
    }
    references.push({ path, description });
  }

  return references;
};

export const parseFinalResponsePayload = (
  record: Record<string, unknown>,
  resultProtocol?: TaskResultProtocol,
): TaskFinalResponsePayload | undefined => {
  const validatedProtocol =
    resultProtocol === undefined
      ? undefined
      : validateResultProtocol(resultProtocol);
  if (resultProtocol !== undefined && validatedProtocol === undefined) {
    return undefined;
  }
  const expectedKeys = [
    "blockerReason",
    ...(validatedProtocol ? ["control"] : []),
    "followUps",
    "highlights",
    "markdown",
    "relatedFiles",
    "status",
    "summary",
    "verification",
  ];
  if (!hasExactKeys(record, expectedKeys)) {
    return undefined;
  }
  const summary = coerceString(record, "summary");
  const status = record.status;
  const blockerReason =
    typeof record.blockerReason === "string"
      ? record.blockerReason.trim()
      : undefined;
  const markdown = coerceString(record, "markdown");
  const highlights = readExactStringArray(record, "highlights");
  const relatedFiles = readExactFileReferences(record);
  const verification = readExactStringArray(record, "verification");
  const followUps = readExactStringArray(record, "followUps");
  const control = validatedProtocol
    ? parseControl(record.control, validatedProtocol)
    : undefined;

  if (
    !summary ||
    (status !== "completed" && status !== "blocked") ||
    blockerReason === undefined ||
    (status === "blocked" && blockerReason.length === 0) ||
    (status === "completed" && blockerReason.length > 0) ||
    !markdown ||
    !highlights ||
    !relatedFiles ||
    !verification ||
    !followUps ||
    (resultProtocol !== undefined && control === undefined)
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
    ...(control ? { control } : {}),
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

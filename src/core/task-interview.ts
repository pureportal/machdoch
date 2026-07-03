import { randomUUID } from "node:crypto";
import { loadRuntimeConfig } from "./config.js";
import { discoverCustomizations } from "./customizations.js";
import { executeTask } from "./execution.js";
import {
  createToolErrorResult,
  type AgentToolDefinition,
} from "./_helpers/agent-tools-shared.js";
import {
  TASK_INTERVIEW_INPUT_TYPES,
  TASK_INTERVIEW_SECTION_TITLE,
  readTaskInterviewSubmission,
  type TaskInterviewSubmission,
} from "./_helpers/read-task-interview-submission.helper.js";
import {
  createLogTimestamp,
  type RalphInputField,
  type RalphInputFieldType,
  type RalphInputValue,
} from "./ralph.js";
import type { ModelProvider, RuntimeConfig } from "./runtime-contract.generated.js";
import type {
  CustomizationDiscoveryResult,
  TaskActionOutputHandler,
  TaskExecutionProgressHandler,
  TaskExecutionResult,
} from "./types.js";

export const DEFAULT_TASK_INTERVIEW_MAX_TURNS = 5;
export const MAX_TASK_INTERVIEW_MAX_TURNS = 5;
const TASK_INTERVIEW_STRING_ARRAY_SCHEMA = {
  type: "array",
  items: { type: "string" },
} as const;

export type TaskInterviewStatus = "questions" | "complete" | "blocked";

export interface TaskInterviewAnswer {
  fieldId: string;
  label: string;
  type: RalphInputFieldType;
  value: RalphInputValue;
  comment?: string;
}

export interface TaskInterviewTranscriptTurn {
  turn: number;
  questionScope?: string;
  questions: RalphInputField[];
  answers: TaskInterviewAnswer[];
  summary?: string;
  createdAt: string;
  answeredAt?: string;
}

export interface TaskInterviewSession {
  id: string;
  prompt: string;
  turn: number;
  maxTurns: number;
  contextSummary?: string;
  contextNotes?: string[];
  findings: string[];
  assumptions: string[];
  relevantFiles: string[];
  transcript: TaskInterviewTranscriptTurn[];
  finalSummary?: string;
}

export interface TaskInterviewOptions {
  prompt: string;
  config?: RuntimeConfig;
  customizations?: CustomizationDiscoveryResult;
  maxTurns?: number;
  session?: TaskInterviewSession;
  contextNotes?: string[];
  answers?: Record<string, RalphInputValue>;
  answerComments?: Record<string, string>;
  onStateChange?: TaskExecutionProgressHandler;
  onActionOutput?: TaskActionOutputHandler;
  runId?: string;
  signal?: AbortSignal;
}

export interface TaskInterviewResult {
  status: TaskInterviewStatus;
  session: TaskInterviewSession;
  fields: RalphInputField[];
  summary: string;
  finalPrompt?: string;
  provider?: ModelProvider;
  model?: string;
  result?: TaskExecutionResult;
}

const clampTaskInterviewMaxTurns = (value: number | undefined): number => {
  if (value === undefined || !Number.isInteger(value)) {
    return DEFAULT_TASK_INTERVIEW_MAX_TURNS;
  }

  return Math.min(Math.max(value, 1), MAX_TASK_INTERVIEW_MAX_TURNS);
};

const mergeTaskInterviewLines = (
  current: readonly string[],
  incoming: readonly string[],
): string[] => {
  const result = [...current];
  const seen = new Set(result.map((entry) => entry.toLowerCase()));

  for (const entry of incoming) {
    const key = entry.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(entry);
  }

  return result.slice(-20);
};

const createTaskInterviewToolDefinitions = (): AgentToolDefinition[] => [
  {
    spec: {
      name: "machdoch_submit_task_interview_round",
      description:
        "Submit the current Machdoch task interview decision. Ask typed questions only when more information would materially improve the task; otherwise mark complete.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          complete: { type: "boolean" },
          summary: { type: "string" },
          questionScope: { type: "string" },
          contextSummary: { type: "string" },
          findings: TASK_INTERVIEW_STRING_ARRAY_SCHEMA,
          assumptions: TASK_INTERVIEW_STRING_ARRAY_SCHEMA,
          relevantFiles: TASK_INTERVIEW_STRING_ARRAY_SCHEMA,
          questions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                label: { type: "string" },
                question: { type: "string" },
                type: {
                  type: "string",
                  enum: TASK_INTERVIEW_INPUT_TYPES,
                },
                required: { type: "boolean" },
                skippable: { type: "boolean" },
                placeholder: { type: "string" },
                help: { type: "string" },
                variableName: { type: "string" },
                defaultValue: {},
                options: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      value: { type: "string" },
                      label: { type: "string" },
                    },
                    required: ["value", "label"],
                  },
                },
                validation: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    min: { type: "number" },
                    max: { type: "number" },
                    step: { type: "number" },
                    pattern: { type: "string" },
                    minLength: { type: "number" },
                    maxLength: { type: "number" },
                  },
                  required: [],
                },
              },
              required: ["label", "type"],
            },
          },
        },
        required: [
          "complete",
          "summary",
          "contextSummary",
          "findings",
          "assumptions",
          "relevantFiles",
          "questions",
        ],
      },
    },
    backingTool: "utilities",
    riskLevel: "low",
    effect: "read",
    execute: async (args) => {
      try {
        const submission = args as unknown as TaskInterviewSubmission;
        const normalized = {
          ...submission,
          questions: Array.isArray(submission.fields)
            ? submission.fields
            : (args.questions ?? []),
        };
        const json = JSON.stringify(normalized, null, 2);

        return {
          toolResult: {
            callId: randomUUID(),
            name: "machdoch_submit_task_interview_round",
            output: json,
          },
          sections: [
            {
              title: TASK_INTERVIEW_SECTION_TITLE,
              audience: "internal",
              lines: json.split("\n"),
            },
          ],
          traceLines: [
            "machdoch_submit_task_interview_round -> returned interview contract",
          ],
        };
      } catch (error) {
        return createToolErrorResult(
          randomUUID(),
          "machdoch_submit_task_interview_round",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  },
];

const createTaskInterviewSession = (
  options: TaskInterviewOptions,
  maxTurns: number,
): TaskInterviewSession => {
  if (options.session) {
    return {
      ...options.session,
      prompt: options.session.prompt || options.prompt,
      maxTurns,
      turn: Math.min(Math.max(options.session.turn, 0), maxTurns),
      contextNotes:
        options.session.contextNotes ??
        mergeTaskInterviewLines([], options.contextNotes ?? []),
      findings: options.session.findings ?? [],
      assumptions: options.session.assumptions ?? [],
      relevantFiles: options.session.relevantFiles ?? [],
      transcript: options.session.transcript ?? [],
    };
  }

  return {
    id: options.runId ?? `task-interview-${randomUUID()}`,
    prompt: options.prompt,
    turn: 0,
    maxTurns,
    contextNotes: mergeTaskInterviewLines([], options.contextNotes ?? []),
    findings: [],
    assumptions: [],
    relevantFiles: [],
    transcript: [],
  };
};

const applyTaskInterviewAnswers = (
  session: TaskInterviewSession,
  answers: Record<string, RalphInputValue> | undefined,
  answerComments: Record<string, string> | undefined,
): TaskInterviewSession => {
  const hasAnswerComments = Object.values(answerComments ?? {}).some(
    (comment) => comment.trim().length > 0,
  );

  if ((!answers && !hasAnswerComments) || session.transcript.length === 0) {
    return session;
  }

  const latestTurn = session.transcript[session.transcript.length - 1];

  if (!latestTurn || latestTurn.answers.length > 0) {
    return session;
  }

  const answerList: TaskInterviewAnswer[] = latestTurn.questions.map((field) => {
    const comment = answerComments?.[field.id]?.trim();

    return {
      fieldId: field.id,
      label: field.label,
      type: field.type,
      value: answers?.[field.id] ?? null,
      ...(comment ? { comment } : {}),
    };
  });

  return {
    ...session,
    transcript: [
      ...session.transcript.slice(0, -1),
      {
        ...latestTurn,
        answers: answerList,
        answeredAt: createLogTimestamp(),
      },
    ],
  };
};

const formatTaskInterviewValue = (value: RalphInputValue): string => {
  if (value === null) {
    return "Skipped";
  }

  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(", ") : "Skipped";
  }

  return String(value);
};

const formatTaskInterviewTranscript = (
  session: TaskInterviewSession,
): string[] => {
  if (session.transcript.length === 0) {
    return ["No previous interview turns."];
  }

  return session.transcript.flatMap((turn) => [
    `Turn ${turn.turn}:`,
    ...(turn.questionScope ? [`Question scope: ${turn.questionScope}`] : []),
    ...(turn.summary ? [`Summary: ${turn.summary}`] : []),
    ...turn.questions.map((field) => `Question: ${field.label} (${field.type})`),
    ...(turn.answers.length > 0
      ? turn.answers.flatMap((answer) => [
          `Answer: ${answer.label} = ${formatTaskInterviewValue(answer.value)}`,
          ...(answer.comment
            ? [`Answer comment for ${answer.label}: ${answer.comment}`]
            : []),
        ])
      : ["Answers: pending"]),
    "",
  ]);
};

const createTaskInterviewSystemPrompt = (): string => {
  return [
    "<machdoch_task_interviewer_contract>",
    "You are Machdoch Task Interviewer. Your job is to refine a user's chat-session request before the normal agent run starts.",
    "Inspect requirements and, when useful, read relevant workspace files, package metadata, configuration, custom instructions, or MCP/tool capability data using only read-only tools.",
    "Do not edit files, start or restart servers, run destructive commands, mutate external systems, or perform broad scans unrelated to the request.",
    "Ask questions only when the answer would materially change the implementation, verification, UX, safety boundary, or acceptance criteria.",
    "Ask multiple concise questions in one round when useful. Use rich field types: select, multiselect, number, boolean, text, textarea, url, path, file, files, image, or images.",
    "When asking questions, optionally set questionScope to a short group name such as \"Scope\", \"UX\", \"Data\", \"Verification\", or \"Constraints\".",
    "For every question, set help to one short reason phrase explaining why the answer matters. Keep help under 140 characters; do not write paragraphs.",
    "For string answers that need a format, include validation.pattern. For numbers, include min, max, or step when helpful.",
    "Keep questions skippable unless missing information would block correctness.",
    `Never exceed ${MAX_TASK_INTERVIEW_MAX_TURNS} question rounds. If enough context is available, mark complete and summarize the task-ready requirements.`,
    "Return the contract by calling machdoch_submit_task_interview_round. If tool calling is unavailable, return only JSON inside <machdoch_task_interview> tags with the same fields.",
    "</machdoch_task_interviewer_contract>",
  ].join("\n");
};

const createTaskInterviewTask = (
  workspaceRoot: string,
  session: TaskInterviewSession,
  nextTurn: number,
): string => [
  "Prepare the next Machdoch chat task interview step.",
  "",
  `Workspace root: ${workspaceRoot}`,
  `Interview turn to prepare: ${nextTurn} of ${session.maxTurns}`,
  "",
  "Original user request:",
  session.prompt,
  "",
  "Additional chat context:",
  ...(session.contextNotes && session.contextNotes.length > 0
    ? session.contextNotes
    : ["None."]),
  "",
  "Accumulated context summary:",
  session.contextSummary ?? "None yet.",
  "",
  "Findings:",
  ...(session.findings.length > 0 ? session.findings : ["None yet."]),
  "",
  "Assumptions:",
  ...(session.assumptions.length > 0 ? session.assumptions : ["None yet."]),
  "",
  "Relevant files:",
  ...(session.relevantFiles.length > 0 ? session.relevantFiles : ["None yet."]),
  "",
  "Interview transcript so far:",
  ...formatTaskInterviewTranscript(session),
  "",
  "Decide whether to complete the interview or ask the next round.",
  "If asking questions, return no more than 6 fields and make each field useful for the final task.",
  "If complete, include a summary that can be used directly by the task executor.",
].join("\n");

export const createTaskPromptFromInterview = (
  session: TaskInterviewSession,
  finalSummary?: string,
): string => {
  const interviewSummary =
    finalSummary ?? session.finalSummary ?? session.contextSummary ?? "No final summary.";
  const contextSummary = session.contextSummary?.trim();

  return [
    session.prompt,
    "",
    "Interview context for this task:",
    interviewSummary,
    ...(contextSummary && contextSummary !== interviewSummary
      ? ["", "Context summary:", contextSummary]
      : []),
    "",
    "Findings:",
    ...(session.findings.length > 0
      ? session.findings.map((entry) => `- ${entry}`)
      : ["- None"]),
    "",
    "Assumptions:",
    ...(session.assumptions.length > 0
      ? session.assumptions.map((entry) => `- ${entry}`)
      : ["- None"]),
    "",
    "Relevant files/config:",
    ...(session.relevantFiles.length > 0
      ? session.relevantFiles.map((entry) => `- ${entry}`)
      : ["- None"]),
    "",
    "Interview answers:",
    ...session.transcript.flatMap((turn) => [
      turn.questionScope ? `${turn.questionScope}:` : `Turn ${turn.turn}:`,
      ...turn.answers.map((answer) =>
        [
          `- ${answer.label}: ${formatTaskInterviewValue(answer.value)}`,
          ...(answer.comment ? [`  Comment: ${answer.comment}`] : []),
        ].join("\n"),
      ),
      ...(turn.answers.length === 0 ? ["- No answers collected."] : []),
    ]),
  ].join("\n");
};

export const createTaskInterviewWithAgent = async (
  workspaceRoot: string,
  options: TaskInterviewOptions,
): Promise<TaskInterviewResult> => {
  const prompt = options.prompt.trim();
  const maxTurns = clampTaskInterviewMaxTurns(options.maxTurns);
  const baseSession = createTaskInterviewSession(
    { ...options, prompt },
    maxTurns,
  );
  const session = applyTaskInterviewAnswers(
    baseSession,
    options.answers,
    options.answerComments,
  );
  const config =
    options.config ??
    (await loadRuntimeConfig(workspaceRoot, "machdoch", undefined, undefined, undefined));
  const interviewerConfig: RuntimeConfig = {
    ...config,
    mode: "ask",
    reasoning: config.reasoning === "default" ? "medium" : config.reasoning,
  };

  if (!prompt) {
    return {
      status: "blocked",
      session,
      fields: [],
      summary: "Expected a prompt before starting a task interview.",
      provider: interviewerConfig.provider,
      model: interviewerConfig.model,
    };
  }

  if (session.turn >= session.maxTurns) {
    const finalSummary =
      session.finalSummary ??
      "The interview reached the maximum number of question rounds.";
    const completedSession: TaskInterviewSession = {
      ...session,
      finalSummary,
    };

    return {
      status: "complete",
      session: completedSession,
      fields: [],
      summary: finalSummary,
      finalPrompt: createTaskPromptFromInterview(
        completedSession,
        finalSummary,
      ),
      provider: interviewerConfig.provider,
      model: interviewerConfig.model,
    };
  }

  const customizations =
    options.customizations ??
    (await discoverCustomizations(workspaceRoot, {
      discoverUserCustomizations: true,
      discoverGithubCustomizations:
        Boolean(config.compatibility.discoverGithubCustomizations),
      includeDiagnostics: true,
    }));
  const nextTurn = session.turn + 1;
  const result = await executeTask(
    createTaskInterviewTask(workspaceRoot, session, nextTurn),
    interviewerConfig,
    customizations,
    {
      ...(options.runId ? { runId: options.runId } : {}),
      ...(options.onStateChange ? { onStateChange: options.onStateChange } : {}),
      ...(options.onActionOutput ? { onActionOutput: options.onActionOutput } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      additionalToolDefinitions: createTaskInterviewToolDefinitions(),
      systemPromptSections: [createTaskInterviewSystemPrompt()],
      instructionAudience: "executor",
      maxDurationMs: null,
    },
  );

  if (result.status !== "executed") {
    return {
      status: "blocked",
      session,
      fields: [],
      summary:
        result.reason ??
        result.summary ??
        "The task interviewer could not complete.",
      provider: interviewerConfig.provider,
      model: interviewerConfig.model,
      result,
    };
  }

  let submission: TaskInterviewSubmission;
  try {
    submission = readTaskInterviewSubmission(result);
  } catch (error) {
    return {
      status: "blocked",
      session,
      fields: [],
      summary: error instanceof Error ? error.message : String(error),
      provider: interviewerConfig.provider,
      model: interviewerConfig.model,
      result,
    };
  }

  const contextSummary =
    submission.contextSummary ?? session.contextSummary ?? submission.summary;
  const updatedSessionBase: TaskInterviewSession = {
    ...session,
    ...(contextSummary ? { contextSummary } : {}),
    findings: mergeTaskInterviewLines(session.findings, submission.findings),
    assumptions: mergeTaskInterviewLines(
      session.assumptions,
      submission.assumptions,
    ),
    relevantFiles: mergeTaskInterviewLines(
      session.relevantFiles,
      submission.relevantFiles,
    ),
  };

  const shouldComplete =
    submission.complete ||
    submission.fields.length === 0 ||
    nextTurn > updatedSessionBase.maxTurns;

  if (shouldComplete) {
    const finalSummary =
      submission.summary ??
      updatedSessionBase.contextSummary ??
      "The interview collected enough context for the task.";
    const completedSession: TaskInterviewSession = {
      ...updatedSessionBase,
      finalSummary,
    };

    return {
      status: "complete",
      session: completedSession,
      fields: [],
      summary: finalSummary,
      finalPrompt: createTaskPromptFromInterview(
        completedSession,
        finalSummary,
      ),
      provider: interviewerConfig.provider,
      model: interviewerConfig.model,
      result,
    };
  }

  const nextSession: TaskInterviewSession = {
    ...updatedSessionBase,
    turn: nextTurn,
    transcript: [
      ...updatedSessionBase.transcript,
      {
        turn: nextTurn,
        questions: submission.fields,
        answers: [],
        ...(submission.questionScope
          ? { questionScope: submission.questionScope }
          : {}),
        ...(submission.summary ? { summary: submission.summary } : {}),
        createdAt: createLogTimestamp(),
      },
    ],
  };

  return {
    status: "questions",
    session: nextSession,
    fields: submission.fields,
    summary:
      submission.summary ??
      `Prepared interview round ${nextTurn} of ${nextSession.maxTurns}.`,
    provider: interviewerConfig.provider,
    model: interviewerConfig.model,
    result,
  };
};

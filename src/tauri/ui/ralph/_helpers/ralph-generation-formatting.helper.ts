import type {
  RalphBlockSettings,
  RalphFlow,
  RalphInputField,
  RalphInputValue,
  RalphPromptBlock,
  RalphRunResult,
} from "../../../../core/ralph.js";
import type { RalphGenerationInterviewSession } from "../../../../core/ralph-generation.js";
import type {
  ProviderModelCatalogSnapshot,
  RuntimeProvider,
} from "../../model-catalog";
import {
  getCatalogModelsForProvider,
  getDefaultModelForProvider,
  RUNNABLE_PROVIDER_ORDER,
} from "../../model-catalog";
import type { RalphCreateFlowResult } from "../../runtime";
import { titleFromId, type RalphProviderOption } from "./format-ralph-flow-labels.helper";
import { getPromptLikeText } from "./get-ralph-node-preview.helper";
import { formatRalphInputValueForPrompt } from "./validate-ralph-input-field-values.helper";

export type RalphGenerationStatus =
  | "running"
  | "stopping"
  | "created"
  | "blocked"
  | "failed";

export interface RalphAiGenerationPromptContext {
  userPrompt: string;
  generationPrompt: string;
}

export interface RalphGenerationStatusDetails {
  status: RalphGenerationStatus;
  summary: string;
  currentActor?: string;
  currentRound?: number;
  maxRounds?: number;
}

export const formatJsonDraft = (value: unknown): string => {
  return JSON.stringify(value ?? {}, null, 2);
};

export const parseJsonDraft = (value: string): unknown | undefined => {
  if (!value.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
};

export const parseStringRecordDraft = (
  value: string,
): Record<string, string> | undefined => {
  const parsed = parseJsonDraft(value);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(parsed).flatMap(([key, entry]) =>
      typeof entry === "string" ? ([[key, entry]] as const) : [],
    ),
  );
};

export const parseNumberList = (value: string): number[] | undefined => {
  const numbers = value
    .split(",")
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((entry) => Number.isInteger(entry));

  return numbers.length > 0 ? numbers : undefined;
};

export const getProviderOption = (
  provider: RalphBlockSettings["provider"] | undefined,
): RalphProviderOption => {
  return PROVIDER_OPTIONS.includes(provider as RalphProviderOption)
    ? (provider as RalphProviderOption)
    : "default";
};

export const getEffectiveProvider = (
  provider: RalphProviderOption,
  activeProvider: RuntimeProvider,
): RuntimeProvider => {
  return provider === "default" ? activeProvider : provider;
};

export const getPreferredModelForProvider = (
  provider: RuntimeProvider,
  snapshot: ProviderModelCatalogSnapshot | null,
): string => {
  const models = getCatalogModelsForProvider(provider, snapshot);
  const defaultModel = getDefaultModelForProvider(provider);

  return models.some((model) => model.id === defaultModel)
    ? defaultModel
    : models[0]?.id ?? defaultModel;
};

export const formatCreateFlowMessage = (
  result: RalphCreateFlowResult,
): string => {
  const details = [
    ...result.validation.errors.map((error) => `Error: ${error}`),
    ...result.validation.warnings.map((warning) => `Warning: ${warning}`),
  ];

  return details.length > 0
    ? `${result.summary} ${details.join(" ")}`
    : result.summary;
};

export const isRalphPromptBlock = (
  block: RalphFlow["blocks"][number] | null | undefined,
): block is RalphPromptBlock => block?.type === "PROMPT";

export const formatPromptBlockTargetLabel = (block: RalphPromptBlock): string =>
  `${block.title || block.id} (${block.id})`;

export const createPromptBlockGenerationPrompt = (
  userPrompt: string,
  block: RalphPromptBlock,
): string => [
  "Update the selected PROMPT block in the current Ralph flow.",
  [
    "Use the prompt block below as the target for this Prompt change.",
    "Preserve its id and existing routes unless the user explicitly asks to change them.",
  ].join(" "),
  "",
  "Selected PROMPT block:",
  JSON.stringify(
    {
      id: block.id,
      title: block.title,
      prompt: getPromptLikeText(block),
    },
    null,
    2,
  ),
  "",
  "Requested change:",
  userPrompt,
].join("\n");

export const getTrimmedGenerationInterviewAnswerComments = (
  answerComments: Record<string, string>,
): Record<string, string> => {
  return Object.fromEntries(
    Object.entries(answerComments).flatMap(([fieldId, comment]) => {
      const trimmedComment = comment.trim();

      return trimmedComment ? [[fieldId, trimmedComment]] : [];
    }),
  );
};

export const formatGenerationInterviewAnswerForPrompt = (
  label: string,
  value: RalphInputValue | undefined,
  comment?: string,
): string[] => {
  const lines = [`- ${label}: ${formatRalphInputValueForPrompt(value)}`];
  const trimmedComment = comment?.trim();

  if (trimmedComment) {
    lines.push(`  Comment: ${trimmedComment}`);
  }

  return lines;
};

export const createLocalGenerationInterviewPrompt = (
  context: RalphAiGenerationPromptContext,
  session: RalphGenerationInterviewSession | undefined,
  fields: readonly RalphInputField[],
  values: Record<string, RalphInputValue>,
  answerComments: Record<string, string> = {},
): string => [
  context.generationPrompt,
  "",
  "Interview context for generation:",
  session?.contextSummary ?? context.userPrompt,
  "",
  "Collected interview answers:",
  ...(session?.transcript ?? []).flatMap((turn) => [
    `Turn ${turn.turn}:`,
    ...turn.answers.flatMap((answer) =>
      formatGenerationInterviewAnswerForPrompt(
        answer.label,
        answer.value,
        answer.comment,
      ),
    ),
  ]),
  ...(fields.length > 0
    ? [
        "Current answers:",
        ...fields.flatMap((field) =>
          formatGenerationInterviewAnswerForPrompt(
            field.label,
            values[field.id],
            answerComments[field.id],
          ),
        ),
      ]
    : []),
  "",
  "Use this interview context when generating the Ralph flow changes.",
].join("\n");

export const getGenerationJobStatusLabel = (
  status: RalphGenerationStatus,
): string => {
  switch (status) {
    case "running":
      return "Generating";
    case "stopping":
      return "Stopping";
    case "created":
      return "Generated";
    case "blocked":
      return "Blocked";
    case "failed":
      return "Failed";
  }
};

export const canCopyGenerationError = <T extends RalphGenerationStatusDetails>(
  job: T | null,
): job is T => job?.status === "blocked" || job?.status === "failed";

export const formatGenerationErrorClipboardText = (
  job: RalphGenerationStatusDetails,
): string => `${getGenerationJobStatusLabel(job.status)}\n\n${job.summary}`;

export const formatGenerationActivityTime = (timestamp: number): string => {
  const date = new Date(timestamp);

  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
};

export const getGenerationPhaseLabel = (
  job: RalphGenerationStatusDetails,
): string => {
  const actor = job.currentActor ? `${titleFromId(job.currentActor)} ` : "";
  const round =
    job.currentRound !== undefined
      ? `Round ${job.currentRound}${job.maxRounds ? `/${job.maxRounds}` : ""}`
      : null;

  return [round, actor ? `${actor.trim()} phase` : null]
    .filter((value): value is string => Boolean(value))
    .join(" - ");
};

export const formatRunMessage = (run: RalphRunResult): string => {
  return `${run.summary} Status: ${run.status}. ${run.blockResults.length} block result${run.blockResults.length === 1 ? "" : "s"}.`;
};

const PROVIDER_OPTIONS: readonly RalphProviderOption[] = [
  "default",
  ...RUNNABLE_PROVIDER_ORDER,
];

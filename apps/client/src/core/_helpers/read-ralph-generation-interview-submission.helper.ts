import type {
  RalphInputField,
  RalphInputFieldType,
  RalphInputOption,
  RalphInputValue,
} from "../ralph.js";
import type { TaskExecutionResult } from "../types.js";

export const RALPH_GENERATION_INTERVIEW_SECTION_TITLE =
  "Ralph generation interview round";

export const RALPH_GENERATION_INTERVIEW_INPUT_TYPES = [
  "text",
  "textarea",
  "number",
  "boolean",
  "select",
  "multiselect",
  "url",
  "path",
  "file",
  "files",
  "image",
  "images",
] as const satisfies readonly RalphInputFieldType[];

export interface RalphGenerationInterviewSubmission {
  complete: boolean;
  summary?: string;
  questionScope?: string;
  contextSummary?: string;
  findings: string[];
  assumptions: string[];
  relevantFiles: string[];
  fields: RalphInputField[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const isRalphGenerationInterviewInputType = (
  value: string,
): value is RalphInputFieldType => {
  return RALPH_GENERATION_INTERVIEW_INPUT_TYPES.includes(
    value as RalphInputFieldType,
  );
};

const normalizeRalphGenerationInterviewFieldId = (
  value: unknown,
  fallback: string,
): string => {
  const normalized =
    typeof value === "string"
      ? value
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/gu, "-")
          .replace(/^-+|-+$/gu, "")
      : "";

  return normalized || fallback;
};

const normalizeRalphGenerationInterviewFieldType = (
  value: unknown,
): RalphInputFieldType => {
  if (typeof value !== "string") {
    return "textarea";
  }

  const normalized = value.trim().toLowerCase().replace(/-/gu, "_");
  const aliases: Record<string, RalphInputFieldType> = {
    checkbox: "boolean",
    checkboxes: "multiselect",
    choice: "select",
    choices: "select",
    input: "text",
    integer: "number",
    multi_select: "multiselect",
    multiple_choice: "select",
    regex: "text",
    single_choice: "select",
    string: "text",
    text_area: "textarea",
  };
  const aliased = aliases[normalized];

  if (aliased) {
    return aliased;
  }

  return isRalphGenerationInterviewInputType(normalized)
    ? normalized
    : "textarea";
};

const normalizeRalphGenerationInterviewOptions = (
  value: unknown,
): RalphInputOption[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const options = value
    .flatMap((entry): RalphInputOption[] => {
      if (typeof entry === "string") {
        const optionValue = entry.trim();

        return optionValue ? [{ value: optionValue, label: optionValue }] : [];
      }

      if (!isRecord(entry)) {
        return [];
      }

      const optionValue =
        typeof entry.value === "string" ? entry.value.trim() : "";
      const optionLabel =
        typeof entry.label === "string" && entry.label.trim()
          ? entry.label.trim()
          : optionValue;

      return optionValue ? [{ value: optionValue, label: optionLabel }] : [];
    })
    .slice(0, 20);

  return options.length > 0 ? options : undefined;
};

const normalizeRalphGenerationInterviewValidation = (
  value: unknown,
): RalphInputField["validation"] | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const validation: NonNullable<RalphInputField["validation"]> = {};
  for (const key of ["min", "max", "step", "minLength", "maxLength"] as const) {
    if (typeof value[key] === "number" && Number.isFinite(value[key])) {
      validation[key] = value[key];
    }
  }

  if (typeof value.pattern === "string" && value.pattern.trim()) {
    validation.pattern = value.pattern.trim();
  }

  return Object.keys(validation).length > 0 ? validation : undefined;
};

const normalizeRalphGenerationInterviewHelp = (
  value: unknown,
): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.replace(/\s+/gu, " ").trim();

  if (!normalized) {
    return undefined;
  }

  return normalized.length > 140
    ? `${normalized.slice(0, 137).trimEnd()}...`
    : normalized;
};

const normalizeRalphGenerationInterviewInputValue = (
  value: unknown,
): RalphInputValue | undefined => {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  return undefined;
};

const normalizeRalphGenerationInterviewStringArray = (
  value: unknown,
): string[] => {
  return Array.isArray(value)
    ? value.flatMap((entry) =>
        typeof entry === "string" && entry.trim() ? [entry.trim()] : [],
      )
    : [];
};

export const normalizeRalphGenerationInterviewSubmission = (
  value: unknown,
): RalphGenerationInterviewSubmission => {
  if (!isRecord(value)) {
    throw new Error("Interview response must be a JSON object.");
  }

  const questions = Array.isArray(value.questions) ? value.questions : [];
  const fields = questions
    .flatMap((entry, index): RalphInputField[] => {
      if (!isRecord(entry)) {
        return [];
      }

      const label =
        typeof entry.label === "string" && entry.label.trim()
          ? entry.label.trim()
          : typeof entry.question === "string" && entry.question.trim()
            ? entry.question.trim()
            : "";

      if (!label) {
        return [];
      }

      const type = normalizeRalphGenerationInterviewFieldType(entry.type);
      const options = normalizeRalphGenerationInterviewOptions(entry.options);

      if ((type === "select" || type === "multiselect") && !options) {
        return [];
      }

      const defaultValueSource =
        "defaultValue" in entry && entry.defaultValue !== null
          ? entry.defaultValue
          : entry.default;
      const defaultValue =
        normalizeRalphGenerationInterviewInputValue(defaultValueSource);
      const validation = normalizeRalphGenerationInterviewValidation(
        entry.validation,
      );
      const help = normalizeRalphGenerationInterviewHelp(entry.help);

      return [
        {
          id: normalizeRalphGenerationInterviewFieldId(
            entry.id,
            `question_${index + 1}`,
          ),
          label,
          type,
          required: entry.required === true,
          skippable: entry.skippable !== false,
          ...(typeof entry.placeholder === "string" && entry.placeholder.trim()
            ? { placeholder: entry.placeholder.trim() }
            : {}),
          ...(help ? { help } : {}),
          ...(defaultValue !== undefined ? { defaultValue } : {}),
          ...(options ? { options } : {}),
          ...(validation ? { validation } : {}),
          ...(typeof entry.variableName === "string" && entry.variableName.trim()
            ? { variableName: entry.variableName.trim() }
            : {}),
        },
      ];
    })
    .slice(0, 6);

  return {
    complete: value.complete === true,
    ...(typeof value.summary === "string" && value.summary.trim()
      ? { summary: value.summary.trim() }
      : {}),
    ...(typeof value.questionScope === "string" && value.questionScope.trim()
      ? { questionScope: value.questionScope.trim() }
      : {}),
    ...(typeof value.contextSummary === "string" && value.contextSummary.trim()
      ? { contextSummary: value.contextSummary.trim() }
      : {}),
    findings: normalizeRalphGenerationInterviewStringArray(value.findings),
    assumptions: normalizeRalphGenerationInterviewStringArray(value.assumptions),
    relevantFiles: normalizeRalphGenerationInterviewStringArray(
      value.relevantFiles,
    ),
    fields,
  };
};

const parseRalphGenerationInterviewJsonCandidate = (text: string): unknown => {
  const trimmed = text.trim();
  const taggedMatch = trimmed.match(
    /<ralph_generation_interview>\s*([\s\S]*?)\s*<\/ralph_generation_interview>/iu,
  );
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  const candidate = taggedMatch?.[1]?.trim() ?? fencedMatch?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");

    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }

    throw new Error("Interview response did not contain valid JSON.");
  }
};

export const readRalphGenerationInterviewSubmission = (
  result: TaskExecutionResult,
): RalphGenerationInterviewSubmission => {
  const candidates = [
    ...result.outputSections
      .filter((section) => section.title === RALPH_GENERATION_INTERVIEW_SECTION_TITLE)
      .map((section) => section.lines.join("\n")),
    result.response?.markdown,
    ...result.outputSections.map((section) => section.lines.join("\n")),
    result.summary,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  for (const candidate of candidates) {
    try {
      return normalizeRalphGenerationInterviewSubmission(
        parseRalphGenerationInterviewJsonCandidate(candidate),
      );
    } catch {
      // Try the next candidate; agents may include narrative around the contract.
    }
  }

  throw new Error("The interviewer did not return a valid interview contract.");
};

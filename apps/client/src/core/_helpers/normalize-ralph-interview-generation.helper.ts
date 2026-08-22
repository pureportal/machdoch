import type {
  RalphInputField,
  RalphInputFieldType,
  RalphInputOption,
  RalphInterviewBlock,
} from "../ralph.js";
import {
  isRalphInputFieldType,
  normalizeGeneratedInputFieldId,
} from "./ralph-input-request-state.helper.js";

export interface RalphInterviewGeneration {
  complete: boolean;
  summary?: string;
  fields: RalphInputField[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const normalizeGeneratedInterviewFieldType = (
  value: unknown,
): RalphInputFieldType => {
  if (typeof value !== "string") {
    return "textarea";
  }

  const normalized = value.trim().toLowerCase().replace(/-/gu, "_");
  const aliases: Record<string, RalphInputFieldType> = {
    input: "text",
    string: "text",
    text_area: "textarea",
    multiple_choice: "select",
    single_choice: "select",
    choice: "select",
    choices: "select",
    multi_select: "multiselect",
    checkbox: "boolean",
    checkboxes: "multiselect",
  };
  const aliased = aliases[normalized];

  if (aliased) {
    return aliased;
  }

  return isRalphInputFieldType(normalized) ? normalized : "textarea";
};

const normalizeGeneratedInterviewOptions = (
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
      const label =
        typeof entry.label === "string" && entry.label.trim()
          ? entry.label.trim()
          : optionValue;

      return optionValue ? [{ value: optionValue, label }] : [];
    })
    .slice(0, 20);

  return options.length > 0 ? options : undefined;
};

export const normalizeRalphInterviewGeneration = (
  value: unknown,
  block: Pick<RalphInterviewBlock, "questionsPerTurn">,
): RalphInterviewGeneration => {
  if (!isRecord(value)) {
    throw new Error("Interview AI response must be a JSON object.");
  }

  const complete = value.complete === true;
  const summary =
    typeof value.summary === "string" && value.summary.trim()
      ? value.summary.trim()
      : undefined;
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

      const type = normalizeGeneratedInterviewFieldType(entry.type);
      const options = normalizeGeneratedInterviewOptions(entry.options);

      if ((type === "select" || type === "multiselect") && !options) {
        return [];
      }

      const id = normalizeGeneratedInputFieldId(
        typeof entry.id === "string" ? entry.id : undefined,
        `q_${index + 1}`,
      );

      return [
        {
          id,
          label,
          type,
          required: false,
          skippable: true,
          ...(typeof entry.placeholder === "string" && entry.placeholder.trim()
            ? { placeholder: entry.placeholder.trim() }
            : {}),
          ...(typeof entry.help === "string" && entry.help.trim()
            ? { help: entry.help.trim() }
            : {}),
          ...(options ? { options } : {}),
        },
      ];
    })
    .slice(0, block.questionsPerTurn ?? 3);

  return { complete, ...(summary ? { summary } : {}), fields };
};

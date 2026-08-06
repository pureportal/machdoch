import type { TaskExecutionResult } from "../types.js";

export const MAX_RALPH_RESULT_CHARS = 16_000;

export const truncateRalphResultText = (value: string): string => {
  if (value.length <= MAX_RALPH_RESULT_CHARS) {
    return value;
  }

  const marker = `\n[Ralph result truncated at ${MAX_RALPH_RESULT_CHARS} characters.]\n`;
  const leadingCharacters = Math.ceil(MAX_RALPH_RESULT_CHARS / 2);
  const trailingCharacters = MAX_RALPH_RESULT_CHARS - leadingCharacters;

  return `${value.slice(0, leadingCharacters)}${marker}${value.slice(-trailingCharacters)}`;
};

export const getRalphResultMarkdown = (
  result: TaskExecutionResult | undefined,
): string => {
  return truncateRalphResultText(
    result?.response?.markdown ?? result?.summary ?? result?.reason ?? "",
  );
};

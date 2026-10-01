import { DEFAULT_ANSWER_LANGUAGE } from "../runtime-contract.generated.js";

export const createAnswerLanguageInstruction = (
  answerLanguage: string | undefined,
): string | undefined => {
  const language = (answerLanguage ?? DEFAULT_ANSWER_LANGUAGE).trim();

  if (!language) return undefined;

  return `Write your final answer to the user in ${JSON.stringify(language)}. This applies to your explanations and summary. Generate requested content, including translations, documents, code, and quotations, in the language the task requires, even when that content appears in the final answer.`;
};

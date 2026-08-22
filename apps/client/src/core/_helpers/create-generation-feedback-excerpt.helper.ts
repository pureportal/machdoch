export const createGenerationFeedbackExcerpt = (
  value: string | undefined,
): string => {
  const normalized = value?.replace(/\s+/gu, " ").trim() ?? "";

  return normalized.length > 1_200
    ? `${normalized.slice(0, 1_200)}...`
    : normalized;
};

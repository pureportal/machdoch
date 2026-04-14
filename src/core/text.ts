/**
 * Splits text into lowercase alphanumeric tokens.
 */
export const tokenizeText = (value: string): string[] => {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 0);
};

/**
 * Creates a deduplicated token set for fast keyword lookups.
 */
export const createTokenSet = (value: string): Set<string> => {
  return new Set(tokenizeText(value));
};

/**
 * Checks whether a keyword is present either as an exact token or, for
 * multi-word phrases, as a normalized substring match.
 */
export const tokenSetIncludesKeyword = (
  tokens: ReadonlySet<string>,
  normalizedText: string,
  keyword: string,
): boolean => {
  const normalizedKeyword = keyword.trim().toLowerCase();

  if (normalizedKeyword.length === 0) {
    return false;
  }

  if (normalizedKeyword.includes(" ")) {
    return normalizedText.includes(normalizedKeyword);
  }

  return tokens.has(normalizedKeyword);
};

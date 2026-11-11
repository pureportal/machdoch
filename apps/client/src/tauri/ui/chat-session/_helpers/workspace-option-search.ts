export interface SearchableWorkspaceOption {
  label: string;
  path: string | null;
}

const normalizeWorkspaceSearchText = (value: string): string => {
  return value
    .trim()
    .replace(/\\/gu, "/")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
};

const scoreNormalizedWorkspaceCandidate = (
  normalizedCandidate: string,
  normalizedQuery: string,
  tokens: readonly string[],
  labelBonus: number,
): number => {
  if (!normalizedCandidate) {
    return 0;
  }

  const words = normalizedCandidate.split(" ");
  let score = 0;

  for (const token of tokens) {
    if (normalizedCandidate === token) {
      score += 500;
      continue;
    }

    if (normalizedCandidate.startsWith(token)) {
      score += 420;
      continue;
    }

    if (words.includes(token)) {
      score += 360;
      continue;
    }

    if (words.some((word) => word.startsWith(token))) {
      score += 300;
      continue;
    }

    const tokenIndex = normalizedCandidate.indexOf(token);

    if (tokenIndex < 0) {
      return 0;
    }

    score += 160 - Math.min(tokenIndex, 100);
  }

  if (normalizedCandidate === normalizedQuery) {
    return score + 800 + labelBonus;
  }

  if (normalizedCandidate.startsWith(normalizedQuery)) {
    return score + 620 + labelBonus;
  }

  const phraseIndex = normalizedCandidate.indexOf(normalizedQuery);

  if (phraseIndex >= 0) {
    return score + 420 - Math.min(phraseIndex, 100) + labelBonus;
  }

  return score + labelBonus;
};

const scoreWorkspaceOption = (
  option: SearchableWorkspaceOption,
  normalizedQuery: string,
  tokens: readonly string[],
): number => {
  const labelScore = scoreNormalizedWorkspaceCandidate(
    normalizeWorkspaceSearchText(option.label),
    normalizedQuery,
    tokens,
    120,
  );
  const pathScore = option.path
    ? scoreNormalizedWorkspaceCandidate(
        normalizeWorkspaceSearchText(option.path),
        normalizedQuery,
        tokens,
        0,
      )
    : 0;

  return Math.max(labelScore, pathScore);
};

export const rankWorkspaceOptions = <TOption extends SearchableWorkspaceOption>(
  options: readonly TOption[],
  searchText: string,
): TOption[] => {
  const normalizedQuery = normalizeWorkspaceSearchText(searchText);

  if (!normalizedQuery) {
    return [...options];
  }

  const tokens = normalizedQuery.split(" ");

  return options
    .map((option, order) => ({
      option,
      order,
      score: scoreWorkspaceOption(option, normalizedQuery, tokens),
    }))
    .filter(({ score }) => score > 0)
    .sort(
      (first, second) =>
        second.score - first.score || first.order - second.order,
    )
    .map(({ option }) => option);
};

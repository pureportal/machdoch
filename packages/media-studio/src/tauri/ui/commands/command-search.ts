export interface SearchableCommandItem {
  id: string;
  title: string;
  keywords?: readonly string[];
  order?: number;
}

const normalizeSearchText = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const rankField = (
  field: string,
  query: string,
  tokens: readonly string[],
): number => {
  if (field === query) return 0;
  if (field.startsWith(query)) return 10;
  if (field.split(" ").some((word) => word.startsWith(query))) return 20;
  let position = 0;
  let tokenPenalty = 0;
  for (const token of tokens) {
    const found = field.indexOf(token, position);
    if (found < 0) return Number.POSITIVE_INFINITY;
    tokenPenalty += found;
    position = found + token.length;
  }
  return 30 + tokenPenalty;
};

export const rankCommandItems = <T extends SearchableCommandItem>(
  items: readonly T[],
  search: string,
): readonly T[] => {
  const query = normalizeSearchText(search);
  const tokens = query.split(" ").filter(Boolean);
  return items
    .map((item, index) => {
      const title = normalizeSearchText(item.title);
      const keywordText = normalizeSearchText(item.keywords?.join(" ") ?? "");
      const id = normalizeSearchText(item.id);
      const rank =
        query.length === 0
          ? 0
          : Math.min(
              rankField(title, query, tokens),
              rankField(keywordText, query, tokens) + 5,
              rankField(id, query, tokens) + 8,
            );
      return { item, index, rank };
    })
    .filter(({ rank }) => Number.isFinite(rank))
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        (left.item.order ?? 0) - (right.item.order ?? 0) ||
        left.item.title.localeCompare(right.item.title) ||
        left.item.id.localeCompare(right.item.id) ||
        left.index - right.index,
    )
    .map(({ item }) => item);
};

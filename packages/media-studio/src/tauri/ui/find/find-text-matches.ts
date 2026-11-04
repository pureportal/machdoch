export interface FindOptions {
  matchCase: boolean;
  wholeWord: boolean;
}

export interface FindTextSpan {
  start: number;
  end: number;
}

export interface FindTextMatchResult {
  matches: readonly FindTextSpan[];
  limited: boolean;
}

export interface FindTextPosition {
  segmentIndex: number;
  offset: number;
}

export const MAX_FIND_MATCHES = 1_000;

const WORD_CHARACTER = "[\\p{L}\\p{N}_]";

const escapeRegularExpression = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

export const createFindExpression = (
  query: string,
  options: FindOptions,
): RegExp | null => {
  const terms = query.split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return null;
  const body = terms.map(escapeRegularExpression).join("\\s+");
  const pattern = options.wholeWord
    ? `(?<!${WORD_CHARACTER})${body}(?!${WORD_CHARACTER})`
    : body;
  return new RegExp(pattern, options.matchCase ? "gu" : "giu");
};

export const findTextMatches = (
  text: string,
  query: string,
  options: FindOptions,
  limit = MAX_FIND_MATCHES,
): FindTextMatchResult => {
  const expression = createFindExpression(query, options);
  if (!expression) return { matches: [], limited: false };
  const matches: FindTextSpan[] = [];
  for (const match of text.matchAll(expression)) {
    if (matches.length === limit) return { matches, limited: true };
    matches.push({ start: match.index, end: match.index + match[0].length });
  }
  return { matches, limited: false };
};

export const findFirstIndex = (
  length: number,
  isAtOrAfter: (index: number) => boolean,
): number => {
  let low = 0;
  let high = length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (isAtOrAfter(middle)) high = middle;
    else low = middle + 1;
  }
  return low;
};

export const locateFindSpan = (
  segments: readonly FindTextSpan[],
  span: FindTextSpan,
): { start: FindTextPosition; end: FindTextPosition } | null => {
  const startIndex = findFirstIndex(
    segments.length,
    (index) => segments[index]!.end > span.start,
  );
  const endIndex =
    findFirstIndex(
      segments.length,
      (index) => segments[index]!.start >= span.end,
    ) - 1;
  const startSegment = segments[startIndex];
  const endSegment = segments[endIndex];
  if (!startSegment || !endSegment || startIndex > endIndex) return null;
  return {
    start: {
      segmentIndex: startIndex,
      offset: Math.max(0, span.start - startSegment.start),
    },
    end: {
      segmentIndex: endIndex,
      offset: Math.min(span.end, endSegment.end) - endSegment.start,
    },
  };
};

export const stepFindIndex = (
  index: number,
  count: number,
  direction: 1 | -1,
): number => {
  if (count === 0) return -1;
  if (index < 0) return direction === 1 ? 0 : count - 1;
  return (index + direction + count) % count;
};

export const formatFindStatus = (
  query: string,
  count: number,
  activeIndex: number,
  limited: boolean,
): string => {
  if (!query.trim()) return "";
  if (count === 0) return "No matches";
  return `${activeIndex + 1} of ${count}${limited ? "+" : ""}`;
};

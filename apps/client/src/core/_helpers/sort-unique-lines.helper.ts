const MAX_SORT_INPUT_LINES = 2_000;

export interface SortUniqueLinesOptions {
  caseSensitive: boolean;
  trimLines: boolean;
  removeEmpty: boolean;
  descending: boolean;
}

const splitSortableLines = (text: string): string[] => {
  return text.length === 0 ? [] : text.split(/\r\n|\r|\n/u);
};

const normalizeSortableLine = (
  line: string,
  caseSensitive: boolean,
): string => {
  return caseSensitive ? line : line.toLowerCase();
};

export const sortUniqueLines = (
  text: string,
  options: SortUniqueLinesOptions,
): string[] | string => {
  const rawLines = splitSortableLines(text);

  if (rawLines.length > MAX_SORT_INPUT_LINES) {
    return `Expected \`text\` to contain no more than ${MAX_SORT_INPUT_LINES} lines.`;
  }

  const uniqueLines = new Map<string, string>();

  for (const rawLine of rawLines) {
    const line = options.trimLines ? rawLine.trim() : rawLine;

    if (options.removeEmpty && line.length === 0) {
      continue;
    }

    const key = normalizeSortableLine(line, options.caseSensitive);

    if (!uniqueLines.has(key)) {
      uniqueLines.set(key, line);
    }
  }

  return [...uniqueLines.values()].sort((left, right) => {
    const comparison = normalizeSortableLine(
      left,
      options.caseSensitive,
    ).localeCompare(normalizeSortableLine(right, options.caseSensitive));

    return options.descending ? -comparison : comparison;
  });
};

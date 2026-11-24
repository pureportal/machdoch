export const parseQuickOpenQuery = (
  query: string,
): { pattern: string; line: number | undefined } => {
  const match = /^(.*?):(\d+)\s*$/u.exec(query);
  if (!match) return { pattern: query.trim(), line: undefined };
  return {
    pattern: (match[1] ?? "").trim(),
    line: Math.max(1, Number(match[2])),
  };
};

export interface HighlightSegment {
  text: string;
  highlighted: boolean;
  directory: boolean;
}

export const highlightSegments = (
  path: string,
  positions: readonly number[],
  nameStart: number,
): HighlightSegment[] => {
  const marked = new Set(positions);
  const characters = [...path];
  const segments: HighlightSegment[] = [];
  characters.forEach((character, index) => {
    const highlighted = marked.has(index);
    const directory = index < nameStart;
    const last = segments.at(-1);
    if (
      last &&
      last.highlighted === highlighted &&
      last.directory === directory
    ) {
      last.text += character;
    } else {
      segments.push({ text: character, highlighted, directory });
    }
  });
  return segments;
};

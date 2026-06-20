const PREVIEW_LINE_LIMIT = 3;
const SINGLE_LINE_PREVIEW_LIMIT = 96;

export const createTextPreviewLines = (
  value: string | null | undefined,
  maxLines = PREVIEW_LINE_LIMIT,
  maxLineLength = SINGLE_LINE_PREVIEW_LIMIT,
): string[] => {
  const normalized = (value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();

  if (normalized.length === 0 || maxLines <= 0 || maxLineLength <= 1) {
    return [];
  }

  const allLines = normalized.split("\n");
  const previewLines = allLines.slice(0, maxLines).map((line) => {
    if (line.length <= maxLineLength) {
      return line;
    }

    return `${line.slice(0, maxLineLength - 1)}…`;
  });

  if (allLines.length > maxLines) {
    previewLines.push("…");
  }

  return previewLines;
};

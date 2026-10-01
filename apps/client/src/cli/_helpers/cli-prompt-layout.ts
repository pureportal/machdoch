import { terminalCellWidth } from "./cli-terminal-text.js";

export interface PromptPosition {
  offset: number;
  row: number;
  column: number;
}

export const layoutPrompt = (
  text: string,
  prompt: string,
  width: number,
): { rows: string[]; positions: PromptPosition[] } => {
  const rows = [prompt];
  let row = 0;
  let column = terminalCellWidth(prompt);
  const positions: PromptPosition[] = [];
  for (const { segment, index } of new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  }).segment(text)) {
    const shown = segment === "\t" ? "  " : segment;
    const cells = segment === "\t" ? 2 : terminalCellWidth(segment);
    if (segment !== "\n" && column + cells > width) {
      rows.push("  ");
      row += 1;
      column = 2;
    }
    positions.push({ offset: index, row, column });
    if (segment === "\n") {
      rows.push("  ");
      row += 1;
      column = 2;
    } else {
      rows[row] += shown;
      column += cells;
    }
  }
  positions.push({ offset: text.length, row, column });
  return { rows, positions };
};

import { stripVTControlCharacters } from "node:util";

export const safeTerminalText = (text: string): string =>
  stripVTControlCharacters(text)
    .replace(/\r\n?/gu, "\n")
    .replace(/\p{Cc}/gu, (character) =>
      character === "\n" || character === "\t" ? character : "",
    );

const characterCellWidth = (character: string): number => {
  if (/\p{Mark}|\u200d|\ufe0f/u.test(character)) return 0;
  const code = character.codePointAt(0) ?? 0;
  return code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe6f) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      code >= 0x1f300)
    ? 2
    : 1;
};

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export const terminalCellWidth = (text: string): number => {
  let width = 0;
  for (const { segment } of graphemes.segment(text)) {
    width += /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(segment)
      ? 2
      : Array.from(segment).reduce(
          (sum, character) => sum + characterCellWidth(character),
          0,
        );
  }
  return width;
};

export const clipTerminalText = (text: string, width: number): string => {
  let cells = 0;
  let result = "";
  const clean = safeTerminalText(text).replace(/\n|\t/gu, " ");
  if (terminalCellWidth(clean) <= width) return clean;
  for (const { segment } of graphemes.segment(clean)) {
    cells += terminalCellWidth(segment);
    if (cells > width - 1) break;
    result += segment;
  }
  return width > 0 ? result + "…" : "";
};

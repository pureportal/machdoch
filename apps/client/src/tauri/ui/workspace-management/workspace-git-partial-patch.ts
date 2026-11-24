export interface PatchHunkLine {
  marker: " " | "+" | "-";
  text: string;
  noNewline: boolean;
}

export interface PatchHunk {
  oldStart: number;
  newStart: number;
  section: string;
  lines: PatchHunkLine[];
}

export interface ParsedFilePatch {
  header: string[];
  hunks: PatchHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/u;

export const parseFilePatch = (patch: string): ParsedFilePatch | null => {
  const lines = patch.replace(/\r\n/gu, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const header: string[] = [];
  const hunks: PatchHunk[] = [];
  for (const line of lines) {
    const match = HUNK_HEADER.exec(line);
    if (match) {
      hunks.push({
        oldStart: Number(match[1]),
        newStart: Number(match[3]),
        section: match[5] ?? "",
        lines: [],
      });
      continue;
    }
    const hunk = hunks.at(-1);
    if (!hunk) {
      header.push(line);
      continue;
    }
    if (line.startsWith("\\")) {
      const previous = hunk.lines.at(-1);
      if (previous) previous.noNewline = true;
      continue;
    }
    const marker = line[0];
    if (marker !== " " && marker !== "+" && marker !== "-") {
      if (line === "")
        hunk.lines.push({ marker: " ", text: "", noNewline: false });
      continue;
    }
    hunk.lines.push({ marker, text: line.slice(1), noNewline: false });
  }
  if (hunks.length === 0 || header.length === 0) return null;
  return { header, hunks };
};

export const patchLineKey = (hunkIndex: number, lineIndex: number): string =>
  `${hunkIndex}:${lineIndex}`;

export const hunkLineKeys = (
  patch: ParsedFilePatch,
  hunkIndex: number,
): string[] =>
  (patch.hunks[hunkIndex]?.lines ?? []).flatMap((line, lineIndex) =>
    line.marker === " " ? [] : [patchLineKey(hunkIndex, lineIndex)],
  );

const rangeText = (start: number, count: number): string =>
  count === 1 ? `${start}` : `${start},${count}`;

const hunkStart = (
  start: number,
  sourceCount: number,
  offset: number,
  count: number,
): number => {
  const firstLine = (sourceCount === 0 ? start + 1 : start) + offset;
  return count === 0 ? firstLine - 1 : firstLine;
};

export const buildPartialPatch = (
  patch: ParsedFilePatch,
  selected: ReadonlySet<string>,
  { reverse }: { reverse: boolean },
): string | null => {
  const output = [...patch.header];
  let offset = 0;
  let included = 0;
  patch.hunks.forEach((hunk, hunkIndex) => {
    const body: PatchHunkLine[] = [];
    let changes = 0;
    hunk.lines.forEach((line, lineIndex) => {
      if (
        line.marker === " " ||
        selected.has(patchLineKey(hunkIndex, lineIndex))
      ) {
        body.push(line);
        if (line.marker !== " ") changes += 1;
        return;
      }
      const keepAsContext = reverse ? line.marker === "+" : line.marker === "-";
      if (keepAsContext) body.push({ ...line, marker: " " });
    });
    if (changes === 0) return;
    included += changes;
    const oldCount = body.filter((line) => line.marker !== "+").length;
    const newCount = body.filter((line) => line.marker !== "-").length;
    let oldStart: number;
    let newStart: number;
    if (reverse) {
      newStart = hunk.newStart;
      const sourceCount = hunk.lines.filter(
        (line) => line.marker !== "-",
      ).length;
      oldStart = hunkStart(hunk.newStart, sourceCount, offset, oldCount);
      offset += oldCount - newCount;
    } else {
      oldStart = hunk.oldStart;
      const sourceCount = hunk.lines.filter(
        (line) => line.marker !== "+",
      ).length;
      newStart = hunkStart(hunk.oldStart, sourceCount, offset, newCount);
      offset += newCount - oldCount;
    }
    output.push(
      `@@ -${rangeText(oldStart, oldCount)} +${rangeText(newStart, newCount)} @@${hunk.section}`,
    );
    for (const line of body) {
      output.push(`${line.marker}${line.text}`);
      if (line.noNewline) output.push("\\ No newline at end of file");
    }
  });
  return included === 0 ? null : `${output.join("\n")}\n`;
};

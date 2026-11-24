export type ConflictChoice = "ours" | "theirs" | "both" | "base";

export interface ConflictRegion {
  index: number;
  startLine: number;
  endLine: number;
  ours: string[];
  base: string[] | null;
  theirs: string[];
  oursLabel: string;
  theirsLabel: string;
}

interface ParsedConflictText {
  segments: (string[] | ConflictRegion)[];
  regions: ConflictRegion[];
  lineEnding: string;
  trailingNewline: boolean;
}

const OURS = /^<{7}(?: (.*))?$/u;
const BASE = /^\|{7}(?: .*)?$/u;
const SEPARATOR = /^={7}$/u;
const THEIRS = /^>{7}(?: (.*))?$/u;

export const parseConflictText = (text: string): ParsedConflictText => {
  const lineEnding = text.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = text.endsWith("\n");
  const lines = text.split(/\r?\n/u);
  if (trailingNewline) lines.pop();
  const segments: (string[] | ConflictRegion)[] = [];
  const regions: ConflictRegion[] = [];
  let plain: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const opening = OURS.exec(lines[index]!);
    if (!opening) {
      plain.push(lines[index]!);
      index += 1;
      continue;
    }
    const startLine = index;
    const ours: string[] = [];
    let base: string[] | null = null;
    const theirs: string[] = [];
    let section: "ours" | "base" | "theirs" = "ours";
    let cursor = index + 1;
    let closing: RegExpExecArray | null = null;
    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]!;
      if (section === "ours" && BASE.test(line)) {
        section = "base";
        base = [];
      } else if (section !== "theirs" && SEPARATOR.test(line)) {
        section = "theirs";
      } else if (section === "theirs" && (closing = THEIRS.exec(line))) {
        break;
      } else if (section === "ours") ours.push(line);
      else if (section === "base") base!.push(line);
      else theirs.push(line);
    }
    if (!closing) {
      plain.push(...lines.slice(index));
      break;
    }
    if (plain.length > 0) segments.push(plain);
    plain = [];
    const region: ConflictRegion = {
      index: regions.length,
      startLine,
      endLine: cursor,
      ours,
      base,
      theirs,
      oursLabel: opening[1] ?? "ours",
      theirsLabel: closing[1] ?? "theirs",
    };
    regions.push(region);
    segments.push(region);
    index = cursor + 1;
  }
  if (plain.length > 0) segments.push(plain);
  return { segments, regions, lineEnding, trailingNewline };
};

const chosenLines = (
  region: ConflictRegion,
  choice: ConflictChoice,
): string[] => {
  switch (choice) {
    case "ours":
      return region.ours;
    case "theirs":
      return region.theirs;
    case "both":
      return [...region.ours, ...region.theirs];
    case "base":
      return region.base ?? [];
  }
};

const render = (
  parsed: ParsedConflictText,
  choose: (region: ConflictRegion) => ConflictChoice | null,
): string => {
  const lines: string[] = [];
  for (const segment of parsed.segments) {
    if (Array.isArray(segment)) {
      lines.push(...segment);
      continue;
    }
    const choice = choose(segment);
    if (choice) {
      lines.push(...chosenLines(segment, choice));
      continue;
    }
    lines.push(`<<<<<<< ${segment.oursLabel}`, ...segment.ours);
    if (segment.base) lines.push("|||||||", ...segment.base);
    lines.push("=======", ...segment.theirs, `>>>>>>> ${segment.theirsLabel}`);
  }
  const joined = lines.join(parsed.lineEnding);
  return parsed.trailingNewline ? `${joined}${parsed.lineEnding}` : joined;
};

export const resolveConflictRegion = (
  text: string,
  regionIndex: number,
  choice: ConflictChoice,
): string =>
  render(parseConflictText(text), (region) =>
    region.index === regionIndex ? choice : null,
  );

export const resolveAllConflicts = (
  text: string,
  choice: ConflictChoice,
): string => render(parseConflictText(text), () => choice);

export const hasConflictMarkers = (text: string): boolean =>
  parseConflictText(text).regions.length > 0;

export type WorkspaceGitDiffLineKind =
  | "hunk"
  | "context"
  | "addition"
  | "deletion"
  | "note";

export interface WorkspaceGitDiffLine {
  kind: WorkspaceGitDiffLineKind;
  text: string;
  oldLine?: number;
  newLine?: number;
}

const HIDDEN_HEADER = /^(?:diff --git |diff --cc |index |--- |\+\+\+ )/u;
const NOTE_HEADER =
  /^(?:new file mode|deleted file mode|old mode|new mode|similarity index|rename from|rename to|copy from|copy to|Binary files|\\ No newline)/u;
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;

export const parseWorkspaceGitPatch = (
  content: string,
): WorkspaceGitDiffLine[] => {
  const lines: WorkspaceGitDiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let combined = false;
  for (const text of content.split(/\r?\n/u)) {
    const hunk = HUNK.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      combined = false;
      lines.push({ kind: "hunk", text });
      continue;
    }
    if (text.startsWith("@@@")) {
      inHunk = true;
      combined = true;
      lines.push({ kind: "hunk", text });
      continue;
    }
    if (NOTE_HEADER.test(text)) {
      lines.push({ kind: "note", text });
      continue;
    }
    if (!inHunk) {
      if (!HIDDEN_HEADER.test(text) && text.length > 0) {
        lines.push({ kind: "note", text });
      }
      continue;
    }
    if (combined) {
      const markers = text.slice(0, 2);
      lines.push({
        kind: markers.includes("+")
          ? "addition"
          : markers.includes("-")
            ? "deletion"
            : "context",
        text,
      });
      continue;
    }
    if (text.startsWith("+")) {
      lines.push({ kind: "addition", text, newLine: newLine++ });
    } else if (text.startsWith("-")) {
      lines.push({ kind: "deletion", text, oldLine: oldLine++ });
    } else if (HIDDEN_HEADER.test(text)) {
      inHunk = false;
    } else {
      lines.push({
        kind: "context",
        text,
        oldLine: oldLine++,
        newLine: newLine++,
      });
    }
  }
  while (lines.at(-1)?.kind === "context" && lines.at(-1)?.text === "") {
    lines.pop();
  }
  return lines;
};

export const workspaceGitPatchStats = (
  lines: readonly WorkspaceGitDiffLine[],
): { additions: number; deletions: number } => ({
  additions: lines.filter((line) => line.kind === "addition").length,
  deletions: lines.filter((line) => line.kind === "deletion").length,
});

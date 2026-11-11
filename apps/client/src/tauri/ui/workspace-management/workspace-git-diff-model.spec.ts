import { describe, expect, it } from "vitest";
import {
  parseWorkspaceGitPatch,
  workspaceGitPatchStats,
} from "./workspace-git-diff-model";

describe("workspace Git diff model", () => {
  it("numbers old and new lines and hides file headers", () => {
    const lines = parseWorkspaceGitPatch(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "index 19b7ae1..84d0f31 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -41,3 +41,4 @@ export interface State {",
        "   root: string;",
        "-  old: string;",
        "+  revision: string;",
        "+  next: string;",
        " }",
        "",
      ].join("\n"),
    );
    expect(
      lines.map((line) => [line.kind, line.oldLine, line.newLine]),
    ).toEqual([
      ["hunk", undefined, undefined],
      ["context", 41, 41],
      ["deletion", 42, undefined],
      ["addition", undefined, 42],
      ["addition", undefined, 43],
      ["context", 43, 44],
    ]);
    expect(workspaceGitPatchStats(lines)).toEqual({
      additions: 2,
      deletions: 1,
    });
  });

  it("keeps file notes and restarts numbering for each hunk", () => {
    const lines = parseWorkspaceGitPatch(
      [
        "diff --git a/b.md b/b.md",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/b.md",
        "@@ -0,0 +1,1 @@",
        "+first",
        "@@ -10,1 +11,1 @@",
        "-ten",
        "+eleven",
        "\\ No newline at end of file",
      ].join("\n"),
    );
    expect(lines[0]).toEqual({ kind: "note", text: "new file mode 100644" });
    expect(lines.find((line) => line.text === "+first")?.newLine).toBe(1);
    expect(lines.find((line) => line.text === "-ten")?.oldLine).toBe(10);
    expect(lines.find((line) => line.text === "+eleven")?.newLine).toBe(11);
    expect(lines.at(-1)?.kind).toBe("note");
  });

  it("classifies combined conflict diffs without line numbers", () => {
    const lines = parseWorkspaceGitPatch(
      [
        "diff --cc src/conflict.ts",
        "@@@ -1,1 -1,1 +1,5 @@@",
        "++<<<<<<< HEAD",
        " +export const mode = 'local';",
        "+ +export const mode = 'remote';",
        "  unchanged",
      ].join("\n"),
    );
    expect(lines.map((line) => line.kind)).toEqual([
      "hunk",
      "addition",
      "addition",
      "addition",
      "context",
    ]);
    expect(lines.every((line) => line.oldLine === undefined)).toBe(true);
  });

  it("reports binary changes as notes", () => {
    expect(
      parseWorkspaceGitPatch(
        "diff --git a/x.bin b/x.bin\nBinary files a/x.bin and b/x.bin differ",
      ),
    ).toEqual([
      { kind: "note", text: "Binary files a/x.bin and b/x.bin differ" },
    ]);
  });
});

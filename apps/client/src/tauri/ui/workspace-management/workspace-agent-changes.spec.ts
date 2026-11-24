import { describe, expect, it } from "vitest";
import {
  formatFileContextForChat,
  latestAgentChangedFiles,
} from "./workspace-agent-changes";

const execution = (
  files: {
    path: string;
    repositoryPath?: string;
    operation: "added" | "modified";
  }[],
) => ({
  source: {
    kind: "execution",
    execution: {
      fileChanges: {
        files: files.map((file) => ({
          ...file,
          entryType: "text" as const,
          oldMode: "100644",
          newMode: "100644",
          lineAnalysis: {
            state: "complete" as const,
            additions: 1,
            deletions: 0,
          },
        })),
      } as never,
    },
  },
});

describe("agent changed files", () => {
  it("uses the latest task with file changes and prefixes nested repositories", () => {
    expect(
      latestAgentChangedFiles([
        execution([{ path: "old.ts", operation: "modified" }]),
        execution([
          { path: "src/a.ts", operation: "modified" },
          { path: "b.ts", repositoryPath: "packages/api", operation: "added" },
        ]),
        { source: { kind: "preview" } },
      ]),
    ).toEqual([
      { path: "src/a.ts", operation: "modified" },
      { path: "packages/api/b.ts", operation: "added" },
    ]);
    expect(latestAgentChangedFiles([{ source: undefined }])).toEqual([]);
  });

  it("formats files and selections for the composer", () => {
    expect(
      formatFileContextForChat({ path: "src/a.ts", selection: null }),
    ).toBe("`src/a.ts`");
    expect(
      formatFileContextForChat({
        path: "src/a.ts",
        selection: { fromLine: 3, toLine: 4, text: "x\ny" },
      }),
    ).toBe("`src/a.ts:3-4`\n```\nx\ny\n```");
  });
});

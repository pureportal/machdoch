import { describe, expect, it } from "vitest";
import {
  adjacentCommandLine,
  parseFinalTermSequence,
  parseVsCodeShellSequence,
  parseWorkingDirectoryUrl,
  unescapeShellIntegrationValue,
  workspaceRelativeDirectory,
} from "./workspace-terminal-shell-integration";

describe("terminal shell integration", () => {
  it("parses command boundaries, exit codes, command lines and folders", () => {
    expect(parseVsCodeShellSequence("A")).toEqual({ kind: "prompt-start" });
    expect(parseVsCodeShellSequence("C")).toEqual({ kind: "command-executed" });
    expect(parseVsCodeShellSequence("D;2")).toEqual({
      kind: "command-finished",
      exitCode: 2,
    });
    expect(parseVsCodeShellSequence("D")).toEqual({
      kind: "command-finished",
      exitCode: null,
    });
    expect(parseVsCodeShellSequence("E;git commit -m a\\x3bb")).toEqual({
      kind: "command-line",
      command: "git commit -m a;b",
    });
    expect(parseVsCodeShellSequence("P;Cwd=C:\\\\work\\\\app")).toEqual({
      kind: "cwd",
      path: "C:\\work\\app",
    });
    expect(parseVsCodeShellSequence("P;Other=1")).toBeNull();
    expect(parseFinalTermSequence("D;0")).toEqual({
      kind: "command-finished",
      exitCode: 0,
    });
    expect(parseWorkingDirectoryUrl("file://host/home/me/app%20x")).toEqual({
      kind: "cwd",
      path: "/home/me/app x",
    });
    expect(parseWorkingDirectoryUrl("file:///C:/work")).toEqual({
      kind: "cwd",
      path: "C:/work",
    });
    expect(unescapeShellIntegrationValue("a\\\\b\\x0ac")).toBe("a\\b\nc");
  });

  it("jumps between recorded commands", () => {
    const records = [{ promptLine: 3 }, { promptLine: 10 }, { promptLine: 40 }];
    expect(adjacentCommandLine(records, 20, "previous")).toBe(10);
    expect(adjacentCommandLine(records, 20, "next")).toBe(40);
    expect(adjacentCommandLine(records, 3, "previous")).toBeNull();
  });

  it("maps shell folders into the workspace", () => {
    expect(
      workspaceRelativeDirectory("C:\\Work\\App\\src", "c:/work/app"),
    ).toBe("src");
    expect(workspaceRelativeDirectory("/home/me/app", "/home/me/app")).toBe(
      ".",
    );
    expect(
      workspaceRelativeDirectory("/home/me/other", "/home/me/app"),
    ).toBeNull();
  });
});

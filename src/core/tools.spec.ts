import {
  getToolDefinition,
  getToolRegistry,
  inferSuggestedTools,
} from "./tools.ts";

describe("getToolRegistry", () => {
  it("returns defensive copies of tool definitions", () => {
    const registry = getToolRegistry();
    const originalFilesystemKeywords = [...(registry[0]?.keywords ?? [])];

    registry[0]?.keywords.push("mutated-keyword");

    expect(getToolRegistry()[0]?.keywords).toEqual(originalFilesystemKeywords);
  });
});

describe("getToolDefinition", () => {
  it("returns a tool definition for a known tool name", () => {
    expect(getToolDefinition("filesystem")).toMatchObject({
      name: "filesystem",
      title: "Filesystem",
    });
  });

  it("returns undefined for an unknown tool name", () => {
    expect(getToolDefinition("unknown" as never)).toBeUndefined();
  });
});

describe("inferSuggestedTools", () => {
  it("matches tool keywords and falls back to filesystem + shell when nothing matches", () => {
    expect(
      inferSuggestedTools("read a file, run a command, and install a package"),
    ).toEqual(["filesystem", "shell", "packages"]);

    expect(inferSuggestedTools("brainstorm a product direction")).toEqual([
      "filesystem",
      "shell",
    ]);
  });

  it("does not match partial words inside larger tokens", () => {
    const tools = inferSuggestedTools(
      "review website runtime architecture and digit grouping",
    );

    expect(tools).toContain("browser");
    expect(tools).not.toContain("shell");
    expect(tools).not.toContain("git");
  });

  it("deduplicates repeated git matches", () => {
    expect(
      inferSuggestedTools("commit the branch, inspect the repo, and use git"),
    ).toEqual(["git"]);
  });

  it("uses network for current weather and forecast requests", () => {
    expect(inferSuggestedTools("What is the weather?")).toEqual(["network"]);
    expect(inferSuggestedTools("show the forecast for Berlin")).toEqual([
      "network",
    ]);
  });

  it("keeps coding and verification tools when the task also asks for online research", () => {
    expect(
      inferSuggestedTools(
        "Research online before you implement better logic in the project",
      ),
    ).toEqual(["filesystem", "shell", "network"]);
  });

  it("prefers filesystem-only suggestions for deterministic read-only inspection tasks", () => {
    expect(inferSuggestedTools("show profiles")).toEqual(["filesystem"]);
    expect(inferSuggestedTools("inspect config")).toEqual(["filesystem"]);
    expect(inferSuggestedTools("list prompts")).toEqual(["filesystem"]);
    expect(
      inferSuggestedTools("scan this workspace and explain the setup"),
    ).toEqual(["filesystem"]);
  });
});

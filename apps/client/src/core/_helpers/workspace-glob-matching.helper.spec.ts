import { matchesWorkspaceGlob } from "./workspace-glob-matching.helper.ts";

describe("matchesWorkspaceGlob", () => {
  it("supports *, **, and ? path matching for workspace-relative paths", () => {
    expect(matchesWorkspaceGlob("src/core/config.ts", "src/**/*.ts")).toBe(
      true,
    );
    expect(matchesWorkspaceGlob("src/core/config.ts", "src/*/config.ts")).toBe(
      true,
    );
    expect(matchesWorkspaceGlob("src/core/config.ts", "src/*/config.?s")).toBe(
      true,
    );
    expect(matchesWorkspaceGlob("src/core/config.ts", "src/*.ts")).toBe(false);
    expect(matchesWorkspaceGlob("README.md", "src/**/*.ts")).toBe(false);
  });

  it("normalizes slashes, leading dots, and empty root paths before matching", () => {
    expect(matchesWorkspaceGlob(".\\src\\core\\config.ts", "/src/**/*.ts")).toBe(
      true,
    );
    expect(matchesWorkspaceGlob("./", ".")).toBe(true);
    expect(matchesWorkspaceGlob("src/core/config.ts/", "src/core/config.ts")).toBe(
      true,
    );
  });
});

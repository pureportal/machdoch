import { describe, expect, it } from "vitest";
import { repositoryForWorkspacePath } from "./workspace-path-repository";

const repositories = [
  { repositoryRoot: "C:/work", relativePath: "." },
  { repositoryRoot: "C:/work/packages/api", relativePath: "packages\\api" },
  {
    repositoryRoot: "C:/work/packages/api-docs",
    relativePath: "packages/api-docs",
  },
];

describe("repository for a workspace path", () => {
  it("picks the innermost repository and makes the path relative to it", () => {
    expect(
      repositoryForWorkspacePath(repositories, "packages/api/src/a.ts"),
    ).toEqual({
      repositoryRoot: "C:/work/packages/api",
      relativePath: "src/a.ts",
    });
    expect(
      repositoryForWorkspacePath(repositories, "packages/api-docs/readme.md"),
    ).toEqual({
      repositoryRoot: "C:/work/packages/api-docs",
      relativePath: "readme.md",
    });
    expect(repositoryForWorkspacePath(repositories, "README.md")).toEqual({
      repositoryRoot: "C:/work",
      relativePath: "README.md",
    });
  });

  it("returns nothing for repository roots or paths outside every repository", () => {
    expect(repositoryForWorkspacePath(repositories, "packages/api")).toBeNull();
    expect(
      repositoryForWorkspacePath(repositories.slice(1), "docs/a.md"),
    ).toBeNull();
  });
});

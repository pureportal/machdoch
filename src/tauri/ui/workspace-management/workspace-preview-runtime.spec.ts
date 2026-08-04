import { describe, expect, it } from "vitest";
import {
  discoverPreviewWorkspaceGitRepositories,
  listPreviewWorkspaceDirectory,
  loadPreviewWorkspaceGitDiff,
  loadPreviewWorkspaceGitOverview,
  loadPreviewWorkspacePullRequests,
  readPreviewWorkspaceFile,
  resolvePreviewWorkspaceFileSource,
} from "./workspace-preview-runtime";

describe("workspace browser preview runtime", () => {
  it("exposes representative file and media states", () => {
    const assets = listPreviewWorkspaceDirectory("assets", 0);
    expect(assets.entries.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(["sample.bin", "tone.wav", "clip.webm"]),
    );
    expect(readPreviewWorkspaceFile("assets/sample.bin").kind).toBe("binary");
    expect(readPreviewWorkspaceFile("docs/build-output.log").kind).toBe(
      "oversized",
    );
    expect(readPreviewWorkspaceFile("docs/sample.pdf").previewKind).toBe("pdf");
    expect(resolvePreviewWorkspaceFileSource("assets/tone.wav")).toMatch(
      /^data:audio\/wav;base64,/u,
    );
  });

  it("covers status, renamed, binary, diff, and pull-request Git states", () => {
    const workspaceRoot = "C:\\Projects\\machdoch";
    const repositories =
      discoverPreviewWorkspaceGitRepositories(workspaceRoot).repositories;
    expect(repositories.map((repository) => repository.relativePath)).toEqual([
      ".",
      "packages/desktop",
    ]);
    const repositoryRoot = repositories[0]?.repositoryRoot ?? workspaceRoot;
    const overview = loadPreviewWorkspaceGitOverview(
      workspaceRoot,
      repositoryRoot,
    );
    expect(overview.totalChanges).toBe(overview.changes.length);
    expect(overview.changes.some((change) => change.conflicted)).toBe(true);
    const renamed = overview.changes.find((change) => change.originalPath);
    expect(renamed?.path).toBe("assets/branding/machdoch.svg");
    expect(
      loadPreviewWorkspaceGitDiff(
        workspaceRoot,
        repositoryRoot,
        renamed?.path ?? "",
      ).originalPath,
    ).toBe("assets/old-logo.svg");
    expect(
      loadPreviewWorkspaceGitDiff(
        workspaceRoot,
        repositoryRoot,
        "assets/sample.bin",
      ).patches[0]?.binary,
    ).toBe(true);
    expect(
      loadPreviewWorkspacePullRequests(workspaceRoot, repositoryRoot).items,
    ).toHaveLength(1);
  });

  it("keeps preview status, diffs, and pull requests repository-specific", () => {
    const workspaceRoot = "C:\\Projects\\machdoch";
    const repositories =
      discoverPreviewWorkspaceGitRepositories(workspaceRoot).repositories;
    const rootRepository = repositories[0]?.repositoryRoot ?? workspaceRoot;
    const desktopRepository = repositories[1]?.repositoryRoot ?? workspaceRoot;
    const rootOverview = loadPreviewWorkspaceGitOverview(
      workspaceRoot,
      rootRepository,
    );
    const desktopOverview = loadPreviewWorkspaceGitOverview(
      workspaceRoot,
      desktopRepository,
    );

    expect(rootOverview.branch).toBe("main");
    expect(desktopOverview.branch).toBe("feature/desktop-shell");
    expect(desktopOverview.changes.map((change) => change.path)).toEqual([
      "src/window.ts",
    ]);
    expect(() =>
      loadPreviewWorkspaceGitDiff(
        workspaceRoot,
        rootRepository,
        "src/window.ts",
      ),
    ).toThrow("This file is no longer changed.");
    expect(
      loadPreviewWorkspaceGitDiff(
        workspaceRoot,
        desktopRepository,
        "src/window.ts",
      ).patches[0]?.content,
    ).toContain("packages/desktop");
    expect(
      loadPreviewWorkspacePullRequests(workspaceRoot, rootRepository).items[0]
        ?.number,
    ).toBe(128);
    expect(
      loadPreviewWorkspacePullRequests(workspaceRoot, desktopRepository)
        .items[0]?.number,
    ).toBe(42);
  });
});

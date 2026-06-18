import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  extractExplicitInspectionPathReference,
  extractTaskPathReferences,
  matchesWorkspaceGlob,
  resolveDeterministicCreateFileTarget,
} from "./task-paths.ts";

const workspacesToClean: string[] = [];

const createWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-paths-"));
  workspacesToClean.push(workspaceRoot);
  return workspaceRoot;
};

const resolveExistingPath = (...segments: string[]): string => {
  return realpathSync.native(join(...segments));
};

const resolveMissingPath = (
  existingRoot: string,
  ...missingSegments: string[]
): string => {
  return resolve(realpathSync.native(existingRoot), ...missingSegments);
};

const createDirectoryLink = async (
  targetPath: string,
  linkPath: string,
): Promise<void> => {
  await symlink(
    targetPath,
    linkPath,
    process.platform === "win32" ? "junction" : "dir",
  );
};

afterEach(async () => {
  await Promise.all(
    workspacesToClean
      .splice(0)
      .map((workspaceRoot) =>
        rm(workspaceRoot, { recursive: true, force: true }),
      ),
  );
});

describe("extractTaskPathReferences", () => {
  it("extracts plausible quoted and inline workspace paths while deduplicating exact repeats", async () => {
    const workspaceRoot = await createWorkspace();

    await mkdir(join(workspaceRoot, "src", "core"), { recursive: true });
    await writeFile(join(workspaceRoot, "README.md"), "# machdoch\n");
    await writeFile(
      join(workspaceRoot, "src", "core", "config.ts"),
      "export {};\n",
    );

    const references = extractTaskPathReferences(
      'show "src/core/config.ts" README.md README.md',
      workspaceRoot,
    );

    expect(references).toEqual([
      {
        requestedPath: "src/core/config.ts",
        resolvedPath: resolveExistingPath(
          workspaceRoot,
          "src",
          "core",
          "config.ts",
        ),
        insideWorkspace: true,
        workspacePath: "src/core/config.ts",
      },
      {
        requestedPath: "README.md",
        resolvedPath: resolveExistingPath(workspaceRoot, "README.md"),
        insideWorkspace: true,
        workspacePath: "README.md",
      },
    ]);
  });

  it("ignores arbitrary quoted text that does not look like a path candidate", async () => {
    const workspaceRoot = await createWorkspace();

    const references = extractTaskPathReferences(
      'debug-build error="TypeScript compile fails in CI"',
      workspaceRoot,
    );

    expect(references).toEqual([]);
  });

  it("recognizes existing extensionless paths and marks outside-workspace references", async () => {
    const workspaceRoot = await createWorkspace();

    await mkdir(join(workspaceRoot, "docs"), { recursive: true });

    const references = extractTaskPathReferences(
      'list docs and show "../secret.txt"',
      workspaceRoot,
    );

    expect(references).toEqual([
      {
        requestedPath: "../secret.txt",
        resolvedPath: resolveMissingPath(resolve(workspaceRoot, ".."), "secret.txt"),
        insideWorkspace: false,
      },
      {
        requestedPath: "docs",
        resolvedPath: resolveExistingPath(workspaceRoot, "docs"),
        insideWorkspace: true,
        workspacePath: "docs",
      },
    ]);
  });

  it("treats symlinked paths that escape the workspace as outside-workspace references", async () => {
    const workspaceRoot = await createWorkspace();
    const externalRoot = await createWorkspace();

    await mkdir(join(externalRoot, "shared"), { recursive: true });
    await writeFile(join(externalRoot, "shared", "secret.txt"), "classified\n");
    await createDirectoryLink(
      join(externalRoot, "shared"),
      join(workspaceRoot, "linked-shared"),
    );

    const references = extractTaskPathReferences(
      "read linked-shared/secret.txt",
      workspaceRoot,
    );

    expect(references).toEqual([
      {
        requestedPath: "linked-shared/secret.txt",
        resolvedPath: resolveExistingPath(
          externalRoot,
          "shared",
          "secret.txt",
        ),
        insideWorkspace: false,
      },
    ]);
  });
});

describe("extractExplicitInspectionPathReference", () => {
  it("requires an inspection-style action before returning a path reference", async () => {
    const workspaceRoot = await createWorkspace();

    await writeFile(join(workspaceRoot, "README.md"), "# machdoch\n");

    expect(
      extractExplicitInspectionPathReference("review README.md", workspaceRoot),
    ).toBeUndefined();

    expect(
      extractExplicitInspectionPathReference(
        "show (README.md).",
        workspaceRoot,
      ),
    ).toEqual({
      requestedPath: "README.md",
      resolvedPath: resolveExistingPath(workspaceRoot, "README.md"),
      insideWorkspace: true,
      workspacePath: "README.md",
    });
  });
});

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
});

describe("resolveDeterministicCreateFileTarget", () => {
  it("marks inferred create targets under symlinked directories as outside the workspace", async () => {
    const workspaceRoot = await createWorkspace();
    const externalRoot = await createWorkspace();

    await mkdir(join(externalRoot, "shared"), { recursive: true });
    await createDirectoryLink(
      join(externalRoot, "shared"),
      join(workspaceRoot, "linked-shared"),
    );

    expect(
      resolveDeterministicCreateFileTarget(
        'create "linked-shared/new.txt"',
        workspaceRoot,
      ),
    ).toEqual({
      requestedPath: "linked-shared/new.txt",
      resolvedPath: resolveMissingPath(
        join(externalRoot, "shared"),
        "new.txt",
      ),
      insideWorkspace: false,
      inferredPath: false,
    });
  });
});

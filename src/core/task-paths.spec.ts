import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractExplicitInspectionPathReference,
  extractTaskPathReferences,
  matchesWorkspaceGlob,
} from "./task-paths.ts";

const workspacesToClean: string[] = [];

const createWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-paths-"));
  workspacesToClean.push(workspaceRoot);
  return workspaceRoot;
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
        resolvedPath: join(workspaceRoot, "src", "core", "config.ts"),
        insideWorkspace: true,
        workspacePath: "src/core/config.ts",
      },
      {
        requestedPath: "README.md",
        resolvedPath: join(workspaceRoot, "README.md"),
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
        resolvedPath: join(workspaceRoot, "..", "secret.txt"),
        insideWorkspace: false,
      },
      {
        requestedPath: "docs",
        resolvedPath: join(workspaceRoot, "docs"),
        insideWorkspace: true,
        workspacePath: "docs",
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
      resolvedPath: join(workspaceRoot, "README.md"),
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

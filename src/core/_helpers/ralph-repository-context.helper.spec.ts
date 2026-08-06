import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertRalphRepositoryContextUnchanged,
  resolveRalphRepositoryContext,
} from "./ralph-repository-context.helper.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("RALPH repository context", () => {
  it("selects the nested worktree containing the detected project", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-repository-"));
    temporaryDirectories.push(workspace);
    const nested = join(workspace, "vendor", "project");
    await mkdir(nested, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: nested });
    execFileSync("git", ["config", "user.email", "ralph@example.invalid"], {
      cwd: nested,
    });
    execFileSync("git", ["config", "user.name", "RALPH Test"], { cwd: nested });
    await writeFile(join(nested, "package.json"), "{}\n", "utf8");
    execFileSync("git", ["add", "package.json"], { cwd: nested });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: nested });

    const context = await resolveRalphRepositoryContext({
      workspaceRoot: workspace,
      projectPath: nested,
    });

    expect(context.source).toBe("nested");
    expect(context.worktreeRoot).toBe(await realpath(nested));
    expect(context.workspacePath).toBe("vendor/project");
    expect(context.digest).toHaveLength(64);
  });

  it("keeps repository identity stable across legitimate new revisions", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-repository-"));
    temporaryDirectories.push(workspace);
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "ralph@example.invalid"], {
      cwd: workspace,
    });
    execFileSync("git", ["config", "user.name", "RALPH Test"], {
      cwd: workspace,
    });
    await writeFile(join(workspace, "package.json"), "{}\n", "utf8");
    execFileSync("git", ["add", "package.json"], { cwd: workspace });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: workspace });
    const before = await resolveRalphRepositoryContext({
      workspaceRoot: workspace,
      projectPath: workspace,
    });

    await writeFile(
      join(workspace, "package.json"),
      '{"private":true}\n',
      "utf8",
    );
    execFileSync("git", ["add", "package.json"], { cwd: workspace });
    execFileSync("git", ["commit", "-qm", "next"], { cwd: workspace });
    const after = await resolveRalphRepositoryContext({
      workspaceRoot: workspace,
      projectPath: workspace,
    });

    expect(after.head).not.toBe(before.head);
    expect(after.digest).toBe(before.digest);
    expect(() =>
      assertRalphRepositoryContextUnchanged(before, after),
    ).not.toThrow();
  });
});

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectRalphGitChangeSnapshot } from "./ralph-git-change-snapshot.helper.js";

describe("RALPH Git change snapshots", () => {
  it("excludes engine control artifacts for a workspace nested inside its worktree", async () => {
    if (spawnSync("git", ["--version"]).status !== 0) {
      return;
    }

    const root = await mkdtemp(join(tmpdir(), "ralph-git-snapshot-"));
    const workspace = join(root, "packages", "app");
    const artifactPath = join(workspace, "artifact.js");

    try {
      await mkdir(workspace, { recursive: true });
      await writeFile(artifactPath, "export const value = 1;\n", "utf8");
      expect(spawnSync("git", ["init"], { cwd: root }).status).toBe(0);
      expect(
        spawnSync("git", ["config", "user.email", "test@example.com"], {
          cwd: root,
        }).status,
      ).toBe(0);
      expect(
        spawnSync("git", ["config", "user.name", "Test"], { cwd: root }).status,
      ).toBe(0);
      expect(spawnSync("git", ["add", "."], { cwd: root }).status).toBe(0);
      expect(
        spawnSync("git", ["commit", "-m", "initial"], { cwd: root }).status,
      ).toBe(0);

      await writeFile(artifactPath, "export const value = 2;\n", "utf8");
      const runDirectory = join(
        workspace,
        ".machdoch",
        "ralph",
        "runs",
        "run-1",
      );
      await mkdir(runDirectory, { recursive: true });
      await writeFile(join(runDirectory, "run.json"), '{"status":"running"}');
      await writeFile(
        join(workspace, ".machdoch", "ralph", "counters.json"),
        '{"counters":{"loop":{"run":{"count":3}}}}',
      );

      const snapshot = await collectRalphGitChangeSnapshot({
        cwd: workspace,
        workspaceRoot: workspace,
        timeoutMs: 30_000,
        maxOutputBytes: 1_000_000,
      });

      expect(snapshot.changedFiles).toEqual(["artifact.js"]);
      expect(snapshot.diffFiles).toEqual(["artifact.js"]);
      expect(snapshot.status).not.toContain(".machdoch");
      expect(snapshot.diffStat).not.toContain(".machdoch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

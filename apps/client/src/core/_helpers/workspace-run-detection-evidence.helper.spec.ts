import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectWorkspaceRunEvidence,
  formatWorkspaceRunEvidence,
} from "./workspace-run-detection-evidence.helper.js";

let workspace: string | undefined;

afterEach(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
  workspace = undefined;
});

describe("collectWorkspaceRunEvidence", () => {
  it("collects manifests, editor launch files, and lockfiles without dependency trees", async () => {
    workspace = await mkdtemp(join(tmpdir(), "machdoch-run-evidence-"));
    await mkdir(join(workspace, ".vscode"));
    await mkdir(join(workspace, "apps", "api"), { recursive: true });
    await mkdir(join(workspace, "node_modules", "left-pad"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify({
        name: "root",
        scripts: { dev: "turbo dev" },
        dependencies: { react: "1.0.0" },
        description: "ignored",
      }),
    );
    await writeFile(join(workspace, "pnpm-lock.yaml"), "lockfileVersion: 9");
    await writeFile(
      join(workspace, ".vscode", "launch.json"),
      '{ "configurations": [] }',
    );
    await writeFile(
      join(workspace, "demo.code-workspace"),
      '{ "folders": [] }',
    );
    await writeFile(
      join(workspace, "apps", "api", "package.json"),
      JSON.stringify({ scripts: { start: "node server.js" } }),
    );
    await writeFile(
      join(workspace, "node_modules", "left-pad", "package.json"),
      "{}",
    );

    const evidence = await collectWorkspaceRunEvidence(workspace);

    expect(evidence.lockfiles).toEqual(["pnpm-lock.yaml"]);
    expect(evidence.directories).toEqual(["apps", "apps/api"]);
    expect(evidence.files.map((file) => file.path)).toEqual([
      ".vscode/launch.json",
      "demo.code-workspace",
      "package.json",
      "apps/api/package.json",
    ]);
    const rootManifest = JSON.parse(
      evidence.files.find((file) => file.path === "package.json")!.content,
    ) as Record<string, unknown>;
    expect(rootManifest).toEqual({
      name: "root",
      scripts: { dev: "turbo dev" },
      dependencyNames: ["react"],
    });
    expect(formatWorkspaceRunEvidence(evidence)).toContain(
      "File: apps/api/package.json",
    );
  });
});

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSchedulerPromptFile } from "./cli-scheduler-commands.js";

const createWorkspaceFixture = async (): Promise<{
  root: string;
  workspaceRoot: string;
}> => {
  const root = await mkdtemp(join(tmpdir(), "machdoch-scheduler-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);

  return { root, workspaceRoot };
};

describe("readSchedulerPromptFile", () => {
  it("reads prompt files inside the workspace", async () => {
    const { root, workspaceRoot } = await createWorkspaceFixture();

    try {
      await writeFile(join(workspaceRoot, "prompt.txt"), "  Inspect logs.  \n");

      await expect(
        readSchedulerPromptFile(workspaceRoot, "prompt.txt"),
      ).resolves.toBe("Inspect logs.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects absolute prompt files outside the workspace", async () => {
    const { root, workspaceRoot } = await createWorkspaceFixture();

    try {
      const outsidePrompt = join(root, "secret.txt");
      await writeFile(outsidePrompt, "private prompt");

      await expect(
        readSchedulerPromptFile(workspaceRoot, outsidePrompt),
      ).rejects.toThrow(/outside the workspace/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects traversal prompt files outside the workspace", async () => {
    const { root, workspaceRoot } = await createWorkspaceFixture();

    try {
      await writeFile(join(root, "secret.txt"), "private prompt");

      await expect(
        readSchedulerPromptFile(workspaceRoot, join("..", "secret.txt")),
      ).rejects.toThrow(/outside the workspace/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

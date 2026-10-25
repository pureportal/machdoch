import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { withWorkspaceRuntimeStorage } from "./workspace-runtime-storage.js";
import { getWorkspaceLocalDirectory } from "./workspace-storage-paths.js";
import { loadWorkspaceConfigFile } from "./config.js";
import {
  createLocalReasoningBank,
  getReasoningBankPath,
} from "./reasoning-bank.js";

it("keeps private runtime state outside the repository without changing versioned configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "machdoch-runtime-storage-"));
  const workspace = join(root, "source"),
    state = join(root, "private");
  try {
    await mkdir(join(workspace, ".machdoch"), { recursive: true });
    const config = '{"autoGitignore":true}\n';
    await writeFile(join(workspace, ".machdoch", "config.json"), config);
    await withWorkspaceRuntimeStorage(workspace, state, async () => {
      expect((await loadWorkspaceConfigFile(workspace)).config).toMatchObject({
        autoGitignore: true,
      });
      expect(getWorkspaceLocalDirectory(workspace, "state")).toBe(
        join(state, "state"),
      );
      expect(
        JSON.parse(
          await readFile(join(state, "state", "storage-layout.json"), "utf8"),
        ),
      ).toEqual({ version: 1 });
      const bank = createLocalReasoningBank(workspace);
      await bank.consolidate([
        {
          title: "Preserve source scope",
          description: "Runtime learning stays private.",
          content:
            "Store generated learning outside the task's source checkout.",
          triggerTerms: ["source scope"],
          outcome: "success",
          confidence: 0.9,
        },
      ]);
      expect(await bank.load()).toHaveLength(1);
      expect(getReasoningBankPath(workspace)).toBe(
        join(state, "state", "reasoning-bank.json"),
      );
    });
    expect(await readdir(join(workspace, ".machdoch"))).toEqual([
      "config.json",
    ]);
    expect(
      await readFile(join(workspace, ".machdoch", "config.json"), "utf8"),
    ).toBe(config);
    expect(getWorkspaceLocalDirectory(workspace, "state")).toBe(
      join(workspace, ".machdoch", "local", "state"),
    );
    await expect(
      Promise.resolve().then(() =>
        withWorkspaceRuntimeStorage(
          workspace,
          join(workspace, "state"),
          () => {},
        ),
      ),
    ).rejects.toThrow("separate");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("isolates storage locations between simultaneous tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "machdoch-runtime-scopes-"));
  try {
    const workspace = join(root, "source");
    const paths = await Promise.all(
      ["first", "second"].map((name) =>
        withWorkspaceRuntimeStorage(workspace, join(root, name), async () => {
          await Promise.resolve();
          return getWorkspaceLocalDirectory(workspace, "cache");
        }),
      ),
    );
    expect(paths).toEqual([
      join(root, "first", "cache"),
      join(root, "second", "cache"),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRalphScopeRegistryForDiscovery } from "./ralph-scope-registry-recovery.helper.js";
import { readRalphScopeRegistryFile } from "./ralph-scope-registry.helper.js";

const directories: string[] = [];
const createDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), "ralph-registry-recovery-"));
  directories.push(directory);
  return directory;
};
const options = {
  flowAlias: "refactor",
  strategy: "priority" as const,
  assertOwnership: async () => undefined,
};

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("RALPH scope registry recovery", () => {
  it.each(["{invalid", "null"])(
    "archives invalid state %s and its Markdown without modifying the originals",
    async (content) => {
      const directory = await createDirectory();
      const path = join(directory, "registry.json");
      const markdownPath = join(directory, "registry.md");
      await writeFile(path, content, "utf8");
      await writeFile(markdownPath, "old scope coverage", "utf8");

      const result = await readRalphScopeRegistryForDiscovery(path, {
        ...options,
        markdownPath,
      });

      expect(result.registry.scopes).toEqual([]);
      expect(result.registry.selection.completedScopeIds).toEqual([]);
      expect(
        await readFile(
          join(result.recovery!.archiveDirectory, "registry.json"),
          "utf8",
        ),
      ).toBe(content);
      expect(
        await readFile(
          join(result.recovery!.archiveDirectory, "scope-registry.md"),
          "utf8",
        ),
      ).toBe("old scope coverage");
      expect(await readFile(path, "utf8")).toBe(content);
      await expect(readRalphScopeRegistryFile(path, options)).rejects.toThrow();
    },
  );

  it("does not reset state when reading fails for a reason other than invalid data", async () => {
    const directory = await createDirectory();
    const path = join(directory, "registry.json");
    await mkdir(path);
    await expect(
      readRalphScopeRegistryForDiscovery(path, options),
    ).rejects.toMatchObject({ code: "EISDIR" });
    expect(await readdir(directory)).toEqual(["registry.json"]);
  });

  it("does not authorize rebuilding when the companion archive fails", async () => {
    const directory = await createDirectory();
    const path = join(directory, "registry.json");
    const markdownPath = join(directory, "registry.md");
    await writeFile(path, "{invalid", "utf8");
    await mkdir(markdownPath);
    await expect(
      readRalphScopeRegistryForDiscovery(path, { ...options, markdownPath }),
    ).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("{invalid");
  });

  it("checks ownership before creating the archive", async () => {
    const directory = await createDirectory();
    const path = join(directory, "registry.json");
    await writeFile(path, "{invalid", "utf8");
    const assertOwnership = vi
      .fn()
      .mockRejectedValue(new Error("lease replaced"));
    await expect(
      readRalphScopeRegistryForDiscovery(path, { ...options, assertOwnership }),
    ).rejects.toThrow("lease replaced");
    expect(await readdir(directory)).toEqual(["registry.json"]);
  });
});

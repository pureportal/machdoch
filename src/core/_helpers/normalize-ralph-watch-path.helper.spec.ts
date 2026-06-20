import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  isDangerousRalphWatchRoot,
  isPathInside,
  normalizeRalphWatchPath,
} from "./normalize-ralph-watch-path.helper.ts";

describe("isPathInside", () => {
  it("matches the root itself and descendants", () => {
    const root = resolve(tmpdir(), "machdoch-watch-root");

    expect(isPathInside(root, root)).toBe(true);
    expect(isPathInside(root, join(root, "nested", "file.md"))).toBe(true);
  });

  it("rejects sibling paths", () => {
    const root = resolve(tmpdir(), "machdoch-watch-root");

    expect(isPathInside(root, resolve(tmpdir(), "machdoch-watch-root-sibling"))).toBe(
      false,
    );
  });
});

describe("isDangerousRalphWatchRoot", () => {
  it("flags filesystem roots and sensitive path segments", () => {
    expect(isDangerousRalphWatchRoot(resolve("/"))).toBe(true);
    expect(isDangerousRalphWatchRoot(resolve(tmpdir(), ".ssh"))).toBe(true);
    expect(isDangerousRalphWatchRoot(resolve(tmpdir(), "project"))).toBe(false);
  });
});

describe("normalizeRalphWatchPath", () => {
  it("returns a canonical existing directory path", async () => {
    const root = await mkdtemp(join(tmpdir(), "machdoch-watch-path-"));
    const canonicalRoot = await realpath(root);

    expect(await normalizeRalphWatchPath(` ${root} `, "watch root", false)).toBe(
      canonicalRoot,
    );
  });

  it("rejects relative, missing, file, and dangerous paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "machdoch-watch-path-"));
    const filePath = join(root, "file.txt");
    await writeFile(filePath, "content", "utf8");

    await expect(
      normalizeRalphWatchPath("relative", "watch root", false),
    ).rejects.toThrow("Expected watch root to be an absolute path.");
    await expect(
      normalizeRalphWatchPath(join(root, "missing"), "watch root", false),
    ).rejects.toThrow();
    await expect(
      normalizeRalphWatchPath(filePath, "watch root", false),
    ).rejects.toThrow("Expected watch root to be a directory");
    await expect(
      normalizeRalphWatchPath(resolve("/"), "watch root", false),
    ).rejects.toThrow("Refusing to watch dangerous or overly broad path");
  });
});

import { mkdir, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanRalphWatchFiles,
  waitForStableRalphWatchFile,
} from "./scan-ralph-watch-files.helper.ts";
import type { RalphWatchRoot } from "../ralph-watches.ts";

const createRoot = (path: string, overrides: Partial<RalphWatchRoot> = {}): RalphWatchRoot => ({
  path,
  include: [],
  exclude: [],
  ...overrides,
});

describe("scanRalphWatchFiles", () => {
  it("collects matching files and directories while respecting excludes", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "machdoch-scan-"));
    await mkdir(join(rootPath, "src", "nested"), { recursive: true });
    await mkdir(join(rootPath, "dist"), { recursive: true });
    await writeFile(join(rootPath, "src", "app.ts"), "source", "utf8");
    await writeFile(join(rootPath, "src", "nested", "value.ts"), "nested", "utf8");
    await writeFile(join(rootPath, "dist", "app.js"), "build", "utf8");

    const snapshots = await scanRalphWatchFiles(
      createRoot(rootPath, {
        include: ["src/**"],
        exclude: ["dist/**"],
      }),
    );

    expect([...snapshots.keys()].sort()).toEqual([
      join(rootPath, "src", "app.ts"),
      join(rootPath, "src", "nested"),
      join(rootPath, "src", "nested", "value.ts"),
    ]);
  });

  it("skips symbolic links", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "machdoch-scan-"));
    const targetPath = join(rootPath, "target.txt");
    await writeFile(targetPath, "target", "utf8");

    try {
      await symlink(targetPath, join(rootPath, "link.txt"));
    } catch {
      return;
    }

    const snapshots = await scanRalphWatchFiles(createRoot(rootPath));

    expect(snapshots.has(targetPath)).toBe(true);
    expect(snapshots.has(join(rootPath, "link.txt"))).toBe(false);
  });
});

describe("waitForStableRalphWatchFile", () => {
  it("returns a file snapshot when the file is stable", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "machdoch-stable-"));
    const filePath = join(rootPath, "file.txt");
    await writeFile(filePath, "stable", "utf8");

    const snapshot = await waitForStableRalphWatchFile(filePath, 1);

    expect(snapshot).toMatchObject({ size: 6, isDirectory: false });
    expect(snapshot?.mtimeMs).toEqual(expect.any(Number));
  });

  it("returns undefined for missing files", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "machdoch-stable-"));

    await expect(
      waitForStableRalphWatchFile(join(rootPath, "missing.txt"), 1),
    ).resolves.toBeUndefined();
  });
});

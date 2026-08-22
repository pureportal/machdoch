import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRalphWatchRoot } from "./normalize-ralph-watch-root.helper.ts";

describe("normalizeRalphWatchRoot", () => {
  it("normalizes include and exclude patterns with default excludes", async () => {
    const root = await mkdtemp(join(tmpdir(), "machdoch-watch-root-"));
    const canonicalRoot = await realpath(root);
    const normalized = await normalizeRalphWatchRoot(
      {
        path: root,
        include: ["src/**", " src/** "],
        exclude: ["**/*.tmp", "node_modules/**"],
      },
      false,
    );

    expect(normalized.path).toBe(canonicalRoot);
    expect(normalized.include).toEqual(["src/**"]);
    expect(normalized.exclude).toEqual(
      expect.arrayContaining([".git/**", "node_modules/**", "**/*.tmp"]),
    );
  });

  it("rejects non-overlapping workspace roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "machdoch-watch-root-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-workspace-root-"));

    await expect(
      normalizeRalphWatchRoot({ path: root, workspaceRoot }, false),
    ).rejects.toThrow(/do not overlap/u);
  });
});

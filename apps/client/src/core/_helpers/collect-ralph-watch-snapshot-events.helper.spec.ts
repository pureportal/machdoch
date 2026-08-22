import { collectRalphWatchSnapshotEvents } from "./collect-ralph-watch-snapshot-events.helper.ts";
import type { RalphWatchFileSnapshot } from "./scan-ralph-watch-files.helper.ts";

const fileSnapshot = (
  overrides: Partial<RalphWatchFileSnapshot> = {},
): RalphWatchFileSnapshot => ({
  size: 10,
  mtimeMs: 100,
  isDirectory: false,
  ...overrides,
});

describe("collectRalphWatchSnapshotEvents", () => {
  it("returns no events for empty snapshots", () => {
    expect(
      collectRalphWatchSnapshotEvents(new Map<string, RalphWatchFileSnapshot>(), new Map()),
    ).toEqual([]);
  });

  it("detects created, changed, and deleted paths while ignoring unchanged paths", () => {
    const previous = new Map<string, RalphWatchFileSnapshot>([
      ["/workspace/changed.md", fileSnapshot({ size: 10, mtimeMs: 100 })],
      ["/workspace/deleted.md", fileSnapshot({ size: 20, mtimeMs: 200 })],
      ["/workspace/unchanged.md", fileSnapshot({ size: 30, mtimeMs: 300 })],
    ]);
    const current = new Map<string, RalphWatchFileSnapshot>([
      ["/workspace/created.md", fileSnapshot({ size: 5, mtimeMs: 50 })],
      ["/workspace/changed.md", fileSnapshot({ size: 11, mtimeMs: 100 })],
      ["/workspace/unchanged.md", fileSnapshot({ size: 30, mtimeMs: 300 })],
    ]);

    expect(collectRalphWatchSnapshotEvents(previous, current)).toEqual([
      {
        eventType: "created",
        path: "/workspace/created.md",
        snapshot: fileSnapshot({ size: 5, mtimeMs: 50 }),
      },
      {
        eventType: "changed",
        path: "/workspace/changed.md",
        snapshot: fileSnapshot({ size: 11, mtimeMs: 100 }),
      },
      {
        eventType: "deleted",
        path: "/workspace/deleted.md",
        snapshot: fileSnapshot({ size: 20, mtimeMs: 200 }),
      },
    ]);
  });

  it("treats mtime changes as content changes even when size is unchanged", () => {
    const previous = new Map<string, RalphWatchFileSnapshot>([
      ["/workspace/app.ts", fileSnapshot({ size: 10, mtimeMs: 100 })],
    ]);
    const current = new Map<string, RalphWatchFileSnapshot>([
      ["/workspace/app.ts", fileSnapshot({ size: 10, mtimeMs: 101 })],
    ]);

    expect(collectRalphWatchSnapshotEvents(previous, current)).toEqual([
      {
        eventType: "changed",
        path: "/workspace/app.ts",
        snapshot: fileSnapshot({ size: 10, mtimeMs: 101 }),
      },
    ]);
  });
});

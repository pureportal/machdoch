import { join } from "node:path";
import { createRalphWatchFileEvent } from "./create-ralph-watch-file-event.helper.ts";
import type { RalphWatchRoot } from "../ralph-watches.ts";

const createRoot = (overrides: Partial<RalphWatchRoot> = {}): RalphWatchRoot => ({
  path: join(process.cwd(), "workspace"),
  include: [],
  exclude: [],
  ...overrides,
});

describe("createRalphWatchFileEvent", () => {
  it("builds the scheduler file event with normalized relative paths and metadata", () => {
    const root = createRoot();
    const path = join(root.path, "docs", "guide.md");

    expect(
      createRalphWatchFileEvent({
        root,
        eventType: "changed",
        path,
        snapshot: { size: 42, mtimeMs: 123, isDirectory: false },
        occurredAt: 456,
      }),
    ).toEqual({
      type: "changed",
      path,
      rootPath: root.path,
      relativePath: "docs/guide.md",
      size: 42,
      mtimeMs: 123,
      isDirectory: false,
      occurredAt: 456,
    });
  });

  it("omits optional metadata for missing deleted-file snapshots", () => {
    const root = createRoot();
    const path = join(root.path, "missing.md");

    expect(
      createRalphWatchFileEvent({
        root,
        eventType: "deleted",
        path,
        snapshot: undefined,
        occurredAt: 789,
      }),
    ).toEqual({
      type: "deleted",
      path,
      rootPath: root.path,
      relativePath: "missing.md",
      occurredAt: 789,
    });
  });
});

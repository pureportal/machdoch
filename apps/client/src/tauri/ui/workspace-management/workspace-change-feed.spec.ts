import { describe, expect, it, vi } from "vitest";
import type { WorkspaceChangeEvents } from "@machdoch/fleet-protocol/workspace-contract";
import {
  changedDirectories,
  createWorkspaceChangeFeed,
  repositoryChangeKinds,
} from "./workspace-change-feed";

const flush = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

const event = (sequence: number, paths: string[] = ["src/a.ts"]) => ({
  sequence,
  workspaceRoot: "C:/work",
  repositories: [{ repositoryRoot: "C:/work", kinds: ["worktree" as const] }],
  paths,
  pathsTruncated: false,
  rescan: false,
});

const harness = () => {
  const sinks = new Map<string, (events: WorkspaceChangeEvents) => void>();
  const close = vi.fn();
  const open = vi.fn(
    async (root: string, onEvents: (events: WorkspaceChangeEvents) => void) => {
      sinks.set(root, onEvents);
      return close;
    },
  );
  const feed = createWorkspaceChangeFeed({
    transport: { open },
    keyOf: (root) => root.toLowerCase(),
  });
  return { feed, open, close, sinks };
};

describe("workspace change feed", () => {
  it("opens one watcher per workspace and fans events out once per sequence", async () => {
    const { feed, open, sinks } = harness();
    const first = vi.fn();
    const second = vi.fn();
    feed.subscribe("C:/Work", first);
    feed.subscribe("c:/work", second);
    await flush();
    expect(open).toHaveBeenCalledTimes(1);
    const sink = sinks.get("C:/Work")!;
    sink({ cursor: 2, watching: true, events: [event(1), event(2)] });
    sink({ cursor: 2, watching: true, events: [event(2)] });
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
    expect(feed.isWatching("C:/WORK")).toBe(true);
  });

  it("closes the watcher only after the last subscriber leaves", async () => {
    const { feed, close } = harness();
    const stopFirst = feed.subscribe("C:/work", vi.fn());
    const stopSecond = feed.subscribe("C:/work", vi.fn());
    await flush();
    stopFirst();
    stopFirst();
    await flush();
    expect(close).not.toHaveBeenCalled();
    stopSecond();
    await flush();
    expect(close).toHaveBeenCalledTimes(1);
    expect(feed.isWatching("C:/work")).toBe(false);
  });

  it("reports watcher failures so callers fall back to polling", async () => {
    const onError = vi.fn();
    const feed = createWorkspaceChangeFeed({
      transport: { open: () => Promise.reject(new Error("no watcher")) },
      keyOf: (root) => root,
      onError,
    });
    feed.subscribe("C:/work", vi.fn());
    await flush();
    expect(onError).toHaveBeenCalled();
    expect(feed.isWatching("C:/work")).toBe(false);
  });

  it("derives repository change kinds and changed folders", () => {
    const change = {
      ...event(1, ["src/a.ts", "src/b.ts", "README.md"]),
      repositories: [
        { repositoryRoot: "C:/work", kinds: ["worktree" as const] },
        {
          repositoryRoot: "C:/work/sub",
          kinds: ["refs" as const, "index" as const],
        },
      ],
    };
    expect([
      ...repositoryChangeKinds(change, (root) => root === "C:/work/sub"),
    ]).toEqual(["refs", "index"]);
    expect(changedDirectories(change)).toEqual(["src", "."]);
  });
});

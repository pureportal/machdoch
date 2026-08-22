import { describe, expect, it, vi } from "vitest";
import type {
  MediaAssetPage,
  MediaAssetRecord,
} from "./contracts.js";
import {
  collectMediaAssetPages,
  matchesMediaAssetQuery,
} from "./asset-library.js";

const asset = (index: number): MediaAssetRecord => ({
  id: `asset:${index}`,
  runId: `run:${Math.floor(index / 2)}`,
  digest: index.toString(16).padStart(64, "0"),
  kind: "image",
  mimeType: "image/png",
  byteSize: 128,
  width: 512,
  height: 512,
  createdAt: "2026-07-25T00:00:00.000Z",
  outputIndex: index % 2,
  fixture: false,
  operation: null,
  sourceAssetIds: [],
  tags: [],
});

const page = (
  revision: string,
  offset: number,
  totalItems: number,
  items: MediaAssetRecord[],
): MediaAssetPage => ({
  schemaVersion: 1,
  revision,
  offset,
  totalItems,
  unchanged: false,
  items,
});

describe("collectMediaAssetPages", () => {
  it("collects every page beyond the former 200-item ceiling", async () => {
    const items = Array.from({ length: 513 }, (_, index) => asset(index));
    const loadPage = vi.fn(
      async ({ offset, limit }: { offset: number; limit: number }) =>
        page("database-a:9", offset, items.length, items.slice(offset, offset + limit)),
    );

    const snapshot = await collectMediaAssetPages({
      loadPage,
      cached: null,
      pageSize: 200,
    });

    expect(snapshot.items).toHaveLength(513);
    expect(snapshot.items.at(-1)?.id).toBe("asset:512");
    expect(loadPage).toHaveBeenCalledTimes(3);
  });

  it("reuses a complete cached snapshot when the revision is unchanged", async () => {
    const cached = {
      revision: "database-a:9",
      items: [asset(0), asset(1)],
    };
    const loadPage = vi.fn(async (): Promise<MediaAssetPage> => ({
      schemaVersion: 1,
      revision: cached.revision,
      offset: 0,
      totalItems: null,
      unchanged: true,
      items: [],
    }));

    const snapshot = await collectMediaAssetPages({ loadPage, cached });

    expect(snapshot).toBe(cached);
    expect(loadPage).toHaveBeenCalledOnce();
  });

  it("restarts when publication changes the revision between pages", async () => {
    const firstRevisionItems = Array.from({ length: 4 }, (_, index) => asset(index));
    const secondRevisionItems = [...firstRevisionItems, asset(4)];
    let calls = 0;
    const loadPage = vi.fn(
      async ({ offset, limit }: { offset: number; limit: number }) => {
        calls += 1;
        if (calls === 1) {
          return page("database-a:10", offset, 4, firstRevisionItems.slice(0, limit));
        }
        return page(
          "database-a:11",
          offset,
          secondRevisionItems.length,
          secondRevisionItems.slice(offset, offset + limit),
        );
      },
    );

    const snapshot = await collectMediaAssetPages({
      loadPage,
      cached: null,
      pageSize: 2,
    });

    expect(snapshot.revision).toBe("database-a:11");
    expect(snapshot.items).toHaveLength(5);
    expect(loadPage).toHaveBeenCalledTimes(5);
  });

  it("rejects a stalled native page instead of returning a partial gallery", async () => {
    const loadPage = vi
      .fn()
      .mockResolvedValueOnce(page("database-a:12", 0, 2, [asset(0)]))
      .mockResolvedValueOnce(page("database-a:12", 1, 2, []));

    await expect(
      collectMediaAssetPages({ loadPage, cached: null }),
    ).rejects.toThrow("stalled at 1 of 2");
  });

  it("does not reuse a same-number revision from a different database", async () => {
    const cached = { revision: "database-a:1", items: [asset(0)] };
    const loadPage = vi.fn(async () =>
      page("database-b:1", 0, 1, [asset(1)]),
    );

    const snapshot = await collectMediaAssetPages({ loadPage, cached });

    expect(snapshot.revision).toBe("database-b:1");
    expect(snapshot.items[0]?.id).toBe("asset:1");
  });
});

describe("matchesMediaAssetQuery", () => {
  it("matches every term across metadata, lineage, and tags", () => {
    const candidate = {
      ...asset(7),
      sourceAssetIds: ["asset:first-frame"],
      tags: [
        {
          value: "game-character",
          label: "Game Character",
          source: "user" as const,
          confidence: null,
          createdAt: "2026-07-25T00:00:00.000Z",
        },
      ],
    };

    expect(matchesMediaAssetQuery(candidate, "game first png")).toBe(true);
    expect(matchesMediaAssetQuery(candidate, "game missing")).toBe(false);
  });

  it("adds human-friendly aliases for alpha workflow outputs", () => {
    const candidate: MediaAssetRecord = {
      ...asset(8),
      operation: {
        kind: "local-image-flow",
        flowRevisionId: "flow-revision:cutout",
        metadataStripped: true,
        assetRole: "cutout",
      },
    };

    expect(matchesMediaAssetQuery(candidate, "transparent cutout derived")).toBe(
      true,
    );
  });
});

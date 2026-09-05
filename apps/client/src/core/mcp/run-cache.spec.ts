import { describe, expect, it } from "vitest";
import { McpRunCacheManager } from "./run-cache.ts";
import type { McpOperationCacheOptions } from "./types.ts";

const createPolicy = (
  overrides: Partial<McpOperationCacheOptions> = {},
): McpOperationCacheOptions => ({
  runId: "run-1",
  operation: "resource",
  readOnly: true,
  ttlMs: 100,
  ...overrides,
});

describe("McpRunCacheManager", () => {
  const lookup = (target: string, runId = "run-1") => ({
    workspaceRoot: "C:/workspace",
    serverId: "test",
    operation: "resource" as const,
    target,
    policy: createPolicy({ runId }),
  });

  it("bounds retained bytes and refreshes replacement LRU order", () => {
    const cache = new McpRunCacheManager({ maxBytes: 10 });
    cache.set(lookup("a"), "aaa");
    cache.set(lookup("b"), "bbb");
    cache.set(lookup("a"), "new");
    cache.set(lookup("c"), "ccc");
    expect(cache.size()).toBe(2);
    expect(cache.get(lookup("b")).hit).toBe(false);
    expect(cache.get(lookup("a")).entry?.value).toBe("new");
    expect(cache.get(lookup("c")).hit).toBe(true);
  });

  it("invalidates stale values when a refreshed result exceeds the per-entry budget", () => {
    const cache = new McpRunCacheManager({ maxEntryBytes: 10 });
    cache.set(lookup("a"), "old");
    expect(cache.set(lookup("a"), "oversized result")).toBeUndefined();
    expect(cache.get(lookup("a")).hit).toBe(false);
  });

  it("keeps snapshots isolated from original, set-result, and get-result mutations", () => {
    const cache = new McpRunCacheManager();
    const value = { values: ["original"] };
    const inserted = cache.set(lookup("a"), value)!;
    value.values.push("changed");
    inserted.value.values.push("changed again");
    const result = cache.get<typeof value>(lookup("a"));
    expect(result.entry?.value.values).toEqual(["original"]);
    result.entry!.value.values.push("changed on read");
    expect(cache.get<typeof value>(lookup("a")).entry?.value.values).toEqual([
      "original",
    ]);
  });

  it("separates changed server configurations and honors shortened TTLs", () => {
    let now = 0;
    const cache = new McpRunCacheManager({ now: () => now });
    const options = { ...lookup("a"), serverIdentity: "old-endpoint" };
    cache.set(options, "old");
    expect(cache.get({ ...options, serverIdentity: "new-endpoint" }).hit).toBe(
      false,
    );
    now = 50;
    expect(
      cache.get({ ...options, policy: createPolicy({ ttlMs: 20 }) }).hit,
    ).toBe(false);
  });

  it("releases byte budgets when runs are deleted or the cache is cleared", () => {
    const cache = new McpRunCacheManager({ maxBytes: 10 });
    cache.set(lookup("a", "old-run"), "aaa");
    cache.set(lookup("b"), "bbb");
    cache.deleteRun("old-run");
    cache.set(lookup("c"), "ccc");
    expect(cache.get(lookup("b")).hit).toBe(true);
    cache.clear();
    cache.set(lookup("d"), "ddd");
    cache.set(lookup("e"), "eee");
    expect(cache.size()).toBe(2);
  });

  it("uses a finite default TTL for malformed limits while preserving explicit zero", () => {
    let now = 0;
    const cache = new McpRunCacheManager({ now: () => now });
    const invalid = { ...lookup("a"), policy: createPolicy({ ttlMs: NaN }) };
    const unlimited = { ...lookup("b"), policy: createPolicy({ ttlMs: 0 }) };
    cache.set(invalid, "a");
    cache.set(unlimited, "b");
    now = 16 * 60_000;
    expect(cache.get(invalid).hit).toBe(false);
    expect(cache.get(unlimited).hit).toBe(true);
    expect(
      new McpRunCacheManager({ maxBytes: 0 }).set(lookup("a"), "a"),
    ).toBeUndefined();
  });
  it("returns cached values within TTL and evicts expired entries", () => {
    let now = 1_000;
    const cache = new McpRunCacheManager({ now: () => now });
    const options = {
      workspaceRoot: "C:/workspace",
      serverId: "serper",
      operation: "resource" as const,
      target: "search://query",
      policy: createPolicy(),
    };

    cache.set(options, { value: "first" });

    expect(cache.get<{ value: string }>(options)).toMatchObject({
      hit: true,
      entry: { value: { value: "first" } },
    });

    now = 1_101;

    expect(cache.get(options).hit).toBe(false);
    expect(cache.size()).toBe(0);
  });

  it("bypasses reads during force refresh but refreshes the stored value", () => {
    const cache = new McpRunCacheManager();
    const baseOptions = {
      workspaceRoot: "C:/workspace",
      serverId: "serper",
      operation: "tool" as const,
      target: "search",
      args: { q: "mcp" },
      policy: createPolicy({ operation: "tool", readOnly: true }),
    };

    cache.set(baseOptions, { value: "old" });

    const refreshOptions = {
      ...baseOptions,
      policy: createPolicy({
        operation: "tool",
        readOnly: true,
        forceRefresh: true,
      }),
    };

    expect(cache.get(refreshOptions).hit).toBe(false);

    cache.set(refreshOptions, { value: "new" });

    expect(cache.get<{ value: string }>(baseOptions).entry?.value).toEqual({
      value: "new",
    });
  });

  it("isolates entries by run id and deletes one run without clearing others", () => {
    const cache = new McpRunCacheManager();
    const options = {
      workspaceRoot: "C:/workspace",
      serverId: "github",
      operation: "prompt" as const,
      target: "summarize_issue",
      args: { issue_number: "1" },
      policy: createPolicy({ operation: "prompt", runId: "run-1" }),
    };
    const otherRunOptions = {
      ...options,
      policy: createPolicy({ operation: "prompt", runId: "run-2" }),
    };

    cache.set(options, "one");
    cache.set(otherRunOptions, "two");

    expect(cache.deleteRun("run-1")).toBe(1);
    expect(cache.get(options).hit).toBe(false);
    expect(cache.get(otherRunOptions).hit).toBe(true);
  });

  it("skips entries when cache is disabled or no run id is available", () => {
    const cache = new McpRunCacheManager();
    const options = {
      workspaceRoot: "C:/workspace",
      serverId: "github",
      operation: "resource" as const,
      target: "repo://readme",
      policy: createPolicy({ enabled: false }),
    };

    expect(cache.set(options, "value")).toBeUndefined();
    expect(cache.get(options).hit).toBe(false);
    expect(cache.size()).toBe(0);
  });
});

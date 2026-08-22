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

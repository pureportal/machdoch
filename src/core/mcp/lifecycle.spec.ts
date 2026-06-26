import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyMcpLifecycleCleanupPlan,
  createManagedMcpId,
  createMcpLifecycleCleanupPlan,
  createMcpUsageEventFromHookPayload,
  getUserMcpLifecyclePath,
  loadMcpLifecycleState,
  parseManagedMcpToolName,
  recordMcpUsageEvent,
} from "./lifecycle.js";

describe("MCP lifecycle", () => {
  let userConfigDirectory: string;
  let previousUserConfigDirectory: string | undefined;

  beforeEach(async () => {
    previousUserConfigDirectory = process.env.MACHDOCH_USER_CONFIG_DIR;
    userConfigDirectory = await mkdtemp(join(tmpdir(), "machdoch-mcp-life-"));
    process.env.MACHDOCH_USER_CONFIG_DIR = userConfigDirectory;
  });

  afterEach(async () => {
    if (previousUserConfigDirectory === undefined) {
      delete process.env.MACHDOCH_USER_CONFIG_DIR;
    } else {
      process.env.MACHDOCH_USER_CONFIG_DIR = previousUserConfigDirectory;
    }

    await rm(userConfigDirectory, { recursive: true, force: true });
  });

  it("normalizes managed server ids with the machdoch_ prefix", () => {
    expect(createManagedMcpId("Playwright Browser")).toBe(
      "machdoch_playwright-browser",
    );
    expect(createManagedMcpId("machdoch_playwright")).toBe("machdoch_playwright");
  });

  it("parses managed MCP tool names and ignores unmanaged tools", () => {
    expect(
      parseManagedMcpToolName("mcp__machdoch_playwright__browser_click"),
    ).toEqual({
      managedId: "machdoch_playwright",
      sourceServerId: "playwright",
      remoteName: "browser_click",
    });

    expect(parseManagedMcpToolName("mcp__filesystem__read_file")).toBeUndefined();
  });

  it("records durable native MCP usage without storing tool arguments", async () => {
    await recordMcpUsageEvent({
      timestamp: "2026-01-01T00:00:00.000Z",
      workspaceRoot: "C:/repo",
      agent: "machdoch",
      serverId: "playwright",
      sourceServerId: "playwright",
      operation: "tool",
      phase: "invoked",
      target: "browser_navigate",
      transportType: "stdio",
    });
    await recordMcpUsageEvent({
      timestamp: "2026-01-01T00:00:01.000Z",
      workspaceRoot: "C:/repo",
      agent: "machdoch",
      serverId: "playwright",
      sourceServerId: "playwright",
      operation: "tool",
      phase: "remote-started",
      target: "browser_navigate",
      transportType: "stdio",
    });
    await recordMcpUsageEvent({
      timestamp: "2026-01-01T00:00:02.000Z",
      workspaceRoot: "C:/repo",
      agent: "machdoch",
      serverId: "playwright",
      sourceServerId: "playwright",
      operation: "tool",
      phase: "succeeded",
      target: "browser_navigate",
      transportType: "stdio",
    });

    const state = await loadMcpLifecycleState();
    const record = state.records.machdoch_playwright;

    expect(record).toMatchObject({
      managedId: "machdoch_playwright",
      sourceServerId: "playwright",
      agent: "machdoch",
      transportType: "stdio",
      workspaceRoot: "C:/repo",
      state: "active",
      usageCount: 1,
      eventCount: 3,
      lastSucceededAt: "2026-01-01T00:00:02.000Z",
    });
    expect(record?.operations?.tool).toMatchObject({
      usageCount: 1,
      eventCount: 3,
      remoteExecutionCount: 1,
    });

    const persisted = JSON.parse(
      await readFile(getUserMcpLifecyclePath(), "utf8"),
    ) as Record<string, unknown>;

    expect(JSON.stringify(persisted)).not.toContain("browser_navigate");
  });

  it("creates usage events from Codex, Claude, and Copilot-style hook payloads", () => {
    const event = createMcpUsageEventFromHookPayload(
      {
        hook_event_name: "PostToolUse",
        tool_name: "mcp__machdoch_playwright__browser_navigate",
        tool_use_id: "tool-1",
        duration_ms: 25,
      },
      {
        agent: "claude-cli",
        workspaceRoot: "C:/repo",
      },
    );

    expect(event).toMatchObject({
      agent: "claude-cli",
      serverId: "machdoch_playwright",
      sourceServerId: "playwright",
      operation: "tool",
      phase: "succeeded",
      target: "browser_navigate",
      toolUseId: "tool-1",
      durationMs: 25,
      workspaceRoot: "C:/repo",
    });
    expect(
      createMcpUsageEventFromHookPayload({
        hook_event_name: "PreToolUse",
        tool_name: "Read",
      }),
    ).toBeUndefined();
  });

  it("creates usage events from API-style MCP call payloads", () => {
    expect(
      createMcpUsageEventFromHookPayload(
        {
          server_label: "machdoch_github",
          name: "create_issue",
          output: "created",
        },
        {
          agent: "openai-api",
          workspaceRoot: "C:/repo",
        },
      ),
    ).toMatchObject({
      agent: "openai-api",
      serverId: "machdoch_github",
      sourceServerId: "github",
      operation: "tool",
      phase: "succeeded",
      target: "create_issue",
    });

    expect(
      createMcpUsageEventFromHookPayload(
        {
          server_name: "machdoch_linear",
          name: "create_issue",
          error: {
            message: "Permission denied",
          },
        },
        {
          agent: "anthropic-api",
          workspaceRoot: "C:/repo",
        },
      ),
    ).toMatchObject({
      agent: "anthropic-api",
      serverId: "machdoch_linear",
      sourceServerId: "linear",
      phase: "failed",
    });
  });

  it("serializes concurrent usage writes in the current process", async () => {
    await Promise.all(
      Array.from({ length: 10 }, async (_entry, index) =>
        recordMcpUsageEvent({
          timestamp: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
          workspaceRoot: "C:/repo",
          agent: "machdoch",
          serverId: "playwright",
          sourceServerId: "playwright",
          operation: "tool",
          phase: "invoked",
          transportType: "stdio",
        }),
      ),
    );

    const state = await loadMcpLifecycleState();

    expect(state.records.machdoch_playwright).toMatchObject({
      usageCount: 10,
      eventCount: 10,
    });
    expect(state.records.machdoch_playwright?.operations?.tool).toMatchObject({
      usageCount: 10,
      eventCount: 10,
    });
  });

  it("marks old managed MCPs as stale candidates without removing them", async () => {
    await recordMcpUsageEvent({
      timestamp: "2026-01-01T00:00:00.000Z",
      workspaceRoot: "C:/repo",
      agent: "machdoch",
      serverId: "playwright",
      sourceServerId: "playwright",
      operation: "tool",
      phase: "invoked",
      transportType: "stdio",
    });
    await recordMcpUsageEvent({
      timestamp: "2026-03-25T00:00:00.000Z",
      workspaceRoot: "C:/repo",
      agent: "machdoch",
      serverId: "github",
      sourceServerId: "github",
      operation: "tool",
      phase: "invoked",
      transportType: "streamable-http",
    });

    const plan = await createMcpLifecycleCleanupPlan({
      unusedDays: 60,
      now: "2026-04-05T00:00:00.000Z",
    });

    expect(plan.candidates.map((candidate) => candidate.managedId)).toEqual([
      "machdoch_playwright",
    ]);

    const result = await applyMcpLifecycleCleanupPlan(plan);
    const state = await loadMcpLifecycleState();

    expect(result).toMatchObject({
      markedCount: 1,
      managedIds: ["machdoch_playwright"],
    });
    expect(state.records.machdoch_playwright?.state).toBe("stale-candidate");
    expect(state.records.machdoch_github?.state).toBe("active");
  });
});

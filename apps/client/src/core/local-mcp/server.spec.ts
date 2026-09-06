import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeConfig, createFlow } from "../__test__/ralph-test-helpers.js";
import {
  createToolDefinitions,
  executeToolCall,
} from "../_helpers/agent-tools.js";
import type { ConversationMemoryRuntime } from "../_helpers/agent-tools-shared.js";
import { loadWorkspaceMemory } from "../workspace-memory.js";
import { createLocalToolRuntime } from "./runtime.js";
import { createLocalMcpServer } from "./server.js";

let root: string;
const cleanup: Array<() => Promise<void>> = [];
const memory = (): ConversationMemoryRuntime => ({
  sessionEnabled: true,
  sessionEntries: [],
  workspaceEnabled: true,
  workspaceEntries: [],
  globalEnabled: false,
  globalEntries: [],
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "machdoch-local-mcp-"));
  vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", join(root, "user"));
  vi.stubEnv("MACHDOCH_RUN_CONTROL_TOKEN", "");
  vi.stubEnv("MACHDOCH_RUN_CONTROL_ADDRESS", "");
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const connect = async (
  mode: "ask" | "machdoch" = "machdoch",
  state = memory(),
) => {
  const config = {
    ...runtimeConfig,
    provider: "unconfigured" as const,
    workspaceRoot: root,
    mode,
  };
  const runtime = createLocalToolRuntime({ config, memory: state });
  const server = createLocalMcpServer(runtime);
  const client = new Client({ name: "parity-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(
    () => server.close(),
    () => client.close(),
  );
  const apiTools = createToolDefinitions(config, state);
  const apiCall = async (name: string, args: Record<string, unknown> = {}) => {
    const { result } = await executeToolCall(
      config,
      state,
      undefined,
      new Map(apiTools.map((tool) => [tool.spec.name, tool])),
      { id: "api", name, arguments: args },
    );
    if (!result) throw new Error("Missing API tool result.");
    return result.toolResult;
  };
  const mcpCall = async (name: string, args: Record<string, unknown> = {}) => {
    const result = CallToolResultSchema.parse(
      await client.callTool({ name, arguments: args }),
    );
    return {
      isError: result.isError,
      output: result.content
        .filter((entry) => entry.type === "text")
        .map((entry) => entry.text)
        .join("\n"),
    };
  };
  return { client, apiTools, apiCall, mcpCall };
};

describe("Machdoch MCP capability parity", () => {
  it.each(["ask", "machdoch"] as const)(
    "discovers the API tool catalog in %s mode",
    async (mode) => {
      const { client, apiTools } = await connect(mode);
      const catalog = (await client.listTools()).tools;
      expect(
        catalog.map((tool) => ({
          name: tool.name,
          inputSchema: tool.inputSchema,
        })),
      ).toEqual(
        apiTools.map((tool) => ({
          name: tool.spec.name,
          inputSchema: tool.spec.inputSchema,
        })),
      );
      expect(catalog.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "list_workflows",
          "list_scheduled_jobs",
          "search_memory",
          "get_active_workspace_agents",
        ]),
      );
      expect(catalog.some((tool) => tool.name === "run_workflow")).toBe(
        mode === "machdoch",
      );
      expect(
        catalog.some((tool) => tool.name === "remember_global_memory"),
      ).toBe(false);
    },
  );

  it("shares scheduler mutations and persisted memory in both directions", async () => {
    const { apiCall, mcpCall } = await connect();
    const created = await mcpCall("create_scheduled_job", {
      name: "Fixture",
      prompt: "Report status",
      schedule: { type: "interval", intervalMs: 60_000 },
    });
    expect(created.isError, created.output).not.toBe(true);
    const job = JSON.parse(created.output).job;
    expect((await apiCall("list_scheduled_jobs")).output).toBe(
      (await mcpCall("list_scheduled_jobs")).output,
    );
    const paused = await apiCall("pause_scheduled_job", { jobId: job.id });
    expect(paused.isError, paused.output).not.toBe(true);
    expect((await apiCall("list_scheduled_jobs")).output).toBe(
      (await mcpCall("list_scheduled_jobs")).output,
    );
    const fact = {
      fact: "Run package checks before committing.",
      memory_key: "package-checks",
      kind: "constraint",
      search_terms: ["checks"],
      importance: 4,
      sensitivity: "non-sensitive",
    };
    expect((await mcpCall("remember_workspace_memory", fact)).isError).not.toBe(
      true,
    );
    expect(await loadWorkspaceMemory(root)).toEqual([
      expect.objectContaining({ key: "package-checks" }),
    ]);
    expect(
      (await apiCall("search_memory", { query: "package checks" })).output,
    ).toBe(
      (await mcpCall("search_memory", { query: "package checks" })).output,
    );
    expect((await apiCall("remember_session_memory", fact)).isError).not.toBe(
      true,
    );
    expect(
      JSON.parse((await mcpCall("search_memory", { scope: "session" })).output),
    ).toHaveLength(1);
    const queued = await apiCall("trigger_scheduled_job", {
      jobId: job.id,
      idempotencyKey: "fixture-run",
    });
    expect(queued.isError, queued.output).not.toBe(true);
    const runId = JSON.parse(queued.output).run.id;
    const cancelled = await mcpCall("cancel_scheduled_run", { runId });
    expect(cancelled.isError, cancelled.output).not.toBe(true);
    expect(JSON.parse(cancelled.output).run.status).toBe("cancelled");
    expect(
      (await apiCall("list_scheduled_runs", { jobId: job.id })).output,
    ).toBe((await mcpCall("list_scheduled_runs", { jobId: job.id })).output);
    expect(
      (await mcpCall("delete_scheduled_job", { jobId: job.id })).isError,
    ).not.toBe(true);
  });

  it.each(["codex-cli", "claude-cli", "copilot-cli"] as const)(
    "schedules %s jobs without losing the provider",
    async (provider) => {
      const { apiCall, mcpCall } = await connect();
      for (const call of [apiCall, mcpCall]) {
        const created = await call("create_scheduled_job", {
          name: provider,
          prompt: "Report status",
          provider,
          schedule: { type: "interval", intervalMs: 60_000 },
        });
        expect(created.isError, created.output).not.toBe(true);
        expect(JSON.parse(created.output).job.target.provider).toBe(provider);
        const outside = await call("create_scheduled_job", {
          name: "Outside",
          targetType: "ralph-flow",
          ralphFlow: {
            id: "fixture",
            executionProfile: "unattended",
            permissions: {
              allowedRoots: [join(root, "..")],
              allowCommands: true,
              allowWrites: true,
              allowNetwork: true,
              allowMcpTools: true,
            },
          },
          schedule: { type: "interval", intervalMs: 60_000 },
        });
        expect(outside.isError).toBe(true);
        expect(outside.output).toContain("inside the active workspace");
      }
    },
  );

  it("saves, validates, runs, and inspects a workflow across both paths", async () => {
    const { apiCall, mcpCall } = await connect();
    const flow = createFlow({
      blocks: [
        { id: "start", type: "START", title: "Start" },
        { id: "end", type: "END", title: "End", status: "success" },
      ],
      edges: [
        { id: "finish", from: "start", fromOutput: "SUCCESS", to: "end" },
      ],
    });
    const saved = await mcpCall("save_workflow", { flow });
    expect(saved.isError, saved.output).not.toBe(true);
    expect(
      JSON.parse((await apiCall("validate_workflow", { flow })).output).valid,
    ).toBe(true);
    expect((await apiCall("read_workflow", { id: flow.id })).output).toBe(
      (await mcpCall("read_workflow", { id: flow.id })).output,
    );
    const stale = await mcpCall("save_workflow", {
      flow,
      expectedFingerprint: "stale",
    });
    expect(stale.isError).toBe(true);
    expect(stale.output).toContain("CAS conflict");
    const run = await mcpCall("run_workflow", { id: flow.id });
    expect(run.isError, run.output).not.toBe(true);
    expect(JSON.parse(run.output).status, run.output).toBe("completed");
    const history = await apiCall("list_workflow_runs");
    expect(history.output).toBe((await mcpCall("list_workflow_runs")).output);
    const runs = JSON.parse(history.output);
    expect(runs).toHaveLength(1);
    expect(
      (await mcpCall("read_workflow_run", { runId: runs[0].id })).isError,
    ).not.toBe(true);
    expect(
      (
        await apiCall("delete_workflow", {
          id: flow.id,
          expectedFingerprint: JSON.parse(saved.output).fingerprint,
        })
      ).isError,
    ).not.toBe(true);
    expect(JSON.parse((await mcpCall("list_workflows")).output)).toEqual([]);
  });

  it("rejects mutations in ask mode and invalid arguments on both paths", async () => {
    const { apiCall, mcpCall } = await connect("ask");
    for (const call of [apiCall, mcpCall]) {
      expect((await call("create_scheduled_job", {})).isError).toBe(true);
      expect(
        (await call("list_workflows", { workspaceRoot: join(root, "outside") }))
          .isError,
      ).toBe(true);
      expect((await call("search_memory", { scope: "global" })).isError).toBe(
        true,
      );
      expect(
        (await call("read_workflow", { id: "../../outside" })).isError,
      ).toBe(true);
      expect((await call("unknown_tool")).isError).toBe(true);
    }
  });

  it.each(["api", "mcp"] as const)(
    "keeps workflow block workspaces and runtime paths inside the workspace through %s",
    async (surface) => {
      const originalRoot = root;
      const workspace = join(root, "workspace");
      const outside = join(root, "outside");
      await mkdir(workspace);
      await mkdir(outside);
      await writeFile(join(outside, "secret.txt"), "outside-secret-content");
      await symlink(outside, join(workspace, "linked"), "junction");
      root = workspace;
      try {
        const { apiCall, mcpCall } = await connect();
        const call = surface === "api" ? apiCall : mcpCall;
        for (const customWorkspace of [false, true]) {
          const flow = createFlow({
            id: customWorkspace ? "custom-workspace" : "runtime-path",
            blocks: [
              { id: "start", type: "START", title: "Start" },
              {
                id: "set-path",
                type: "UTILITY",
                title: "Set path",
                utility: {
                  type: "SET_VARIABLE",
                  variableName: "target",
                  value: "linked/secret.txt",
                },
              },
              {
                id: "read",
                type: "UTILITY",
                title: "Read",
                utility: {
                  type: "READ_FILE",
                  path: customWorkspace ? "secret.txt" : "{{target:path}}",
                },
                ...(customWorkspace
                  ? {
                      settings: {
                        workspace: { mode: "custom" as const, path: outside },
                      },
                    }
                  : {}),
              },
              { id: "end", type: "END", title: "End", status: "success" },
            ],
            edges: [
              {
                id: "set",
                from: "start",
                fromOutput: "SUCCESS",
                to: "set-path",
              },
              {
                id: "read",
                from: "set-path",
                fromOutput: "SUCCESS",
                to: "read",
              },
              { id: "end", from: "read", fromOutput: "SUCCESS", to: "end" },
            ],
          });
          const saved = await call("save_workflow", { flow });
          expect(saved.isError, saved.output).not.toBe(true);
          const result = await call("run_workflow", {
            id: flow.id,
            maxTransitions: 8,
          });
          expect(result.output).toContain(
            "Workflow paths must stay inside the active workspace",
          );
          expect(result.output).not.toContain("outside-secret-content");
        }
      } finally {
        root = originalRoot;
      }
    },
  );

  it("keeps filesystem access inside the workspace, including symlinks", async () => {
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "outside");
    await symlink(outside, join(workspace, "linked"), "junction");
    const originalRoot = root;
    root = workspace;
    try {
      const { apiCall, mcpCall } = await connect();
      for (const call of [apiCall, mcpCall]) {
        const result = await call("read_file", {
          path: "../outside/secret.txt",
          startLine: 1,
          endLine: 10,
        });
        expect(result.isError).toBe(true);
        expect(result.output).toContain("workspace");
        expect(result.output).not.toContain("input schema");
        expect(
          (
            await call("read_file", {
              path: "linked/secret.txt",
              startLine: 1,
              endLine: 10,
            })
          ).isError,
        ).toBe(true);
      }
      await symlink(outside, join(workspace, ".machdoch"), "junction");
      for (const call of [apiCall, mcpCall]) {
        for (const name of [
          "list_workflows",
          "list_scheduled_jobs",
          "search_memory",
        ]) {
          const result = await call(name);
          expect(result.isError, name).toBe(true);
          expect(result.output).toContain("workspace");
        }
      }
    } finally {
      root = originalRoot;
    }
  });
});

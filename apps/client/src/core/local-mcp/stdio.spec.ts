import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeConfig } from "../__test__/ralph-test-helpers.js";
import { resolveMachdochCliLaunch } from "../provider-enrollment/machdoch-cli-launch.js";
import { projectMcpForProvider } from "../provider-enrollment/mcp-projector.js";
import { startLocalMcpHost } from "./http.js";
import { saveWorkspaceMemoryOverride } from "../config.js";
import { saveUserWorkspaceMemoryDefaultEnabled } from "../env.js";

let root: string;
const cleanup: Array<() => Promise<void>> = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "machdoch-mcp-source launch-"));
  vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", join(root, "user"));
  vi.stubEnv("MACHDOCH_RUN_CONTROL_TOKEN", "");
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  });
});

const launch = () => {
  const entry = fileURLToPath(new URL("../../cli/main.ts", import.meta.url));
  return resolveMachdochCliLaunch({
    execPath: process.execPath,
    execArgv: ["--import", "@oxc-node/core/register"],
    argv: [process.execPath, entry],
    cwd: root,
    environment: { MACHDOCH_USER_CONFIG_DIR: join(root, "user") },
  });
};

const connect = async (
  command: string,
  args: string[],
  env: Record<string, string>,
) => {
  const transport = new StdioClientTransport({
    command,
    args,
    cwd: root,
    env: { ...getDefaultEnvironment(), ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "source-launch-regression", version: "1" });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  cleanup.push(
    () => transport.close(),
    () => client.close(),
  );
  try {
    await client.connect(transport);
  } catch (error) {
    throw new Error(`${String(error)}\n${diagnostics}`, { cause: error });
  }
  return client;
};

describe("Machdoch source CLI MCP", () => {
  it.each([
    [false, null, false],
    [true, false, false],
    [false, true, true],
  ] as const)(
    "honors workspace memory defaults %s and override %s",
    async (defaultEnabled, override, enabled) => {
      await saveUserWorkspaceMemoryDefaultEnabled(defaultEnabled);
      await saveWorkspaceMemoryOverride(root, override);
      const descriptor = launch();
      const client = await connect(
        descriptor.command,
        [
          ...descriptor.args,
          "mcp",
          "serve",
          "--cwd",
          root,
          "--mode",
          "machdoch",
        ],
        descriptor.environment,
      );
      expect(
        (await client.listTools()).tools.some(
          (tool) => tool.name === "remember_workspace_memory",
        ),
      ).toBe(enabled);
    },
    60_000,
  );

  it("closes its HTTP connection and exits when the stdio client disconnects", async () => {
    const host = await startLocalMcpHost({
      config: { ...runtimeConfig, workspaceRoot: root },
      memory: {
        sessionEnabled: false,
        sessionEntries: [],
        globalEnabled: false,
        globalEntries: [],
      },
    });
    cleanup.push(host.close);
    const descriptor = launch();
    const child = spawn(
      descriptor.command,
      [...descriptor.args, "mcp", "connect"],
      {
        cwd: root,
        env: {
          ...getDefaultEnvironment(),
          ...descriptor.environment,
          MACHDOCH_LOCAL_MCP_URL: host.endpoint.url,
          MACHDOCH_LOCAL_MCP_TOKEN: host.endpoint.token,
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const closed = once(child, "close");
    cleanup.push(async () => {
      if (child.exitCode === null) child.kill();
      await closed;
    });
    const lines = createInterface({ input: child.stdout });
    const initialized = once(lines, "line");
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "disconnect-test", version: "1" },
        },
      })}\n`,
    );
    const [response] = await initialized;
    expect(JSON.parse(response).id).toBe(1);
    child.stdin.end();
    await vi.waitFor(() => expect(child.exitCode).toBe(0), { timeout: 10_000 });
    expect(await closed).toEqual([0, null]);
    lines.close();
  });

  it("launches the actual oxc import-only preload from an unrelated working directory", async () => {
    const descriptor = launch();
    expect(descriptor.args[1]).toMatch(/^file:/u);
    const client = await connect(
      descriptor.command,
      [...descriptor.args, "mcp", "serve", "--cwd", root, "--mode", "ask"],
      descriptor.environment,
    );
    const tools = (await client.listTools()).tools;
    expect(tools.some((tool) => tool.name === "list_workflows")).toBe(true);
    expect(tools.some((tool) => tool.name === "create_scheduled_job")).toBe(
      false,
    );
    const result = await client.callTool({
      name: "list_workflows",
      arguments: {},
    });
    expect(result.content).toEqual([{ type: "text", text: "[]" }]);
    expect(
      (
        await client.callTool({
          name: "remember_workspace_memory",
          arguments: {},
        })
      ).isError,
    ).toBe(true);
  }, 60_000);

  it.each(["codex-cli", "claude-cli", "copilot-cli"] as const)(
    "invokes the parent runtime with the generated %s MCP configuration",
    async (provider) => {
      const workspaceRoot = join(root, "workspace");
      await mkdir(workspaceRoot);
      const memory = {
        sessionEnabled: true,
        sessionEntries: [],
        globalEnabled: false,
        globalEntries: [],
      };
      const host = await startLocalMcpHost({
        config: { ...runtimeConfig, workspaceRoot, mode: "machdoch" },
        memory,
      });
      cleanup.push(host.close);
      const descriptor = launch();
      const projection = await projectMcpForProvider(provider, workspaceRoot, {
        machdochCliLaunch: descriptor,
        localMcp: host.endpoint,
      });
      const entry = projection.servers.find(
        (server) => server.canonicalId === "machdoch",
      );
      expect(entry).toBeDefined();
      const config = entry!.providerConfig;
      const client = await connect(
        config.command as string,
        config.args as string[],
        config.env as Record<string, string>,
      );
      const catalog = (await client.listTools()).tools;
      expect(catalog.some((tool) => tool.name === "list_scheduled_jobs")).toBe(
        true,
      );
      expect(
        catalog.every((tool) => `machdoch__${tool.name}`.length <= 64),
      ).toBe(true);
      expect(catalog.some((tool) => tool.name === "run_workflow")).toBe(true);
      const result = await client.callTool({
        name: "list_workflows",
        arguments: {},
      });
      expect(result.content).toEqual([{ type: "text", text: "[]" }]);
      expect(
        (
          await client.callTool({
            name: "remember_session_memory",
            arguments: {
              fact: "Use focused checks.",
              memory_key: "checks",
              kind: "preference",
              search_terms: [],
              importance: 3,
              sensitivity: "non-sensitive",
            },
          })
        ).isError,
      ).not.toBe(true);
      expect(memory.sessionEntries).toHaveLength(1);
      expect(
        (
          await client.callTool({
            name: "list_workflows",
            arguments: { workspaceRoot: root },
          })
        ).isError,
      ).toBe(true);
    },
  );
});

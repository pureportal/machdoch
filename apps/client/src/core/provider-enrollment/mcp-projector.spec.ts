import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentCliProvider } from "../runtime-contract.generated.js";
import type { MachdochCliLaunch } from "./machdoch-cli-launch.js";
import { projectMcpForProvider } from "./mcp-projector.js";

const roots: string[] = [];
const originalConfigDirectory = process.env.MACHDOCH_USER_CONFIG_DIR;

afterEach(async () => {
  if (originalConfigDirectory === undefined)
    delete process.env.MACHDOCH_USER_CONFIG_DIR;
  else process.env.MACHDOCH_USER_CONFIG_DIR = originalConfigDirectory;
  delete process.env.MCP_PROJECTOR_TEST_TOKEN;
  delete process.env.MCP_PROJECTOR_OPTIONAL_TOKEN;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const createLaunch = (root: string, source = false): MachdochCliLaunch => ({
  command: join(root, "runtime", "machdoch node.exe"),
  args: source
    ? [
        "--import",
        "@oxc-node/core/register",
        join(root, "src", "cli", "main.ts"),
      ]
    : [join(root, "runtime", "machdoch cli.cjs")],
  cwd: root,
  environment: { MACHDOCH_USER_CONFIG_DIR: join(root, "user") },
});

describe("MCP projector", () => {
  it("adds the run-scoped read-only workspace presence server", async () => {
    const root = await mkdtemp(join(tmpdir(), "machdoch-projector-presence-"));
    roots.push(root);
    process.env.MACHDOCH_USER_CONFIG_DIR = join(root, "user");
    const launch = createLaunch(root);

    const projection = await projectMcpForProvider("codex-cli", root, {
      machdochCliLaunch: launch,
      workspacePresence: {
        address: "127.0.0.1:43125",
        token: "presence-token",
        agentId: "agent-id",
      },
    });

    expect(
      projection.servers.find(
        (server) => server.canonicalId === "machdoch-workspace-presence",
      ),
    ).toMatchObject({
      route: "cli-native-mcp",
      capabilities: ["tools"],
      providerConfig: {
        command: launch.command,
        args: [...launch.args, "mcp", "presence", "--cwd", root],
        cwd: launch.cwd,
        env: {
          MACHDOCH_RUN_CONTROL_ADDRESS: "127.0.0.1:43125",
          MACHDOCH_WORKSPACE_PRESENCE_TOKEN: "presence-token",
          MACHDOCH_WORKSPACE_AGENT_ID: "agent-id",
        },
      },
    });
  });

  it("uses direct native entries first and a named stdio proxy for field loss", async () => {
    const root = await mkdtemp(join(tmpdir(), "machdoch-projector-"));
    roots.push(root);
    process.env.MACHDOCH_USER_CONFIG_DIR = join(root, "user");
    const configDirectory = join(root, ".machdoch", "mcp");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      join(configDirectory, "mcp.json"),
      JSON.stringify({
        schemaVersion: 1,
        servers: [
          {
            id: "direct",
            enabled: true,
            transport: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
              env: {},
            },
          },
          {
            id: "proxied",
            enabled: true,
            transport: { type: "sse", url: "https://example.test/sse" },
          },
          {
            id: "http-direct",
            enabled: true,
            transport: {
              type: "streamable-http",
              url: "https://example.test/mcp",
            },
            timeoutMs: 12_500,
            maxTotalTimeoutMs: 45_500,
          },
        ],
      }),
      "utf8",
    );
    const projection = await projectMcpForProvider("codex-cli", root, {
      machdochCliLaunch: {
        command: "machdoch-node-test",
        args: ["machdoch-cli-test.cjs"],
        cwd: root,
        environment: { MACHDOCH_USER_CONFIG_DIR: join(root, "user") },
      },
    });
    expect(
      projection.servers.find((server) => server.canonicalId === "direct")
        ?.route,
    ).toBe("cli-native-mcp");
    const proxied = projection.servers.find(
      (server) => server.canonicalId === "proxied",
    );
    expect(proxied?.route).toBe("cli-stdio-proxy");
    expect(proxied?.providerConfig).toMatchObject({
      command: "machdoch-node-test",
      args: ["machdoch-cli-test.cjs", "mcp", "proxy", "proxied", "--cwd", root],
      cwd: root,
      env: { MACHDOCH_USER_CONFIG_DIR: join(root, "user") },
    });
    expect(
      projection.servers.find((server) => server.canonicalId === "http-direct"),
    ).toMatchObject({
      route: "cli-native-mcp",
      providerConfig: {
        url: "https://example.test/mcp",
        startup_timeout_sec: 13,
        tool_timeout_sec: 46,
      },
    });
  });

  it("keeps workspace overrides out of the global user projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "machdoch-projector-scope-"));
    roots.push(root);
    const userRoot = join(root, "user");
    const workspaceConfigRoot = join(root, ".machdoch", "mcp");
    process.env.MACHDOCH_USER_CONFIG_DIR = userRoot;
    await Promise.all([
      mkdir(userRoot, { recursive: true }),
      mkdir(workspaceConfigRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(userRoot, "mcp.json"),
        JSON.stringify({
          schemaVersion: 1,
          servers: [
            {
              id: "shared",
              enabled: true,
              transport: { type: "stdio", command: "user-command" },
            },
          ],
        }),
        "utf8",
      ),
      writeFile(
        join(workspaceConfigRoot, "mcp.json"),
        JSON.stringify({
          schemaVersion: 1,
          servers: [
            {
              id: "shared",
              transport: { type: "stdio", command: "workspace-command" },
            },
          ],
        }),
        "utf8",
      ),
    ]);

    const userProjection = await projectMcpForProvider("codex-cli", root, {
      persistent: true,
      scope: "user",
    });
    const workspaceProjection = await projectMcpForProvider("codex-cli", root, {
      persistent: true,
      scope: "workspace",
    });

    expect(userProjection.servers).toHaveLength(1);
    expect(userProjection.servers[0]?.providerConfig).toMatchObject({
      command: "user-command",
    });
    expect(workspaceProjection.servers).toHaveLength(1);
    expect(workspaceProjection.servers[0]?.providerConfig).toMatchObject({
      command: "workspace-command",
    });
  });

  it.each<AgentCliProvider>(["codex-cli", "claude-cli", "copilot-cli"])(
    "renders a packaged launch descriptor for %s proxies",
    async (provider) => {
      const root = await mkdtemp(
        join(tmpdir(), "machdoch-projector-packaged-"),
      );
      roots.push(root);
      process.env.MACHDOCH_USER_CONFIG_DIR = join(root, "user");
      const configDirectory = join(root, ".machdoch", "mcp");
      await mkdir(configDirectory, { recursive: true });
      await writeFile(
        join(configDirectory, "mcp.json"),
        JSON.stringify({
          schemaVersion: 1,
          servers: [
            {
              id: "policy-server",
              enabled: true,
              transport: { type: "stdio", command: "node" },
              sampling: "ask-agent",
              timeoutMs: 70_000,
              maxTotalTimeoutMs: 420_000,
            },
          ],
        }),
        "utf8",
      );
      const launch = createLaunch(root);

      const projection = await projectMcpForProvider(provider, root, {
        machdochCliLaunch: launch,
      });
      const projected = projection.servers[0];

      expect(projected?.route).toBe("cli-stdio-proxy");
      expect(projected?.providerConfig).toMatchObject({
        command: launch.command,
        args: [...launch.args, "mcp", "proxy", "policy-server", "--cwd", root],
        cwd: root,
        env: launch.environment,
      });
      if (provider === "copilot-cli") {
        expect(projected?.providerConfig).toMatchObject({
          type: "local",
          timeout: 420_000,
          tools: ["*"],
        });
      } else if (provider === "codex-cli") {
        expect(projected?.providerConfig).toMatchObject({
          startup_timeout_sec: 70,
          tool_timeout_sec: 420,
        });
      }
    },
  );

  it("preserves source launch arguments and projects required MCP environment separately", async () => {
    const root = await mkdtemp(join(tmpdir(), "machdoch-projector-source-"));
    roots.push(root);
    process.env.MACHDOCH_USER_CONFIG_DIR = join(root, "user");
    process.env.MCP_PROJECTOR_TEST_TOKEN = "fixture-secret";
    const configDirectory = join(root, ".machdoch", "mcp");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      join(configDirectory, "mcp.json"),
      JSON.stringify({
        schemaVersion: 1,
        servers: [
          {
            id: "secret-server",
            enabled: true,
            transport: {
              type: "stdio",
              command: "node",
              env: { TOKEN: "${env:MCP_PROJECTOR_TEST_TOKEN}" },
            },
          },
        ],
      }),
      "utf8",
    );
    const launch = createLaunch(root, true);

    const projection = await projectMcpForProvider("copilot-cli", root, {
      machdochCliLaunch: launch,
    });

    expect(projection.environment).toEqual({
      MCP_PROJECTOR_TEST_TOKEN: "fixture-secret",
    });
    expect(projection.servers[0]?.providerConfig).toMatchObject({
      command: launch.command,
      args: [...launch.args, "mcp", "proxy", "secret-server", "--cwd", root],
    });
    expect(JSON.stringify(projection.config)).not.toContain("fixture-secret");

    const codexProjection = await projectMcpForProvider("codex-cli", root, {
      machdochCliLaunch: launch,
    });
    expect(codexProjection.servers[0]?.providerConfig).toMatchObject({
      env_vars: ["MCP_PROJECTOR_TEST_TOKEN"],
    });
    expect(JSON.stringify(codexProjection.config)).not.toContain(
      "fixture-secret",
    );
  });

  it("pins user-scoped proxy commands to the user configuration", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "machdoch-projector-user-proxy-"),
    );
    roots.push(root);
    const userRoot = join(root, "user");
    process.env.MACHDOCH_USER_CONFIG_DIR = userRoot;
    await mkdir(userRoot, { recursive: true });
    await writeFile(
      join(userRoot, "mcp.json"),
      JSON.stringify({
        schemaVersion: 1,
        servers: [
          {
            id: "shared",
            enabled: true,
            transport: { type: "stdio", command: "user-command" },
            sampling: "ask-agent",
          },
        ],
      }),
      "utf8",
    );
    const launch = createLaunch(root);

    const projection = await projectMcpForProvider("codex-cli", root, {
      persistent: true,
      scope: "user",
      machdochCliLaunch: launch,
    });

    expect(projection.servers[0]?.providerConfig).toMatchObject({
      args: [...launch.args, "mcp", "proxy", "shared", "--scope", "user"],
    });
    expect(projection.servers[0]?.providerConfig).not.toHaveProperty("cwd");
  });

  it("reports a missing required environment value before generating enrollment config", async () => {
    const root = await mkdtemp(join(tmpdir(), "machdoch-projector-env-error-"));
    roots.push(root);
    process.env.MACHDOCH_USER_CONFIG_DIR = join(root, "user");
    const configDirectory = join(root, ".machdoch", "mcp");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      join(configDirectory, "mcp.json"),
      JSON.stringify({
        schemaVersion: 1,
        servers: [
          {
            id: "missing-secret",
            enabled: true,
            transport: {
              type: "stdio",
              command: "node",
              args: ["${env:MISSING_PROJECTOR_TOKEN}"],
            },
          },
        ],
      }),
      "utf8",
    );

    await expect(
      projectMcpForProvider("copilot-cli", root, {
        machdochCliLaunch: createLaunch(root),
      }),
    ).rejects.toThrow(
      "Central MCP configuration requires environment variable MISSING_PROJECTOR_TOKEN",
    );
  });

  it("proxies disabled roots and keeps auth environment references optional", async () => {
    const root = await mkdtemp(join(tmpdir(), "machdoch-projector-policy-"));
    roots.push(root);
    process.env.MACHDOCH_USER_CONFIG_DIR = join(root, "user");
    const configDirectory = join(root, ".machdoch", "mcp");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      join(configDirectory, "mcp.json"),
      JSON.stringify({
        schemaVersion: 1,
        servers: [
          {
            id: "policy-server",
            enabled: true,
            transport: { type: "stdio", command: "node" },
            roots: "disabled",
          },
          {
            id: "oauth-server",
            enabled: true,
            transport: {
              type: "streamable-http",
              url: "https://example.test/mcp",
            },
            auth: {
              type: "oauth",
              redirectUrl: "http://127.0.0.1:43110/oauth/callback",
              accessTokenEnv: "MCP_PROJECTOR_OPTIONAL_TOKEN",
            },
          },
          {
            id: "bearer-server",
            enabled: true,
            transport: { type: "stdio", command: "node" },
            auth: {
              type: "bearer",
              tokenEnv: "MCP_PROJECTOR_OPTIONAL_TOKEN",
            },
          },
          {
            id: "header-server",
            enabled: true,
            transport: { type: "stdio", command: "node" },
            auth: {
              type: "headers",
              envHeaders: {
                Authorization: "MCP_PROJECTOR_OPTIONAL_TOKEN",
              },
            },
          },
          {
            id: "external-oauth-server",
            enabled: true,
            transport: {
              type: "streamable-http",
              url: "https://example.test/external-mcp",
            },
            auth: {
              type: "oauth",
              redirectUrl: "https://example.test/oauth/callback",
            },
          },
        ],
      }),
      "utf8",
    );

    const projection = await projectMcpForProvider("copilot-cli", root, {
      machdochCliLaunch: createLaunch(root),
    });

    expect(
      projection.servers.find(
        (server) => server.canonicalId === "policy-server",
      )?.route,
    ).toBe("cli-stdio-proxy");
    expect(
      projection.servers.find(
        (server) => server.canonicalId === "oauth-server",
      ),
    ).toBeUndefined();
    expect(
      projection.uncoveredServers.find(
        (server) => server.canonicalId === "oauth-server",
      ),
    ).toMatchObject({
      reason: expect.stringContaining(
        `machdoch mcp oauth-authorize oauth-server --cwd "${root}"`,
      ),
    });
    expect(
      projection.servers.find(
        (server) => server.canonicalId === "bearer-server",
      )?.route,
    ).toBe("cli-stdio-proxy");
    expect(
      projection.servers.find(
        (server) => server.canonicalId === "header-server",
      )?.route,
    ).toBe("cli-stdio-proxy");
    expect(projection.environment).toEqual({});
    expect(projection.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "oauth-server: OAuth authorization is required.",
        ),
      ]),
    );
    expect(
      projection.uncoveredServers.find(
        (server) => server.canonicalId === "external-oauth-server",
      )?.reason,
    ).toContain(
      `machdoch mcp oauth-start external-oauth-server --cwd "${root}"`,
    );
  });

  it("passes available optional auth environment overrides to the proxy process", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "machdoch-projector-optional-env-"),
    );
    roots.push(root);
    process.env.MACHDOCH_USER_CONFIG_DIR = join(root, "user");
    process.env.MCP_PROJECTOR_OPTIONAL_TOKEN = "optional-secret";
    const configDirectory = join(root, ".machdoch", "mcp");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      join(configDirectory, "mcp.json"),
      JSON.stringify({
        schemaVersion: 1,
        servers: [
          {
            id: "oauth-server",
            enabled: true,
            transport: {
              type: "streamable-http",
              url: "https://example.test/mcp",
            },
            auth: {
              type: "oauth",
              redirectUrl: "http://127.0.0.1:43110/oauth/callback",
              accessTokenEnv: "MCP_PROJECTOR_OPTIONAL_TOKEN",
            },
          },
        ],
      }),
      "utf8",
    );

    const projection = await projectMcpForProvider("copilot-cli", root, {
      machdochCliLaunch: createLaunch(root),
    });

    expect(projection.environment).toEqual({
      MCP_PROJECTOR_OPTIONAL_TOKEN: "optional-secret",
    });
    expect(JSON.stringify(projection.config)).not.toContain("optional-secret");
    expect(
      projection.servers.find((server) => server.canonicalId === "oauth-server")
        ?.warnings,
    ).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("machdoch mcp oauth-authorize"),
      ]),
    );
  });
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  coerceMcpConfigOverride,
  createMcpConfigFromPreset,
  loadMcpConfig,
  saveUserMcpOAuthState,
} from "./config.ts";

const workspacesToClean: string[] = [];
const originalUserConfigDir = process.env.MACHDOCH_USER_CONFIG_DIR;

const createWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-mcp-"));
  workspacesToClean.push(workspaceRoot);
  process.env.MACHDOCH_USER_CONFIG_DIR = join(workspaceRoot, ".user-config");
  return workspaceRoot;
};

afterEach(async () => {
  if (originalUserConfigDir === undefined) {
    delete process.env.MACHDOCH_USER_CONFIG_DIR;
  } else {
    process.env.MACHDOCH_USER_CONFIG_DIR = originalUserConfigDir;
  }

  await Promise.all(
    workspacesToClean
      .splice(0)
      .map((workspaceRoot) =>
        rm(workspaceRoot, { recursive: true, force: true }),
      ),
  );
});

describe("loadMcpConfig", () => {
  it("merges presets, user config, workspace config, and child overrides", async () => {
    const workspaceRoot = await createWorkspace();
    const userConfigDir = join(workspaceRoot, ".user-config");

    await mkdir(userConfigDir, { recursive: true });
    await mkdir(join(workspaceRoot, ".machdoch", "mcp"), { recursive: true });
    await writeFile(
      join(userConfigDir, "mcp.json"),
      JSON.stringify(
        {
          defaults: {
            securityProfile: "strict",
            directTools: false,
            idleShutdownMs: 0,
            cache: {
              enabled: false,
              ttlSeconds: 30,
            },
          },
          servers: {
            github: {
              url: "https://api.githubcopilot.com/mcp/",
              requestInit: {
                headers: {
                  Authorization: "Bearer user-token",
                },
              },
            },
          },
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(workspaceRoot, ".machdoch", "mcp", "mcp.json"),
      JSON.stringify(
        {
          defaults: {
            exposure: "hybrid",
            cache: {
              enabled: true,
            },
          },
          servers: [
            {
              id: "github",
              enabled: true,
              securityProfile: "balanced",
              timeoutMs: 120_000,
              idleShutdownMs: 1_000,
              cache: {
                ttlMs: 45_000,
              },
            },
          ],
        },
        null,
        2,
      ),
    );

    const config = await loadMcpConfig(workspaceRoot, {
      defaults: {
        securityProfile: "weak",
        cache: {
          forceRefresh: true,
        },
      },
      servers: [
        {
          id: "github",
          maxResponseChars: 1234,
          cache: {
            forceRefresh: false,
          },
        },
      ],
    });
    const github = config.servers.find((server) => server.id === "github");

    expect(config.defaults.securityProfile).toBe("weak");
    expect(config.defaults.directTools).toBe(false);
    expect(config.defaults.idleShutdownMs).toBe(0);
    expect(config.defaults.cache).toEqual({
      enabled: true,
      ttlMs: 30_000,
      forceRefresh: true,
    });
    expect(github).toMatchObject({
      id: "github",
      enabled: true,
      securityProfile: "balanced",
      timeoutMs: 120_000,
      idleShutdownMs: 1_000,
      maxResponseChars: 1234,
      cache: {
        enabled: true,
        ttlMs: 45_000,
        forceRefresh: false,
      },
      sources: ["preset", "user", "workspace", "override"],
    });
    expect(github?.transport).toMatchObject({
      type: "streamable-http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: {
        Authorization: "Bearer user-token",
      },
    });
  });

  it("creates editable enabled servers from presets", () => {
    expect(createMcpConfigFromPreset("github-remote")).toMatchObject({
      id: "github",
      enabled: true,
      transport: {
        type: "streamable-http",
        url: "https://api.githubcopilot.com/mcp/",
      },
      auth: {
        type: "bearer",
        tokenEnv: "GITHUB_PERSONAL_ACCESS_TOKEN",
      },
    });
  });

  it("creates editable enabled OAuth servers from hosted presets", () => {
    expect(createMcpConfigFromPreset("linear-remote")).toMatchObject({
      id: "linear",
      enabled: true,
      preset: "linear-remote",
      transport: {
        type: "streamable-http",
        url: "https://mcp.linear.app/mcp",
        legacySseFallback: true,
      },
      auth: {
        type: "oauth",
        redirectUrl: "http://127.0.0.1:43110/oauth/callback",
        scopes: ["read", "write"],
      },
      exposure: {
        mode: "hybrid",
        directTools: true,
      },
    });
  });

  it("creates an editable enabled Tauri MCP development server from its preset", () => {
    expect(createMcpConfigFromPreset("tauri-mcp-server")).toMatchObject({
      id: "tauri",
      enabled: true,
      preset: "tauri-mcp-server",
      transport: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@hypothesi/tauri-mcp-server"],
        cwd: "${workspaceRoot}",
        inheritEnvironment: true,
      },
      exposure: {
        mode: "hybrid",
        directTools: true,
      },
      toolOverrides: {
        webview_screenshot: {
          effect: "external-read",
          riskLevel: "medium",
          readOnlyInAskMode: true,
        },
        ipc_get_backend_state: {
          effect: "external-read",
          riskLevel: "medium",
          readOnlyInAskMode: true,
        },
      },
    });
  });

  it("persists visible OAuth state in the user MCP config", async () => {
    const workspaceRoot = await createWorkspace();
    const server = createMcpConfigFromPreset("github-remote", {
      auth: {
        type: "oauth",
        redirectUrl: "http://127.0.0.1:43110/oauth/callback",
        scopes: ["repo", "read:user"],
      },
    });

    await saveUserMcpOAuthState(server, {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenType: "Bearer",
      tokenScope: "repo read:user",
      expiresIn: 3600,
      idToken: "id-token",
      authorizationUrl: "https://github.com/login/oauth/authorize",
      authorizationState: "state-1",
      codeVerifier: "verifier-1",
      clientInformation: {
        client_id: "registered-client",
      },
      discoveryState: {
        authorizationServerUrl: "https://github.com/login/oauth",
      },
    });

    const config = await loadMcpConfig(workspaceRoot);
    const github = config.servers.find((entry) => entry.id === "github");

    expect(github?.auth).toMatchObject({
      type: "oauth",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenType: "Bearer",
      tokenScope: "repo read:user",
      expiresIn: 3600,
      idToken: "id-token",
      authorizationUrl: "https://github.com/login/oauth/authorize",
      authorizationState: "state-1",
      codeVerifier: "verifier-1",
      clientInformation: {
        client_id: "registered-client",
      },
      discoveryState: {
        authorizationServerUrl: "https://github.com/login/oauth",
      },
    });
  });

  it("coerces child overrides with partial server patches", () => {
    expect(
      coerceMcpConfigOverride({
        defaults: {
          securityProfile: "weak",
          elicitation: "disabled",
          cache: {
            enabled: true,
            ttlSeconds: 5,
          },
        },
        servers: {
          github: {
            enabled: true,
            maxResponseChars: 2048,
            cache: {
              ttlSeconds: 10,
            },
          },
        },
      }),
    ).toEqual({
      defaults: {
        securityProfile: "weak",
        elicitation: "disabled",
        cache: {
          enabled: true,
          ttlMs: 5_000,
        },
      },
      servers: [
        {
          id: "github",
          enabled: true,
          maxResponseChars: 2048,
          cache: {
            ttlMs: 10_000,
          },
        },
      ],
    });
  });
});

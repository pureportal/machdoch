/// <reference types="vitest/globals" />
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type {
  CreateMessageRequest,
  CreateMessageResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { saveWorkspaceMcpDiscovery } from "./config.ts";
import {
  McpClientManager,
  McpOAuthAuthorizationRequiredError,
  type McpSamplingHandler,
} from "./client.ts";
import { mcpRunCacheManager } from "./run-cache.ts";
import type { McpEffectiveServerConfig } from "./types.ts";

const workspacesToClean: string[] = [];
const originalUserConfigDir = process.env.MACHDOCH_USER_CONFIG_DIR;

const createServer = (
  overrides: Partial<McpEffectiveServerConfig> = {},
): McpEffectiveServerConfig => ({
  id: "test",
  title: "Test MCP",
  enabled: true,
  transport: {
    type: "stdio",
    command: "test-mcp",
  },
  exposure: {
    mode: "hybrid",
    directTools: true,
  },
  securityProfile: "weak",
  timeoutMs: 60_000,
  maxTotalTimeoutMs: 300_000,
  idleShutdownMs: 0,
  maxResponseChars: 60_000,
  cache: {
    enabled: true,
    ttlMs: 900_000,
    forceRefresh: false,
  },
  roots: "workspace",
  sampling: "disabled",
  tasks: "optional",
  sources: ["workspace"],
  ...overrides,
});

const createTransport = (): Transport => {
  let protocolVersion: string | undefined;

  return {
    close: vi.fn(async () => undefined),
    setProtocolVersion: vi.fn((version: string) => {
      protocolVersion = version;
    }),
    get protocolVersion() {
      return protocolVersion;
    },
  } as unknown as Transport;
};

const createClient = (overrides: Partial<Client> = {}): Client => {
  return {
    connect: vi.fn(async () => undefined),
    setRequestHandler: vi.fn(),
    getServerCapabilities: vi.fn(() => ({})),
    getServerVersion: vi.fn(() => undefined),
    getInstructions: vi.fn(() => undefined),
    ...overrides,
  } as unknown as Client;
};

const wait = (timeoutMs: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
};

const getAvailableLoopbackPort = async (): Promise<number> => {
  const server = createHttpServer();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP listener address.");
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  return address.port;
};

const createWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-mcp-client-"));
  workspacesToClean.push(workspaceRoot);
  process.env.MACHDOCH_USER_CONFIG_DIR = join(workspaceRoot, ".user-config");
  return workspaceRoot;
};

const writeWorkspaceMcpConfig = async (
  workspaceRoot: string,
  cache: Record<string, unknown> = { enabled: true, ttlMs: 900_000 },
): Promise<void> => {
  const configDirectory = join(workspaceRoot, ".machdoch", "mcp");

  await mkdir(configDirectory, { recursive: true });
  await writeFile(
    join(configDirectory, "mcp.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        defaults: {
          cache,
        },
        servers: [
          {
            id: "test",
            enabled: true,
            transport: {
              type: "stdio",
              command: "test-mcp",
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
};

const writeWorkspaceOAuthMcpConfig = async (
  workspaceRoot: string,
  redirectUrl: string,
): Promise<void> => {
  const configDirectory = join(workspaceRoot, ".machdoch", "mcp");

  await mkdir(configDirectory, { recursive: true });
  await writeFile(
    join(configDirectory, "mcp.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        servers: [
          {
            id: "test",
            enabled: true,
            transport: {
              type: "streamable-http",
              url: "https://example.com/mcp",
            },
            auth: {
              type: "oauth",
              redirectUrl,
              scopes: ["read"],
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
};

const createSamplingRequest = (
  overrides: Partial<CreateMessageRequest["params"]> = {},
): CreateMessageRequest => ({
  method: "sampling/createMessage",
  params: {
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: "Summarize the result.",
        },
      },
    ],
    maxTokens: 128,
    ...overrides,
  },
});

afterEach(async () => {
  mcpRunCacheManager.clear();

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

describe("McpClientManager lifecycle", () => {
  it("cleans up transports when client construction fails", async () => {
    const transport = createTransport();
    const manager = new McpClientManager({
      createTransport: () => transport,
      createClient: () => {
        throw new Error("constructor failed");
      },
      loadRuntimeEnvironment: async () => ({}),
    });
    await expect(
      manager.getConnection("C:/workspace", createServer()),
    ).rejects.toThrow("constructor failed");
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(manager.listConnections()).toEqual([]);
  });

  it("does not register a connection that closes during its handshake", async () => {
    const transport = createTransport();
    const client = createClient();
    vi.mocked(client.connect).mockImplementation(async () => {
      client.onclose?.();
    });
    const manager = new McpClientManager({
      createTransport: () => transport,
      createClient: () => client,
      loadRuntimeEnvironment: async () => ({}),
    });
    await expect(
      manager.getConnection("C:/workspace", createServer()),
    ).rejects.toThrow("closed during startup");
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(manager.listConnections()).toEqual([]);
  });

  it("cancels startup before environment loading completes without creating a transport", async () => {
    let finish = (_env: Record<string, string>) => {};
    const environment = new Promise<Record<string, string>>((resolve) => {
      finish = resolve;
    });
    const loadRuntimeEnvironment = vi.fn(() => environment);
    const createTransportMock = vi.fn(createTransport);
    const manager = new McpClientManager({
      createTransport: createTransportMock,
      createClient: () => createClient(),
      loadRuntimeEnvironment,
    });
    const pending = manager.getConnection("C:/workspace", createServer());
    await vi.waitFor(() =>
      expect(loadRuntimeEnvironment).toHaveBeenCalledTimes(1),
    );
    await Promise.all([
      expect(pending).rejects.toThrow("cancelled by shutdown"),
      manager.closeAll(),
    ]);
    finish({});
    await Promise.resolve();
    expect(createTransportMock).not.toHaveBeenCalled();
    expect(manager.listConnections()).toEqual([]);
  });

  it("closes one server without waiting for another server's stalled handshake", async () => {
    let finish = () => {};
    const handshake = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const slow = createClient({ connect: vi.fn(() => handshake) });
    const manager = new McpClientManager({
      createTransport,
      createClient: ({ server }) =>
        server.id === "slow" ? slow : createClient(),
      loadRuntimeEnvironment: async () => ({}),
    });
    const pending = manager.getConnection(
      "C:/workspace",
      createServer({ id: "slow" }),
    );
    try {
      await manager.getConnection("C:/workspace", createServer());
      await manager.closeServer("C:/workspace", "test");
      expect(manager.listConnections()).toEqual([]);
    } finally {
      finish();
      await pending;
      await manager.closeAll();
    }
  });

  it("rejects new connections until shutdown completes and then allows reuse", async () => {
    let finish = () => {};
    const closePending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const transport = createTransport();
    vi.mocked(transport.close).mockImplementationOnce(() => closePending);
    const manager = new McpClientManager({
      createTransport: () => transport,
      createClient: () => createClient(),
      loadRuntimeEnvironment: async () => ({}),
    });
    const server = createServer();
    await manager.getConnection("C:/workspace", server);
    const closing = manager.closeAll();
    try {
      await expect(
        manager.getConnection("C:/workspace", server),
      ).rejects.toThrow("shutting down");
    } finally {
      finish();
      await closing;
    }
    await expect(
      manager.getConnection("C:/workspace", server),
    ).resolves.toBeDefined();
    await manager.closeAll();
  });

  it("reuses equivalent paths but separates changed connection settings", async () => {
    const manager = new McpClientManager({
      createTransport,
      createClient: () => createClient(),
      loadRuntimeEnvironment: async () => ({}),
    });
    const server = createServer();
    const initial = await manager.getConnection("C:/workspace", server);
    expect(await manager.getConnection("C:/workspace/child/..", server)).toBe(
      initial,
    );
    const changed = await manager.getConnection("C:/workspace", {
      ...server,
      roots: "disabled",
    });
    expect(changed).not.toBe(initial);
    expect(manager.listConnections()).toHaveLength(2);
    await manager.closeAll();
  });
  it("shares connection startup across concurrent requests", async () => {
    let finishConnect: () => void = () => undefined;
    const connectPending = new Promise<void>((resolve) => {
      finishConnect = resolve;
    });
    const transport = createTransport();
    const client = createClient({
      connect: vi.fn(async () => connectPending),
    });
    const createTransportMock = vi.fn(() => transport);
    const createClientMock = vi.fn(() => client);
    const manager = new McpClientManager({
      createClient: createClientMock,
      createTransport: createTransportMock,
      loadRuntimeEnvironment: async () => ({}),
    });
    const server = createServer();

    const first = manager.getConnection("C:/workspace", server);
    const second = manager.getConnection("C:/workspace", server);

    await vi.waitFor(() => {
      expect(client.connect).toHaveBeenCalledTimes(1);
    });
    finishConnect();

    const [firstConnection, secondConnection] = await Promise.all([
      first,
      second,
    ]);

    expect(firstConnection).toBe(secondConnection);
    expect(createTransportMock).toHaveBeenCalledTimes(1);
    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(manager.listConnections()).toHaveLength(1);
    await manager.closeAll();
  });

  it("closes a transport when connection startup fails", async () => {
    const failedTransport = createTransport();
    const replacementTransport = createTransport();
    const clients = [
      createClient({
        connect: vi.fn(async () => {
          throw new Error("handshake failed");
        }),
      }),
      createClient(),
    ];
    const transports = [failedTransport, replacementTransport];
    const manager = new McpClientManager({
      createClient: () => clients.shift() ?? createClient(),
      createTransport: () => transports.shift() ?? createTransport(),
      loadRuntimeEnvironment: async () => ({}),
    });
    const server = createServer();

    await expect(manager.getConnection("C:/workspace", server)).rejects.toThrow(
      "handshake failed",
    );

    expect(failedTransport.close).toHaveBeenCalledTimes(1);
    expect(manager.listConnections()).toEqual([]);

    await expect(
      manager.getConnection("C:/workspace", server),
    ).resolves.toBeDefined();
    expect(manager.listConnections()).toHaveLength(1);
    await manager.closeAll();
  });

  it("cancels an in-flight connection when closing all transports", async () => {
    let finishConnect: () => void = () => undefined;
    const connectPending = new Promise<void>((resolve) => {
      finishConnect = resolve;
    });
    const transport = createTransport();
    const client = createClient({
      connect: vi.fn(async () => connectPending),
    });
    const manager = new McpClientManager({
      createClient: () => client,
      createTransport: () => transport,
      loadRuntimeEnvironment: async () => ({}),
    });

    const connection = manager.getConnection("C:/workspace", createServer());

    await vi.waitFor(() => {
      expect(client.connect).toHaveBeenCalledTimes(1);
    });
    const closing = manager.closeAll();
    await Promise.all([
      expect(connection).rejects.toThrow("cancelled by shutdown"),
      closing,
    ]);
    finishConnect();
    await Promise.resolve();

    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(manager.listConnections()).toEqual([]);
  });

  it("cancels an in-flight server connection before closing it", async () => {
    let finishConnect: () => void = () => undefined;
    const connectPending = new Promise<void>((resolve) => {
      finishConnect = resolve;
    });
    const transport = createTransport();
    const client = createClient({
      connect: vi.fn(async () => connectPending),
    });
    const manager = new McpClientManager({
      createClient: () => client,
      createTransport: () => transport,
      loadRuntimeEnvironment: async () => ({}),
    });

    const connection = manager.getConnection("C:/workspace", createServer());

    await vi.waitFor(() => {
      expect(client.connect).toHaveBeenCalledTimes(1);
    });
    const closing = manager.closeServer("C:/workspace", "test");
    await Promise.all([
      expect(connection).rejects.toThrow("cancelled by shutdown"),
      closing,
    ]);
    finishConnect();
    await Promise.resolve();

    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(manager.listConnections()).toEqual([]);
  });

  it("closes idle connections after the configured shutdown window", async () => {
    const transport = createTransport();
    const manager = new McpClientManager({
      createClient: () => createClient(),
      createTransport: () => transport,
      loadRuntimeEnvironment: async () => ({}),
    });
    const server = createServer({ idleShutdownMs: 5 });

    await manager.getConnection("C:/workspace", server);

    expect(manager.listConnections()).toHaveLength(1);

    await wait(30);

    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(manager.listConnections()).toEqual([]);
  });

  it("reconnects read-only discovery after a pooled connection fails", async () => {
    const firstTransport = createTransport();
    const secondTransport = createTransport();
    const firstClient = createClient({
      getServerCapabilities: vi.fn(() => ({ tools: {} })),
      listTools: vi.fn(async () => {
        throw new Error("stale transport");
      }),
    } as Partial<Client>);
    const secondClient = createClient({
      getServerCapabilities: vi.fn(() => ({ tools: {} })),
      listTools: vi.fn(async () => ({ tools: [] })),
    } as Partial<Client>);
    const clients = [firstClient, secondClient];
    const transports = [firstTransport, secondTransport];
    const manager = new McpClientManager({
      createClient: () => clients.shift() ?? secondClient,
      createTransport: () => transports.shift() ?? secondTransport,
      loadRuntimeEnvironment: async () => ({}),
    });
    const server = createServer();

    await expect(
      manager.discoverServer("C:/workspace", server),
    ).resolves.toMatchObject({
      serverId: "test",
      tools: [],
    });

    expect(firstTransport.close).toHaveBeenCalledTimes(1);
    expect(secondTransport.close).not.toHaveBeenCalled();
    expect(manager.listConnections()).toHaveLength(1);
  });

  it.each([ErrorCode.InvalidParams, ErrorCode.RequestTimeout])(
    "keeps the server alive after RPC failure %s",
    async (code) => {
      const transport = createTransport();
      const client = createClient({
        getServerCapabilities: vi.fn(() => ({ tools: {} })),
        listTools: vi
          .fn()
          .mockRejectedValueOnce(new McpError(code, "invalid request"))
          .mockResolvedValue({ tools: [] }),
      } as Partial<Client>);
      const createTransportMock = vi.fn(() => transport);
      const manager = new McpClientManager({
        createClient: () => client,
        createTransport: createTransportMock,
        loadRuntimeEnvironment: async () => ({}),
      });
      const server = createServer();
      await expect(
        manager.discoverServer("C:/workspace", server),
      ).rejects.toThrow("invalid request");
      expect(transport.close).not.toHaveBeenCalled();
      await manager.discoverServer("C:/workspace", server);
      expect(createTransportMock).toHaveBeenCalledTimes(1);
      await manager.closeAll();
    },
  );

  it("rejects looping discovery without reconnecting to the same broken catalog", async () => {
    const transport = createTransport();
    const client = createClient({
      getServerCapabilities: vi.fn(() => ({ tools: {} })),
      listTools: vi.fn(async () => ({ tools: [], nextCursor: "again" })),
    } as Partial<Client>);
    const manager = new McpClientManager({
      createTransport: () => transport,
      createClient: () => client,
      loadRuntimeEnvironment: async () => ({}),
    });
    await expect(
      manager.discoverServer("C:/workspace", createServer()),
    ).rejects.toThrow("repeated pagination cursor");
    expect(client.listTools).toHaveBeenCalledTimes(2);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(transport.close).not.toHaveBeenCalled();
    await manager.closeAll();
  });

  it("evicts a closed transport before the next operation tries to reuse it", async () => {
    const client = createClient();
    const manager = new McpClientManager({
      createClient: () => client,
      createTransport,
      loadRuntimeEnvironment: async () => ({}),
    });
    const server = createServer({ idleShutdownMs: 60_000 });
    const connection = await manager.getConnection("C:/workspace", server);
    client.onclose?.();
    expect(manager.listConnections()).toEqual([]);
    expect(connection.idleTimer).toBeUndefined();
    const replacement = await manager.getConnection("C:/workspace", server);
    expect(replacement).not.toBe(connection);
    await manager.closeAll();
  });

  it("evicts the retry connection when discovery fails again", async () => {
    const transports = [createTransport(), createTransport()];
    let index = 0;
    const manager = new McpClientManager({
      createClient: () =>
        createClient({
          getServerCapabilities: vi.fn(() => ({ tools: {} })),
          listTools: vi.fn().mockRejectedValue(new Error("broken transport")),
        } as Partial<Client>),
      createTransport: () => transports[index++]!,
      loadRuntimeEnvironment: async () => ({}),
    });
    await expect(
      manager.discoverServer("C:/workspace", createServer()),
    ).rejects.toThrow("broken transport");
    expect(manager.listConnections()).toEqual([]);
    for (const transport of transports)
      expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it("enriches live discovery with protocol and catalog hashes", async () => {
    const transport = createTransport();
    const client = createClient({
      connect: vi.fn(async (candidateTransport: Transport) => {
        candidateTransport.setProtocolVersion?.("2025-11-25");
      }),
      getServerCapabilities: vi.fn(() => ({ tools: {} })),
      listTools: vi.fn(async () => ({
        tools: [
          {
            name: "search",
            description: "Search the web.",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
            },
          },
        ],
      })),
    } as Partial<Client>);
    const manager = new McpClientManager({
      createClient: () => client,
      createTransport: () => transport,
      loadRuntimeEnvironment: async () => ({}),
    });
    const server = createServer();

    const discovery = await manager.discoverServer("C:/workspace", server);

    expect(discovery).toMatchObject({
      protocolVersion: "2025-11-25",
      capabilitiesHash: expect.stringMatching(/^sha256:/u),
      catalogHash: expect.stringMatching(/^sha256:/u),
      toolCatalogHash: expect.stringMatching(/^sha256:/u),
      tools: [
        {
          name: "search",
          inputSchemaHash: expect.stringMatching(/^sha256:/u),
          definitionHash: expect.stringMatching(/^sha256:/u),
        },
      ],
    });
  });

  it("registers configured roots and reports effective connection capabilities", async () => {
    const workspaceRoot = await createWorkspace();
    const transport = createTransport();
    const client = createClient();
    const manager = new McpClientManager({
      createClient: () => client,
      createTransport: () => transport,
      loadRuntimeEnvironment: async () => ({}),
    });
    const server = createServer({
      roots: ["${workspaceRoot}", "docs", "https://example.com/mcp-root"],
    });

    await manager.getConnection(workspaceRoot, server);

    const handler = vi.mocked(client.setRequestHandler).mock.calls[0]?.[1] as
      | (() => Promise<{ roots: Array<{ uri: string; name?: string }> }>)
      | undefined;

    await expect(handler?.()).resolves.toEqual({
      roots: [
        {
          uri: pathToFileURL(workspaceRoot).href,
          name: basename(workspaceRoot),
        },
        {
          uri: pathToFileURL(join(workspaceRoot, "docs")).href,
          name: "docs",
        },
        {
          uri: "https://example.com/mcp-root",
          name: "mcp-root",
        },
      ],
    });

    expect(manager.listConnections()).toMatchObject([
      {
        serverId: "test",
        roots: server.roots,
        sampling: "disabled",
        tasks: "optional",
      },
    ]);
  });

  it("registers sampling/createMessage when server sampling is enabled", async () => {
    const workspaceRoot = await createWorkspace();
    const transport = createTransport();
    const client = createClient();
    const samplingResult: CreateMessageResult = {
      role: "assistant",
      content: {
        type: "text",
        text: "sampled answer",
      },
      model: "test-model",
      stopReason: "endTurn",
    };
    const samplingHandler: McpSamplingHandler = vi.fn(
      async () => samplingResult,
    );
    const manager = new McpClientManager({
      createClient: () => client,
      createTransport: () => transport,
      samplingHandler,
      loadRuntimeEnvironment: async () => ({}),
    });
    const server = createServer({ sampling: "ask-agent" });
    const signal = new AbortController().signal;

    await manager.getConnection(workspaceRoot, server);

    const handler = vi.mocked(client.setRequestHandler).mock.calls[1]?.[1] as
      | ((
          request: CreateMessageRequest,
          extra: { signal?: AbortSignal },
        ) => Promise<CreateMessageResult>)
      | undefined;

    await expect(
      handler?.(createSamplingRequest(), { signal }),
    ).resolves.toEqual(samplingResult);
    expect(samplingHandler).toHaveBeenCalledWith({
      workspaceRoot,
      server,
      request: createSamplingRequest(),
      signal,
    });
  });

  it("rejects MCP sampling tool requests because tool sampling is not advertised", async () => {
    const workspaceRoot = await createWorkspace();
    const transport = createTransport();
    const client = createClient();
    const samplingHandler: McpSamplingHandler = vi.fn(async () => ({
      role: "assistant" as const,
      content: {
        type: "text" as const,
        text: "unexpected",
      },
      model: "test-model",
    }));
    const manager = new McpClientManager({
      createClient: () => client,
      createTransport: () => transport,
      samplingHandler,
      loadRuntimeEnvironment: async () => ({}),
    });
    const server = createServer({ sampling: "ask-agent" });

    await manager.getConnection(workspaceRoot, server);

    const handler = vi.mocked(client.setRequestHandler).mock.calls[1]?.[1] as
      | ((
          request: CreateMessageRequest,
          extra: { signal?: AbortSignal },
        ) => Promise<CreateMessageResult>)
      | undefined;

    await expect(
      handler?.(
        createSamplingRequest({
          tools: [
            {
              name: "server_tool",
              inputSchema: {
                type: "object",
                additionalProperties: true,
              },
            },
          ],
        }),
        {},
      ),
    ).rejects.toThrow("MCP sampling tools are not enabled");
    expect(samplingHandler).not.toHaveBeenCalled();
  });

  it("passes a config-backed OAuth provider to HTTP transports", async () => {
    let capturedTransport: Transport | undefined;
    const workspaceRoot = await createWorkspace();
    const client = createClient({
      connect: vi.fn(async (transport: Transport) => {
        capturedTransport = transport;
      }),
    } as Partial<Client>);
    const manager = new McpClientManager({
      createClient: () => client,
      loadRuntimeEnvironment: async () => ({
        MCP_ACCESS_TOKEN: "access-token",
        MCP_CLIENT_SECRET: "client-secret",
      }),
    });
    const server = createServer({
      transport: {
        type: "streamable-http",
        url: "https://example.com/mcp",
      },
      auth: {
        type: "oauth",
        clientId: "client-id",
        clientSecretEnv: "MCP_CLIENT_SECRET",
        redirectUrl: "http://127.0.0.1:43110/oauth/callback",
        scopes: ["repo", "read:user"],
        accessTokenEnv: "MCP_ACCESS_TOKEN",
        refreshToken: "refresh-token",
      },
    });

    await manager.getConnection(workspaceRoot, server);

    if (!capturedTransport) {
      throw new Error("Expected the MCP transport to be created.");
    }

    const authProvider = (
      capturedTransport as { _authProvider?: OAuthClientProvider }
    )._authProvider;

    if (!authProvider) {
      throw new Error(
        "Expected the MCP transport to receive an OAuth provider.",
      );
    }

    await expect(Promise.resolve(authProvider.tokens())).resolves.toMatchObject(
      {
        access_token: "access-token",
        refresh_token: "refresh-token",
        token_type: "Bearer",
        scope: "repo read:user",
      },
    );
    expect(authProvider.clientInformation()).toMatchObject({
      client_id: "client-id",
      client_secret: "client-secret",
      scope: "repo read:user",
    });

    await authProvider.saveClientInformation?.({
      client_id: "registered-client",
      redirect_uris: ["http://127.0.0.1:43110/oauth/callback"],
    });
    await authProvider.saveCodeVerifier("verifier-1");
    const authorizationRequiredError = await Promise.resolve()
      .then(() =>
        authProvider.redirectToAuthorization(
          new URL("https://example.com/oauth/authorize?state=state-1"),
        ),
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(authorizationRequiredError).toBeInstanceOf(
      McpOAuthAuthorizationRequiredError,
    );
    expect(authorizationRequiredError).toMatchObject({
      message:
        "MCP OAuth authorization is required for server `test`. Run `machdoch mcp oauth-authorize test` before reconnecting. If automatic browser callback handling is unavailable, run `machdoch mcp oauth-start test`, then `machdoch mcp oauth-finish test <callback-url-or-code>`.",
      authorizationUrl: "https://example.com/oauth/authorize?state=state-1",
    });
    if (!(authorizationRequiredError instanceof Error)) {
      throw new Error("Expected OAuth authorization to fail.");
    }
    expect(authorizationRequiredError.message).not.toContain(
      "https://example.com/oauth/authorize",
    );
    await authProvider.saveTokens({
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "repo read:user",
    });

    const persistedConfig = JSON.parse(
      await readFile(join(workspaceRoot, ".user-config", "mcp.json"), "utf8"),
    ) as {
      servers: Array<{
        id: string;
        transport?: unknown;
        auth?: Record<string, unknown>;
      }>;
    };
    const persistedServer = persistedConfig.servers.find(
      (entry) => entry.id === "test",
    );

    expect(persistedServer?.transport).toEqual(server.transport);
    expect(persistedServer?.auth).toMatchObject({
      type: "oauth",
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      tokenType: "Bearer",
      tokenScope: "repo read:user",
      expiresIn: 3600,
      clientInformation: {
        client_id: "registered-client",
      },
    });
    expect(persistedServer?.auth).not.toHaveProperty("codeVerifier");
    expect(persistedServer?.auth).not.toHaveProperty("authorizationUrl");
  });

  it("receives loopback callbacks during interactive OAuth authorization", async () => {
    const workspaceRoot = await createWorkspace();
    const port = await getAvailableLoopbackPort();
    const callbackUrl = `http://127.0.0.1:${port}/oauth/callback`;
    const manager = new McpClientManager({
      loadRuntimeEnvironment: async () => ({}),
    });

    await writeWorkspaceOAuthMcpConfig(workspaceRoot, callbackUrl);

    const beginSpy = vi.spyOn(manager, "beginOAuth").mockResolvedValue({
      serverId: "test",
      status: "authorization-required",
      configPath: join(workspaceRoot, ".user-config", "mcp.json"),
      authorizationUrl: "https://example.com/oauth/authorize?state=state-1",
    });
    const finishSpy = vi.spyOn(manager, "finishOAuth").mockResolvedValue({
      serverId: "test",
      status: "authorized",
      configPath: join(workspaceRoot, ".user-config", "mcp.json"),
      stateVerified: true,
    });

    await expect(
      manager.authorizeOAuth(workspaceRoot, "test", {
        callbackTimeoutMs: 1_000,
        openAuthorizationUrl: async (authorizationUrl) => {
          expect(authorizationUrl).toBe(
            "https://example.com/oauth/authorize?state=state-1",
          );

          const rejectedResponse = await fetch(
            `${callbackUrl}?code=wrong&state=state-2`,
          );

          expect(rejectedResponse.status).toBe(400);

          const acceptedResponse = await fetch(
            `${callbackUrl}?code=abc&state=state-1`,
          );

          expect(acceptedResponse.status).toBe(200);
        },
      }),
    ).resolves.toMatchObject({
      serverId: "test",
      status: "authorized",
      stateVerified: true,
    });

    expect(beginSpy).toHaveBeenCalledWith(workspaceRoot, "test", {});
    expect(finishSpy).toHaveBeenCalledWith(
      workspaceRoot,
      "test",
      `${callbackUrl}?code=abc&state=state-1`,
      {},
    );
  });

  it("rejects OAuth error callbacks during interactive authorization", async () => {
    const workspaceRoot = await createWorkspace();
    const port = await getAvailableLoopbackPort();
    const callbackUrl = `http://127.0.0.1:${port}/oauth/callback`;
    const manager = new McpClientManager({
      loadRuntimeEnvironment: async () => ({}),
    });

    await writeWorkspaceOAuthMcpConfig(workspaceRoot, callbackUrl);

    vi.spyOn(manager, "beginOAuth").mockResolvedValue({
      serverId: "test",
      status: "authorization-required",
      configPath: join(workspaceRoot, ".user-config", "mcp.json"),
      authorizationUrl: "https://example.com/oauth/authorize?state=state-1",
    });
    const finishSpy = vi.spyOn(manager, "finishOAuth").mockResolvedValue({
      serverId: "test",
      status: "authorized",
      configPath: join(workspaceRoot, ".user-config", "mcp.json"),
    });

    await expect(
      manager.authorizeOAuth(workspaceRoot, "test", {
        callbackTimeoutMs: 1_000,
        openAuthorizationUrl: async () => {
          const response = await fetch(
            `${callbackUrl}?error=access_denied&error_description=Denied&state=state-1`,
          );

          expect(response.status).toBe(400);
        },
      }),
    ).rejects.toThrow("access_denied: Denied");

    expect(finishSpy).not.toHaveBeenCalled();
  });

  it("reports callback listener port conflicts before opening the browser", async () => {
    const workspaceRoot = await createWorkspace();
    const port = await getAvailableLoopbackPort();
    const callbackUrl = `http://127.0.0.1:${port}/oauth/callback`;
    const occupyingServer = createHttpServer();
    const manager = new McpClientManager({
      loadRuntimeEnvironment: async () => ({}),
    });

    await new Promise<void>((resolve, reject) => {
      occupyingServer.once("error", reject);
      occupyingServer.listen(port, "127.0.0.1", () => {
        occupyingServer.off("error", reject);
        resolve();
      });
    });

    await writeWorkspaceOAuthMcpConfig(workspaceRoot, callbackUrl);

    vi.spyOn(manager, "beginOAuth").mockResolvedValue({
      serverId: "test",
      status: "authorization-required",
      configPath: join(workspaceRoot, ".user-config", "mcp.json"),
      authorizationUrl: "https://example.com/oauth/authorize?state=state-1",
    });
    const openAuthorizationUrl = vi.fn(async () => undefined);

    try {
      const authorizationError = await manager
        .authorizeOAuth(workspaceRoot, "test", {
          callbackTimeoutMs: 1_000,
          openAuthorizationUrl,
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(authorizationError).toBeInstanceOf(Error);
      expect(authorizationError).toMatchObject({
        message: expect.stringContaining("already in use"),
      });
      expect(authorizationError).toMatchObject({
        message: expect.stringContaining(
          "Retry `machdoch mcp oauth-authorize test`",
        ),
      });
      expect(authorizationError).toMatchObject({
        message: expect.stringContaining(
          "run `machdoch mcp oauth-start test`, then `machdoch mcp oauth-finish test <callback-url-or-code>`",
        ),
      });
      expect(openAuthorizationUrl).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => {
        occupyingServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  });

  it("does not replay a direct tool call based on remote error prose", async () => {
    const workspaceRoot = await createWorkspace();
    const task = {
      taskId: "task-1",
      status: "working" as const,
      createdAt: "2026-06-13T00:00:00.000Z",
      lastUpdatedAt: "2026-06-13T00:00:00.000Z",
      ttl: null,
    };
    const remoteError = new Error(
      'Tool "long_search" requires task-based execution. Use client.experimental.tasks.callToolStream() instead.',
    );
    const callTool = vi.fn(async () => {
      throw remoteError;
    });
    const callToolStream = vi.fn(async function* () {
      yield {
        type: "taskCreated" as const,
        task,
      };
      yield {
        type: "taskStatus" as const,
        task: {
          ...task,
          status: "completed" as const,
          statusMessage: "done",
        },
      };
      yield {
        type: "result" as const,
        result: {
          content: [{ type: "text" as const, text: "streamed result" }],
        },
      };
    });
    const manager = new McpClientManager({
      createClient: () =>
        createClient({
          callTool,
          experimental: {
            tasks: {
              callToolStream,
            },
          },
        } as unknown as Partial<Client>),
      createTransport,
      loadRuntimeEnvironment: async () => ({}),
    });

    await writeWorkspaceMcpConfig(workspaceRoot);
    await saveWorkspaceMcpDiscovery(workspaceRoot, {
      serverId: "test",
      discoveredAt: "2026-06-13T00:00:00.000Z",
      transportType: "stdio",
      tools: [
        {
          name: "long_search",
          inputSchema: {
            type: "object",
            required: ["query"],
            properties: { query: { type: "string" } },
            additionalProperties: false,
          },
          taskSupport: "optional",
        },
      ],
      resources: [],
      resourceTemplates: [],
      prompts: [],
    });

    await expect(
      manager.callTool(workspaceRoot, "test", "long_search", { query: "mcp" }),
    ).rejects.toBe(remoteError);

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callToolStream).not.toHaveBeenCalled();
  });

  it("uses cached task metadata to stream required task tools immediately", async () => {
    const workspaceRoot = await createWorkspace();
    const callTool = vi.fn(async () => ({
      content: [{ type: "text", text: "unexpected" }],
    }));
    const callToolStream = vi.fn(async function* () {
      yield {
        type: "result" as const,
        result: {
          content: [{ type: "text" as const, text: "cached task path" }],
        },
      };
    });
    const manager = new McpClientManager({
      createClient: () =>
        createClient({
          callTool,
          experimental: {
            tasks: {
              callToolStream,
            },
          },
        } as unknown as Partial<Client>),
      createTransport,
      loadRuntimeEnvironment: async () => ({}),
    });

    await writeWorkspaceMcpConfig(workspaceRoot);
    await saveWorkspaceMcpDiscovery(workspaceRoot, {
      serverId: "test",
      discoveredAt: "2026-06-13T00:00:00.000Z",
      transportType: "stdio",
      capabilities: {
        tools: {},
        tasks: {
          requests: {
            tools: {
              call: {},
            },
          },
        },
      },
      tools: [
        {
          name: "long_search",
          inputSchema: {
            type: "object",
            additionalProperties: true,
          },
          taskSupport: "required",
        },
      ],
      resources: [],
      resourceTemplates: [],
      prompts: [],
    });

    await expect(
      manager.callTool(workspaceRoot, "test", "long_search", { query: "mcp" }),
    ).resolves.toMatchObject({
      content: [{ text: "cached task path" }],
    });

    expect(callTool).not.toHaveBeenCalled();
    expect(callToolStream).toHaveBeenCalledTimes(1);
  });

  it("blocks malformed tool arguments against authoritative discovery metadata", async () => {
    const workspaceRoot = await createWorkspace();
    const callTool = vi.fn(async () => ({ content: [] }));
    const manager = new McpClientManager({
      createClient: () => createClient({ callTool } as Partial<Client>),
      createTransport,
      loadRuntimeEnvironment: async () => ({}),
    });

    await writeWorkspaceMcpConfig(workspaceRoot);
    await saveWorkspaceMcpDiscovery(workspaceRoot, {
      serverId: "test",
      discoveredAt: "2026-06-13T00:00:00.000Z",
      transportType: "stdio",
      tools: [
        {
          name: "get_issue",
          inputSchema: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string", minLength: 1 } },
            additionalProperties: false,
          },
        },
      ],
      resources: [],
      resourceTemplates: [],
      prompts: [],
    });

    await expect(
      manager.callTool(workspaceRoot, "test", "get_issue", {
        quotedTask: "get CLOUD-999",
      }),
    ).rejects.toThrow("do not match the discovered input schema");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("uses a proxy-resolved server snapshot instead of reloading workspace overrides", async () => {
    const workspaceRoot = await createWorkspace();
    await writeWorkspaceMcpConfig(workspaceRoot);
    const callTool = vi.fn(async () => ({
      content: [{ type: "text", text: "user-scoped result" }],
    }));
    const observedCommands: string[] = [];
    const manager = new McpClientManager({
      createClient: () => createClient({ callTool } as Partial<Client>),
      createTransport: (context) => {
        if (context.server.transport.type === "stdio") {
          observedCommands.push(context.server.transport.command);
        }
        return createTransport();
      },
      loadRuntimeEnvironment: async () => ({}),
    });
    const effectiveServer = createServer({
      transport: { type: "stdio", command: "user-scoped-command" },
      sources: ["user"],
    });

    await expect(
      manager.callTool(
        workspaceRoot,
        "test",
        "search",
        { query: "mcp" },
        {
          effectiveServer,
          authoritativeDiscovery: {
            serverId: "test",
            discoveredAt: new Date(0).toISOString(),
            transportType: "stdio",
            tools: [
              {
                name: "search",
                inputSchema: {
                  type: "object",
                  properties: { query: { type: "string" } },
                  required: ["query"],
                },
              },
            ],
            resources: [],
            resourceTemplates: [],
            prompts: [],
          },
        },
      ),
    ).resolves.toMatchObject({
      content: [{ text: "user-scoped result" }],
    });
    expect(observedCommands).toEqual(["user-scoped-command"]);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("delegates task listing to the SDK task client", async () => {
    const workspaceRoot = await createWorkspace();
    const listTasks = vi.fn(async () => ({
      tasks: [
        {
          taskId: "task-1",
          status: "working" as const,
          createdAt: "2026-06-13T00:00:00.000Z",
          lastUpdatedAt: "2026-06-13T00:00:00.000Z",
          ttl: null,
        },
      ],
      nextCursor: "next",
    }));
    const manager = new McpClientManager({
      createClient: () =>
        createClient({
          experimental: {
            tasks: {
              listTasks,
            },
          },
        } as unknown as Partial<Client>),
      createTransport,
      loadRuntimeEnvironment: async () => ({}),
    });

    await writeWorkspaceMcpConfig(workspaceRoot);

    await expect(
      manager.listTasks(workspaceRoot, "test", "cursor-1"),
    ).resolves.toMatchObject({
      tasks: [{ taskId: "task-1" }],
      nextCursor: "next",
    });
    expect(listTasks).toHaveBeenCalledWith(
      "cursor-1",
      expect.objectContaining({
        timeout: 60_000,
        maxTotalTimeout: 300_000,
      }),
    );
  });

  it("caches read-only tool calls within one run scope", async () => {
    const workspaceRoot = await createWorkspace();
    const callTool = vi.fn(async () => ({
      content: [{ type: "text", text: "cached result" }],
    }));
    const manager = new McpClientManager({
      createClient: () =>
        createClient({
          callTool,
        } as Partial<Client>),
      createTransport,
      loadRuntimeEnvironment: async () => ({}),
    });

    await writeWorkspaceMcpConfig(workspaceRoot);
    await saveWorkspaceMcpDiscovery(workspaceRoot, {
      serverId: "test",
      discoveredAt: "2026-06-13T00:00:00.000Z",
      transportType: "stdio",
      tools: [
        {
          name: "search",
          inputSchema: {
            type: "object",
            required: ["q"],
            properties: { q: { type: "string" } },
            additionalProperties: false,
          },
        },
      ],
      resources: [],
      resourceTemplates: [],
      prompts: [],
    });

    const options = {
      cache: {
        runId: "run-1",
        operation: "tool" as const,
        readOnly: true,
      },
    };

    await expect(
      manager.callTool(workspaceRoot, "test", "search", { q: "mcp" }, options),
    ).resolves.toMatchObject({
      content: [{ text: "cached result" }],
    });
    await manager.callTool(
      workspaceRoot,
      "test",
      "search",
      { q: "mcp" },
      options,
    );

    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("does not cache side-effecting tool calls", async () => {
    const workspaceRoot = await createWorkspace();
    const callTool = vi.fn(async () => ({
      content: [{ type: "text", text: "created" }],
    }));
    const manager = new McpClientManager({
      createClient: () =>
        createClient({
          callTool,
        } as Partial<Client>),
      createTransport,
      loadRuntimeEnvironment: async () => ({}),
    });

    await writeWorkspaceMcpConfig(workspaceRoot);
    await saveWorkspaceMcpDiscovery(workspaceRoot, {
      serverId: "test",
      discoveredAt: "2026-06-13T00:00:00.000Z",
      transportType: "stdio",
      tools: [
        {
          name: "create_issue",
          inputSchema: {
            type: "object",
            additionalProperties: false,
          },
        },
      ],
      resources: [],
      resourceTemplates: [],
      prompts: [],
    });

    const options = {
      cache: {
        runId: "run-1",
        operation: "tool" as const,
        readOnly: false,
      },
    };

    await manager.callTool(workspaceRoot, "test", "create_issue", {}, options);
    await manager.callTool(workspaceRoot, "test", "create_issue", {}, options);

    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it("caches resource reads using the effective server cache policy", async () => {
    const workspaceRoot = await createWorkspace();
    const readResource = vi.fn(async () => ({
      contents: [{ uri: "repo://readme", text: "README" }],
    }));
    const manager = new McpClientManager({
      createClient: () =>
        createClient({
          readResource,
        } as Partial<Client>),
      createTransport,
      loadRuntimeEnvironment: async () => ({}),
    });

    await writeWorkspaceMcpConfig(workspaceRoot, {
      enabled: true,
      ttlSeconds: 60,
    });

    const options = {
      cache: {
        runId: "run-1",
        operation: "resource" as const,
      },
    };

    await manager.readResource(workspaceRoot, "test", "repo://readme", options);
    await manager.readResource(workspaceRoot, "test", "repo://readme", options);

    expect(readResource).toHaveBeenCalledTimes(1);
  });
});

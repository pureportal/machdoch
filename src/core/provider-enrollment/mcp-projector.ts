import type { AgentCliProvider } from "../runtime-contract.generated.js";
import {
  listEnabledMcpServers,
  loadMcpConfig,
  loadMcpDiscoveryCacheSync,
} from "../mcp/config.js";
import type {
  McpEffectiveServerConfig,
  McpServerDiscovery,
} from "../mcp/types.js";
import { PROVIDER_CAPABILITY_REGISTRY } from "./capability-registry.js";
import { digestJson } from "./digests.js";
import type {
  McpProjectedServer,
  McpProjection,
} from "./types.js";

interface McpProjectionOptions {
  persistent?: boolean;
  scope?: "user" | "workspace";
  machdochCommand?: string;
  compatibilityServerName?: string;
}

const getCapabilities = (discovery: McpServerDiscovery | undefined): string[] => {
  const capabilities: string[] = [];
  if ((discovery?.tools.length ?? 0) > 0) capabilities.push("tools");
  if ((discovery?.resources.length ?? 0) > 0 || (discovery?.resourceTemplates.length ?? 0) > 0) {
    capabilities.push("resources");
  }
  if ((discovery?.prompts.length ?? 0) > 0) capabilities.push("prompts");
  if (discovery?.instructions) capabilities.push("initialization-instructions");
  if (discovery?.capabilities && "tasks" in discovery.capabilities) capabilities.push("tasks");
  return capabilities.length > 0 ? capabilities : ["unknown-until-connect"];
};

const hasResolvedSecretMaterial = (server: McpEffectiveServerConfig): boolean => {
  if (server.auth?.type === "oauth") return true;
  if (server.auth?.type === "bearer" && server.auth.token) return true;
  if (
    server.auth?.type === "headers" &&
    Object.keys(server.auth.headers ?? {}).length > 0
  ) {
    return true;
  }
  if (server.transport.type === "stdio" && server.transport.env) {
    return Object.values(server.transport.env).some(
      (value) => !/^\$\{env:[A-Za-z_][A-Za-z0-9_]*\}$/u.test(value),
    );
  }
  if (server.transport.type !== "stdio" && server.transport.headers) {
    return Object.keys(server.transport.headers).length > 0;
  }
  return false;
};

const shouldProxyServer = (
  provider: AgentCliProvider,
  server: McpEffectiveServerConfig,
  discovery: McpServerDiscovery | undefined,
  projectedId: string,
): string | undefined => {
  const profile = PROVIDER_CAPABILITY_REGISTRY[provider];
  if (!(profile.supportedMcpTransports as readonly string[]).includes(server.transport.type)) {
    return `${provider} cannot directly represent ${server.transport.type}.`;
  }
  if (hasResolvedSecretMaterial(server)) {
    return "Provider enrollment files must not contain resolved secret material.";
  }
  if (server.sampling !== "disabled") {
    return "Provider-native configuration cannot preserve Machdoch sampling policy.";
  }
  if (Array.isArray(server.roots)) {
    return "Provider-native configuration cannot preserve explicit Machdoch roots.";
  }
  const directToolExposure = server.exposure?.directTools;
  if (
    (typeof directToolExposure === "object" && directToolExposure !== null && (
      (directToolExposure.include?.length ?? 0) > 0 ||
      (directToolExposure.exclude?.length ?? 0) > 0 ||
      Boolean(directToolExposure.namespacePrefix)
    )) ||
    server.toolOverrides
  ) {
    return "Provider-native configuration cannot preserve Machdoch tool exposure overrides.";
  }
  if (
    provider === "copilot-cli" &&
    discovery?.tools.some((tool) => `${projectedId}__${tool.name}`.length > 64)
  ) {
    return "Copilot's combined MCP server/tool name limit requires stable proxy names.";
  }
  return undefined;
};

const createProjectedServerId = (
  provider: AgentCliProvider,
  serverId: string,
  persistent: boolean,
): string => {
  if (!persistent && provider !== "copilot-cli") return serverId;
  const slug = serverId
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 4) || "srv";
  return `machdoch-${slug}-${digestJson(serverId).slice(0, 8)}`;
};

const resolveTemplateForProvider = (value: string): string => {
  return value.replace(
    /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/u,
    "${$1}",
  );
};

const mapEnvironment = (
  values: Record<string, string> | undefined,
): Record<string, string> | undefined => {
  if (!values) return undefined;
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      resolveTemplateForProvider(value),
    ]),
  );
};

const getHttpHeaders = (
  server: McpEffectiveServerConfig,
): Record<string, string> | undefined => {
  if (server.transport.type === "stdio") return undefined;
  const headers = { ...(server.transport.headers ?? {}) };
  const auth = server.auth;
  if (auth?.type === "bearer") {
    const token = auth.tokenEnv ? `\${${auth.tokenEnv}}` : auth.token;
    if (token) headers[auth.headerName ?? "Authorization"] = `Bearer ${token}`;
  } else if (auth?.type === "headers") {
    Object.assign(headers, auth.headers ?? {});
    for (const [header, envKey] of Object.entries(auth.envHeaders ?? {})) {
      headers[header] = `\${${envKey}}`;
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
};

const toCodexConfig = (server: McpEffectiveServerConfig): Record<string, unknown> => {
  if (server.transport.type === "stdio") {
    return {
      command: server.transport.command,
      ...(server.transport.args ? { args: server.transport.args } : {}),
      ...(server.transport.cwd ? { cwd: server.transport.cwd } : {}),
      ...(server.transport.env ? { env: mapEnvironment(server.transport.env) } : {}),
      startup_timeout_sec: Math.ceil(server.timeoutMs / 1_000),
      tool_timeout_sec: Math.ceil(server.maxTotalTimeoutMs / 1_000),
    };
  }
  return {
    url: server.transport.url,
    ...(getHttpHeaders(server) ? { http_headers: getHttpHeaders(server) } : {}),
  };
};

const toClaudeConfig = (server: McpEffectiveServerConfig): Record<string, unknown> => {
  if (server.transport.type === "stdio") {
    return {
      type: "stdio",
      command: server.transport.command,
      ...(server.transport.args ? { args: server.transport.args } : {}),
      ...(server.transport.cwd ? { cwd: server.transport.cwd } : {}),
      ...(server.transport.env ? { env: mapEnvironment(server.transport.env) } : {}),
    };
  }
  return {
    type: server.transport.type === "sse" ? "sse" : "http",
    url: server.transport.url,
    ...(getHttpHeaders(server) ? { headers: getHttpHeaders(server) } : {}),
  };
};

const toCopilotConfig = (server: McpEffectiveServerConfig): Record<string, unknown> => {
  if (server.transport.type === "stdio") {
    return {
      type: "local",
      command: server.transport.command,
      ...(server.transport.args ? { args: server.transport.args } : {}),
      ...(server.transport.cwd ? { cwd: server.transport.cwd } : {}),
      ...(server.transport.env ? { env: mapEnvironment(server.transport.env) } : {}),
      tools: ["*"],
    };
  }
  return {
    type: server.transport.type === "sse" ? "sse" : "http",
    url: server.transport.url,
    ...(getHttpHeaders(server) ? { headers: getHttpHeaders(server) } : {}),
    tools: ["*"],
  };
};

const mapNativeServer = (
  provider: AgentCliProvider,
  server: McpEffectiveServerConfig,
): Record<string, unknown> => {
  switch (provider) {
    case "codex-cli":
      return toCodexConfig(server);
    case "claude-cli":
      return toClaudeConfig(server);
    case "copilot-cli":
      return toCopilotConfig(server);
  }
};

const createProxyConfig = (
  provider: AgentCliProvider,
  serverId: string,
  workspaceRoot: string,
  machdochCommand: string,
): Record<string, unknown> => {
  const proxyServer: McpEffectiveServerConfig = {
    id: `machdoch-${serverId}`,
    enabled: true,
    transport: {
      type: "stdio",
      command: machdochCommand,
      args: ["mcp", "proxy", serverId, "--cwd", workspaceRoot],
    },
    securityProfile: "weak",
    timeoutMs: 60_000,
    maxTotalTimeoutMs: 300_000,
    idleShutdownMs: 900_000,
    maxResponseChars: 60_000,
    cache: { enabled: false, ttlMs: 0, forceRefresh: false },
    roots: "workspace",
    sampling: "disabled",
    tasks: "optional",
    sources: ["override"],
  };
  return mapNativeServer(provider, proxyServer);
};

const createProviderConfig = (
  servers: readonly McpProjectedServer[],
): Record<string, unknown> => ({
  mcpServers: Object.fromEntries(
    servers.map((server) => [server.id, server.providerConfig]),
  ),
});

export const projectMcpForProvider = async (
  provider: AgentCliProvider,
  workspaceRoot: string,
  options: McpProjectionOptions = {},
): Promise<McpProjection> => {
  const effectiveConfig = await loadMcpConfig(workspaceRoot);
  const discovery = loadMcpDiscoveryCacheSync(workspaceRoot).servers;
  const enabledServers = listEnabledMcpServers(effectiveConfig).filter((server) => {
    if (!options.scope) return true;
    const isWorkspaceServer = server.sources.includes("workspace");
    return options.scope === "workspace" ? isWorkspaceServer : !isWorkspaceServer;
  });
  const projectedServers: McpProjectedServer[] = [];
  const warnings: string[] = [];
  const machdochCommand = options.machdochCommand ?? process.env.MACHDOCH_CLI_PATH ?? "machdoch";

  for (const server of enabledServers) {
    const projectedId = createProjectedServerId(
      provider,
      server.id,
      options.persistent === true,
    );
    const proxyReason = shouldProxyServer(
      provider,
      server,
      discovery[server.id],
      projectedId,
    );
    const capabilities = getCapabilities(discovery[server.id]);
    const serverDigest = digestJson({
      server,
      discovery: discovery[server.id],
    });

    if (proxyReason) {
      warnings.push(`${server.id}: ${proxyReason} Using the per-server stdio proxy.`);
      projectedServers.push({
        id: projectedId,
        canonicalId: server.id,
        digest: serverDigest,
        route: "cli-stdio-proxy",
        providerConfig: createProxyConfig(
          provider,
          server.id,
          workspaceRoot,
          machdochCommand,
        ),
        capabilities,
        warnings: [proxyReason],
      });
      continue;
    }

    projectedServers.push({
      id: projectedId,
      canonicalId: server.id,
      digest: serverDigest,
      route: "cli-native-mcp",
      providerConfig: mapNativeServer(provider, server),
      capabilities,
      warnings: [],
    });
  }

  const config = createProviderConfig(projectedServers);
  return {
    provider,
    effectiveConfigDigest: digestJson({
      defaults: effectiveConfig.defaults,
      servers: enabledServers,
    }),
    catalogDigest: digestJson(
      projectedServers.map((server) => ({
        id: server.canonicalId,
        digest: server.digest,
        capabilities: server.capabilities,
      })),
    ),
    servers: projectedServers,
    config,
    warnings,
  };
};

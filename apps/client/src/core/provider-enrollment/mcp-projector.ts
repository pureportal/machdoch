import type { AgentCliProvider } from "../runtime-contract.generated.js";
import { loadRuntimeEnvironment } from "../env.js";
import {
  listEnabledMcpServers,
  loadMcpConfig,
  loadMcpDiscoveryCacheSync,
  loadUserMcpConfig,
  loadUserMcpDiscoveryCacheSync,
} from "../mcp/config.js";
import { isMcpOAuthLoopbackRedirectUrl } from "../mcp/oauth-loopback.js";
import { getMcpOAuthRecoveryCommands } from "../mcp/oauth-recovery.js";
import type {
  McpEffectiveServerConfig,
  McpServerDiscovery,
} from "../mcp/types.js";
import { PROVIDER_CAPABILITY_REGISTRY } from "./capability-registry.js";
import { digestJson } from "./digests.js";
import {
  assertMachdochCliLaunch,
  resolveMachdochCliLaunch,
  type MachdochCliLaunch,
} from "./machdoch-cli-launch.js";
import { isMcpToolEnabledForProjection } from "./mcp-tool-exposure.js";
import type {
  McpProjectedServer,
  McpProjection,
  McpUncoveredServer,
} from "./types.js";

export interface McpProjectionOptions {
  persistent?: boolean;
  scope?: "user" | "workspace";
  machdochCliLaunch?: MachdochCliLaunch;
  workspacePresence?: {
    address: string;
    token: string;
    agentId: string;
  };
}

const ENVIRONMENT_TEMPLATE_PATTERN = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/gu;
const HAS_ENVIRONMENT_TEMPLATE_PATTERN = /\$\{env:[A-Za-z_][A-Za-z0-9_]*\}/u;

const getCapabilities = (
  discovery: McpServerDiscovery | undefined,
  server: McpEffectiveServerConfig,
): string[] => {
  const capabilities: string[] = [];
  if (
    discovery?.tools.some((tool) =>
      isMcpToolEnabledForProjection(server, tool.name),
    )
  ) {
    capabilities.push("tools");
  }
  if (
    (discovery?.resources.length ?? 0) > 0 ||
    (discovery?.resourceTemplates.length ?? 0) > 0
  ) {
    capabilities.push("resources");
  }
  if ((discovery?.prompts.length ?? 0) > 0) capabilities.push("prompts");
  if (discovery?.instructions) capabilities.push("initialization-instructions");
  if (
    server.tasks !== "disabled" &&
    discovery?.capabilities &&
    "tasks" in discovery.capabilities
  )
    capabilities.push("tasks");
  return capabilities.length > 0 ? capabilities : ["unknown-until-connect"];
};

const hasEnvironmentTemplate = (value: string): boolean => {
  return HAS_ENVIRONMENT_TEMPLATE_PATTERN.test(value);
};

const transportHasTemplates = (server: McpEffectiveServerConfig): boolean => {
  const transport = server.transport;
  const values =
    transport.type === "stdio"
      ? [
          transport.command,
          ...(transport.args ?? []),
          ...(transport.cwd ? [transport.cwd] : []),
          ...Object.values(transport.env ?? {}),
        ]
      : [transport.url, ...Object.values(transport.headers ?? {})];
  return values.some(
    (value) =>
      hasEnvironmentTemplate(value) || value.includes("${workspaceRoot}"),
  );
};

const shouldProxyServer = (
  provider: AgentCliProvider,
  server: McpEffectiveServerConfig,
  discovery: McpServerDiscovery | undefined,
  projectedId: string,
): string | undefined => {
  const profile = PROVIDER_CAPABILITY_REGISTRY[provider];
  if (
    !(profile.supportedMcpTransports as readonly string[]).includes(
      server.transport.type,
    )
  ) {
    return `${provider} cannot directly represent ${server.transport.type}.`;
  }
  if (server.auth && server.auth.type !== "none") {
    return "Provider enrollment files must not contain resolved secret material.";
  }
  if (
    server.transport.type === "stdio" &&
    (Object.keys(server.transport.env ?? {}).length > 0 ||
      server.transport.inheritEnvironment === true ||
      server.transport.stderr !== undefined)
  ) {
    return "Provider-native configuration cannot preserve the MCP server environment and stdio policy.";
  }
  if (
    server.transport.type !== "stdio" &&
    Object.keys(server.transport.headers ?? {}).length > 0
  ) {
    return "Provider enrollment files must not contain resolved HTTP header material.";
  }
  if (
    server.transport.type === "streamable-http" &&
    (server.transport.sessionId !== undefined ||
      server.transport.legacySseFallback !== undefined)
  ) {
    return "Provider-native configuration cannot preserve the streamable HTTP session policy.";
  }
  if (transportHasTemplates(server)) {
    return "Provider-native configuration cannot resolve Machdoch MCP templates consistently.";
  }
  if (server.sampling !== "disabled") {
    return "Provider-native configuration cannot preserve Machdoch sampling policy.";
  }
  if (server.roots !== "workspace") {
    return "Provider-native configuration cannot preserve the Machdoch roots policy.";
  }
  const directToolExposure = server.exposure?.directTools;
  const directToolsEnabled =
    typeof directToolExposure === "boolean"
      ? directToolExposure
      : directToolExposure?.enabled !== false;
  if (!directToolsEnabled || server.exposure?.mode === "meta-tools") {
    return "Provider-native configuration cannot preserve disabled direct MCP tool exposure.";
  }
  if (
    (typeof directToolExposure === "object" &&
      directToolExposure !== null &&
      ((directToolExposure.include?.length ?? 0) > 0 ||
        (directToolExposure.exclude?.length ?? 0) > 0 ||
        Boolean(directToolExposure.namespacePrefix))) ||
    Object.keys(server.toolOverrides ?? {}).length > 0
  ) {
    return "Provider-native configuration cannot preserve Machdoch tool exposure overrides.";
  }
  if (server.tasks === "disabled") {
    return "Provider-native configuration cannot preserve disabled MCP task exposure.";
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
  const slug =
    serverId
      .toLocaleLowerCase("en-US")
      .replace(/[^a-z0-9_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 4) || "srv";
  return `machdoch-${slug}-${digestJson(serverId).slice(0, 8)}`;
};

const toCodexConfig = (
  server: McpEffectiveServerConfig,
): Record<string, unknown> => {
  if (server.transport.type === "stdio") {
    return {
      command: server.transport.command,
      ...(server.transport.args ? { args: server.transport.args } : {}),
      ...(server.transport.cwd ? { cwd: server.transport.cwd } : {}),
      ...(server.transport.env ? { env: server.transport.env } : {}),
      startup_timeout_sec: Math.ceil(server.timeoutMs / 1_000),
      tool_timeout_sec: Math.ceil(server.maxTotalTimeoutMs / 1_000),
    };
  }
  return {
    url: server.transport.url,
    startup_timeout_sec: Math.ceil(server.timeoutMs / 1_000),
    tool_timeout_sec: Math.ceil(server.maxTotalTimeoutMs / 1_000),
  };
};

const toClaudeConfig = (
  server: McpEffectiveServerConfig,
): Record<string, unknown> => {
  if (server.transport.type === "stdio") {
    return {
      type: "stdio",
      command: server.transport.command,
      ...(server.transport.args ? { args: server.transport.args } : {}),
      ...(server.transport.cwd ? { cwd: server.transport.cwd } : {}),
      ...(server.transport.env ? { env: server.transport.env } : {}),
    };
  }
  return {
    type: server.transport.type === "sse" ? "sse" : "http",
    url: server.transport.url,
  };
};

const toCopilotConfig = (
  server: McpEffectiveServerConfig,
): Record<string, unknown> => {
  if (server.transport.type === "stdio") {
    return {
      type: "local",
      command: server.transport.command,
      ...(server.transport.args ? { args: server.transport.args } : {}),
      ...(server.transport.cwd ? { cwd: server.transport.cwd } : {}),
      ...(server.transport.env ? { env: server.transport.env } : {}),
      tools: ["*"],
      timeout: server.timeoutMs,
    };
  }
  return {
    type: server.transport.type === "sse" ? "sse" : "http",
    url: server.transport.url,
    tools: ["*"],
    timeout: server.timeoutMs,
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
  server: McpEffectiveServerConfig,
  workspaceRoot: string,
  launch: MachdochCliLaunch,
  scope: McpProjectionOptions["scope"],
  environmentKeys: readonly string[],
): Record<string, unknown> => {
  const proxyServer: McpEffectiveServerConfig = {
    id: `machdoch-${server.id}`,
    enabled: true,
    transport: {
      type: "stdio",
      command: launch.command,
      args: [
        ...launch.args,
        "mcp",
        "proxy",
        server.id,
        ...(scope === "user" ? ["--scope", "user"] : ["--cwd", workspaceRoot]),
      ],
      ...(scope === "user" ? {} : { cwd: launch.cwd }),
      ...(Object.keys(launch.environment).length > 0
        ? { env: launch.environment }
        : {}),
    },
    securityProfile: "weak",
    timeoutMs: server.timeoutMs,
    maxTotalTimeoutMs: server.maxTotalTimeoutMs,
    idleShutdownMs: 900_000,
    maxResponseChars: 60_000,
    cache: { enabled: false, ttlMs: 0, forceRefresh: false },
    roots: "workspace",
    sampling: "disabled",
    tasks: "optional",
    sources: ["override"],
  };
  const providerConfig = mapNativeServer(provider, proxyServer);
  return {
    ...providerConfig,
    ...(provider === "copilot-cli"
      ? { timeout: server.maxTotalTimeoutMs }
      : {}),
    ...(provider === "codex-cli" && environmentKeys.length > 0
      ? { env_vars: environmentKeys }
      : {}),
  };
};

const createWorkspacePresenceProjection = (
  provider: AgentCliProvider,
  workspaceRoot: string,
  launch: MachdochCliLaunch,
  presence: NonNullable<McpProjectionOptions["workspacePresence"]>,
): McpProjectedServer => {
  const canonicalId = "machdoch-workspace-presence";
  const server: McpEffectiveServerConfig = {
    id: canonicalId,
    enabled: true,
    transport: {
      type: "stdio",
      command: launch.command,
      args: [...launch.args, "mcp", "presence", "--cwd", workspaceRoot],
      cwd: launch.cwd,
      env: {
        ...launch.environment,
        MACHDOCH_RUN_CONTROL_ADDRESS: presence.address,
        MACHDOCH_WORKSPACE_PRESENCE_TOKEN: presence.token,
        MACHDOCH_WORKSPACE_AGENT_ID: presence.agentId,
      },
    },
    securityProfile: "weak",
    timeoutMs: 5_000,
    maxTotalTimeoutMs: 5_000,
    idleShutdownMs: 900_000,
    maxResponseChars: 60_000,
    cache: { enabled: false, ttlMs: 0, forceRefresh: false },
    roots: "workspace",
    sampling: "disabled",
    tasks: "disabled",
    sources: ["override"],
  };
  return {
    id: createProjectedServerId(provider, canonicalId, false),
    canonicalId,
    digest: digestJson({ canonicalId, workspaceRoot }),
    route: "cli-native-mcp",
    providerConfig: mapNativeServer(provider, server),
    capabilities: ["tools"],
    warnings: [],
  };
};

const collectEnvironmentTemplateKeys = (
  value: unknown,
  keys: Set<string>,
): void => {
  if (typeof value === "string") {
    for (const match of value.matchAll(ENVIRONMENT_TEMPLATE_PATTERN)) {
      const key = match[1];
      if (key) keys.add(key);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectEnvironmentTemplateKeys(entry, keys);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) {
      collectEnvironmentTemplateKeys(entry, keys);
    }
  }
};

interface ServerEnvironmentReferences {
  required: Set<string>;
  optional: Set<string>;
}

const getServerEnvironmentReferences = (
  server: McpEffectiveServerConfig,
): ServerEnvironmentReferences => {
  const required = new Set<string>();
  const optional = new Set<string>();
  collectEnvironmentTemplateKeys(server.transport, required);
  collectEnvironmentTemplateKeys(server.auth, required);
  const auth = server.auth;
  if (auth?.type === "bearer" && !auth.token && auth.tokenEnv) {
    optional.add(auth.tokenEnv);
  }
  if (auth?.type === "headers") {
    for (const key of Object.values(auth.envHeaders ?? {})) {
      optional.add(key);
    }
  }
  if (auth?.type === "oauth") {
    for (const key of [
      auth.clientSecret ? undefined : auth.clientSecretEnv,
      auth.accessToken ? undefined : auth.accessTokenEnv,
      auth.refreshToken ? undefined : auth.refreshTokenEnv,
    ]) {
      if (key) optional.add(key);
    }
  }
  for (const key of required) optional.delete(key);
  return { required, optional };
};

const getEnvironmentValue = (
  environment: Record<string, string>,
  key: string,
): string | undefined => {
  const direct = environment[key];
  if (direct !== undefined || process.platform !== "win32") return direct;
  const canonicalKey = key.toLocaleUpperCase("en-US");
  return Object.entries(environment).find(
    ([candidate]) => candidate.toLocaleUpperCase("en-US") === canonicalKey,
  )?.[1];
};

const resolveProjectionEnvironment = async (
  servers: readonly McpEffectiveServerConfig[],
): Promise<Record<string, string>> => {
  const requiredKeys = new Set<string>();
  const optionalKeys = new Set<string>();
  let inheritEnvironment = false;
  for (const server of servers) {
    const references = getServerEnvironmentReferences(server);
    for (const key of references.required) requiredKeys.add(key);
    for (const key of references.optional) optionalKeys.add(key);
    inheritEnvironment ||=
      server.transport.type === "stdio" &&
      server.transport.inheritEnvironment === true;
  }
  for (const key of requiredKeys) optionalKeys.delete(key);
  if (
    !inheritEnvironment &&
    requiredKeys.size === 0 &&
    optionalKeys.size === 0
  ) {
    return {};
  }
  const runtimeEnvironment = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    ...(await loadRuntimeEnvironment()),
  };
  if (inheritEnvironment) return runtimeEnvironment;

  const environment: Record<string, string> = {};
  for (const key of requiredKeys) {
    const value = getEnvironmentValue(runtimeEnvironment, key);
    if (value === undefined || value.trim().length === 0) {
      throw new Error(
        `Central MCP configuration requires environment variable ${key}, but it is unavailable for CLI-provider enrollment.`,
      );
    }
    environment[key] = value;
  }
  for (const key of optionalKeys) {
    const value = getEnvironmentValue(runtimeEnvironment, key);
    if (value !== undefined && value.trim().length > 0) {
      environment[key] = value;
    }
  }
  return environment;
};

const getProxyEnvironmentKeys = (
  server: McpEffectiveServerConfig,
  environment: Record<string, string>,
): string[] => {
  if (
    server.transport.type === "stdio" &&
    server.transport.inheritEnvironment === true
  ) {
    return Object.keys(environment).sort();
  }
  const references = getServerEnvironmentReferences(server);
  return [...references.required, ...references.optional]
    .filter((key) => getEnvironmentValue(environment, key) !== undefined)
    .sort();
};

const getCopilotOAuthProxyBlock = (
  provider: AgentCliProvider,
  server: McpEffectiveServerConfig,
  environment: Record<string, string>,
  workspaceRoot: string,
  scope: McpProjectionOptions["scope"],
): string | undefined => {
  if (
    provider !== "copilot-cli" ||
    server.auth?.type !== "oauth" ||
    !server.auth.redirectUrl
  ) {
    return undefined;
  }
  const accessToken =
    server.auth.accessToken ??
    (server.auth.accessTokenEnv
      ? getEnvironmentValue(environment, server.auth.accessTokenEnv)
      : undefined);
  if (accessToken?.trim()) return undefined;

  const recoveryScope =
    scope ?? (server.sources.includes("workspace") ? "workspace" : "user");
  const commands = getMcpOAuthRecoveryCommands(server.id, {
    ...(recoveryScope === "user"
      ? { scope: "user" as const }
      : { workspaceRoot }),
  });
  return isMcpOAuthLoopbackRedirectUrl(server.auth.redirectUrl)
    ? `OAuth authorization is required. Run \`${commands.authorize}\`, then refresh provider enrollment.`
    : `OAuth authorization is required. Run \`${commands.start}\`, complete sign-in, then run \`${commands.finish}\` and refresh provider enrollment.`;
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
  const effectiveConfig =
    options.scope === "user"
      ? await loadUserMcpConfig()
      : await loadMcpConfig(workspaceRoot);
  const discovery =
    options.scope === "user"
      ? loadUserMcpDiscoveryCacheSync().servers
      : loadMcpDiscoveryCacheSync(workspaceRoot).servers;
  const enabledServers = listEnabledMcpServers(effectiveConfig).filter(
    (server) => {
      if (!options.scope) return true;
      const isWorkspaceServer = server.sources.includes("workspace");
      return options.scope === "workspace"
        ? isWorkspaceServer
        : !isWorkspaceServer;
    },
  );
  const projectedServers: McpProjectedServer[] = [];
  const uncoveredServers: McpUncoveredServer[] = [];
  const warnings: string[] = [];
  const environment = await resolveProjectionEnvironment(enabledServers);
  let machdochCliLaunch: MachdochCliLaunch | undefined;

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
    const capabilities = getCapabilities(discovery[server.id], server);
    const serverDigest = digestJson({
      server,
      discovery: discovery[server.id],
    });

    if (proxyReason) {
      const oauthBlock = getCopilotOAuthProxyBlock(
        provider,
        server,
        environment,
        workspaceRoot,
        options.scope,
      );
      if (oauthBlock) {
        warnings.push(`${server.id}: ${oauthBlock}`);
        uncoveredServers.push({
          canonicalId: server.id,
          digest: serverDigest,
          capabilities,
          reason: oauthBlock,
        });
        continue;
      }
      try {
        machdochCliLaunch ??= options.machdochCliLaunch
          ? assertMachdochCliLaunch(options.machdochCliLaunch)
          : resolveMachdochCliLaunch();
      } catch (error) {
        throw new Error(
          `MCP server \`${server.id}\` requires the ${provider} stdio proxy, but Machdoch could not construct a launchable CLI command: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      warnings.push(
        `${server.id}: ${proxyReason} Using the per-server stdio proxy.`,
      );
      projectedServers.push({
        id: projectedId,
        canonicalId: server.id,
        digest: serverDigest,
        route: "cli-stdio-proxy",
        providerConfig: createProxyConfig(
          provider,
          server,
          workspaceRoot,
          machdochCliLaunch,
          options.scope,
          getProxyEnvironmentKeys(server, environment),
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

  if (options.workspacePresence) {
    machdochCliLaunch ??= options.machdochCliLaunch
      ? assertMachdochCliLaunch(options.machdochCliLaunch)
      : resolveMachdochCliLaunch();
    projectedServers.push(
      createWorkspacePresenceProjection(
        provider,
        workspaceRoot,
        machdochCliLaunch,
        options.workspacePresence,
      ),
    );
  }

  const config = createProviderConfig(projectedServers);
  return {
    provider,
    effectiveConfigDigest: digestJson({
      defaults: effectiveConfig.defaults,
      servers: enabledServers,
      workspacePresence: options.workspacePresence !== undefined,
    }),
    catalogDigest: digestJson([
      ...projectedServers.map((server) => ({
        id: server.canonicalId,
        digest: server.digest,
        capabilities: server.capabilities,
        covered: true,
      })),
      ...uncoveredServers.map((server) => ({
        id: server.canonicalId,
        digest: server.digest,
        capabilities: server.capabilities,
        covered: false,
      })),
    ]),
    servers: projectedServers,
    uncoveredServers,
    config,
    environment,
    warnings,
  };
};

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { normalizeOptionalString } from "../../common/_helpers/normalize-optional-string.js";
import { getUserConfigPath } from "../env.js";
import type { ToolCallEffect, ToolRiskLevel } from "../types.js";
import { enrichMcpDiscoveryMetadata } from "./discovery-metadata.js";
import { getMcpPreset, listMcpPresets } from "./presets.js";
import {
  MCP_CONFIG_FILE_NAME,
  MCP_CONFIG_SCHEMA_VERSION,
  MCP_DISCOVERY_CACHE_SCHEMA_VERSION,
  MCP_USER_DISCOVERY_CACHE_FILE_NAME,
  MCP_WORKSPACE_DIRECTORY,
  MCP_WORKSPACE_DISCOVERY_CACHE_FILE_NAME,
  type McpAuthConfig,
  type McpCachePolicyConfig,
  type McpConfigFile,
  type McpConfigOverride,
  type McpConfigSource,
  type McpDefaultConfig,
  type McpDirectToolExposureConfig,
  type McpDiscoveryCacheFile,
  type McpEffectiveCachePolicyConfig,
  type McpEffectiveConfig,
  type McpEffectiveDefaults,
  type McpEffectiveServerConfig,
  type McpElicitationMode,
  type McpExposureMode,
  type McpOAuthConfig,
  type McpOAuthStatePatch,
  type McpRootMode,
  type McpSamplingMode,
  type McpSecurityProfile,
  type McpServerConfig,
  type McpServerDiscovery,
  type McpServerExposureConfig,
  type McpServerOverride,
  type McpStdioTransportConfig,
  type McpStreamableHttpTransportConfig,
  type McpTaskMode,
  type McpToolOverride,
  type McpTransportConfig,
} from "./types.js";

const DEFAULT_MCP_DEFAULTS: McpEffectiveDefaults = {
  enabled: true,
  securityProfile: "weak",
  exposure: "hybrid",
  directTools: true,
  timeoutMs: 60_000,
  maxTotalTimeoutMs: 300_000,
  idleShutdownMs: 900_000,
  maxResponseChars: 60_000,
  cache: {
    enabled: true,
    ttlMs: 900_000,
    forceRefresh: false,
  },
  roots: "workspace",
  sampling: "disabled",
  tasks: "optional",
  elicitation: "disabled",
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const isStringArray = (value: unknown): value is string[] => {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
};

const coerceRecordOfStrings = (
  value: unknown,
): Record<string, string> | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value).flatMap(([key, entry]) => {
    if (typeof entry !== "string") {
      return [];
    }

    return [[key, entry] as const];
  });

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const coerceStringArray = (value: unknown): string[] | undefined => {
  return isStringArray(value) ? value.filter((entry) => entry.trim().length > 0) : undefined;
};

const coercePositiveInteger = (
  value: unknown,
  fallback?: number,
): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.trunc(value);
};

const coerceNonNegativeInteger = (
  value: unknown,
  fallback?: number,
): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }

  return Math.trunc(value);
};

const normalizeServerId = (value: string): string => {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
};

const isSecurityProfile = (value: unknown): value is McpSecurityProfile => {
  return value === "weak" || value === "balanced" || value === "strict";
};

const isExposureMode = (value: unknown): value is McpExposureMode => {
  return value === "meta-tools" || value === "direct-tools" || value === "hybrid";
};

const isSamplingMode = (value: unknown): value is McpSamplingMode => {
  return value === "disabled" || value === "ask-agent";
};

const isRootMode = (value: unknown): value is McpRootMode => {
  return value === "disabled" || value === "workspace";
};

const isTaskMode = (value: unknown): value is McpTaskMode => {
  return value === "disabled" || value === "optional";
};

const isElicitationMode = (value: unknown): value is McpElicitationMode => {
  return value === "disabled";
};

const isToolEffect = (
  value: unknown,
): value is ToolCallEffect => {
  return (
    value === "read" ||
    value === "write" ||
    value === "external-read" ||
    value === "external-side-effect"
  );
};

const isRiskLevel = (
  value: unknown,
): value is ToolRiskLevel => {
  return value === "low" || value === "medium" || value === "high";
};

const coerceDirectToolExposure = (
  value: unknown,
): boolean | McpDirectToolExposureConfig | undefined => {
  if (typeof value === "boolean") {
    return value;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const include = coerceStringArray(value.include);
  const exclude = coerceStringArray(value.exclude);
  const exposure: McpDirectToolExposureConfig = {};

  if (typeof value.enabled === "boolean") {
    exposure.enabled = value.enabled;
  }

  if (include) {
    exposure.include = include;
  }

  if (exclude) {
    exposure.exclude = exclude;
  }

  if (typeof value.namespacePrefix === "string") {
    exposure.namespacePrefix = value.namespacePrefix;
  }

  return exposure;
};

const coerceExposure = (value: unknown): McpServerExposureConfig | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const directTools = coerceDirectToolExposure(value.directTools);

  return {
    ...(isExposureMode(value.mode) ? { mode: value.mode } : {}),
    ...(directTools !== undefined ? { directTools } : {}),
  };
};

const coerceAuth = (value: unknown): McpAuthConfig | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  if (value.type === "bearer") {
    return {
      type: "bearer",
      ...(typeof value.token === "string" ? { token: value.token } : {}),
      ...(typeof value.tokenEnv === "string" ? { tokenEnv: value.tokenEnv } : {}),
      ...(typeof value.headerName === "string"
        ? { headerName: value.headerName }
        : {}),
    };
  }

  if (value.type === "headers") {
    const headers = coerceRecordOfStrings(value.headers);
    const envHeaders = coerceRecordOfStrings(value.envHeaders);
    const auth: McpAuthConfig = { type: "headers" };

    if (headers) {
      auth.headers = headers;
    }

    if (envHeaders) {
      auth.envHeaders = envHeaders;
    }

    return auth;
  }

  if (value.type === "oauth") {
    const scopes = coerceStringArray(value.scopes);
    const auth: McpAuthConfig = { type: "oauth" };

    if (typeof value.clientId === "string") {
      auth.clientId = value.clientId;
    }

    if (typeof value.clientSecret === "string") {
      auth.clientSecret = value.clientSecret;
    }

    if (typeof value.clientSecretEnv === "string") {
      auth.clientSecretEnv = value.clientSecretEnv;
    }

    if (typeof value.redirectUrl === "string") {
      auth.redirectUrl = value.redirectUrl;
    }

    if (typeof value.clientMetadataUrl === "string") {
      auth.clientMetadataUrl = value.clientMetadataUrl;
    }

    if (scopes) {
      auth.scopes = scopes;
    }

    if (typeof value.accessToken === "string") {
      auth.accessToken = value.accessToken;
    }

    if (typeof value.accessTokenEnv === "string") {
      auth.accessTokenEnv = value.accessTokenEnv;
    }

    if (typeof value.refreshToken === "string") {
      auth.refreshToken = value.refreshToken;
    }

    if (typeof value.refreshTokenEnv === "string") {
      auth.refreshTokenEnv = value.refreshTokenEnv;
    }

    if (typeof value.tokenType === "string") {
      auth.tokenType = value.tokenType;
    }

    if (typeof value.tokenScope === "string") {
      auth.tokenScope = value.tokenScope;
    }

    const expiresIn = coerceNonNegativeInteger(value.expiresIn);

    if (expiresIn !== undefined) {
      auth.expiresIn = expiresIn;
    }

    if (typeof value.idToken === "string") {
      auth.idToken = value.idToken;
    }

    if (typeof value.authorizationUrl === "string") {
      auth.authorizationUrl = value.authorizationUrl;
    }

    if (typeof value.authorizationState === "string") {
      auth.authorizationState = value.authorizationState;
    }

    if (typeof value.codeVerifier === "string") {
      auth.codeVerifier = value.codeVerifier;
    }

    if (isRecord(value.clientInformation)) {
      auth.clientInformation = { ...value.clientInformation };
    }

    if (isRecord(value.discoveryState)) {
      auth.discoveryState = { ...value.discoveryState };
    }

    return auth;
  }

  return value.type === "none" ? { type: "none" } : undefined;
};

const coerceStdioTransport = (
  value: Record<string, unknown>,
): McpStdioTransportConfig | undefined => {
  const command =
    typeof value.command === "string"
      ? normalizeOptionalString(value.command)
      : undefined;

  if (!command) {
    return undefined;
  }

  const args = coerceStringArray(value.args);
  const env = coerceRecordOfStrings(value.env);
  const transport: McpStdioTransportConfig = {
    type: "stdio",
    command,
  };

  if (args) {
    transport.args = args;
  }

  if (typeof value.cwd === "string") {
    transport.cwd = value.cwd;
  }

  if (env) {
    transport.env = env;
  }

  if (typeof value.inheritEnvironment === "boolean") {
    transport.inheritEnvironment = value.inheritEnvironment;
  }

  if (
    value.stderr === "ignore" ||
    value.stderr === "inherit" ||
    value.stderr === "pipe"
  ) {
    transport.stderr = value.stderr;
  }

  return transport;
};

const coerceHttpTransport = (
  value: Record<string, unknown>,
): McpStreamableHttpTransportConfig | undefined => {
  const url =
    typeof value.url === "string" ? normalizeOptionalString(value.url) : undefined;

  if (!url) {
    return undefined;
  }

  const requestInitHeaders =
    isRecord(value.requestInit) && isRecord(value.requestInit.headers)
      ? coerceRecordOfStrings(value.requestInit.headers)
      : undefined;
  const headers = coerceRecordOfStrings(value.headers) ?? requestInitHeaders;
  const transport: McpStreamableHttpTransportConfig = {
    type: "streamable-http",
    url,
  };

  if (headers) {
    transport.headers = headers;
  }

  if (typeof value.sessionId === "string") {
    transport.sessionId = value.sessionId;
  }

  if (typeof value.legacySseFallback === "boolean") {
    transport.legacySseFallback = value.legacySseFallback;
  }

  return transport;
};

const coerceSseTransport = (
  value: Record<string, unknown>,
): McpTransportConfig | undefined => {
  const url =
    typeof value.url === "string" ? normalizeOptionalString(value.url) : undefined;

  if (!url) {
    return undefined;
  }

  const headers = coerceRecordOfStrings(value.headers);
  const transport: McpTransportConfig = {
    type: "sse",
    url,
  };

  if (headers) {
    transport.headers = headers;
  }

  return transport;
};

const coerceTransport = (value: unknown): McpTransportConfig | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  if (value.type === "stdio" || typeof value.command === "string") {
    return coerceStdioTransport(value);
  }

  if (
    value.type === "sse" ||
    value.type === "http+sse" ||
    value.type === "legacy-sse"
  ) {
    return coerceSseTransport(value);
  }

  if (
    value.type === "streamable-http" ||
    value.type === "http" ||
    typeof value.url === "string"
  ) {
    return coerceHttpTransport(value);
  }

  return undefined;
};

const coerceToolOverrides = (
  value: unknown,
): Record<string, McpToolOverride> | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value).flatMap(([toolName, override]) => {
    if (!isRecord(override)) {
      return [];
    }

    const toolOverride: McpToolOverride = {};

    if (typeof override.enabled === "boolean") {
      toolOverride.enabled = override.enabled;
    }

    if (typeof override.title === "string") {
      toolOverride.title = override.title;
    }

    if (typeof override.description === "string") {
      toolOverride.description = override.description;
    }

    if (isRiskLevel(override.riskLevel)) {
      toolOverride.riskLevel = override.riskLevel;
    }

    if (isToolEffect(override.effect)) {
      toolOverride.effect = override.effect;
    }

    if (typeof override.readOnlyInAskMode === "boolean") {
      toolOverride.readOnlyInAskMode = override.readOnlyInAskMode;
    }

    return [[toolName, toolOverride] as const];
  });

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const coerceRoots = (value: unknown): McpRootMode | string[] | undefined => {
  if (isRootMode(value)) {
    return value;
  }

  return coerceStringArray(value);
};

const coerceCachePolicy = (
  value: unknown,
): McpCachePolicyConfig | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const ttlMs = coerceNonNegativeInteger(value.ttlMs);
  const ttlSeconds = coerceNonNegativeInteger(value.ttlSeconds);
  const cache: McpCachePolicyConfig = {};

  if (typeof value.enabled === "boolean") {
    cache.enabled = value.enabled;
  }

  if (ttlMs !== undefined) {
    cache.ttlMs = ttlMs;
  } else if (ttlSeconds !== undefined) {
    cache.ttlMs = ttlSeconds * 1_000;
  }

  if (typeof value.forceRefresh === "boolean") {
    cache.forceRefresh = value.forceRefresh;
  }

  return Object.keys(cache).length > 0 ? cache : undefined;
};

const coerceDefaults = (value: unknown): McpDefaultConfig | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const roots = coerceRoots(value.roots);
  const timeoutMs = coercePositiveInteger(value.timeoutMs);
  const maxTotalTimeoutMs = coercePositiveInteger(value.maxTotalTimeoutMs);
  const idleShutdownMs = coerceNonNegativeInteger(value.idleShutdownMs);
  const maxResponseChars = coercePositiveInteger(value.maxResponseChars);
  const cache = coerceCachePolicy(value.cache);
  const defaults: McpDefaultConfig = {};

  if (typeof value.enabled === "boolean") {
    defaults.enabled = value.enabled;
  }

  if (isSecurityProfile(value.securityProfile)) {
    defaults.securityProfile = value.securityProfile;
  }

  if (isExposureMode(value.exposure)) {
    defaults.exposure = value.exposure;
  }

  if (typeof value.directTools === "boolean") {
    defaults.directTools = value.directTools;
  }

  if (timeoutMs !== undefined) {
    defaults.timeoutMs = timeoutMs;
  }

  if (maxTotalTimeoutMs !== undefined) {
    defaults.maxTotalTimeoutMs = maxTotalTimeoutMs;
  }

  if (idleShutdownMs !== undefined) {
    defaults.idleShutdownMs = idleShutdownMs;
  }

  if (maxResponseChars !== undefined) {
    defaults.maxResponseChars = maxResponseChars;
  }

  if (cache) {
    defaults.cache = cache;
  }

  if (roots !== undefined) {
    defaults.roots = roots;
  }

  if (isSamplingMode(value.sampling)) {
    defaults.sampling = value.sampling;
  }

  if (isTaskMode(value.tasks)) {
    defaults.tasks = value.tasks;
  }

  if (isElicitationMode(value.elicitation)) {
    defaults.elicitation = value.elicitation;
  }

  return defaults;
};

const coerceServerList = (value: unknown): McpServerOverride[] => {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const server = coerceServerOverride(entry);
      return server ? [server] : [];
    });
  }

  if (!isRecord(value)) {
    return [];
  }

  return Object.entries(value).flatMap(([id, entry]) => {
    const server = coerceServerOverride(entry, id);
    return server ? [server] : [];
  });
};

const parseMcpConfigFile = (raw: string): McpConfigFile => {
  const parsed: unknown = JSON.parse(raw);

  if (!isRecord(parsed)) {
    return {};
  }

  const defaults = coerceDefaults(parsed.defaults);
  const servers = coerceServerList(parsed.servers);

  return {
    ...(parsed.schemaVersion === MCP_CONFIG_SCHEMA_VERSION
      ? { schemaVersion: MCP_CONFIG_SCHEMA_VERSION }
      : {}),
    ...(defaults ? { defaults } : {}),
    ...(servers.length > 0 ? { servers } : {}),
  };
};

const readConfigFile = async (path: string): Promise<McpConfigFile> => {
  if (!existsSync(path)) {
    return {};
  }

  return parseMcpConfigFile(await readFile(path, "utf8"));
};

const readConfigFileSync = (path: string): McpConfigFile => {
  if (!existsSync(path)) {
    return {};
  }

  return parseMcpConfigFile(readFileSync(path, "utf8"));
};

export const getUserMcpConfigPath = (): string => {
  return join(dirname(getUserConfigPath()), MCP_CONFIG_FILE_NAME);
};

export const getWorkspaceMcpConfigPath = (workspaceRoot: string): string => {
  return join(workspaceRoot, MCP_WORKSPACE_DIRECTORY, MCP_CONFIG_FILE_NAME);
};

export const getUserMcpDiscoveryCachePath = (): string => {
  return join(dirname(getUserConfigPath()), MCP_USER_DISCOVERY_CACHE_FILE_NAME);
};

export const getWorkspaceMcpDiscoveryCachePath = (
  workspaceRoot: string,
): string => {
  return join(
    workspaceRoot,
    MCP_WORKSPACE_DIRECTORY,
    MCP_WORKSPACE_DISCOVERY_CACHE_FILE_NAME,
  );
};

const mergeDefaults = (
  base: McpEffectiveDefaults,
  patch: McpDefaultConfig | undefined,
): McpEffectiveDefaults => {
  if (!patch) {
    return base;
  }

  return {
    ...base,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.securityProfile ? { securityProfile: patch.securityProfile } : {}),
    ...(patch.exposure ? { exposure: patch.exposure } : {}),
    ...(patch.directTools !== undefined ? { directTools: patch.directTools } : {}),
    ...(patch.timeoutMs !== undefined ? { timeoutMs: patch.timeoutMs } : {}),
    ...(patch.maxTotalTimeoutMs !== undefined
      ? { maxTotalTimeoutMs: patch.maxTotalTimeoutMs }
      : {}),
    ...(patch.idleShutdownMs !== undefined
      ? { idleShutdownMs: patch.idleShutdownMs }
      : {}),
    ...(patch.maxResponseChars !== undefined
      ? { maxResponseChars: patch.maxResponseChars }
      : {}),
    ...(patch.cache
      ? { cache: mergeEffectiveCachePolicy(base.cache, patch.cache) }
      : {}),
    ...(patch.roots !== undefined ? { roots: patch.roots } : {}),
    ...(patch.sampling ? { sampling: patch.sampling } : {}),
    ...(patch.tasks ? { tasks: patch.tasks } : {}),
    ...(patch.elicitation ? { elicitation: patch.elicitation } : {}),
  };
};

const mergeCachePolicy = (
  base: McpCachePolicyConfig | McpEffectiveCachePolicyConfig | undefined,
  patch: McpCachePolicyConfig | undefined,
): McpCachePolicyConfig => {
  const patchTtlMs =
    patch?.ttlMs ??
    (patch?.ttlSeconds !== undefined ? patch.ttlSeconds * 1_000 : undefined);

  return {
    ...(base ?? {}),
    ...(patch?.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patchTtlMs !== undefined ? { ttlMs: patchTtlMs } : {}),
    ...(patch?.forceRefresh !== undefined
      ? { forceRefresh: patch.forceRefresh }
      : {}),
  };
};

const mergeEffectiveCachePolicy = (
  base: McpEffectiveCachePolicyConfig,
  patch: McpCachePolicyConfig | undefined,
): McpEffectiveCachePolicyConfig => {
  const merged = mergeCachePolicy(base, patch);

  return {
    enabled: merged.enabled ?? base.enabled,
    ttlMs: merged.ttlMs ?? base.ttlMs,
    forceRefresh: merged.forceRefresh ?? base.forceRefresh,
  };
};

const resolveEffectiveCachePolicy = (
  defaults: McpEffectiveCachePolicyConfig,
  serverCache: McpCachePolicyConfig | undefined,
): McpEffectiveCachePolicyConfig => {
  return mergeEffectiveCachePolicy(defaults, serverCache);
};

const mergeTransports = (
  base: McpTransportConfig,
  patch: McpTransportConfig,
): McpTransportConfig => {
  if (base.type !== patch.type) {
    return patch;
  }

  return { ...base, ...patch } as McpTransportConfig;
};

const mergeServers = (
  base: McpServerConfig,
  patch: McpServerConfig,
): McpServerConfig => {
  return {
    ...base,
    ...patch,
    transport: mergeTransports(base.transport, patch.transport),
    ...(base.auth || patch.auth ? { auth: { ...base.auth, ...patch.auth } as McpAuthConfig } : {}),
    ...(base.exposure || patch.exposure
      ? { exposure: { ...base.exposure, ...patch.exposure } }
      : {}),
    ...(base.cache || patch.cache
      ? { cache: mergeCachePolicy(base.cache, patch.cache) }
      : {}),
    ...(base.toolOverrides || patch.toolOverrides
      ? {
          toolOverrides: {
            ...(base.toolOverrides ?? {}),
            ...(patch.toolOverrides ?? {}),
          },
        }
      : {}),
  };
};

const mergeServerPatch = (
  base: McpServerConfig,
  patch: McpServerOverride,
): McpServerConfig => {
  return {
    ...base,
    ...patch,
    transport: patch.transport
      ? mergeTransports(base.transport, patch.transport)
      : base.transport,
    ...(base.auth || patch.auth
      ? { auth: { ...base.auth, ...patch.auth } as McpAuthConfig }
      : {}),
    ...(base.exposure || patch.exposure
      ? { exposure: { ...base.exposure, ...patch.exposure } }
      : {}),
    ...(base.cache || patch.cache
      ? { cache: mergeCachePolicy(base.cache, patch.cache) }
      : {}),
    ...(base.toolOverrides || patch.toolOverrides
      ? {
          toolOverrides: {
            ...(base.toolOverrides ?? {}),
            ...(patch.toolOverrides ?? {}),
          },
        }
      : {}),
  };
};

const addServers = (
  map: Map<string, { server: McpServerConfig; sources: McpConfigSource[] }>,
  servers: McpServerConfig[],
  source: McpConfigSource,
): void => {
  for (const server of servers) {
    const current = map.get(server.id);

    if (!current) {
      map.set(server.id, { server, sources: [source] });
      continue;
    }

    current.server = mergeServers(current.server, server);
    current.sources = [...new Set([...current.sources, source])];
  }
};

const addServerOverrides = (
  map: Map<string, { server: McpServerConfig; sources: McpConfigSource[] }>,
  servers: McpServerOverride[],
  source: McpConfigSource,
): void => {
  for (const patch of servers) {
    const current = map.get(patch.id);

    if (!current) {
      if (patch.transport) {
        map.set(patch.id, {
          server: patch as McpServerConfig,
          sources: [source],
        });
      }
      continue;
    }

    current.server = mergeServerPatch(current.server, patch);
    current.sources = [...new Set([...current.sources, source])];
  }
};

const getExposureMode = (
  server: McpServerConfig,
  defaults: McpEffectiveDefaults,
): McpExposureMode => {
  return server.exposure?.mode ?? defaults.exposure;
};

const getDirectToolsEnabled = (
  server: McpServerConfig,
  defaults: McpEffectiveDefaults,
): boolean => {
  const directTools = server.exposure?.directTools;

  if (typeof directTools === "boolean") {
    return directTools;
  }

  if (isRecord(directTools) && typeof directTools.enabled === "boolean") {
    return directTools.enabled;
  }

  return defaults.directTools;
};

const applyServerDefaults = (
  server: McpServerConfig,
  defaults: McpEffectiveDefaults,
  sources: McpConfigSource[],
): McpEffectiveServerConfig => {
  const exposureMode = getExposureMode(server, defaults);
  const directTools = getDirectToolsEnabled(server, defaults);

  return {
    ...server,
    enabled: server.enabled ?? defaults.enabled,
    exposure: {
      ...(server.exposure ?? {}),
      mode: exposureMode,
      directTools,
    },
    securityProfile: server.securityProfile ?? defaults.securityProfile,
    timeoutMs: server.timeoutMs ?? defaults.timeoutMs,
    maxTotalTimeoutMs: server.maxTotalTimeoutMs ?? defaults.maxTotalTimeoutMs,
    idleShutdownMs: server.idleShutdownMs ?? defaults.idleShutdownMs,
    maxResponseChars: server.maxResponseChars ?? defaults.maxResponseChars,
    cache: resolveEffectiveCachePolicy(defaults.cache, server.cache),
    roots: server.roots ?? defaults.roots,
    sampling: server.sampling ?? defaults.sampling,
    tasks: server.tasks ?? defaults.tasks,
    sources,
  };
};

const coerceServerOverride = (
  value: unknown,
  fallbackId?: string,
): McpServerOverride | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const rawId =
    typeof value.id === "string" ? normalizeOptionalString(value.id) : fallbackId;
  const id = rawId ? normalizeServerId(rawId) : "";

  if (!id) {
    return undefined;
  }

  const transport =
    coerceTransport(value.transport) ??
    coerceTransport({
      ...value,
      ...(isRecord(value.requestInit) ? { requestInit: value.requestInit } : {}),
    });
  const exposure = coerceExposure(value.exposure);
  const auth = coerceAuth(value.auth);
  const roots = coerceRoots(value.roots);
  const toolOverrides = coerceToolOverrides(value.toolOverrides);
  const timeoutMs = coercePositiveInteger(value.timeoutMs);
  const maxTotalTimeoutMs = coercePositiveInteger(value.maxTotalTimeoutMs);
  const idleShutdownMs = coerceNonNegativeInteger(value.idleShutdownMs);
  const maxResponseChars = coercePositiveInteger(value.maxResponseChars);
  const cache = coerceCachePolicy(value.cache);
  const server: McpServerOverride = { id };

  if (typeof value.title === "string") {
    server.title = value.title;
  }

  if (typeof value.description === "string") {
    server.description = value.description;
  }

  if (typeof value.enabled === "boolean") {
    server.enabled = value.enabled;
  }

  if (typeof value.preset === "string") {
    server.preset = value.preset;
  }

  if (transport) {
    server.transport = transport;
  }

  if (auth) {
    server.auth = auth;
  }

  if (exposure) {
    server.exposure = exposure;
  }

  if (isSecurityProfile(value.securityProfile)) {
    server.securityProfile = value.securityProfile;
  }

  if (timeoutMs !== undefined) {
    server.timeoutMs = timeoutMs;
  }

  if (maxTotalTimeoutMs !== undefined) {
    server.maxTotalTimeoutMs = maxTotalTimeoutMs;
  }

  if (idleShutdownMs !== undefined) {
    server.idleShutdownMs = idleShutdownMs;
  }

  if (maxResponseChars !== undefined) {
    server.maxResponseChars = maxResponseChars;
  }

  if (cache) {
    server.cache = cache;
  }

  if (toolOverrides) {
    server.toolOverrides = toolOverrides;
  }

  if (roots !== undefined) {
    server.roots = roots;
  }

  if (isSamplingMode(value.sampling)) {
    server.sampling = value.sampling;
  }

  if (isTaskMode(value.tasks)) {
    server.tasks = value.tasks;
  }

  if (typeof value.notes === "string") {
    server.notes = value.notes;
  }

  return server;
};

const coerceOverrideServers = (
  servers: McpConfigOverride["servers"],
): McpServerOverride[] => {
  return (servers ?? []).flatMap((server) => {
    const normalized = coerceServerOverride(server);
    return normalized ? [normalized] : [];
  });
};

export const coerceMcpConfigOverride = (
  value: unknown,
): McpConfigOverride | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const defaults = coerceDefaults(value.defaults);
  const servers = Array.isArray(value.servers)
    ? value.servers.flatMap((server) => {
        const normalized = coerceServerOverride(server);
        return normalized ? [normalized] : [];
      })
    : isRecord(value.servers)
      ? Object.entries(value.servers).flatMap(([id, server]) => {
          const normalized = coerceServerOverride(server, id);
          return normalized ? [normalized] : [];
        })
      : [];
  const override: McpConfigOverride = {};

  if (defaults) {
    override.defaults = defaults;
  }

  if (servers.length > 0) {
    override.servers = servers;
  }

  return override.defaults || override.servers ? override : undefined;
};

const createEffectiveConfig = (
  workspaceRoot: string,
  userConfig: McpConfigFile,
  workspaceConfig: McpConfigFile,
  overrides?: McpConfigOverride,
): McpEffectiveConfig => {
  const userConfigPath = getUserMcpConfigPath();
  const workspaceConfigPath = getWorkspaceMcpConfigPath(workspaceRoot);
  const userDiscoveryCachePath = getUserMcpDiscoveryCachePath();
  const workspaceDiscoveryCachePath = getWorkspaceMcpDiscoveryCachePath(workspaceRoot);
  const defaults = mergeDefaults(
    mergeDefaults(
      mergeDefaults(DEFAULT_MCP_DEFAULTS, userConfig.defaults),
      workspaceConfig.defaults,
    ),
    overrides?.defaults,
  );
  const servers = new Map<
    string,
    { server: McpServerConfig; sources: McpConfigSource[] }
  >();

  addServers(
    servers,
    listMcpPresets().map((preset) => preset.server),
    "preset",
  );
  addServerOverrides(servers, userConfig.servers ?? [], "user");
  addServerOverrides(servers, workspaceConfig.servers ?? [], "workspace");
  addServerOverrides(servers, coerceOverrideServers(overrides?.servers), "override");

  return {
    defaults,
    servers: [...servers.values()].map(({ server, sources }) =>
      applyServerDefaults(server, defaults, sources),
    ),
    userConfigPath,
    workspaceConfigPath,
    userDiscoveryCachePath,
    workspaceDiscoveryCachePath,
  };
};

export const loadMcpConfig = async (
  workspaceRoot: string,
  overrides?: McpConfigOverride,
): Promise<McpEffectiveConfig> => {
  const [userConfig, workspaceConfig] = await Promise.all([
    readConfigFile(getUserMcpConfigPath()),
    readConfigFile(getWorkspaceMcpConfigPath(workspaceRoot)),
  ]);

  return createEffectiveConfig(workspaceRoot, userConfig, workspaceConfig, overrides);
};

export const loadMcpConfigSync = (
  workspaceRoot: string,
  overrides?: McpConfigOverride,
): McpEffectiveConfig => {
  return createEffectiveConfig(
    workspaceRoot,
    readConfigFileSync(getUserMcpConfigPath()),
    readConfigFileSync(getWorkspaceMcpConfigPath(workspaceRoot)),
    overrides,
  );
};

export const getEnabledMcpServer = (
  config: McpEffectiveConfig,
  serverId: string,
): McpEffectiveServerConfig | undefined => {
  const normalized = normalizeServerId(serverId);

  return config.servers.find(
    (server) => server.id === normalized && server.enabled,
  );
};

export const listEnabledMcpServers = (
  config: McpEffectiveConfig,
): McpEffectiveServerConfig[] => {
  return config.servers.filter((server) => server.enabled);
};

export const createMcpConfigFromPreset = (
  presetId: string,
  overrides: Partial<McpServerConfig> = {},
): McpServerConfig => {
  const preset = getMcpPreset(presetId);

  if (!preset) {
    throw new Error(`Unknown MCP preset \`${presetId}\`.`);
  }

  return mergeServers(preset.server, {
    ...preset.server,
    ...overrides,
    id: normalizeServerId(overrides.id ?? preset.server.id),
    enabled: overrides.enabled ?? true,
  });
};

export const saveUserMcpConfig = async (
  config: McpConfigFile,
): Promise<string> => {
  const path = getUserMcpConfigPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return path;
};

export const saveWorkspaceMcpConfig = async (
  workspaceRoot: string,
  config: McpConfigFile,
): Promise<string> => {
  const path = getWorkspaceMcpConfigPath(workspaceRoot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return path;
};

export const saveUserMcpOAuthState = async (
  server: Pick<McpServerConfig, "id" | "transport"> &
    Partial<Pick<McpServerConfig, "title" | "description" | "preset">>,
  patch: McpOAuthStatePatch,
): Promise<string> => {
  const path = getUserMcpConfigPath();
  const config = await readConfigFile(path);
  const normalizedId = normalizeServerId(server.id);
  const servers = [...(config.servers ?? [])];
  const index = servers.findIndex((entry) => entry.id === normalizedId);
  const current = index >= 0 ? servers[index] : undefined;
  const currentAuth =
    current?.auth?.type === "oauth" ? current.auth : ({ type: "oauth" } satisfies McpOAuthConfig);
  const nextAuth = {
    ...currentAuth,
    type: "oauth",
  } as McpOAuthConfig;
  const nextAuthRecord = nextAuth as unknown as Record<string, unknown>;

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete nextAuthRecord[key];
      continue;
    }

    nextAuthRecord[key] = value;
  }

  const nextServer: McpServerOverride = {
    ...(current ?? {
      id: normalizedId,
      transport: server.transport,
      ...(server.title ? { title: server.title } : {}),
      ...(server.description ? { description: server.description } : {}),
      ...(server.preset ? { preset: server.preset } : {}),
    }),
    id: normalizedId,
    ...(!current?.transport ? { transport: server.transport } : {}),
    auth: nextAuth,
  };

  if (index >= 0) {
    servers[index] = nextServer;
  } else {
    servers.push(nextServer);
  }

  return saveUserMcpConfig({
    ...config,
    schemaVersion: MCP_CONFIG_SCHEMA_VERSION,
    servers,
  });
};

const parseDiscoveryCache = (raw: string): McpDiscoveryCacheFile => {
  const parsed: unknown = JSON.parse(raw);

  if (!isRecord(parsed) || !isRecord(parsed.servers)) {
    return {
      schemaVersion: MCP_DISCOVERY_CACHE_SCHEMA_VERSION,
      servers: {},
    };
  }

  return {
    schemaVersion: MCP_DISCOVERY_CACHE_SCHEMA_VERSION,
    servers: Object.fromEntries(
      Object.entries(parsed.servers).flatMap(([serverId, discovery]) => {
        if (!isRecord(discovery)) {
          return [];
        }

        return [
          [
            serverId,
            enrichMcpDiscoveryMetadata(discovery as unknown as McpServerDiscovery),
          ] as const,
        ];
      }),
    ),
  };
};

const loadDiscoveryCacheFileSync = (path: string): McpDiscoveryCacheFile => {
  if (!existsSync(path)) {
    return {
      schemaVersion: MCP_DISCOVERY_CACHE_SCHEMA_VERSION,
      servers: {},
    };
  }

  return parseDiscoveryCache(readFileSync(path, "utf8"));
};

const loadDiscoveryCacheFile = async (
  path: string,
): Promise<McpDiscoveryCacheFile> => {
  if (!existsSync(path)) {
    return {
      schemaVersion: MCP_DISCOVERY_CACHE_SCHEMA_VERSION,
      servers: {},
    };
  }

  return parseDiscoveryCache(await readFile(path, "utf8"));
};

export const loadMcpDiscoveryCacheSync = (
  workspaceRoot: string,
): McpDiscoveryCacheFile => {
  const userCache = loadDiscoveryCacheFileSync(getUserMcpDiscoveryCachePath());
  const workspaceCache = loadDiscoveryCacheFileSync(
    getWorkspaceMcpDiscoveryCachePath(workspaceRoot),
  );

  return {
    schemaVersion: MCP_DISCOVERY_CACHE_SCHEMA_VERSION,
    servers: {
      ...userCache.servers,
      ...workspaceCache.servers,
    },
  };
};

export const loadMcpDiscoveryCache = async (
  workspaceRoot: string,
): Promise<McpDiscoveryCacheFile> => {
  const [userCache, workspaceCache] = await Promise.all([
    loadDiscoveryCacheFile(getUserMcpDiscoveryCachePath()),
    loadDiscoveryCacheFile(getWorkspaceMcpDiscoveryCachePath(workspaceRoot)),
  ]);

  return {
    schemaVersion: MCP_DISCOVERY_CACHE_SCHEMA_VERSION,
    servers: {
      ...userCache.servers,
      ...workspaceCache.servers,
    },
  };
};

export const saveWorkspaceMcpDiscovery = async (
  workspaceRoot: string,
  discovery: McpServerDiscovery,
): Promise<string> => {
  const path = getWorkspaceMcpDiscoveryCachePath(workspaceRoot);
  const cache = await loadDiscoveryCacheFile(path);
  const enrichedDiscovery = enrichMcpDiscoveryMetadata(discovery);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(
      {
        schemaVersion: MCP_DISCOVERY_CACHE_SCHEMA_VERSION,
        servers: {
          ...cache.servers,
          [enrichedDiscovery.serverId]: enrichedDiscovery,
        },
      } satisfies McpDiscoveryCacheFile,
      null,
      2,
    )}\n`,
    "utf8",
  );

  return path;
};

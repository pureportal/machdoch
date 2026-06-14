import type { ToolCallEffect, ToolRiskLevel } from "../types.js";

export const MCP_CONFIG_SCHEMA_VERSION = 1;
export const MCP_DISCOVERY_CACHE_SCHEMA_VERSION = 1;

export const MCP_CONFIG_FILE_NAME = "mcp.json";
export const MCP_WORKSPACE_DIRECTORY = ".machdoch/mcp";
export const MCP_WORKSPACE_DISCOVERY_CACHE_FILE_NAME = "discovery-cache.json";
export const MCP_USER_DISCOVERY_CACHE_FILE_NAME = "mcp-discovery-cache.json";

export type McpConfigSource = "preset" | "user" | "workspace" | "override";
export type McpTransportType = "stdio" | "streamable-http" | "sse";
export type McpSecurityProfile = "weak" | "balanced" | "strict";
export type McpElicitationMode = "disabled";
export type McpSamplingMode = "disabled" | "ask-agent";
export type McpRootMode = "disabled" | "workspace";
export type McpTaskMode = "disabled" | "optional";
export type McpExposureMode = "meta-tools" | "direct-tools" | "hybrid";

export interface McpStdioTransportConfig {
  type: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  inheritEnvironment?: boolean;
  stderr?: "pipe" | "ignore" | "inherit";
}

export interface McpStreamableHttpTransportConfig {
  type: "streamable-http";
  url: string;
  headers?: Record<string, string>;
  sessionId?: string;
  legacySseFallback?: boolean;
}

export interface McpSseTransportConfig {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
}

export type McpTransportConfig =
  | McpStdioTransportConfig
  | McpStreamableHttpTransportConfig
  | McpSseTransportConfig;

export interface McpNoAuthConfig {
  type: "none";
}

export interface McpBearerAuthConfig {
  type: "bearer";
  token?: string;
  tokenEnv?: string;
  headerName?: string;
}

export interface McpHeaderAuthConfig {
  type: "headers";
  headers?: Record<string, string>;
  envHeaders?: Record<string, string>;
}

export interface McpOAuthConfig {
  type: "oauth";
  clientId?: string;
  clientSecret?: string;
  clientSecretEnv?: string;
  redirectUrl?: string;
  clientMetadataUrl?: string;
  scopes?: string[];
  accessToken?: string;
  accessTokenEnv?: string;
  refreshToken?: string;
  refreshTokenEnv?: string;
  tokenType?: string;
  tokenScope?: string;
  expiresIn?: number;
  idToken?: string;
  authorizationUrl?: string;
  authorizationState?: string;
  codeVerifier?: string;
  clientInformation?: Record<string, unknown>;
  discoveryState?: Record<string, unknown>;
}

export type McpOAuthStatePatch = {
  [Key in keyof McpOAuthConfig]?: McpOAuthConfig[Key] | undefined;
};

export type McpAuthConfig =
  | McpNoAuthConfig
  | McpBearerAuthConfig
  | McpHeaderAuthConfig
  | McpOAuthConfig;

export interface McpDirectToolExposureConfig {
  enabled?: boolean;
  include?: string[];
  exclude?: string[];
  namespacePrefix?: string;
}

export interface McpServerExposureConfig {
  mode?: McpExposureMode;
  directTools?: boolean | McpDirectToolExposureConfig;
}

export interface McpToolOverride {
  enabled?: boolean;
  title?: string;
  description?: string;
  riskLevel?: ToolRiskLevel;
  effect?: ToolCallEffect;
  readOnlyInAskMode?: boolean;
}

export interface McpServerConfig {
  id: string;
  title?: string;
  description?: string;
  enabled?: boolean;
  preset?: string;
  transport: McpTransportConfig;
  auth?: McpAuthConfig;
  exposure?: McpServerExposureConfig;
  securityProfile?: McpSecurityProfile;
  timeoutMs?: number;
  maxTotalTimeoutMs?: number;
  idleShutdownMs?: number;
  maxResponseChars?: number;
  cache?: McpCachePolicyConfig;
  toolOverrides?: Record<string, McpToolOverride>;
  roots?: McpRootMode | string[];
  sampling?: McpSamplingMode;
  tasks?: McpTaskMode;
  notes?: string;
}

export interface McpDefaultConfig {
  enabled?: boolean;
  securityProfile?: McpSecurityProfile;
  exposure?: McpExposureMode;
  directTools?: boolean;
  timeoutMs?: number;
  maxTotalTimeoutMs?: number;
  idleShutdownMs?: number;
  maxResponseChars?: number;
  cache?: McpCachePolicyConfig;
  roots?: McpRootMode | string[];
  sampling?: McpSamplingMode;
  tasks?: McpTaskMode;
  elicitation?: McpElicitationMode;
}

export interface McpConfigFile {
  schemaVersion?: typeof MCP_CONFIG_SCHEMA_VERSION;
  defaults?: McpDefaultConfig;
  servers?: McpServerOverride[];
}

export type McpServerOverride = Partial<McpServerConfig> & Pick<McpServerConfig, "id">;

export interface McpConfigOverride {
  defaults?: McpDefaultConfig;
  servers?: McpServerOverride[];
}

export interface McpCachePolicyConfig {
  enabled?: boolean;
  ttlMs?: number;
  ttlSeconds?: number;
  forceRefresh?: boolean;
}

export interface McpEffectiveCachePolicyConfig {
  enabled: boolean;
  ttlMs: number;
  forceRefresh: boolean;
}

export interface McpPresetDefinition {
  id: string;
  title: string;
  description: string;
  server: McpServerConfig;
}

export interface McpEffectiveDefaults {
  enabled: boolean;
  securityProfile: McpSecurityProfile;
  exposure: McpExposureMode;
  directTools: boolean;
  timeoutMs: number;
  maxTotalTimeoutMs: number;
  idleShutdownMs: number;
  maxResponseChars: number;
  cache: McpEffectiveCachePolicyConfig;
  roots: McpRootMode | string[];
  sampling: McpSamplingMode;
  tasks: McpTaskMode;
  elicitation: McpElicitationMode;
}

export interface McpEffectiveServerConfig
  extends Omit<
    McpServerConfig,
    | "enabled"
    | "securityProfile"
    | "timeoutMs"
    | "maxTotalTimeoutMs"
    | "idleShutdownMs"
    | "maxResponseChars"
    | "cache"
    | "roots"
    | "sampling"
    | "tasks"
  > {
  enabled: boolean;
  securityProfile: McpSecurityProfile;
  timeoutMs: number;
  maxTotalTimeoutMs: number;
  idleShutdownMs: number;
  maxResponseChars: number;
  cache: McpEffectiveCachePolicyConfig;
  roots: McpRootMode | string[];
  sampling: McpSamplingMode;
  tasks: McpTaskMode;
  sources: McpConfigSource[];
}

export interface McpEffectiveConfig {
  defaults: McpEffectiveDefaults;
  servers: McpEffectiveServerConfig[];
  userConfigPath: string;
  workspaceConfigPath: string;
  userDiscoveryCachePath: string;
  workspaceDiscoveryCachePath: string;
}

export interface McpDiscoveredTool {
  name: string;
  title?: string;
  description?: string;
  descriptionHash?: string;
  inputSchema: Record<string, unknown>;
  inputSchemaHash?: string;
  outputSchema?: Record<string, unknown>;
  outputSchemaHash?: string;
  definitionHash?: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  taskSupport?: "optional" | "required" | "forbidden";
}

export interface McpDiscoveredResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  definitionHash?: string;
}

export interface McpDiscoveredResourceTemplate {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  definitionHash?: string;
}

export interface McpDiscoveredPrompt {
  name: string;
  title?: string;
  description?: string;
  descriptionHash?: string;
  definitionHash?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

export interface McpServerDiscovery {
  serverId: string;
  discoveredAt: string;
  protocolVersion?: string;
  serverVersion?: {
    name?: string;
    version?: string;
  };
  instructions?: string;
  transportType: McpTransportType;
  capabilities?: Record<string, unknown>;
  capabilitiesHash?: string;
  catalogHash?: string;
  toolCatalogHash?: string;
  resourceCatalogHash?: string;
  promptCatalogHash?: string;
  tools: McpDiscoveredTool[];
  resources: McpDiscoveredResource[];
  resourceTemplates: McpDiscoveredResourceTemplate[];
  prompts: McpDiscoveredPrompt[];
}

export interface McpDiscoveryCacheFile {
  schemaVersion: typeof MCP_DISCOVERY_CACHE_SCHEMA_VERSION;
  servers: Record<string, McpServerDiscovery>;
}

export type McpDiscoveryChangeCategory =
  | "capabilities"
  | "tool"
  | "resource"
  | "resource_template"
  | "prompt";

export type McpDiscoveryChangeType = "added" | "removed" | "changed";

export interface McpDiscoveryChange {
  category: McpDiscoveryChangeCategory;
  type: McpDiscoveryChangeType;
  name: string;
  previousHash?: string;
  nextHash?: string;
}

export interface McpDiscoveryChangeSet {
  changed: boolean;
  previousCatalogHash?: string;
  nextCatalogHash: string;
  changes: McpDiscoveryChange[];
}

export interface McpDirectToolMapping {
  exposedName: string;
  serverId: string;
  remoteName: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  inputSchemaHash?: string;
  outputSchemaHash?: string;
  descriptionHash?: string;
  definitionHash?: string;
  riskLevel: ToolRiskLevel;
  effect: ToolCallEffect;
  readOnlyInAskMode: boolean;
}

export interface McpOperationOptions {
  signal?: AbortSignal;
  onProgress?: (message: string) => void | Promise<void>;
  configOverride?: McpConfigOverride;
  cache?: McpOperationCacheOptions;
}

export interface McpOperationCacheOptions {
  runId: string;
  enabled?: boolean;
  ttlMs?: number;
  forceRefresh?: boolean;
  operation: "tool" | "resource" | "prompt";
  readOnly?: boolean;
}

export interface McpOAuthFlowResult {
  serverId: string;
  status: "authorized" | "authorization-required";
  configPath: string;
  authorizationUrl?: string;
  stateVerified?: boolean;
}

export interface McpConnectionStatus {
  workspaceRoot: string;
  serverId: string;
  transportType: McpTransportType;
  protocolVersion?: string;
  connectedAt: string;
  lastUsedAt: string;
  activeOperations: number;
  idleShutdownMs: number;
  roots: McpRootMode | string[];
  sampling: McpSamplingMode;
  tasks: McpTaskMode;
  closesAt?: string;
}

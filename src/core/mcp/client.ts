import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  auth as runOAuthFlow,
  type AuthResult,
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ResponseMessage } from "@modelcontextprotocol/sdk/shared/responseMessage.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  CallToolResultSchema,
  CreateMessageRequestSchema,
  ErrorCode,
  GetTaskPayloadResultSchema,
  ListRootsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  CancelTaskResult,
  CallToolResult,
  ClientCapabilities,
  CreateMessageRequest,
  CreateMessageResult,
  GetTaskPayloadResult,
  GetPromptResult,
  GetTaskResult,
  ListRootsResult,
  ListPromptsResult,
  ListResourceTemplatesResult,
  ListResourcesResult,
  ListTasksResult,
  ListToolsResult,
  ReadResourceResult,
  SamplingMessage,
  SamplingMessageContentBlock,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeOptionalString } from "../../common/_helpers/normalize-optional-string.js";
import { createProviderAdapter } from "../_helpers/provider-adapters.js";
import { loadRuntimeConfig } from "../config.js";
import { loadWorkspaceEnv } from "../env.js";
import type { AgentModelImageInput } from "../types.js";
import {
  getEnabledMcpServer,
  getUserMcpConfigPath,
  loadMcpDiscoveryCache,
  loadMcpConfig,
  saveUserMcpOAuthState,
  saveWorkspaceMcpDiscovery,
} from "./config.js";
import {
  compareMcpDiscoveries,
  enrichMcpDiscoveryMetadata,
} from "./discovery-metadata.js";
import { mcpRunCacheManager } from "./run-cache.js";
import type {
  McpAuthConfig,
  McpDiscoveredPrompt,
  McpDiscoveredResource,
  McpDiscoveredResourceTemplate,
  McpDiscoveredTool,
  McpConnectionStatus,
  McpDiscoveryChangeSet,
  McpEffectiveServerConfig,
  McpOAuthFlowResult,
  McpOAuthStatePatch,
  McpOperationOptions,
  McpOperationCacheOptions,
  McpServerDiscovery,
  McpStdioTransportConfig,
  McpTransportConfig,
} from "./types.js";

export interface McpConnection {
  key: string;
  client: Client;
  transport: Transport;
  server: McpEffectiveServerConfig;
  workspaceRoot: string;
  connectedAt: number;
  lastUsedAt: number;
  activeOperations: number;
  idleShutdownMs: number;
  protocolVersion?: string;
  idleTimer?: ReturnType<typeof setTimeout>;
}

export interface McpConnectionContext {
  workspaceRoot: string;
  env: Record<string, string>;
  server: McpEffectiveServerConfig;
}

export interface McpSamplingHandlerContext {
  workspaceRoot: string;
  server: McpEffectiveServerConfig;
  request: CreateMessageRequest;
  signal?: AbortSignal;
}

export type McpSamplingHandler = (
  context: McpSamplingHandlerContext,
) => Promise<CreateMessageResult>;

interface McpConnectionLease {
  connection: McpConnection;
  release: () => void;
}

export interface McpClientManagerOptions {
  createClient?: (context: McpConnectionContext) => Client;
  createTransport?: (context: McpConnectionContext) => Transport;
  samplingHandler?: McpSamplingHandler;
  loadWorkspaceEnv?: (workspaceRoot: string) => Promise<Record<string, string>>;
  now?: () => number;
  setIdleTimer?: (
    handler: () => void,
    timeoutMs: number,
  ) => ReturnType<typeof setTimeout>;
  clearIdleTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

const MCP_CLIENT_INFO = {
  name: "machdoch",
  version: "0.1.0",
};

const SUPPORTED_SAMPLING_IMAGE_MEDIA_TYPES = new Set<AgentModelImageInput["mediaType"]>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
]);

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const stringifyJsonForPrompt = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const limitSamplingText = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxChars - 24))}\n[truncated by MCP sampling cap]`;
};

const copyProcessEnv = (): Record<string, string> => {
  return Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) =>
      typeof value === "string" ? [[key, value] as const] : [],
    ),
  );
};

const resolveEnvironmentValue = (
  key: string,
  env: Record<string, string>,
): string | undefined => {
  return env[key] ?? process.env[key];
};

const resolveTemplateValue = (
  value: string,
  context: Pick<McpConnectionContext, "workspaceRoot" | "env">,
): string => {
  return value
    .replace(/\$\{workspaceRoot\}/gu, context.workspaceRoot)
    .replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_match, key: string) => {
      return resolveEnvironmentValue(key, context.env) ?? "";
    });
};

const resolveStringRecord = (
  values: Record<string, string> | undefined,
  context: Pick<McpConnectionContext, "workspaceRoot" | "env">,
): Record<string, string> | undefined => {
  if (!values) {
    return undefined;
  }

  const resolved = Object.fromEntries(
    Object.entries(values).flatMap(([key, value]) => {
      const resolvedValue = resolveTemplateValue(value, context);
      return resolvedValue ? [[key, resolvedValue] as const] : [];
    }),
  );

  return Object.keys(resolved).length > 0 ? resolved : undefined;
};

const normalizeSamplingImageMediaType = (
  mimeType: string,
): AgentModelImageInput["mediaType"] | undefined => {
  return SUPPORTED_SAMPLING_IMAGE_MEDIA_TYPES.has(
    mimeType as AgentModelImageInput["mediaType"],
  )
    ? (mimeType as AgentModelImageInput["mediaType"])
    : undefined;
};

const formatSamplingContentBlock = (
  block: SamplingMessageContentBlock,
  imageInputs: AgentModelImageInput[],
  messageIndex: number,
  blockIndex: number,
): string => {
  switch (block.type) {
    case "text":
      return block.text;

    case "image": {
      const mediaType = normalizeSamplingImageMediaType(block.mimeType);

      if (mediaType) {
        imageInputs.push({
          path: `mcp-sampling:${messageIndex}:${blockIndex}`,
          mediaType,
          data: block.data,
          detail: "auto",
        });
      }

      return mediaType
        ? `[image attached: ${block.mimeType}]`
        : `[unsupported image omitted: ${block.mimeType}]`;
    }

    case "audio":
      return `[unsupported audio omitted: ${block.mimeType}]`;

    case "tool_use":
      return `Tool use requested: ${block.name} (${block.id})\n${stringifyJsonForPrompt(block.input)}`;

    case "tool_result":
      return `Tool result for ${block.toolUseId}\n${stringifyJsonForPrompt(block.content)}`;

    default:
      return stringifyJsonForPrompt(block);
  }
};

const formatSamplingMessage = (
  message: SamplingMessage,
  imageInputs: AgentModelImageInput[],
  messageIndex: number,
): string => {
  const blocks = Array.isArray(message.content)
    ? message.content
    : [message.content];
  const content = blocks
    .map((block, blockIndex) =>
      formatSamplingContentBlock(block, imageInputs, messageIndex, blockIndex),
    )
    .filter((line) => line.trim().length > 0)
    .join("\n\n");

  return `${message.role.toUpperCase()}:\n${content || "[empty message]"}`;
};

const createSamplingUserPrompt = (
  request: CreateMessageRequest,
  imageInputs: AgentModelImageInput[],
): string => {
  const contextNote =
    request.params.includeContext && request.params.includeContext !== "none"
      ? `\n\nRequested MCP context inclusion (${request.params.includeContext}) is ignored by machdoch's current sampling bridge.`
      : "";
  const stopNote =
    request.params.stopSequences && request.params.stopSequences.length > 0
      ? `\n\nRequested stop sequences: ${request.params.stopSequences.join(", ")}`
      : "";

  return `${request.params.messages
    .map((message, index) => formatSamplingMessage(message, imageInputs, index))
    .join("\n\n---\n\n")}${contextNote}${stopNote}`;
};

const normalizeSamplingStopReason = (
  stopReason: string | undefined,
  truncated: boolean,
): CreateMessageResult["stopReason"] => {
  if (truncated) {
    return "maxTokens";
  }

  if (!stopReason || stopReason === "stop" || stopReason === "completed") {
    return "endTurn";
  }

  return stopReason;
};

const assertSupportedSamplingRequest = (request: CreateMessageRequest): void => {
  if (request.params.tools && request.params.tools.length > 0) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "MCP sampling tools are not enabled for this machdoch MCP consumer.",
    );
  }
};

const createProviderSamplingHandler: McpSamplingHandler = async ({
  workspaceRoot,
  server,
  request,
  signal,
}) => {
  assertSupportedSamplingRequest(request);

  const config = await loadRuntimeConfig(workspaceRoot);
  const adapter = await createProviderAdapter(config, [], undefined);

  if (!adapter) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "MCP sampling is enabled, but no machdoch model adapter is available for the current workspace runtime configuration.",
    );
  }

  const imageInputs: AgentModelImageInput[] = [];
  const requestedMaxChars = Math.max(1, request.params.maxTokens) * 4;
  const maxChars = Math.min(server.maxResponseChars, requestedMaxChars);
  const turn = await adapter.startTurn({
    model: config.model,
    systemPrompt:
      request.params.systemPrompt ??
      "Answer the MCP server sampling request. Do not call tools.",
    userPrompt: createSamplingUserPrompt(request, imageInputs),
    ...(imageInputs.length > 0 ? { imageInputs } : {}),
    tools: [],
    ...(signal ? { signal } : {}),
  });
  const text = limitSamplingText(turn.text, maxChars);
  const truncated = text.length < turn.text.length;

  return {
    role: "assistant",
    content: {
      type: "text",
      text,
    },
    model: config.model,
    stopReason: normalizeSamplingStopReason(turn.stopReason, truncated),
  };
};

type McpOAuthAuthConfig = Extract<McpAuthConfig, { type: "oauth" }>;

export class McpOAuthAuthorizationRequiredError extends Error {
  constructor(
    readonly serverId: string,
    readonly authorizationUrl: string,
    readonly configPath: string,
  ) {
    super(
      `MCP OAuth authorization is required for server \`${serverId}\`. Open this URL in a browser, complete authorization, then finish the OAuth callback before reconnecting: ${authorizationUrl}`,
    );
  }
}

class ConfiguredMcpOAuthProvider implements OAuthClientProvider {
  private savedClientInformation: OAuthClientInformationMixed | undefined;
  private savedTokens: OAuthTokens | undefined;
  private savedCodeVerifier: string | undefined;
  private savedDiscoveryState: OAuthDiscoveryState | undefined;
  clientMetadataUrl?: string;
  lastSavedPath: string | undefined;
  lastAuthorizationUrl: string | undefined;

  constructor(
    private readonly auth: McpOAuthAuthConfig,
    private readonly context: Pick<McpConnectionContext, "workspaceRoot" | "env">,
    private readonly server: Pick<
      McpEffectiveServerConfig,
      "id" | "transport" | "title" | "description" | "preset"
    >,
  ) {
    const clientMetadataUrl = this.auth.clientMetadataUrl
      ? resolveTemplateValue(this.auth.clientMetadataUrl, this.context)
      : undefined;

    if (clientMetadataUrl) {
      this.clientMetadataUrl = clientMetadataUrl;
    }
  }

  get redirectUrl(): string | URL | undefined {
    return this.auth.redirectUrl
      ? resolveTemplateValue(this.auth.redirectUrl, this.context)
      : undefined;
  }

  get clientMetadata(): OAuthClientMetadata {
    const redirectUrl = this.redirectUrl;
    const scope = this.auth.scopes?.join(" ");
    const hasClientSecret = this.resolveClientSecret() !== undefined;

    return {
      redirect_uris: redirectUrl ? [String(redirectUrl)] : [],
      client_name: "machdoch",
      grant_types: redirectUrl
        ? ["authorization_code", "refresh_token"]
        : ["client_credentials"],
      response_types: redirectUrl ? ["code"] : [],
      token_endpoint_auth_method: hasClientSecret ? "client_secret_basic" : "none",
      ...(scope ? { scope } : {}),
    };
  }

  async state(): Promise<string> {
    const state = randomUUID();
    await this.persistOAuthState({ authorizationState: state });
    return state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const clientId = this.auth.clientId
      ? resolveTemplateValue(this.auth.clientId, this.context)
      : undefined;

    if (!clientId) {
      return (
        this.savedClientInformation ??
        (isRecord(this.auth.clientInformation)
          ? (this.auth.clientInformation as OAuthClientInformationMixed)
          : undefined)
      );
    }

    const clientSecret = this.resolveClientSecret();

    return {
      ...this.clientMetadata,
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    };
  }

  async saveClientInformation(
    clientInformation: OAuthClientInformationMixed,
  ): Promise<void> {
    this.savedClientInformation = clientInformation;
    await this.persistOAuthState({
      clientInformation: clientInformation as unknown as Record<string, unknown>,
    });
  }

  tokens(): OAuthTokens | undefined {
    if (this.savedTokens) {
      return this.savedTokens;
    }

    const accessToken =
      this.auth.accessToken ??
      (this.auth.accessTokenEnv
        ? resolveEnvironmentValue(this.auth.accessTokenEnv, this.context.env)
        : undefined);

    if (!accessToken) {
      return undefined;
    }

    const refreshToken =
      this.auth.refreshToken ??
      (this.auth.refreshTokenEnv
        ? resolveEnvironmentValue(this.auth.refreshTokenEnv, this.context.env)
        : undefined);
    const scope = this.auth.scopes?.join(" ");
    const configuredScope = this.auth.tokenScope ?? scope;

    return {
      access_token: accessToken,
      token_type: this.auth.tokenType ?? "Bearer",
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      ...(this.auth.idToken ? { id_token: this.auth.idToken } : {}),
      ...(this.auth.expiresIn !== undefined
        ? { expires_in: this.auth.expiresIn }
        : {}),
      ...(configuredScope ? { scope: configuredScope } : {}),
    };
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const refreshToken =
      tokens.refresh_token ??
      this.savedTokens?.refresh_token ??
      this.auth.refreshToken ??
      (this.auth.refreshTokenEnv
        ? resolveEnvironmentValue(this.auth.refreshTokenEnv, this.context.env)
        : undefined);

    this.savedTokens = {
      ...this.savedTokens,
      ...tokens,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
    };
    this.savedCodeVerifier = undefined;
    this.lastAuthorizationUrl = undefined;

    await this.persistOAuthState({
      accessToken: this.savedTokens.access_token,
      refreshToken: this.savedTokens.refresh_token,
      tokenType: this.savedTokens.token_type,
      tokenScope: this.savedTokens.scope,
      expiresIn: this.savedTokens.expires_in,
      idToken: this.savedTokens.id_token,
      authorizationUrl: undefined,
      authorizationState: undefined,
      codeVerifier: undefined,
    });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.lastAuthorizationUrl = authorizationUrl.href;
    await this.persistOAuthState({ authorizationUrl: authorizationUrl.href });
    throw new McpOAuthAuthorizationRequiredError(
      this.server.id,
      authorizationUrl.href,
      this.lastSavedPath ?? getUserMcpConfigPath(),
    );
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.savedCodeVerifier = codeVerifier;
    await this.persistOAuthState({ codeVerifier });
  }

  codeVerifier(): string {
    const codeVerifier = this.savedCodeVerifier ?? this.auth.codeVerifier;

    if (!codeVerifier) {
      throw new Error(
        `MCP OAuth code verifier is not available for server \`${this.server.id}\`. Restart the authorization flow.`,
      );
    }

    return codeVerifier;
  }

  prepareTokenRequest(scope?: string): URLSearchParams | undefined {
    if (this.redirectUrl) {
      return undefined;
    }

    const params = new URLSearchParams({
      grant_type: "client_credentials",
    });

    if (scope) {
      params.set("scope", scope);
    }

    return params;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.savedDiscoveryState = state;
    await this.persistOAuthState({
      discoveryState: state as unknown as Record<string, unknown>,
    });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return (
      this.savedDiscoveryState ??
      (isRecord(this.auth.discoveryState)
        ? (this.auth.discoveryState as unknown as OAuthDiscoveryState)
        : undefined)
    );
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    const patch: McpOAuthStatePatch = {};

    if (scope === "all" || scope === "client") {
      this.savedClientInformation = undefined;
      patch.clientInformation = undefined;
    }

    if (scope === "all" || scope === "tokens") {
      this.savedTokens = undefined;
      patch.accessToken = undefined;
      patch.refreshToken = undefined;
      patch.tokenType = undefined;
      patch.tokenScope = undefined;
      patch.expiresIn = undefined;
      patch.idToken = undefined;
    }

    if (scope === "all" || scope === "verifier") {
      this.savedCodeVerifier = undefined;
      patch.codeVerifier = undefined;
      patch.authorizationUrl = undefined;
      patch.authorizationState = undefined;
    }

    if (scope === "all" || scope === "discovery") {
      this.savedDiscoveryState = undefined;
      patch.discoveryState = undefined;
    }

    if (Object.keys(patch).length > 0) {
      await this.persistOAuthState(patch);
    }
  }

  private async persistOAuthState(patch: McpOAuthStatePatch): Promise<void> {
    this.lastSavedPath = await saveUserMcpOAuthState(this.server, patch);
  }

  private resolveClientSecret(): string | undefined {
    return (
      this.auth.clientSecret ??
      (this.auth.clientSecretEnv
        ? resolveEnvironmentValue(this.auth.clientSecretEnv, this.context.env)
        : undefined)
    );
  }
}

const resolveAuthHeaders = (
  auth: McpAuthConfig | undefined,
  context: Pick<McpConnectionContext, "workspaceRoot" | "env">,
): Record<string, string> => {
  if (!auth || auth.type === "none") {
    return {};
  }

  if (auth.type === "bearer") {
    const token =
      auth.token ??
      (auth.tokenEnv ? resolveEnvironmentValue(auth.tokenEnv, context.env) : undefined);

    return token
      ? {
          [auth.headerName ?? "Authorization"]: `Bearer ${token}`,
        }
      : {};
  }

  if (auth.type === "headers") {
    return {
      ...(resolveStringRecord(auth.headers, context) ?? {}),
      ...Object.fromEntries(
        Object.entries(auth.envHeaders ?? {}).flatMap(([headerName, envKey]) => {
          const value = resolveEnvironmentValue(envKey, context.env);
          return value ? [[headerName, value] as const] : [];
        }),
      ),
    };
  }

  return {};
};

const createOAuthProvider = (
  context: McpConnectionContext,
): OAuthClientProvider | undefined => {
  return context.server.auth?.type === "oauth"
    ? new ConfiguredMcpOAuthProvider(
        context.server.auth,
        context,
        context.server,
      )
    : undefined;
};

const createHttpHeaders = (
  transport: Extract<McpTransportConfig, { type: "streamable-http" | "sse" }>,
  context: McpConnectionContext,
): Record<string, string> => {
  return {
    ...(resolveStringRecord(transport.headers, context) ?? {}),
    ...resolveAuthHeaders(context.server.auth, context),
  };
};

const createStdioEnvironment = (
  transport: McpStdioTransportConfig,
  context: McpConnectionContext,
): Record<string, string> => {
  return {
    ...(transport.inheritEnvironment ? copyProcessEnv() : getDefaultEnvironment()),
    ...(resolveStringRecord(transport.env, context) ?? {}),
  };
};

const createTransport = (context: McpConnectionContext): Transport => {
  const { server } = context;
  const transport = server.transport;

  if (transport.type === "stdio") {
    return new StdioClientTransport({
      command: resolveTemplateValue(transport.command, context),
      ...(transport.args
        ? {
            args: transport.args.map((arg) => resolveTemplateValue(arg, context)),
          }
        : {}),
      ...(transport.cwd
        ? { cwd: resolveTemplateValue(transport.cwd, context) }
        : {}),
      env: createStdioEnvironment(transport, context),
      stderr: transport.stderr ?? "pipe",
    });
  }

  if (transport.type === "streamable-http") {
    const headers = createHttpHeaders(transport, context);
    const authProvider = createOAuthProvider(context);

    return new StreamableHTTPClientTransport(
      new URL(resolveTemplateValue(transport.url, context)),
      {
        ...(authProvider ? { authProvider } : {}),
        ...(Object.keys(headers).length > 0
          ? {
              requestInit: {
                headers,
              },
            }
          : {}),
        ...(transport.sessionId ? { sessionId: transport.sessionId } : {}),
      },
    ) as unknown as Transport;
  }

  const headers = createHttpHeaders(transport, context);
  const authProvider = createOAuthProvider(context);

  return new SSEClientTransport(new URL(resolveTemplateValue(transport.url, context)), {
    ...(authProvider ? { authProvider } : {}),
    ...(Object.keys(headers).length > 0
      ? {
          requestInit: {
            headers,
          },
          eventSourceInit: {
            fetch: (input, init) =>
              fetch(input, {
                ...init,
                headers: {
                  ...(init?.headers ?? {}),
                  ...headers,
                },
              }),
          },
        }
      : {}),
  });
};

const getOAuthServerUrl = (context: McpConnectionContext): URL => {
  const transport = context.server.transport;

  if (transport.type === "stdio") {
    throw new Error(
      `MCP OAuth is only supported for HTTP/SSE servers; \`${context.server.id}\` uses stdio.`,
    );
  }

  return new URL(resolveTemplateValue(transport.url, context));
};

const getOAuthScope = (auth: McpOAuthAuthConfig): string | undefined => {
  return auth.scopes && auth.scopes.length > 0 ? auth.scopes.join(" ") : undefined;
};

interface ParsedOAuthAuthorizationResponse {
  code: string;
  state?: string;
}

const parseOAuthAuthorizationResponse = (
  authorizationResponse: string,
): ParsedOAuthAuthorizationResponse => {
  const value = authorizationResponse.trim();

  if (!value) {
    throw new Error("Expected an OAuth authorization code or callback URL.");
  }

  const parseParams = (params: URLSearchParams): ParsedOAuthAuthorizationResponse => {
    const error = params.get("error");

    if (error) {
      const description = params.get("error_description");
      throw new Error(
        `MCP OAuth authorization failed: ${description ? `${error}: ${description}` : error}`,
      );
    }

    const code = normalizeOptionalString(params.get("code") ?? undefined);

    if (!code) {
      throw new Error("OAuth callback URL does not contain a code parameter.");
    }

    const state = normalizeOptionalString(params.get("state") ?? undefined);

    return {
      code,
      ...(state ? { state } : {}),
    };
  };

  if (value.startsWith("?")) {
    return parseParams(new URLSearchParams(value.slice(1)));
  }

  try {
    return parseParams(new URL(value).searchParams);
  } catch {
    return { code: value };
  }
};

const validateOAuthState = (
  server: McpEffectiveServerConfig,
  state: string | undefined,
): boolean | undefined => {
  const expectedState =
    server.auth?.type === "oauth" ? server.auth.authorizationState : undefined;

  if (!expectedState) {
    return undefined;
  }

  if (state && state !== expectedState) {
    throw new Error(
      `MCP OAuth state mismatch for server \`${server.id}\`. Restart the authorization flow.`,
    );
  }

  return state === expectedState;
};

const createOAuthFlowResult = (
  serverId: string,
  result: AuthResult,
  provider: ConfiguredMcpOAuthProvider,
  extra: Pick<McpOAuthFlowResult, "stateVerified"> = {},
): McpOAuthFlowResult => {
  const status =
    result === "AUTHORIZED" ? "authorized" : "authorization-required";

  return {
    serverId,
    status,
    configPath: provider.lastSavedPath ?? getUserMcpConfigPath(),
    ...(provider.lastAuthorizationUrl
      ? { authorizationUrl: provider.lastAuthorizationUrl }
      : {}),
    ...extra,
  };
};

const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/u;

const hasUriScheme = (value: string): boolean => {
  return (
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) &&
    !WINDOWS_ABSOLUTE_PATH_PATTERN.test(value)
  );
};

const createClientCapabilities = (
  server: McpEffectiveServerConfig,
): ClientCapabilities => {
  const capabilities: ClientCapabilities = {};

  if (server.roots !== "disabled") {
    capabilities.roots = { listChanged: false };
  }

  if (server.sampling !== "disabled") {
    capabilities.sampling = {};
  }

  if (server.tasks !== "disabled") {
    capabilities.tasks = {
      list: {},
      cancel: {},
    };
  }

  return capabilities;
};

const createClient = (context: McpConnectionContext): Client => {
  return new Client(MCP_CLIENT_INFO, {
    capabilities: createClientCapabilities(context.server),
    enforceStrictCapabilities: false,
    defaultTaskPollInterval: 2_500,
    maxTaskQueueSize: 1_000,
  });
};

const createRootName = (uri: string, fallback: string): string => {
  try {
    const parsed = new URL(uri);
    const pathname = decodeURIComponent(parsed.pathname);
    const name = basename(pathname);

    return name || parsed.hostname || fallback;
  } catch {
    return fallback;
  }
};

const createFileRoot = (
  rootPath: string,
  fallbackName: string,
): ListRootsResult["roots"][number] => {
  const uri = pathToFileURL(rootPath).href;

  return {
    uri,
    name: basename(rootPath) || fallbackName,
  };
};

const resolveConfiguredRoot = (
  entry: string,
  context: McpConnectionContext,
): ListRootsResult["roots"][number] | undefined => {
  const resolvedEntry = resolveTemplateValue(entry, context).trim();

  if (!resolvedEntry) {
    return undefined;
  }

  if (hasUriScheme(resolvedEntry)) {
    return {
      uri: resolvedEntry,
      name: createRootName(resolvedEntry, "MCP root"),
    };
  }

  const rootPath = isAbsolute(resolvedEntry)
    ? resolvedEntry
    : resolve(context.workspaceRoot, resolvedEntry);

  return createFileRoot(rootPath, basename(rootPath) || "MCP root");
};

const dedupeRoots = (
  roots: ListRootsResult["roots"],
): ListRootsResult["roots"] => {
  const seenUris = new Set<string>();

  return roots.filter((root) => {
    if (seenUris.has(root.uri)) {
      return false;
    }

    seenUris.add(root.uri);
    return true;
  });
};

const resolveMcpRoots = (
  context: McpConnectionContext,
): ListRootsResult["roots"] => {
  if (context.server.roots === "disabled") {
    return [];
  }

  if (context.server.roots === "workspace") {
    return [
      createFileRoot(
        context.workspaceRoot,
        basename(context.workspaceRoot) || "Workspace",
      ),
    ];
  }

  return dedupeRoots(
    context.server.roots.flatMap((entry) => {
      const root = resolveConfiguredRoot(entry, context);
      return root ? [root] : [];
    }),
  );
};

const registerClientRequestHandlers = (
  client: Client,
  context: McpConnectionContext,
  samplingHandler: McpSamplingHandler,
): void => {
  if (context.server.roots !== "disabled") {
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: resolveMcpRoots(context),
    }));
  }

  if (context.server.sampling !== "disabled") {
    client.setRequestHandler(CreateMessageRequestSchema, async (request, extra) => {
      assertSupportedSamplingRequest(request);

      const handlerContext: McpSamplingHandlerContext = {
        workspaceRoot: context.workspaceRoot,
        server: context.server,
        request,
      };

      if (extra.signal) {
        handlerContext.signal = extra.signal;
      }

      return samplingHandler(handlerContext);
    });
  }
};

const maybeUnrefTimer = (timer: ReturnType<typeof setTimeout>): void => {
  const candidate = timer as { unref?: unknown };

  if (typeof candidate.unref === "function") {
    candidate.unref();
  }
};

const readTransportProtocolVersion = (
  transport: Transport,
): string | undefined => {
  const value = (transport as { protocolVersion?: unknown }).protocolVersion;

  return typeof value === "string" ? value : undefined;
};

const captureTransportProtocolVersion = (
  transport: Transport,
): (() => string | undefined) => {
  let protocolVersion: string | undefined;
  const originalSetProtocolVersion = transport.setProtocolVersion;

  if (originalSetProtocolVersion) {
    transport.setProtocolVersion = (version: string): void => {
      protocolVersion = version;
      originalSetProtocolVersion.call(transport, version);
    };
  }

  return () => protocolVersion ?? readTransportProtocolVersion(transport);
};

const createConnectionKey = (
  workspaceRoot: string,
  server: McpEffectiveServerConfig,
): string => {
  return JSON.stringify({
    workspaceRoot,
    serverId: server.id,
    transport: server.transport,
    auth: server.auth ?? null,
  });
};

const createRequestOptions = (
  server: McpEffectiveServerConfig,
  options: McpOperationOptions = {},
): RequestOptions => {
  return {
    timeout: server.timeoutMs,
    maxTotalTimeout: server.maxTotalTimeoutMs,
    resetTimeoutOnProgress: true,
    ...(options.signal ? { signal: options.signal } : {}),
    onprogress: (progress) => {
      const totalSuffix =
        progress.total !== undefined ? `/${progress.total}` : "";
      const message = progress.message
        ? `${progress.progress}${totalSuffix}: ${progress.message}`
        : `${progress.progress}${totalSuffix}`;

      void Promise.resolve(options.onProgress?.(message)).catch(() => undefined);
    },
  };
};

const createTaskRequestOptions = (
  server: McpEffectiveServerConfig,
  options: McpOperationOptions = {},
): RequestOptions => {
  return {
    ...createRequestOptions(server, options),
    task: {},
  };
};

const isTaskRequiredToolError = (error: unknown): boolean => {
  return (
    error instanceof Error &&
    error.message.includes("requires task-based execution") &&
    error.message.includes("callToolStream")
  );
};

const emitTaskStreamProgress = (
  options: McpOperationOptions,
  message: ResponseMessage<CallToolResult>,
): void => {
  if (message.type !== "taskCreated" && message.type !== "taskStatus") {
    return;
  }

  const task = message.task;
  const statusMessage = task.statusMessage ? `: ${task.statusMessage}` : "";
  const prefix = message.type === "taskCreated" ? "created" : task.status;

  void Promise.resolve(
    options.onProgress?.(`task ${task.taskId} ${prefix}${statusMessage}`),
  ).catch(() => undefined);
};

const collectTaskToolResult = async (
  client: Client,
  server: McpEffectiveServerConfig,
  toolName: string,
  args: Record<string, unknown>,
  options: McpOperationOptions,
): Promise<CallToolResult> => {
  let finalResult: CallToolResult | undefined;
  const stream = client.experimental.tasks.callToolStream(
    {
      name: toolName,
      arguments: args,
      _meta: {
        progressToken: randomUUID(),
      },
    },
    CallToolResultSchema,
    createTaskRequestOptions(server, options),
  );

  for await (const message of stream) {
    emitTaskStreamProgress(options, message);

    if (message.type === "error") {
      throw message.error;
    }

    if (message.type === "result") {
      finalResult = message.result;
    }
  }

  if (!finalResult) {
    throw new Error(
      `MCP task tool \`${toolName}\` finished without returning a result.`,
    );
  }

  return finalResult;
};

const shouldCacheToolResult = (
  result: CallToolResult,
): boolean => {
  return result.isError !== true;
};

const resolveOperationCachePolicy = (
  options: McpOperationOptions,
  server: McpEffectiveServerConfig,
  operation: McpOperationCacheOptions["operation"],
  requiresReadOnly = false,
): McpOperationCacheOptions | undefined => {
  if (!options.cache || options.cache.operation !== operation) {
    return undefined;
  }

  if (requiresReadOnly && options.cache.readOnly !== true) {
    return undefined;
  }

  return {
    ...options.cache,
    enabled: options.cache.enabled ?? server.cache.enabled,
    ttlMs: options.cache.ttlMs ?? server.cache.ttlMs,
    forceRefresh: options.cache.forceRefresh ?? server.cache.forceRefresh,
  };
};

const hasCapability = (
  capabilities: Record<string, unknown> | undefined,
  key: "tools" | "resources" | "prompts",
): boolean => {
  return isRecord(capabilities?.[key]);
};

const listAllTools = async (
  client: Client,
  server: McpEffectiveServerConfig,
  options: McpOperationOptions,
): Promise<ListToolsResult["tools"]> => {
  const tools: ListToolsResult["tools"] = [];
  let cursor: string | undefined;

  do {
    const result = await client.listTools(
      cursor ? { cursor } : undefined,
      createRequestOptions(server, options),
    );
    tools.push(...result.tools);
    cursor = result.nextCursor;
  } while (cursor);

  return tools;
};

const listAllResources = async (
  client: Client,
  server: McpEffectiveServerConfig,
  options: McpOperationOptions,
): Promise<ListResourcesResult["resources"]> => {
  const resources: ListResourcesResult["resources"] = [];
  let cursor: string | undefined;

  do {
    const result = await client.listResources(
      cursor ? { cursor } : undefined,
      createRequestOptions(server, options),
    );
    resources.push(...result.resources);
    cursor = result.nextCursor;
  } while (cursor);

  return resources;
};

const listAllResourceTemplates = async (
  client: Client,
  server: McpEffectiveServerConfig,
  options: McpOperationOptions,
): Promise<ListResourceTemplatesResult["resourceTemplates"]> => {
  const templates: ListResourceTemplatesResult["resourceTemplates"] = [];
  let cursor: string | undefined;

  do {
    const result = await client.listResourceTemplates(
      cursor ? { cursor } : undefined,
      createRequestOptions(server, options),
    );
    templates.push(...result.resourceTemplates);
    cursor = result.nextCursor;
  } while (cursor);

  return templates;
};

const listAllPrompts = async (
  client: Client,
  server: McpEffectiveServerConfig,
  options: McpOperationOptions,
): Promise<ListPromptsResult["prompts"]> => {
  const prompts: ListPromptsResult["prompts"] = [];
  let cursor: string | undefined;

  do {
    const result = await client.listPrompts(
      cursor ? { cursor } : undefined,
      createRequestOptions(server, options),
    );
    prompts.push(...result.prompts);
    cursor = result.nextCursor;
  } while (cursor);

  return prompts;
};

const normalizeTool = (tool: ListToolsResult["tools"][number]): McpDiscoveredTool => {
  return {
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.annotations
      ? {
          annotations: {
            ...(tool.annotations.readOnlyHint !== undefined
              ? { readOnlyHint: tool.annotations.readOnlyHint }
              : {}),
            ...(tool.annotations.destructiveHint !== undefined
              ? { destructiveHint: tool.annotations.destructiveHint }
              : {}),
            ...(tool.annotations.idempotentHint !== undefined
              ? { idempotentHint: tool.annotations.idempotentHint }
              : {}),
            ...(tool.annotations.openWorldHint !== undefined
              ? { openWorldHint: tool.annotations.openWorldHint }
              : {}),
          },
        }
      : {}),
    ...(tool.execution?.taskSupport
      ? { taskSupport: tool.execution.taskSupport }
      : {}),
  };
};

const normalizeResource = (
  resource: ListResourcesResult["resources"][number],
): McpDiscoveredResource => {
  return {
    uri: resource.uri,
    name: resource.name,
    ...(resource.title ? { title: resource.title } : {}),
    ...(resource.description ? { description: resource.description } : {}),
    ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
    ...(typeof resource.size === "number" ? { size: resource.size } : {}),
  };
};

const normalizeResourceTemplate = (
  template: ListResourceTemplatesResult["resourceTemplates"][number],
): McpDiscoveredResourceTemplate => {
  return {
    uriTemplate: template.uriTemplate,
    name: template.name,
    ...(template.title ? { title: template.title } : {}),
    ...(template.description ? { description: template.description } : {}),
    ...(template.mimeType ? { mimeType: template.mimeType } : {}),
  };
};

const normalizePrompt = (
  prompt: ListPromptsResult["prompts"][number],
): McpDiscoveredPrompt => {
  return {
    name: prompt.name,
    ...(prompt.title ? { title: prompt.title } : {}),
    ...(prompt.description ? { description: prompt.description } : {}),
    ...(prompt.arguments
      ? {
          arguments: prompt.arguments.map((argument) => ({
            name: argument.name,
            ...(argument.description
              ? { description: argument.description }
              : {}),
            ...(argument.required !== undefined
              ? { required: argument.required }
              : {}),
          })),
        }
      : {}),
  };
};

export class McpClientManager {
  private readonly connections = new Map<string, McpConnection>();
  private readonly createClientImpl: (context: McpConnectionContext) => Client;
  private readonly createTransportImpl: (context: McpConnectionContext) => Transport;
  private readonly samplingHandler: McpSamplingHandler;
  private readonly loadWorkspaceEnvImpl: (
    workspaceRoot: string,
  ) => Promise<Record<string, string>>;
  private readonly now: () => number;
  private readonly setIdleTimerImpl: (
    handler: () => void,
    timeoutMs: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly clearIdleTimerImpl: (
    timer: ReturnType<typeof setTimeout>,
  ) => void;

  constructor(options: McpClientManagerOptions = {}) {
    this.createClientImpl = options.createClient ?? createClient;
    this.createTransportImpl = options.createTransport ?? createTransport;
    this.samplingHandler = options.samplingHandler ?? createProviderSamplingHandler;
    this.loadWorkspaceEnvImpl = options.loadWorkspaceEnv ?? loadWorkspaceEnv;
    this.now = options.now ?? Date.now;
    this.setIdleTimerImpl = options.setIdleTimer ?? setTimeout;
    this.clearIdleTimerImpl = options.clearIdleTimer ?? clearTimeout;
  }

  private clearConnectionIdleTimer(connection: McpConnection): void {
    if (!connection.idleTimer) {
      return;
    }

    this.clearIdleTimerImpl(connection.idleTimer);
    delete connection.idleTimer;
  }

  private scheduleIdleShutdown(connection: McpConnection): void {
    this.clearConnectionIdleTimer(connection);

    if (connection.idleShutdownMs <= 0 || connection.activeOperations > 0) {
      return;
    }

    const elapsedMs = Math.max(0, this.now() - connection.lastUsedAt);
    const remainingMs = Math.max(0, connection.idleShutdownMs - elapsedMs);
    const timer = this.setIdleTimerImpl(() => {
      void this.closeConnectionIfIdle(connection.key, connection);
    }, remainingMs);

    maybeUnrefTimer(timer);
    connection.idleTimer = timer;
  }

  private async closeConnection(
    key: string,
    connection: McpConnection,
  ): Promise<void> {
    this.clearConnectionIdleTimer(connection);

    if (this.connections.get(key) === connection) {
      this.connections.delete(key);
    }

    await connection.transport.close().catch(() => undefined);
  }

  private async closeConnectionIfIdle(
    key: string,
    connection: McpConnection,
  ): Promise<void> {
    if (this.connections.get(key) !== connection) {
      return;
    }

    if (connection.activeOperations > 0) {
      this.scheduleIdleShutdown(connection);
      return;
    }

    if (
      connection.idleShutdownMs > 0 &&
      this.now() - connection.lastUsedAt < connection.idleShutdownMs
    ) {
      this.scheduleIdleShutdown(connection);
      return;
    }

    await this.closeConnection(key, connection);
  }

  private async getOrCreateConnection(
    workspaceRoot: string,
    server: McpEffectiveServerConfig,
  ): Promise<McpConnection> {
    const key = createConnectionKey(workspaceRoot, server);
    const current = this.connections.get(key);

    if (current) {
      return current;
    }

    const env = await this.loadWorkspaceEnvImpl(workspaceRoot);
    const context: McpConnectionContext = { workspaceRoot, env, server };
    const transport = this.createTransportImpl(context);
    const client = this.createClientImpl(context);
    const getProtocolVersion = captureTransportProtocolVersion(transport);

    registerClientRequestHandlers(client, context, this.samplingHandler);

    await client.connect(transport, {
      timeout: server.timeoutMs,
      maxTotalTimeout: server.maxTotalTimeoutMs,
    });

    const connectedAt = this.now();
    const protocolVersion = getProtocolVersion();
    const connection: McpConnection = {
      key,
      client,
      transport,
      server,
      workspaceRoot,
      connectedAt,
      lastUsedAt: connectedAt,
      activeOperations: 0,
      idleShutdownMs: server.idleShutdownMs,
      ...(protocolVersion ? { protocolVersion } : {}),
    };

    this.connections.set(key, connection);
    this.scheduleIdleShutdown(connection);
    return connection;
  }

  private async acquireConnection(
    workspaceRoot: string,
    server: McpEffectiveServerConfig,
  ): Promise<McpConnectionLease> {
    const connection = await this.getOrCreateConnection(workspaceRoot, server);
    let released = false;

    this.clearConnectionIdleTimer(connection);
    connection.activeOperations += 1;
    connection.lastUsedAt = this.now();

    return {
      connection,
      release: () => {
        if (released) {
          return;
        }

        released = true;
        connection.activeOperations = Math.max(0, connection.activeOperations - 1);
        connection.lastUsedAt = this.now();
        this.scheduleIdleShutdown(connection);
      },
    };
  }

  private async withConnection<T>(
    workspaceRoot: string,
    server: McpEffectiveServerConfig,
    operation: (connection: McpConnection) => Promise<T>,
    options: { retryAfterConnectionFailure?: boolean } = {},
  ): Promise<T> {
    const lease = await this.acquireConnection(workspaceRoot, server);

    try {
      return await operation(lease.connection);
    } catch (error) {
      const failedConnection = lease.connection;
      lease.release();
      await this.closeConnection(failedConnection.key, failedConnection);

      if (!options.retryAfterConnectionFailure) {
        throw error;
      }

      const retryLease = await this.acquireConnection(workspaceRoot, server);

      try {
        return await operation(retryLease.connection);
      } finally {
        retryLease.release();
      }
    } finally {
      lease.release();
    }
  }

  async getConnection(
    workspaceRoot: string,
    server: McpEffectiveServerConfig,
  ): Promise<McpConnection> {
    const lease = await this.acquireConnection(workspaceRoot, server);
    const { connection } = lease;
    lease.release();
    return connection;
  }

  listConnections(): McpConnectionStatus[] {
    return [...this.connections.values()].map((connection) => {
      const closesAt =
        connection.idleShutdownMs > 0 && connection.activeOperations === 0
          ? new Date(connection.lastUsedAt + connection.idleShutdownMs).toISOString()
          : undefined;

      return {
        workspaceRoot: connection.workspaceRoot,
        serverId: connection.server.id,
        transportType: connection.server.transport.type,
        ...(connection.protocolVersion
          ? { protocolVersion: connection.protocolVersion }
          : {}),
        connectedAt: new Date(connection.connectedAt).toISOString(),
        lastUsedAt: new Date(connection.lastUsedAt).toISOString(),
        activeOperations: connection.activeOperations,
        idleShutdownMs: connection.idleShutdownMs,
        roots: connection.server.roots,
        sampling: connection.server.sampling,
        tasks: connection.server.tasks,
        ...(closesAt ? { closesAt } : {}),
      };
    });
  }

  async closeServer(workspaceRoot: string, serverId: string): Promise<void> {
    const pending = [...this.connections.entries()].filter(([, connection]) => {
      return connection.server.id === serverId && connection.workspaceRoot === workspaceRoot;
    });

    await Promise.all(
      pending.map(async ([key, connection]) => {
        await this.closeConnection(key, connection);
      }),
    );
  }

  async closeAll(): Promise<void> {
    const connections = [...this.connections.entries()];
    this.connections.clear();

    await Promise.all(
      connections.map(([, connection]) =>
        this.closeConnection(connection.key, connection),
      ),
    );
  }

  async beginOAuth(
    workspaceRoot: string,
    serverId: string,
    options: McpOperationOptions = {},
  ): Promise<McpOAuthFlowResult> {
    const config = await loadMcpConfig(workspaceRoot, options.configOverride);
    const server = getEnabledMcpServer(config, serverId);

    if (!server) {
      throw new Error(`MCP server \`${serverId}\` is not configured or not enabled.`);
    }

    if (server.auth?.type !== "oauth") {
      throw new Error(`MCP server \`${server.id}\` is not configured for OAuth.`);
    }

    const env = await this.loadWorkspaceEnvImpl(workspaceRoot);
    const context: McpConnectionContext = { workspaceRoot, env, server };
    const provider = new ConfiguredMcpOAuthProvider(server.auth, context, server);
    const scope = getOAuthScope(server.auth);

    try {
      const result = await runOAuthFlow(provider, {
        serverUrl: getOAuthServerUrl(context),
        ...(scope ? { scope } : {}),
      });

      return createOAuthFlowResult(server.id, result, provider);
    } catch (error) {
      if (error instanceof McpOAuthAuthorizationRequiredError) {
        return {
          serverId: error.serverId,
          status: "authorization-required",
          configPath: error.configPath,
          authorizationUrl: error.authorizationUrl,
        };
      }

      throw error;
    }
  }

  async finishOAuth(
    workspaceRoot: string,
    serverId: string,
    authorizationResponse: string,
    options: McpOperationOptions = {},
  ): Promise<McpOAuthFlowResult> {
    const config = await loadMcpConfig(workspaceRoot, options.configOverride);
    const server = getEnabledMcpServer(config, serverId);

    if (!server) {
      throw new Error(`MCP server \`${serverId}\` is not configured or not enabled.`);
    }

    if (server.auth?.type !== "oauth") {
      throw new Error(`MCP server \`${server.id}\` is not configured for OAuth.`);
    }

    const parsed = parseOAuthAuthorizationResponse(authorizationResponse);
    const stateVerified = validateOAuthState(server, parsed.state);
    const env = await this.loadWorkspaceEnvImpl(workspaceRoot);
    const context: McpConnectionContext = { workspaceRoot, env, server };
    const provider = new ConfiguredMcpOAuthProvider(server.auth, context, server);
    const scope = getOAuthScope(server.auth);
    const result = await runOAuthFlow(provider, {
      serverUrl: getOAuthServerUrl(context),
      authorizationCode: parsed.code,
      ...(scope ? { scope } : {}),
    });

    await this.closeServer(workspaceRoot, server.id);

    return createOAuthFlowResult(server.id, result, provider, {
      ...(stateVerified !== undefined ? { stateVerified } : {}),
    });
  }

  async discoverServer(
    workspaceRoot: string,
    server: McpEffectiveServerConfig,
    options: McpOperationOptions = {},
  ): Promise<McpServerDiscovery> {
    return this.withConnection(
      workspaceRoot,
      server,
      async ({ client, protocolVersion }) => {
        const capabilities = client.getServerCapabilities() as
          | Record<string, unknown>
          | undefined;
        const tools = hasCapability(capabilities, "tools")
          ? await listAllTools(client, server, options)
          : [];
        const resources = hasCapability(capabilities, "resources")
          ? await listAllResources(client, server, options)
          : [];
        const resourceTemplates = hasCapability(capabilities, "resources")
          ? await listAllResourceTemplates(client, server, options)
          : [];
        const prompts = hasCapability(capabilities, "prompts")
          ? await listAllPrompts(client, server, options)
          : [];
        const serverVersion = client.getServerVersion();
        const instructions = client.getInstructions();

        return enrichMcpDiscoveryMetadata({
          serverId: server.id,
          discoveredAt: new Date().toISOString(),
          ...(protocolVersion ? { protocolVersion } : {}),
          ...(serverVersion
            ? {
                serverVersion: {
                  ...(serverVersion.name ? { name: serverVersion.name } : {}),
                  ...(serverVersion.version
                    ? { version: serverVersion.version }
                    : {}),
                },
              }
            : {}),
          ...(instructions ? { instructions } : {}),
          transportType: server.transport.type,
          ...(capabilities ? { capabilities } : {}),
          tools: tools.map(normalizeTool),
          resources: resources.map(normalizeResource),
          resourceTemplates: resourceTemplates.map(normalizeResourceTemplate),
          prompts: prompts.map(normalizePrompt),
        });
      },
      { retryAfterConnectionFailure: true },
    );
  }

  async discoverServerById(
    workspaceRoot: string,
    serverId: string,
    options: McpOperationOptions & { persist?: boolean } = {},
  ): Promise<{
    discovery: McpServerDiscovery;
    cachePath?: string;
    changes?: McpDiscoveryChangeSet;
  }> {
    const config = await loadMcpConfig(workspaceRoot, options.configOverride);
    const server = getEnabledMcpServer(config, serverId);

    if (!server) {
      throw new Error(`MCP server \`${serverId}\` is not configured or not enabled.`);
    }

    const previousDiscovery =
      options.persist === true
        ? (await loadMcpDiscoveryCache(workspaceRoot)).servers[server.id]
        : undefined;
    const discovery = await this.discoverServer(workspaceRoot, server, options);
    const changes =
      options.persist === true
        ? compareMcpDiscoveries(previousDiscovery, discovery)
        : undefined;
    const cachePath =
      options.persist === true
        ? await saveWorkspaceMcpDiscovery(workspaceRoot, discovery)
        : undefined;

    return {
      discovery,
      ...(cachePath ? { cachePath } : {}),
      ...(changes ? { changes } : {}),
    };
  }

  async callTool(
    workspaceRoot: string,
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    options: McpOperationOptions = {},
  ): Promise<CallToolResult> {
    const config = await loadMcpConfig(workspaceRoot, options.configOverride);
    const server = getEnabledMcpServer(config, serverId);

    if (!server) {
      throw new Error(`MCP server \`${serverId}\` is not configured or not enabled.`);
    }

    const cachePolicy = resolveOperationCachePolicy(options, server, "tool", true);
    const cacheLookup = mcpRunCacheManager.get<CallToolResult>({
      workspaceRoot,
      serverId: server.id,
      operation: "tool",
      target: toolName,
      args,
      ...(cachePolicy ? { policy: cachePolicy } : {}),
    });

    if (cacheLookup.hit && cacheLookup.entry) {
      return cacheLookup.entry.value;
    }

    const cachedDiscovery = (await loadMcpDiscoveryCache(workspaceRoot)).servers[
      server.id
    ];
    const requiresTaskStream =
      cachedDiscovery?.tools.some(
        (tool) => tool.name === toolName && tool.taskSupport === "required",
      ) ?? false;

    if (requiresTaskStream && server.tasks === "disabled") {
      throw new Error(
        `MCP tool \`${server.id}.${toolName}\` requires task execution, but tasks are disabled for this server.`,
      );
    }

    const result = await this.withConnection(workspaceRoot, server, async ({ client }) => {
      if (requiresTaskStream) {
        return collectTaskToolResult(client, server, toolName, args, options);
      }

      try {
        const result = await client.callTool(
          {
            name: toolName,
            arguments: args,
            _meta: {
              progressToken: randomUUID(),
            },
          },
          undefined,
          createRequestOptions(server, options),
        );

        return result as CallToolResult;
      } catch (error) {
        if (server.tasks !== "disabled" && isTaskRequiredToolError(error)) {
          return collectTaskToolResult(client, server, toolName, args, options);
        }

        throw error;
      }
    });

    if (cachePolicy && shouldCacheToolResult(result)) {
      mcpRunCacheManager.set(
        {
          workspaceRoot,
          serverId: server.id,
          operation: "tool",
          target: toolName,
          args,
          policy: cachePolicy,
        },
        result,
      );
    }

    return result;
  }

  async listTasks(
    workspaceRoot: string,
    serverId: string,
    cursor: string | undefined,
    options: McpOperationOptions = {},
  ): Promise<ListTasksResult> {
    const config = await loadMcpConfig(workspaceRoot, options.configOverride);
    const server = getEnabledMcpServer(config, serverId);

    if (!server) {
      throw new Error(`MCP server \`${serverId}\` is not configured or not enabled.`);
    }

    if (server.tasks === "disabled") {
      throw new Error(`MCP tasks are disabled for server \`${serverId}\`.`);
    }

    return this.withConnection(
      workspaceRoot,
      server,
      ({ client }) =>
        client.experimental.tasks.listTasks(
          cursor,
          createRequestOptions(server, options),
        ),
      { retryAfterConnectionFailure: true },
    );
  }

  async getTask(
    workspaceRoot: string,
    serverId: string,
    taskId: string,
    options: McpOperationOptions = {},
  ): Promise<GetTaskResult> {
    const config = await loadMcpConfig(workspaceRoot, options.configOverride);
    const server = getEnabledMcpServer(config, serverId);

    if (!server) {
      throw new Error(`MCP server \`${serverId}\` is not configured or not enabled.`);
    }

    if (server.tasks === "disabled") {
      throw new Error(`MCP tasks are disabled for server \`${serverId}\`.`);
    }

    return this.withConnection(
      workspaceRoot,
      server,
      ({ client }) =>
        client.experimental.tasks.getTask(
          taskId,
          createRequestOptions(server, options),
        ),
      { retryAfterConnectionFailure: true },
    );
  }

  async getTaskResult(
    workspaceRoot: string,
    serverId: string,
    taskId: string,
    options: McpOperationOptions = {},
  ): Promise<GetTaskPayloadResult> {
    const config = await loadMcpConfig(workspaceRoot, options.configOverride);
    const server = getEnabledMcpServer(config, serverId);

    if (!server) {
      throw new Error(`MCP server \`${serverId}\` is not configured or not enabled.`);
    }

    if (server.tasks === "disabled") {
      throw new Error(`MCP tasks are disabled for server \`${serverId}\`.`);
    }

    return this.withConnection(
      workspaceRoot,
      server,
      ({ client }) =>
        client.experimental.tasks.getTaskResult(
          taskId,
          GetTaskPayloadResultSchema,
          createRequestOptions(server, options),
        ),
      { retryAfterConnectionFailure: true },
    );
  }

  async cancelTask(
    workspaceRoot: string,
    serverId: string,
    taskId: string,
    options: McpOperationOptions = {},
  ): Promise<CancelTaskResult> {
    const config = await loadMcpConfig(workspaceRoot, options.configOverride);
    const server = getEnabledMcpServer(config, serverId);

    if (!server) {
      throw new Error(`MCP server \`${serverId}\` is not configured or not enabled.`);
    }

    if (server.tasks === "disabled") {
      throw new Error(`MCP tasks are disabled for server \`${serverId}\`.`);
    }

    return this.withConnection(workspaceRoot, server, ({ client }) =>
      client.experimental.tasks.cancelTask(
        taskId,
        createRequestOptions(server, options),
      ),
    );
  }

  async readResource(
    workspaceRoot: string,
    serverId: string,
    uri: string,
    options: McpOperationOptions = {},
  ): Promise<ReadResourceResult> {
    const config = await loadMcpConfig(workspaceRoot, options.configOverride);
    const server = getEnabledMcpServer(config, serverId);

    if (!server) {
      throw new Error(`MCP server \`${serverId}\` is not configured or not enabled.`);
    }

    const cachePolicy = resolveOperationCachePolicy(options, server, "resource");
    const cacheLookup = mcpRunCacheManager.get<ReadResourceResult>({
      workspaceRoot,
      serverId: server.id,
      operation: "resource",
      target: uri,
      ...(cachePolicy ? { policy: cachePolicy } : {}),
    });

    if (cacheLookup.hit && cacheLookup.entry) {
      return cacheLookup.entry.value;
    }

    const result = await this.withConnection(
      workspaceRoot,
      server,
      ({ client }) =>
        client.readResource({ uri }, createRequestOptions(server, options)),
      { retryAfterConnectionFailure: true },
    );

    if (cachePolicy) {
      mcpRunCacheManager.set(
        {
          workspaceRoot,
          serverId: server.id,
          operation: "resource",
          target: uri,
          policy: cachePolicy,
        },
        result,
      );
    }

    return result;
  }

  async getPrompt(
    workspaceRoot: string,
    serverId: string,
    promptName: string,
    args: Record<string, string>,
    options: McpOperationOptions = {},
  ): Promise<GetPromptResult> {
    const config = await loadMcpConfig(workspaceRoot, options.configOverride);
    const server = getEnabledMcpServer(config, serverId);

    if (!server) {
      throw new Error(`MCP server \`${serverId}\` is not configured or not enabled.`);
    }

    const cachePolicy = resolveOperationCachePolicy(options, server, "prompt");
    const cacheLookup = mcpRunCacheManager.get<GetPromptResult>({
      workspaceRoot,
      serverId: server.id,
      operation: "prompt",
      target: promptName,
      args,
      ...(cachePolicy ? { policy: cachePolicy } : {}),
    });

    if (cacheLookup.hit && cacheLookup.entry) {
      return cacheLookup.entry.value;
    }

    const result = await this.withConnection(
      workspaceRoot,
      server,
      ({ client }) =>
        client.getPrompt(
          {
            name: promptName,
            arguments: args,
          },
          createRequestOptions(server, options),
        ),
      { retryAfterConnectionFailure: true },
    );

    if (cachePolicy) {
      mcpRunCacheManager.set(
        {
          workspaceRoot,
          serverId: server.id,
          operation: "prompt",
          target: promptName,
          args,
          policy: cachePolicy,
        },
        result,
      );
    }

    return result;
  }
}

export const mcpClientManager = new McpClientManager();

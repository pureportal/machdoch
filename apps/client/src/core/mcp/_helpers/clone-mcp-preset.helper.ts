import type {
  McpAuthConfig,
  McpPresetDefinition,
  McpServerConfig,
  McpTransportConfig,
} from "../types.js";

const cloneMcpTransportConfig = (
  transport: McpTransportConfig,
): McpTransportConfig => {
  switch (transport.type) {
    case "stdio":
      return {
        ...transport,
        ...(transport.args ? { args: [...transport.args] } : {}),
        ...(transport.env ? { env: { ...transport.env } } : {}),
      };
    case "streamable-http":
      return {
        ...transport,
        ...(transport.headers ? { headers: { ...transport.headers } } : {}),
      };
    case "sse":
      return {
        ...transport,
        ...(transport.headers ? { headers: { ...transport.headers } } : {}),
      };
  }
};

const cloneMcpAuthConfig = (auth: McpAuthConfig): McpAuthConfig => {
  switch (auth.type) {
    case "none":
    case "bearer":
      return { ...auth };
    case "headers":
      return {
        ...auth,
        ...(auth.headers ? { headers: { ...auth.headers } } : {}),
        ...(auth.envHeaders ? { envHeaders: { ...auth.envHeaders } } : {}),
      };
    case "oauth":
      return {
        ...auth,
        ...(auth.scopes ? { scopes: [...auth.scopes] } : {}),
        ...(auth.clientInformation
          ? { clientInformation: { ...auth.clientInformation } }
          : {}),
        ...(auth.discoveryState ? { discoveryState: { ...auth.discoveryState } } : {}),
      };
  }
};

const cloneMcpServerConfig = (server: McpServerConfig): McpServerConfig => {
  return {
    ...server,
    transport: cloneMcpTransportConfig(server.transport),
    ...(server.auth ? { auth: cloneMcpAuthConfig(server.auth) } : {}),
    ...(server.exposure ? { exposure: { ...server.exposure } } : {}),
    ...(server.cache ? { cache: { ...server.cache } } : {}),
    ...(server.toolOverrides
      ? {
          toolOverrides: Object.fromEntries(
            Object.entries(server.toolOverrides).map(([toolName, override]) => [
              toolName,
              { ...override },
            ]),
          ),
        }
      : {}),
    ...(Array.isArray(server.roots) ? { roots: [...server.roots] } : {}),
  };
};

export const cloneMcpPreset = (
  preset: McpPresetDefinition,
): McpPresetDefinition => {
  return {
    ...preset,
    server: cloneMcpServerConfig(preset.server),
  };
};

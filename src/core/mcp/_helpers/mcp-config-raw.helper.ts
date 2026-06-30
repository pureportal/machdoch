import {
  MCP_CONFIG_SCHEMA_VERSION,
  type McpServerConfig,
} from "../types.js";

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

export const normalizeMcpConfigServerId = (value: string): string => {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
};

const getMcpConfigServerArray = (
  value: unknown,
): Array<Record<string, unknown>> => {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => (isRecord(entry) ? [{ ...entry }] : []));
  }

  if (!isRecord(value)) {
    return [];
  }

  return Object.entries(value).flatMap(([id, entry]) => {
    if (!isRecord(entry)) {
      return [];
    }

    return [{ id, ...entry }];
  });
};

const parseMcpConfigRaw = (raw: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(raw);

  if (!isRecord(parsed)) {
    return {};
  }

  return parsed;
};

const stringifyMcpConfig = (
  config: Record<string, unknown>,
  servers: Array<Record<string, unknown>>,
): string => {
  return `${JSON.stringify(
    {
      ...config,
      schemaVersion: MCP_CONFIG_SCHEMA_VERSION,
      servers,
    },
    null,
    2,
  )}\n`;
};

export const createMcpConfigRawWithMarketplaceServer = (
  raw: string,
  server: McpServerConfig,
): string => {
  const config = parseMcpConfigRaw(raw);
  const servers = getMcpConfigServerArray(config.servers);
  const normalizedId = normalizeMcpConfigServerId(server.id);
  const serverRecord = JSON.parse(JSON.stringify(server)) as Record<string, unknown>;
  const existingIndex = servers.findIndex((entry) => {
    return (
      typeof entry.id === "string" &&
      normalizeMcpConfigServerId(entry.id) === normalizedId
    );
  });

  if (existingIndex >= 0) {
    servers[existingIndex] = {
      ...servers[existingIndex],
      ...serverRecord,
      id: normalizedId,
      enabled: true,
    };
  } else {
    servers.push({
      ...serverRecord,
      id: normalizedId,
      enabled: true,
    });
  }

  return stringifyMcpConfig(config, servers);
};

export const createMcpConfigRawWithServerEnabled = (
  raw: string,
  serverId: string,
  enabled: boolean,
): string => {
  const config = parseMcpConfigRaw(raw);
  const normalizedId = normalizeMcpConfigServerId(serverId);
  const servers = getMcpConfigServerArray(config.servers).map((server) => {
    if (
      typeof server.id !== "string" ||
      normalizeMcpConfigServerId(server.id) !== normalizedId
    ) {
      return server;
    }

    return {
      ...server,
      id: normalizedId,
      enabled,
    };
  });

  return stringifyMcpConfig(config, servers);
};

export const createMcpConfigRawWithoutServer = (
  raw: string,
  serverId: string,
): string => {
  const config = parseMcpConfigRaw(raw);
  const normalizedId = normalizeMcpConfigServerId(serverId);
  const servers = getMcpConfigServerArray(config.servers).filter((server) => {
    return (
      typeof server.id !== "string" ||
      normalizeMcpConfigServerId(server.id) !== normalizedId
    );
  });

  return stringifyMcpConfig(config, servers);
};

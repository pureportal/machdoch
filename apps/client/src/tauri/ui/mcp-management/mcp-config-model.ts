import type { McpPresetSummary } from "../runtime";

export type ServerRecord = Record<string, unknown>;
export type TransportType = "stdio" | "streamable-http" | "sse";
export type AuthType = "none" | "bearer" | "headers" | "oauth";
export type IssueTone = "error" | "warning";
export type McpServerStatus = "needs-setup" | "enabled" | "disabled";

export interface ParsedMcpDraft {
  config: ServerRecord;
  servers: ServerRecord[];
  error: string | null;
}

export interface ValidationIssue {
  serverKey: string;
  tone: IssueTone;
  text: string;
}

export interface DiscoverySummary {
  serverId: string | null;
  transportType: string | null;
  protocolVersion: string | null;
  cachePath: string | null;
  discoveredAt: string | null;
  tools: number | null;
  resources: number | null;
  resourceTemplates: number | null;
  prompts: number | null;
}

export interface McpPresetGroup {
  id: string;
  label: string;
  presets: McpPresetSummary[];
}

export const MCP_CONFIG_SCHEMA_VERSION = 1;

export const TRANSPORT_TYPES: readonly TransportType[] = [
  "stdio",
  "streamable-http",
  "sse",
];

const MCP_PRESET_CATEGORIES = [
  { id: "web-search", label: "Web & Search" },
  { id: "docs-knowledge", label: "Docs & Knowledge" },
  { id: "planning-design", label: "Planning & Design" },
  { id: "code-ci", label: "Code & CI" },
  { id: "data-observability", label: "Data & Observability" },
  { id: "browser-apps", label: "Browser & Apps" },
  { id: "more", label: "More" },
] as const;

type McpPresetCategoryId = (typeof MCP_PRESET_CATEGORIES)[number]["id"];

const MCP_PRESET_CATEGORY_BY_ID: Partial<Record<string, McpPresetCategoryId>> =
  {
    "serper-search": "web-search",
    "firecrawl-web": "web-search",
    "context7-docs": "docs-knowledge",
    "notion-remote": "docs-knowledge",
    "linear-remote": "planning-design",
    "figma-remote": "planning-design",
    "github-remote": "code-ci",
    "github-local-docker": "code-ci",
    "gitlab-remote": "code-ci",
    "sentry-remote": "data-observability",
    "mimorii-remote": "data-observability",
    "supabase-remote": "data-observability",
    "chrome-devtools": "browser-apps",
    "playwright-browser": "browser-apps",
    "tauri-mcp-server": "browser-apps",
  };

export const groupMcpPresets = (
  presets: readonly McpPresetSummary[],
): McpPresetGroup[] => {
  return MCP_PRESET_CATEGORIES.flatMap((category) => {
    const categoryPresets = presets.filter(
      (preset) =>
        (MCP_PRESET_CATEGORY_BY_ID[preset.id] ?? "more") === category.id,
    );

    return categoryPresets.length > 0
      ? [{ id: category.id, label: category.label, presets: categoryPresets }]
      : [];
  });
};

export const isRecord = (value: unknown): value is ServerRecord => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

export const normalizeServerId = (value: string): string => {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
};

export const getString = (
  record: ServerRecord | undefined,
  key: string,
): string => {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
};

export const getBoolean = (
  record: ServerRecord | undefined,
  key: string,
  fallback: boolean,
): boolean => {
  const value = record?.[key];
  return typeof value === "boolean" ? value : fallback;
};

export const getRecord = (
  record: ServerRecord | undefined,
  key: string,
): ServerRecord | undefined => {
  const value = record?.[key];
  return isRecord(value) ? value : undefined;
};

export const getServerId = (server: ServerRecord, index: number): string => {
  return getString(server, "id") || `server-${index + 1}`;
};

export const getServerKey = (server: ServerRecord, index: number): string => {
  return `${getServerId(server, index)}:${index}`;
};

const parseServers = (value: unknown): ServerRecord[] => {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => (isRecord(entry) ? [{ ...entry }] : []));
  }

  if (!isRecord(value)) {
    return [];
  }

  return Object.entries(value).flatMap(([id, entry]) =>
    isRecord(entry) ? [{ id, ...entry }] : [],
  );
};

export const parseDraft = (raw: string): ParsedMcpDraft => {
  try {
    const parsed = JSON.parse(raw) as unknown;

    if (!isRecord(parsed)) {
      return {
        config: { schemaVersion: MCP_CONFIG_SCHEMA_VERSION, servers: [] },
        servers: [],
        error: "Config must be an object.",
      };
    }
    if (parsed.schemaVersion !== MCP_CONFIG_SCHEMA_VERSION) {
      return {
        config: parsed,
        servers: [],
        error: `schemaVersion must be ${MCP_CONFIG_SCHEMA_VERSION}. Recreate this configuration.`,
      };
    }

    return {
      config: parsed,
      servers: parseServers(parsed.servers),
      error: null,
    };
  } catch (error) {
    return {
      config: { schemaVersion: MCP_CONFIG_SCHEMA_VERSION, servers: [] },
      servers: [],
      error: error instanceof Error ? error.message : "Invalid config.",
    };
  }
};

export const getFirstMcpServerId = (raw: string): string | null => {
  const { servers, error } = parseDraft(raw);
  const first = servers[0];
  return error || !first ? null : getString(first, "id").trim() || null;
};

export const stringifyDraft = (
  config: ServerRecord,
  servers: ServerRecord[],
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

export const setRecordValue = (
  record: ServerRecord,
  key: string,
  value: unknown,
): ServerRecord => {
  const next = { ...record };

  if (value === undefined || value === "") {
    delete next[key];
  } else {
    next[key] = value;
  }

  return next;
};

export const parseStringList = (value: string): string[] | undefined => {
  const entries = value
    .split(/\r?\n|,/u)
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries.length > 0 ? entries : undefined;
};

export const formatStringList = (value: unknown): string => {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === "string").join("\n")
    : "";
};

export const parseStringRecord = (
  value: string,
): Record<string, string> | undefined => {
  const entries = value.split(/\r?\n/u).flatMap((line) => {
    const separatorIndex = line.indexOf("=");

    if (separatorIndex <= 0) {
      return [];
    }

    const key = line.slice(0, separatorIndex).trim();
    const entryValue = line.slice(separatorIndex + 1).trim();

    return key ? [[key, entryValue] as const] : [];
  });

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

export const formatStringRecord = (value: unknown): string => {
  if (!isRecord(value)) {
    return "";
  }

  return Object.entries(value)
    .flatMap(([key, entry]) =>
      typeof entry === "string" ? [`${key}=${entry}`] : [],
    )
    .join("\n");
};

export const parseRootsInput = (
  value: string,
): string[] | string | undefined => {
  const normalized = value.trim();

  if (!normalized) {
    return undefined;
  }

  if (normalized === "workspace" || normalized === "disabled") {
    return normalized;
  }

  return parseStringList(value);
};

export const formatRoots = (value: unknown): string => {
  if (Array.isArray(value)) {
    return value.join(", ");
  }

  return typeof value === "string" ? value : "";
};

export const parseOptionalInteger = (value: string): number | undefined => {
  const normalized = value.trim();

  if (!normalized) {
    return undefined;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : undefined;
};

export const formatOptionalNumber = (value: unknown): string | number => {
  return typeof value === "number" ? value : "";
};

export const getTransportType = (
  server: ServerRecord | undefined,
): TransportType => {
  const type = getString(getRecord(server, "transport"), "type");

  return type === "streamable-http" || type === "sse" ? type : "stdio";
};

export const createTransport = (
  type: TransportType,
  current: ServerRecord | undefined = {},
): ServerRecord => {
  const fields =
    type === "stdio"
      ? ["command", "args", "cwd", "env", "inheritEnvironment", "stderr"]
      : type === "streamable-http"
        ? ["url", "headers", "sessionId"]
        : ["url", "headers"];
  const retained = Object.fromEntries(
    Object.entries(current).filter(([key]) => fields.includes(key)),
  );

  if (type === "stdio") {
    return {
      ...retained,
      type,
      command: getString(current, "command"),
    };
  }

  return {
    ...retained,
    type,
    url: getString(current, "url"),
  };
};

export const getAuthType = (server: ServerRecord | undefined): AuthType => {
  const type = getString(getRecord(server, "auth"), "type");

  if (type === "bearer" || type === "headers" || type === "oauth") {
    return type;
  }

  return "none";
};

export const createAuth = (
  type: AuthType,
  current: ServerRecord | undefined = {},
): ServerRecord => {
  return { ...current, type };
};

export const getUniqueServerId = (
  servers: ServerRecord[],
  preferredId: string,
): string => {
  const normalized = normalizeServerId(preferredId) || "mcp-server";
  const used = new Set(
    servers.map((server, index) =>
      normalizeServerId(getServerId(server, index)),
    ),
  );

  if (!used.has(normalized)) {
    return normalized;
  }

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${normalized}-${index}`;

    if (!used.has(candidate)) {
      return candidate;
    }
  }

  return `${normalized}-${Date.now()}`;
};

export const isValidHttpUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

export const validateServers = (servers: ServerRecord[]): ValidationIssue[] => {
  const idCounts = new Map<string, number>();

  for (const [index, server] of servers.entries()) {
    const id = normalizeServerId(getServerId(server, index));
    idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }

  return servers.flatMap((server, index) => {
    const issues: ValidationIssue[] = [];
    const serverId = getServerId(server, index);
    const normalizedId = normalizeServerId(serverId);
    const serverKey = getServerKey(server, index);
    const transport = getRecord(server, "transport");
    const transportType = getTransportType(server);

    if (!normalizedId) {
      issues.push({
        serverKey,
        tone: "error",
        text: "Server ID is required.",
      });
    } else if ((idCounts.get(normalizedId) ?? 0) > 1) {
      issues.push({
        serverKey,
        tone: "error",
        text: `Server ID "${normalizedId}" is used more than once.`,
      });
    }

    if (transportType === "stdio") {
      if (!getString(transport, "command").trim()) {
        issues.push({
          serverKey,
          tone: "error",
          text: "Stdio transport requires a command.",
        });
      }
    } else {
      const url = getString(transport, "url").trim();

      if (!url) {
        issues.push({
          serverKey,
          tone: "error",
          text: "Remote transport requires a URL.",
        });
      } else if (!isValidHttpUrl(url)) {
        issues.push({
          serverKey,
          tone: "error",
          text: "Remote transport URL must use HTTP or HTTPS.",
        });
      }
    }

    if (getAuthType(server) === "bearer") {
      const auth = getRecord(server, "auth");

      if (
        !getString(auth, "token").trim() &&
        !getString(auth, "tokenEnv").trim()
      ) {
        issues.push({
          serverKey,
          tone: "warning",
          text: "Bearer auth should use a token env var or token.",
        });
      }
    }

    return issues;
  });
};

export const getServerStatus = (
  server: ServerRecord,
  issues: readonly ValidationIssue[],
): McpServerStatus => {
  if (issues.some((issue) => issue.tone === "error")) {
    return "needs-setup";
  }

  return getBoolean(server, "enabled", true) ? "enabled" : "disabled";
};

export const describeServerConnection = (server: ServerRecord): string => {
  const transport = getRecord(server, "transport");
  const target =
    getTransportType(server) === "stdio"
      ? [
          getString(transport, "command"),
          ...formatStringList(transport?.args).split("\n"),
        ]
          .filter(Boolean)
          .join(" ")
      : getString(transport, "url");

  return target.trim() || getTransportType(server);
};

export const parseDiscoverySummary = (
  raw: string | null,
): DiscoverySummary | null => {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const result = isRecord(parsed) ? parsed : undefined;
    const discovery = isRecord(result?.discovery)
      ? result.discovery
      : undefined;

    if (!result && !discovery) {
      return null;
    }

    return {
      serverId: getString(discovery, "serverId") || null,
      transportType: getString(discovery, "transportType") || null,
      protocolVersion: getString(discovery, "protocolVersion") || null,
      cachePath: getString(result, "cachePath") || null,
      discoveredAt: getString(discovery, "discoveredAt") || null,
      tools: Array.isArray(discovery?.tools) ? discovery.tools.length : null,
      resources: Array.isArray(discovery?.resources)
        ? discovery.resources.length
        : null,
      resourceTemplates: Array.isArray(discovery?.resourceTemplates)
        ? discovery.resourceTemplates.length
        : null,
      prompts: Array.isArray(discovery?.prompts)
        ? discovery.prompts.length
        : null,
    };
  } catch {
    return null;
  }
};

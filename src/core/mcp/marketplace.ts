import {
  MCP_CONFIG_SCHEMA_VERSION,
  type McpServerConfig,
  type McpTransportConfig,
} from "./types.js";
import { normalizeOptionalString } from "../../helpers/normalize-optional-string.helper.js";

export const MCP_OFFICIAL_REGISTRY_BASE_URL =
  "https://registry.modelcontextprotocol.io/v0.1";

export const MCP_MARKETPLACE_SCHEMA_VERSION = 1;

export type McpMarketplaceInstallKind =
  | "remote"
  | "npm"
  | "pypi"
  | "nuget"
  | "oci"
  | "cargo"
  | "mcpb"
  | "unknown";

export type McpMarketplaceCredentialSource =
  | "environment"
  | "header"
  | "url-variable"
  | "argument";

export interface McpRegistryInput {
  name?: string | undefined;
  value?: string | undefined;
  default?: string | undefined;
  description?: string | undefined;
  placeholder?: string | undefined;
  format?: "string" | "number" | "boolean" | "filepath" | undefined;
  choices?: string[] | undefined;
  isRequired?: boolean | undefined;
  isSecret?: boolean | undefined;
}

export interface McpRegistryKeyValueInput extends McpRegistryInput {
  name: string;
}

export interface McpRegistryArgument extends McpRegistryInput {
  type: "positional" | "named" | string;
  isRepeated?: boolean | undefined;
  valueHint?: string | undefined;
  variables?: Record<string, McpRegistryInput> | undefined;
}

export interface McpRegistryTransport {
  type: string;
  url?: string | undefined;
  headers?: McpRegistryKeyValueInput[] | undefined;
  variables?: Record<string, McpRegistryInput> | undefined;
}

export interface McpRegistryPackage {
  registryType: string;
  registryBaseUrl?: string | undefined;
  identifier: string;
  version?: string | undefined;
  runtimeHint?: string | undefined;
  runtimeArguments?: McpRegistryArgument[] | undefined;
  packageArguments?: McpRegistryArgument[] | undefined;
  environmentVariables?: McpRegistryKeyValueInput[] | undefined;
  fileSha256?: string | undefined;
  transport: McpRegistryTransport;
}

export interface McpRegistryServerJson {
  $schema?: string | undefined;
  name: string;
  title?: string | undefined;
  description: string;
  version: string;
  websiteUrl?: string | undefined;
  repository?: {
    url?: string | undefined;
    source?: string | undefined;
    subfolder?: string | undefined;
  } | undefined;
  icons?: Array<{
    src: string;
    mimeType?: string | undefined;
    sizes?: string[] | undefined;
    theme?: "light" | "dark" | undefined;
  }> | undefined;
  packages?: McpRegistryPackage[] | undefined;
  remotes?: McpRegistryTransport[] | undefined;
  _meta?: Record<string, unknown> | undefined;
}

export interface McpRegistryServerEntry {
  server: McpRegistryServerJson;
  _meta?: Record<string, unknown> | undefined;
}

export interface McpMarketplaceRegistrySource {
  id: string;
  title: string;
  baseUrl: string;
  enabled: boolean;
  official?: boolean | undefined;
}

export interface McpMarketplaceCredentialField {
  id: string;
  source: McpMarketplaceCredentialSource;
  name: string;
  label: string;
  description?: string | undefined;
  placeholder?: string | undefined;
  defaultValue?: string | undefined;
  required: boolean;
  secret: boolean;
  choices?: string[] | undefined;
}

export interface McpMarketplaceInstallCandidate {
  id: string;
  kind: McpMarketplaceInstallKind;
  title: string;
  registryType?: string | undefined;
  transportType: string;
  packageIdentifier?: string | undefined;
  packageVersion?: string | undefined;
  remoteUrl?: string | undefined;
  runtimeHint?: string | undefined;
  score: number;
}

export interface McpMarketplaceInstallPlan {
  id: string;
  title: string;
  description: string;
  serverName: string;
  serverVersion: string;
  kind: McpMarketplaceInstallKind;
  candidate: McpMarketplaceInstallCandidate;
  server: McpServerConfig;
  credentialFields: McpMarketplaceCredentialField[];
  missingCredentialFields: McpMarketplaceCredentialField[];
  requiredCommands: string[];
  warnings: string[];
  blockedReasons: string[];
  generatedCommand?: {
    command: string;
    args: string[];
  } | undefined;
}

export interface McpMarketplaceInstallOptions {
  candidateId?: string | undefined;
  serverId?: string | undefined;
  credentials?: Record<string, string> | undefined;
}

export interface McpRegistryOfficialMetadata {
  status: string;
  statusChangedAt?: string | undefined;
  publishedAt?: string | undefined;
  updatedAt?: string | undefined;
  isLatest?: boolean | undefined;
}

export interface McpMarketplaceCategory {
  id: string;
  label: string;
  description: string;
  keywords: string[];
}

export interface McpMarketplaceRecommendation {
  label: string;
  reason: string;
}

export const MCP_MARKETPLACE_CATEGORIES: readonly McpMarketplaceCategory[] = [
  {
    id: "featured",
    label: "Featured",
    description: "Useful MCPs to start with.",
    keywords: ["github", "filesystem", "browser", "search", "docs", "database"],
  },
  {
    id: "developer-tools",
    label: "Developer Tools",
    description: "Code, repositories, browsers, terminals, and local workflows.",
    keywords: [
      "github",
      "gitlab",
      "git",
      "browser",
      "chrome",
      "playwright",
      "filesystem",
      "developer",
      "code",
      "repository",
    ],
  },
  {
    id: "data-search",
    label: "Data & Search",
    description: "Search, databases, analytics, and retrieval tools.",
    keywords: [
      "search",
      "database",
      "postgres",
      "mysql",
      "sqlite",
      "analytics",
      "vector",
      "docs",
      "knowledge",
    ],
  },
  {
    id: "productivity",
    label: "Productivity",
    description: "Notes, documents, calendars, tasks, and workspace automation.",
    keywords: [
      "notion",
      "slack",
      "linear",
      "jira",
      "calendar",
      "obsidian",
      "docs",
      "task",
      "email",
    ],
  },
  {
    id: "infrastructure",
    label: "Infrastructure",
    description: "Cloud, containers, Kubernetes, CI, and operations.",
    keywords: [
      "docker",
      "kubernetes",
      "cloud",
      "aws",
      "azure",
      "gcp",
      "terraform",
      "ci",
      "deploy",
    ],
  },
] as const;

const INSTALL_KIND_ORDER: readonly McpMarketplaceInstallKind[] = [
  "remote",
  "npm",
  "pypi",
  "oci",
  "nuget",
  "cargo",
  "mcpb",
  "unknown",
] as const;

const MCP_MARKETPLACE_RECOMMENDED_SERVER_NAMES: ReadonlySet<string> = new Set([
  "app.linear/linear",
  "com.figma.mcp/mcp",
  "com.notion/mcp",
  "com.pulsemcp.mirror/modelcontextprotocol-fetch",
  "com.pulsemcp.mirror/modelcontextprotocol-filesystem",
  "com.pulsemcp.mirror/modelcontextprotocol-git",
  "com.pulsemcp.mirror/modelcontextprotocol-github",
  "com.pulsemcp.mirror/modelcontextprotocol-memory",
  "com.pulsemcp.mirror/modelcontextprotocol-postgres",
  "com.pulsemcp.mirror/modelcontextprotocol-sequential-thinking",
  "com.pulsemcp.mirror/modelcontextprotocol-sqlite",
  "com.supabase/mcp",
  "io.github.firecrawl/firecrawl-mcp-server",
  "io.github.github/github-mcp-server",
  "io.github.grafana/mcp-grafana",
  "io.github.microsoft/playwright-mcp",
  "io.github.mongodb-js/mongodb-mcp-server",
  "io.github.upstash/context7",
] as const);

const MCP_MARKETPLACE_RECOMMENDED_REPOSITORIES: ReadonlySet<string> = new Set([
  "figma/mcp-server-guide",
  "firecrawl/firecrawl-mcp-server",
  "github/github-mcp-server",
  "grafana/mcp-grafana",
  "microsoft/playwright-mcp",
  "mongodb-js/mongodb-mcp-server",
  "supabase/mcp",
  "upstash/context7",
] as const);

const DEFAULT_SERVER_TIMEOUT_MS = 60_000;
const DEFAULT_SERVER_MAX_TOTAL_TIMEOUT_MS = 300_000;
const DEFAULT_SERVER_IDLE_SHUTDOWN_MS = 900_000;
const DEFAULT_SERVER_MAX_RESPONSE_CHARS = 60_000;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const isStringArray = (value: unknown): value is string[] => {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
};

const normalizeServerId = (value: string): string => {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
};

const isEnvironmentVariableName = (value: string): boolean => {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value.trim());
};

const normalizeRegistryType = (value: string | undefined): McpMarketplaceInstallKind => {
  const normalized = value?.trim().toLowerCase();

  switch (normalized) {
    case "npm":
      return "npm";
    case "pypi":
      return "pypi";
    case "nuget":
      return "nuget";
    case "oci":
    case "docker":
      return "oci";
    case "cargo":
      return "cargo";
    case "mcpb":
      return "mcpb";
    default:
      return "unknown";
  }
};

export const normalizeMcpMarketplaceRegistryBaseUrl = (value: string): string => {
  const trimmed = value.trim().replace(/\/+$/u, "");

  if (!trimmed) {
    return MCP_OFFICIAL_REGISTRY_BASE_URL;
  }

  if (/\/v\d+(?:\.\d+)?$/u.test(trimmed)) {
    return trimmed;
  }

  return `${trimmed}/v0.1`;
};

export const createMcpMarketplaceServersUrl = (
  registry: Pick<McpMarketplaceRegistrySource, "baseUrl">,
  options: {
    search?: string;
    cursor?: string;
    limit?: number;
    latestOnly?: boolean;
    updatedSince?: string;
  } = {},
): string => {
  const url = new URL(`${normalizeMcpMarketplaceRegistryBaseUrl(registry.baseUrl)}/servers`);
  const limit = options.limit ?? 30;
  const search = options.search?.trim();

  url.searchParams.set("limit", String(Math.min(100, Math.max(1, limit))));

  if (options.latestOnly ?? true) {
    url.searchParams.set("version", "latest");
  }

  if (search) {
    url.searchParams.set("search", search);
  }

  if (options.updatedSince) {
    url.searchParams.set("updated_since", options.updatedSince);
  }

  if (options.cursor) {
    url.searchParams.set("cursor", options.cursor);
  }

  return url.href;
};

export const getMcpRegistryServerTitle = (
  server: Pick<McpRegistryServerJson, "title" | "name">,
): string => {
  return server.title?.trim() || server.name;
};

export const getMcpRegistryOfficialMetadata = (
  entry: Pick<McpRegistryServerEntry, "_meta">,
): McpRegistryOfficialMetadata => {
  const official = isRecord(entry._meta?.["io.modelcontextprotocol.registry/official"])
    ? entry._meta["io.modelcontextprotocol.registry/official"]
    : undefined;

  if (!isRecord(official)) {
    return { status: "active" };
  }

  return {
    status:
      typeof official.status === "string" && official.status.trim()
        ? official.status
        : "active",
    ...(typeof official.statusChangedAt === "string"
      ? { statusChangedAt: official.statusChangedAt }
      : {}),
    ...(typeof official.publishedAt === "string"
      ? { publishedAt: official.publishedAt }
      : {}),
    ...(typeof official.updatedAt === "string"
      ? { updatedAt: official.updatedAt }
      : {}),
    ...(typeof official.isLatest === "boolean"
      ? { isLatest: official.isLatest }
      : {}),
  };
};

export const getMcpRegistryServerId = (
  server: Pick<McpRegistryServerJson, "name" | "title">,
): string => {
  const normalized =
    normalizeServerId(server.name) ||
    normalizeServerId(server.title ?? server.name);

  return normalized || "mcp-server";
};

const escapeRegExp = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
};

const includesKeyword = (haystack: string, keyword: string): boolean => {
  return new RegExp(
    `(^|[^a-z0-9])${escapeRegExp(keyword)}([^a-z0-9]|$)`,
    "u",
  ).test(haystack);
};

const normalizeMarketplaceRecommendationValue = (value: string): string => {
  return value.trim().toLowerCase().replace(/\.git$/u, "");
};

const getGitHubRepositoryPath = (value: string | undefined): string | null => {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);

    if (url.hostname !== "github.com") {
      return null;
    }

    const [owner, repo] = url.pathname
      .replace(/^\/+|\/+$/gu, "")
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean);

    return owner && repo
      ? normalizeMarketplaceRecommendationValue(`${owner}/${repo}`)
      : null;
  } catch {
    return null;
  }
};

export const getMcpMarketplaceRecommendationForServer = (
  server: Pick<McpRegistryServerJson, "name" | "repository">,
): McpMarketplaceRecommendation | null => {
  const serverName = normalizeMarketplaceRecommendationValue(server.name);
  const repositoryPath = getGitHubRepositoryPath(server.repository?.url);

  if (
    MCP_MARKETPLACE_RECOMMENDED_SERVER_NAMES.has(serverName) ||
    (repositoryPath &&
      MCP_MARKETPLACE_RECOMMENDED_REPOSITORIES.has(repositoryPath))
  ) {
    return {
      label: "Recommended",
      reason: "MachDoch curated pick based on broad utility, provider trust, and marketplace popularity signals.",
    };
  }

  return null;
};

export const getMcpMarketplaceCategoriesForServer = (
  server: Pick<McpRegistryServerJson, "name" | "title" | "description">,
): string[] => {
  const haystack = `${server.name} ${server.title ?? ""} ${server.description}`.toLowerCase();
  const matches = MCP_MARKETPLACE_CATEGORIES.filter((category) => {
    return category.keywords.some((keyword) => includesKeyword(haystack, keyword));
  }).map((category) => category.id);

  return matches;
};

const createCredentialId = (
  source: McpMarketplaceCredentialSource,
  name: string,
): string => {
  return `${source}:${name}`;
};

const addCredentialField = (
  fields: Map<string, McpMarketplaceCredentialField>,
  field: McpMarketplaceCredentialField,
): void => {
  const current = fields.get(field.id);

  if (!current) {
    fields.set(field.id, field);
    return;
  }

  fields.set(field.id, {
    ...current,
    required: current.required || field.required,
    secret: current.secret || field.secret,
    description: current.description ?? field.description,
    placeholder: current.placeholder ?? field.placeholder,
    defaultValue: current.defaultValue ?? field.defaultValue,
    choices: current.choices ?? field.choices,
  });
};

const getCredentialValue = (
  credentials: Record<string, string> | undefined,
  field: Pick<McpMarketplaceCredentialField, "id" | "name">,
): string | undefined => {
  const direct = credentials?.[field.id]?.trim();

  if (direct) {
    return direct;
  }

  const byName = credentials?.[field.name]?.trim();
  return byName || undefined;
};

const createFieldFromInput = (
  source: McpMarketplaceCredentialSource,
  name: string,
  input: McpRegistryInput = {},
): McpMarketplaceCredentialField => {
  return {
    id: createCredentialId(source, name),
    source,
    name,
    label: name,
    ...(input.description ? { description: input.description } : {}),
    ...(input.placeholder ? { placeholder: input.placeholder } : {}),
    ...(input.default ? { defaultValue: input.default } : {}),
    required: input.isRequired === true,
    secret: input.isSecret === true,
    ...(input.choices && input.choices.length > 0 ? { choices: input.choices } : {}),
  };
};

const addTemplateVariableFields = (
  fields: Map<string, McpMarketplaceCredentialField>,
  template: string | undefined,
  variables: Record<string, McpRegistryInput> | undefined,
  source: McpMarketplaceCredentialSource,
  fallbackInput?: McpRegistryInput,
): void => {
  if (!template) {
    return;
  }

  const variableNames = [...template.matchAll(/\{([^{}]+)\}/gu)].map(
    (match) => match[1],
  );

  for (const name of variableNames) {
    if (!name) {
      continue;
    }

    const input =
      variables?.[name] ??
      (fallbackInput
        ? {
            ...fallbackInput,
            isRequired: fallbackInput.isRequired ?? true,
          }
        : { isRequired: true });

    addCredentialField(fields, createFieldFromInput(source, name, input));
  }
};

const getCredentialConfigValue = (
  credentials: Record<string, string> | undefined,
  field: Pick<
    McpMarketplaceCredentialField,
    "defaultValue" | "id" | "name" | "secret"
  >,
): string | undefined => {
  const value = getCredentialValue(credentials, field);

  if (!field.secret) {
    return value ?? field.defaultValue;
  }

  if (value) {
    return isEnvironmentVariableName(value)
      ? `\${env:${value.trim()}}`
      : undefined;
  }

  return field.defaultValue;
};

const resolveTemplate = (
  value: string,
  fields: Map<string, McpMarketplaceCredentialField>,
  credentials: Record<string, string> | undefined,
): string => {
  return value.replace(/\{([^{}]+)\}/gu, (match, name: string) => {
    const urlField = fields.get(createCredentialId("url-variable", name));
    const headerField = fields.get(createCredentialId("header", name));
    const argumentField = fields.get(createCredentialId("argument", name));
    const field = urlField ?? headerField ?? argumentField;

    if (!field) {
      return credentials?.[name]?.trim() || match;
    }

    return getCredentialConfigValue(credentials, field) ?? match;
  });
};

const coerceInput = (value: unknown): McpRegistryInput => {
  if (!isRecord(value)) {
    return {};
  }

  const choices = isStringArray(value.choices) ? value.choices : undefined;

  return {
    ...(normalizeOptionalString(value.name) ? { name: normalizeOptionalString(value.name) } : {}),
    ...(normalizeOptionalString(value.value)
      ? { value: normalizeOptionalString(value.value) }
      : {}),
    ...(normalizeOptionalString(value.default)
      ? { default: normalizeOptionalString(value.default) }
      : {}),
    ...(normalizeOptionalString(value.description)
      ? { description: normalizeOptionalString(value.description) }
      : {}),
    ...(normalizeOptionalString(value.placeholder)
      ? { placeholder: normalizeOptionalString(value.placeholder) }
      : {}),
    ...(value.format === "string" ||
    value.format === "number" ||
    value.format === "boolean" ||
    value.format === "filepath"
      ? { format: value.format }
      : {}),
    ...(choices ? { choices } : {}),
    ...(typeof value.isRequired === "boolean" ? { isRequired: value.isRequired } : {}),
    ...(typeof value.isSecret === "boolean" ? { isSecret: value.isSecret } : {}),
  };
};

const coerceKeyValueInputs = (value: unknown): McpRegistryKeyValueInput[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const name = normalizeOptionalString(entry.name);

    if (!name) {
      return [];
    }

    return [{ ...coerceInput(entry), name }];
  });
};

const coerceArguments = (value: unknown): McpRegistryArgument[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const type = normalizeOptionalString(entry.type);
    const variables = isRecord(entry.variables)
      ? Object.fromEntries(
          Object.entries(entry.variables).map(([key, input]) => [
            key,
            coerceInput(input),
          ]),
        )
      : undefined;

    if (!type) {
      return [];
    }

    return [
      {
        ...coerceInput(entry),
        type,
        ...(typeof entry.isRepeated === "boolean"
          ? { isRepeated: entry.isRepeated }
          : {}),
        ...(normalizeOptionalString(entry.valueHint)
          ? { valueHint: normalizeOptionalString(entry.valueHint) }
          : {}),
        ...(variables ? { variables } : {}),
      },
    ];
  });
};

const coerceIcons = (
  value: unknown,
): NonNullable<McpRegistryServerJson["icons"]> => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const src = normalizeOptionalString(entry.src);

    if (!src) {
      return [];
    }

    const sizes = Array.isArray(entry.sizes)
      ? entry.sizes.flatMap((size) => {
          const normalized = normalizeOptionalString(size);
          return normalized ? [normalized] : [];
        })
      : [];

    return [
      {
        src,
        ...(normalizeOptionalString(entry.mimeType)
          ? { mimeType: normalizeOptionalString(entry.mimeType) }
          : {}),
        ...(sizes.length > 0 ? { sizes } : {}),
        ...(entry.theme === "light" || entry.theme === "dark"
          ? { theme: entry.theme }
          : {}),
      },
    ];
  });
};

const coerceTransport = (value: unknown): McpRegistryTransport | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const type = normalizeOptionalString(value.type);

  if (!type) {
    return undefined;
  }

  const variables = isRecord(value.variables)
    ? Object.fromEntries(
        Object.entries(value.variables).map(([key, input]) => [
          key,
          coerceInput(input),
        ]),
      )
    : undefined;

  return {
    type,
    ...(normalizeOptionalString(value.url) ? { url: normalizeOptionalString(value.url) } : {}),
    ...(coerceKeyValueInputs(value.headers).length > 0
      ? { headers: coerceKeyValueInputs(value.headers) }
      : {}),
    ...(variables ? { variables } : {}),
  };
};

const coercePackage = (value: unknown): McpRegistryPackage | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const registryType = normalizeOptionalString(value.registryType);
  const identifier = normalizeOptionalString(value.identifier);
  const transport = coerceTransport(value.transport);

  if (!registryType || !identifier || !transport) {
    return undefined;
  }

  return {
    registryType,
    identifier,
    ...(normalizeOptionalString(value.registryBaseUrl)
      ? { registryBaseUrl: normalizeOptionalString(value.registryBaseUrl) }
      : {}),
    ...(normalizeOptionalString(value.version)
      ? { version: normalizeOptionalString(value.version) }
      : {}),
    ...(normalizeOptionalString(value.runtimeHint)
      ? { runtimeHint: normalizeOptionalString(value.runtimeHint) }
      : {}),
    ...(coerceArguments(value.runtimeArguments).length > 0
      ? { runtimeArguments: coerceArguments(value.runtimeArguments) }
      : {}),
    ...(coerceArguments(value.packageArguments).length > 0
      ? { packageArguments: coerceArguments(value.packageArguments) }
      : {}),
    ...(coerceKeyValueInputs(value.environmentVariables).length > 0
      ? { environmentVariables: coerceKeyValueInputs(value.environmentVariables) }
      : {}),
    ...(normalizeOptionalString(value.fileSha256)
      ? { fileSha256: normalizeOptionalString(value.fileSha256) }
      : {}),
    transport,
  };
};

export const coerceMcpRegistryServerEntry = (
  value: unknown,
): McpRegistryServerEntry | undefined => {
  if (!isRecord(value) || !isRecord(value.server)) {
    return undefined;
  }

  const name = normalizeOptionalString(value.server.name);
  const description = normalizeOptionalString(value.server.description);
  const version = normalizeOptionalString(value.server.version);

  if (!name || !description || !version) {
    return undefined;
  }

  const packages = Array.isArray(value.server.packages)
    ? value.server.packages.flatMap((entry) => {
        const pkg = coercePackage(entry);
        return pkg ? [pkg] : [];
      })
    : undefined;
  const remotes = Array.isArray(value.server.remotes)
    ? value.server.remotes.flatMap((entry) => {
        const remote = coerceTransport(entry);
        return remote ? [remote] : [];
      })
    : undefined;
  const icons = coerceIcons(value.server.icons);
  const repository = isRecord(value.server.repository)
    ? {
        ...(normalizeOptionalString(value.server.repository.url)
          ? { url: normalizeOptionalString(value.server.repository.url) }
          : {}),
        ...(normalizeOptionalString(value.server.repository.source)
          ? { source: normalizeOptionalString(value.server.repository.source) }
          : {}),
        ...(normalizeOptionalString(value.server.repository.subfolder)
          ? { subfolder: normalizeOptionalString(value.server.repository.subfolder) }
          : {}),
      }
    : undefined;

  return {
    server: {
      name,
      description,
      version,
      ...(normalizeOptionalString(value.server.$schema)
        ? { $schema: normalizeOptionalString(value.server.$schema) }
        : {}),
      ...(normalizeOptionalString(value.server.title)
        ? { title: normalizeOptionalString(value.server.title) }
        : {}),
      ...(normalizeOptionalString(value.server.websiteUrl)
        ? { websiteUrl: normalizeOptionalString(value.server.websiteUrl) }
        : {}),
      ...(repository && Object.keys(repository).length > 0 ? { repository } : {}),
      ...(icons.length > 0 ? { icons } : {}),
      ...(packages && packages.length > 0 ? { packages } : {}),
      ...(remotes && remotes.length > 0 ? { remotes } : {}),
      ...(isRecord(value.server._meta) ? { _meta: value.server._meta } : {}),
    },
    ...(isRecord(value._meta) ? { _meta: value._meta } : {}),
  };
};

const createRemoteCandidates = (
  server: McpRegistryServerJson,
): McpMarketplaceInstallCandidate[] => {
  return (server.remotes ?? []).flatMap((remote, index) => {
    if (!remote.url) {
      return [];
    }

    const transportType =
      remote.type === "sse" ? "sse" : "streamable-http";
    const requiredCredentials = [
      ...Object.values(remote.variables ?? {}).filter(
        (input) => input.isRequired === true,
      ),
      ...(remote.headers ?? []).filter((header) => header.isRequired === true),
    ].length;
    const optionalCredentials =
      Object.keys(remote.variables ?? {}).length +
      (remote.headers ?? []).length -
      requiredCredentials;

    return [
      {
        id: `remote:${index}`,
        kind: "remote",
        title:
          transportType === "sse"
            ? "Remote SSE endpoint"
            : "Remote HTTP endpoint",
        transportType,
        remoteUrl: remote.url,
        score:
          (transportType === "streamable-http" ? 100 : 90) -
          requiredCredentials * 20 -
          optionalCredentials * 5,
      },
    ];
  });
};

const createPackageCandidates = (
  server: McpRegistryServerJson,
): McpMarketplaceInstallCandidate[] => {
  return (server.packages ?? []).map((pkg, index) => {
    const kind = normalizeRegistryType(pkg.registryType);
    const orderIndex = INSTALL_KIND_ORDER.indexOf(kind);
    const requiredCredentials = [
      ...(pkg.environmentVariables ?? []).filter((env) => env.isRequired === true),
      ...(pkg.runtimeArguments ?? []).filter((arg) => arg.isRequired === true),
      ...(pkg.packageArguments ?? []).filter((arg) => arg.isRequired === true),
      ...(pkg.transport.headers ?? []).filter((header) => header.isRequired === true),
    ].length;
    const score =
      90 -
      (orderIndex < 0 ? 100 : orderIndex * 5) -
      requiredCredentials * 12 -
      (kind === "mcpb" ? 30 : 0);

    return {
      id: `package:${index}`,
      kind,
      title: `${pkg.registryType} package`,
      registryType: pkg.registryType,
      transportType: pkg.transport.type,
      packageIdentifier: pkg.identifier,
      ...(pkg.version ? { packageVersion: pkg.version } : {}),
      ...(pkg.runtimeHint ? { runtimeHint: pkg.runtimeHint } : {}),
      score,
    };
  });
};

export const createMcpMarketplaceInstallCandidates = (
  server: McpRegistryServerJson,
): McpMarketplaceInstallCandidate[] => {
  return [...createRemoteCandidates(server), ...createPackageCandidates(server)].sort(
    (left, right) => right.score - left.score,
  );
};

const addTransportCredentialFields = (
  fields: Map<string, McpMarketplaceCredentialField>,
  transport: McpRegistryTransport,
): void => {
  addTemplateVariableFields(fields, transport.url, transport.variables, "url-variable");

  for (const header of transport.headers ?? []) {
    if (header.value) {
      addTemplateVariableFields(fields, header.value, undefined, "header", header);
      continue;
    }

    addCredentialField(fields, createFieldFromInput("header", header.name, header));
  }
};

const addArgumentCredentialFields = (
  fields: Map<string, McpMarketplaceCredentialField>,
  argument: McpRegistryArgument,
): void => {
  if (argument.value) {
    addTemplateVariableFields(fields, argument.value, argument.variables, "argument");
    return;
  }

  const name = argument.name ?? argument.valueHint;

  if (!name || argument.isRequired !== true) {
    return;
  }

  addCredentialField(fields, createFieldFromInput("argument", name, argument));
};

const addPackageCredentialFields = (
  fields: Map<string, McpMarketplaceCredentialField>,
  pkg: McpRegistryPackage,
): void => {
  for (const env of pkg.environmentVariables ?? []) {
    addCredentialField(fields, createFieldFromInput("environment", env.name, env));
  }

  for (const argument of [
    ...(pkg.runtimeArguments ?? []),
    ...(pkg.packageArguments ?? []),
  ]) {
    addArgumentCredentialFields(fields, argument);
  }

  addTransportCredentialFields(fields, pkg.transport);
};

const getMissingCredentialFields = (
  fields: McpMarketplaceCredentialField[],
  credentials: Record<string, string> | undefined,
): McpMarketplaceCredentialField[] => {
  return fields.filter((field) => {
    return (
      field.required &&
      !getCredentialValue(credentials, field) &&
      !field.defaultValue
    );
  });
};

const getInvalidCredentialFields = (
  fields: McpMarketplaceCredentialField[],
  credentials: Record<string, string> | undefined,
): McpMarketplaceCredentialField[] => {
  return fields.filter((field) => {
    const value = getCredentialValue(credentials, field);
    return Boolean(field.secret && value && !isEnvironmentVariableName(value));
  });
};

const getArgumentValue = (
  argument: McpRegistryArgument,
  fields: Map<string, McpMarketplaceCredentialField>,
  credentials: Record<string, string> | undefined,
): string | undefined => {
  if (argument.value) {
    return resolveTemplate(argument.value, fields, credentials);
  }

  const name = argument.name ?? argument.valueHint;

  if (!name) {
    return argument.default;
  }

  const field = fields.get(createCredentialId("argument", name));

  if (!field) {
    return argument.default;
  }

  return getCredentialConfigValue(credentials, field);
};

const renderArguments = (
  args: McpRegistryArgument[] | undefined,
  fields: Map<string, McpMarketplaceCredentialField>,
  credentials: Record<string, string> | undefined,
): string[] => {
  return (args ?? []).flatMap((argument) => {
    const value = getArgumentValue(argument, fields, credentials);

    if (!value) {
      return [];
    }

    if (argument.type !== "named") {
      return [value];
    }

    const rawName = argument.name?.trim();

    if (!rawName) {
      return [value];
    }

    const flag = rawName.startsWith("-") ? rawName : `--${rawName}`;
    return [flag, value];
  });
};

const getPackageVersionIdentifier = (
  pkg: McpRegistryPackage,
  kind: McpMarketplaceInstallKind,
): string => {
  if (!pkg.version || pkg.version === "latest") {
    return pkg.identifier;
  }

  if (kind === "npm") {
    return `${pkg.identifier}@${pkg.version}`;
  }

  if (kind === "pypi") {
    return `${pkg.identifier}==${pkg.version}`;
  }

  if (kind === "nuget") {
    return `${pkg.identifier}@${pkg.version}`;
  }

  return pkg.identifier;
};

const hasArgument = (args: string[], value: string): boolean => {
  return args.some((entry) => entry === value);
};

const createPackageCommand = (
  pkg: McpRegistryPackage,
  kind: McpMarketplaceInstallKind,
  fields: Map<string, McpMarketplaceCredentialField>,
  credentials: Record<string, string> | undefined,
): { command: string; args: string[]; warnings: string[] } => {
  const runtimeArgs = renderArguments(pkg.runtimeArguments, fields, credentials);
  const packageArgs = renderArguments(pkg.packageArguments, fields, credentials);
  const identifier = getPackageVersionIdentifier(pkg, kind);
  const warnings: string[] = [];

  if (kind === "npm") {
    const command = pkg.runtimeHint || "npx";
    const args = [...runtimeArgs];

    if (command === "npx" && !hasArgument(args, "-y") && !hasArgument(args, "--yes")) {
      args.push("-y");
    }

    args.push(identifier, ...packageArgs);
    return { command, args, warnings };
  }

  if (kind === "pypi") {
    const command = pkg.runtimeHint || "uvx";
    return { command, args: [...runtimeArgs, identifier, ...packageArgs], warnings };
  }

  if (kind === "oci") {
    const command = pkg.runtimeHint || "docker";
    const envArgs = (pkg.environmentVariables ?? []).flatMap((env) => {
      return ["-e", env.name];
    });
    const args =
      command === "docker" && runtimeArgs.length === 0
        ? ["run", "-i", "--rm", ...envArgs, pkg.identifier, ...packageArgs]
        : [...runtimeArgs, pkg.identifier, ...packageArgs];

    return { command, args, warnings };
  }

  if (kind === "nuget") {
    const command = pkg.runtimeHint || "dnx";
    return { command, args: [...runtimeArgs, identifier, ...packageArgs], warnings };
  }

  if (kind === "cargo") {
    const command = pkg.runtimeHint || "cargo";
    const args =
      command === "cargo" && runtimeArgs.length === 0
        ? ["run", "--quiet", "--package", pkg.identifier, "--", ...packageArgs]
        : [...runtimeArgs, identifier, ...packageArgs];

    warnings.push(
      "Cargo package execution depends on the package's documented runtime command.",
    );
    return { command, args, warnings };
  }

  if (kind === "mcpb") {
    const command = pkg.runtimeHint || "mcpb";
    const args =
      runtimeArgs.length === 0
        ? ["run", pkg.identifier, ...packageArgs]
        : [...runtimeArgs, pkg.identifier, ...packageArgs];

    warnings.push(
      "MCPB packages require SHA-256 verification before one-click installation.",
    );
    return { command, args, warnings };
  }

  const command = pkg.runtimeHint || pkg.registryType;
  warnings.push(`Unknown registry type \`${pkg.registryType}\`; generated a best-effort stdio command.`);
  return { command, args: [...runtimeArgs, identifier, ...packageArgs], warnings };
};

const createHeadersRecord = (
  transport: McpRegistryTransport,
  fields: Map<string, McpMarketplaceCredentialField>,
  credentials: Record<string, string> | undefined,
): Record<string, string> | undefined => {
  const entries = (transport.headers ?? []).flatMap((header) => {
    if (header.value) {
      const resolvedValue = resolveTemplate(header.value, fields, credentials);
      return /(^|[^$])\{[^{}]+\}/u.test(resolvedValue)
        ? []
        : [[header.name, resolvedValue] as const];
    }

    const field = fields.get(createCredentialId("header", header.name));
    const value = field
      ? getCredentialConfigValue(credentials, field)
      : header.default;

    return value ? [[header.name, value] as const] : [];
  });

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const createEnvironmentRecord = (
  pkg: McpRegistryPackage,
  credentials: Record<string, string> | undefined,
): Record<string, string> | undefined => {
  const entries = (pkg.environmentVariables ?? []).flatMap((env) => {
    const field = createFieldFromInput("environment", env.name, env);
    const value = field.secret
      ? getCredentialConfigValue(credentials, field) ??
        (env.isRequired === true ? `\${env:${env.name}}` : undefined)
      : getCredentialValue(credentials, field) ?? env.value ?? env.default;

    if (value) {
      return [[env.name, value] as const];
    }

    return env.isRequired === true ? [[env.name, `\${env:${env.name}}`] as const] : [];
  });

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const createRemoteTransport = (
  remote: McpRegistryTransport,
  fields: Map<string, McpMarketplaceCredentialField>,
  credentials: Record<string, string> | undefined,
): McpTransportConfig => {
  const url = resolveTemplate(remote.url ?? "", fields, credentials);
  const headers = createHeadersRecord(remote, fields, credentials);

  if (remote.type === "sse") {
    return {
      type: "sse",
      url,
      ...(headers ? { headers } : {}),
    };
  }

  return {
    type: "streamable-http",
    url,
    ...(headers ? { headers } : {}),
    legacySseFallback: true,
  };
};

const createPackageTransport = (
  pkg: McpRegistryPackage,
  command: { command: string; args: string[] },
  credentials: Record<string, string> | undefined,
): McpTransportConfig => {
  const env = createEnvironmentRecord(pkg, credentials);

  return {
    type: "stdio",
    command: command.command,
    args: command.args,
    ...(env ? { env } : {}),
    inheritEnvironment: true,
    stderr: "pipe",
  };
};

const getRequiredCommands = (
  kind: McpMarketplaceInstallKind,
  command: string | undefined,
): string[] => {
  if (command) {
    return [command];
  }

  switch (kind) {
    case "remote":
      return [];
    case "npm":
      return ["npx"];
    case "pypi":
      return ["uvx"];
    case "oci":
      return ["docker"];
    case "nuget":
      return ["dnx"];
    case "cargo":
      return ["cargo"];
    case "mcpb":
      return ["mcpb"];
    case "unknown":
      return [];
  }
};

const getCandidateRemote = (
  server: McpRegistryServerJson,
  candidate: McpMarketplaceInstallCandidate,
): McpRegistryTransport | undefined => {
  if (!candidate.id.startsWith("remote:")) {
    return undefined;
  }

  const index = Number(candidate.id.slice("remote:".length));
  return Number.isInteger(index) ? server.remotes?.[index] : undefined;
};

const getCandidatePackage = (
  server: McpRegistryServerJson,
  candidate: McpMarketplaceInstallCandidate,
): McpRegistryPackage | undefined => {
  if (!candidate.id.startsWith("package:")) {
    return undefined;
  }

  const index = Number(candidate.id.slice("package:".length));
  return Number.isInteger(index) ? server.packages?.[index] : undefined;
};

const createBaseServerConfig = (
  registryServer: McpRegistryServerJson,
  options: McpMarketplaceInstallOptions | undefined,
  transport: McpTransportConfig,
): McpServerConfig => {
  const id = normalizeServerId(options?.serverId ?? getMcpRegistryServerId(registryServer));

  return {
    id: id || "mcp-server",
    title: getMcpRegistryServerTitle(registryServer),
    description: registryServer.description,
    enabled: true,
    preset: `marketplace:${registryServer.name}`,
    transport,
    exposure: {
      mode: "hybrid",
      directTools: true,
    },
    securityProfile: "weak",
    timeoutMs: DEFAULT_SERVER_TIMEOUT_MS,
    maxTotalTimeoutMs: DEFAULT_SERVER_MAX_TOTAL_TIMEOUT_MS,
    idleShutdownMs: DEFAULT_SERVER_IDLE_SHUTDOWN_MS,
    maxResponseChars: DEFAULT_SERVER_MAX_RESPONSE_CHARS,
    cache: {
      enabled: true,
      ttlMs: 900_000,
      forceRefresh: false,
    },
    roots: "workspace",
    sampling: "disabled",
    tasks: "optional",
    notes: `Installed from MCP Marketplace: ${registryServer.name}@${registryServer.version}`,
  };
};

export const createMcpMarketplaceInstallPlan = (
  entry: McpRegistryServerEntry,
  options: McpMarketplaceInstallOptions = {},
): McpMarketplaceInstallPlan => {
  const candidates = createMcpMarketplaceInstallCandidates(entry.server);
  const candidate =
    candidates.find((installCandidate) => installCandidate.id === options.candidateId) ??
    candidates[0];

  if (!candidate) {
    throw new Error(`MCP registry server \`${entry.server.name}\` has no installable remotes or packages.`);
  }

  const fields = new Map<string, McpMarketplaceCredentialField>();
  const warnings: string[] = [];
  const blockedReasons: string[] = [];
  let generatedCommand: { command: string; args: string[] } | undefined;
  let transport: McpTransportConfig;

  const remote = getCandidateRemote(entry.server, candidate);
  const pkg = getCandidatePackage(entry.server, candidate);

  if (remote) {
    addTransportCredentialFields(fields, remote);
    transport = createRemoteTransport(remote, fields, options.credentials);
  } else if (pkg) {
    addPackageCredentialFields(fields, pkg);
    const command = createPackageCommand(
      pkg,
      candidate.kind,
      fields,
      options.credentials,
    );

    generatedCommand = {
      command: command.command,
      args: command.args,
    };
    warnings.push(...command.warnings);
    if (candidate.kind === "mcpb") {
      blockedReasons.push(
        "MCPB one-click install is disabled until artifact download and SHA-256 verification are implemented.",
      );
    }
    if (candidate.kind === "unknown") {
      blockedReasons.push(
        `Registry type \`${pkg.registryType}\` needs manual review before installation.`,
      );
    }
    transport = createPackageTransport(pkg, command, options.credentials);
  } else {
    throw new Error(`MCP install candidate \`${candidate.id}\` is no longer available.`);
  }

  const credentialFields = [...fields.values()];
  const invalidCredentialFields = getInvalidCredentialFields(
    credentialFields,
    options.credentials,
  );

  if (invalidCredentialFields.length > 0) {
    blockedReasons.push(
      "Secret fields must contain environment variable names, not raw secret values.",
    );
  }

  const server = createBaseServerConfig(entry.server, options, transport);

  return {
    id: `${entry.server.name}:${entry.server.version}:${candidate.id}`,
    title: getMcpRegistryServerTitle(entry.server),
    description: entry.server.description,
    serverName: entry.server.name,
    serverVersion: entry.server.version,
    kind: candidate.kind,
    candidate,
    server,
    credentialFields,
    missingCredentialFields: getMissingCredentialFields(
      credentialFields,
      options.credentials,
    ),
    requiredCommands: getRequiredCommands(
      candidate.kind,
      generatedCommand?.command,
    ),
    warnings,
    blockedReasons,
    ...(generatedCommand ? { generatedCommand } : {}),
  };
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
  const normalizedId = normalizeServerId(server.id);
  const serverRecord = JSON.parse(JSON.stringify(server)) as Record<string, unknown>;
  const existingIndex = servers.findIndex((entry) => {
    return typeof entry.id === "string" && normalizeServerId(entry.id) === normalizedId;
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
  const normalizedId = normalizeServerId(serverId);
  const servers = getMcpConfigServerArray(config.servers).map((server) => {
    if (typeof server.id !== "string" || normalizeServerId(server.id) !== normalizedId) {
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
  const normalizedId = normalizeServerId(serverId);
  const servers = getMcpConfigServerArray(config.servers).filter((server) => {
    return typeof server.id !== "string" || normalizeServerId(server.id) !== normalizedId;
  });

  return stringifyMcpConfig(config, servers);
};

import {
  coerceMcpRegistryServerEntry,
  createMcpMarketplaceInstallCandidates,
  getMcpMarketplaceCategoriesForServer,
  getMcpMarketplaceRecommendationForServer,
  getMcpRegistryOfficialMetadata,
  getMcpRegistryServerTitle,
  type McpMarketplaceInstallKind,
  type McpMarketplaceRecommendation,
  type McpMarketplaceRegistrySource,
  type McpRegistryServerEntry,
} from "../../../core/mcp/marketplace.js";
import { normalizeOptionalString } from "../../../helpers/normalize-optional-string.helper.js";

export type MarketplaceView =
  | "discover"
  | "installed"
  | "registries"
  | "advanced";

export type MarketplaceMessageTone = "success" | "warning" | "error" | "info";

export type McpMarketplaceSortMode =
  | "relevance"
  | "recommended"
  | "popularity"
  | "stars"
  | "downloads"
  | "name"
  | "updated"
  | "registry"
  | "install-method";

export type MarketplaceInstallKindFilter =
  | "all"
  | "remote"
  | "local"
  | "auth-required";

export type MarketplaceDetailTab = "overview" | "install" | "trust" | "raw";

export interface MarketplaceResultMetrics {
  downloads?: number | undefined;
  popularity?: number | undefined;
  quality?: number | undefined;
  rating?: number | undefined;
  security?: number | undefined;
  stars?: number | undefined;
  updatedAtMs?: number | undefined;
}

export interface MarketplaceMessage {
  tone: MarketplaceMessageTone;
  text: string;
}

export interface MarketplaceResult {
  key: string;
  entry: McpRegistryServerEntry;
  registry: McpMarketplaceRegistrySource;
  recommendation: McpMarketplaceRecommendation | null;
  recommended: boolean;
  categories: string[];
  title: string;
  status: string;
  installKind: McpMarketplaceInstallKind;
  installScore: number;
  authRequired: boolean;
  logoUrl: string | null;
  metrics: MarketplaceResultMetrics;
  packageRegistryTypes: string[];
  repositoryUrl: string | null;
  searchText: string;
  publishedAtMs: number;
  updatedAtMs: number;
}

export interface MarketplaceRegistryPage {
  registryId: string;
  nextCursor: string | null;
  count: number;
  error: string | null;
}

export interface MarketplaceRegistryServerReference {
  key: string;
  name: string;
  registryId: string;
}

export interface MarketplaceRegistryParseResult {
  deletedServers: MarketplaceRegistryServerReference[];
  results: MarketplaceResult[];
  page: MarketplaceRegistryPage;
}

export interface InstalledServerSummary {
  id: string;
  title: string;
  description: string;
  enabled: boolean;
  transportType: string;
  preset: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const normalizeString = (value: unknown): string => {
  return normalizeOptionalString(value) ?? "";
};

const parseDateMs = (value: string | undefined): number => {
  if (!value) {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizeOptionalNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
};

const compareStrings = (left: string, right: string): number => {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
};

const getResultSortTitle = (result: MarketplaceResult): string => {
  return result.title || result.entry.server.name;
};

const getFeaturedScore = (result: MarketplaceResult): number => {
  if (result.recommended) {
    return 30;
  }

  return result.categories.includes("featured") ? 10 : 0;
};

const getStatusScore = (result: MarketplaceResult): number => {
  const normalizedStatus = result.status.toLowerCase();

  if (normalizedStatus === "deprecated") {
    return -50;
  }

  return normalizedStatus === "active" ? 10 : 0;
};

const getResultUpdatedAt = (result: MarketplaceResult): number => {
  return result.metrics.updatedAtMs || result.updatedAtMs || result.publishedAtMs;
};

const getResultStars = (result: MarketplaceResult): number => {
  return result.metrics.stars ?? 0;
};

const getResultDownloads = (result: MarketplaceResult): number => {
  return result.metrics.downloads ?? 0;
};

const getResultPopularity = (result: MarketplaceResult): number => {
  return (
    result.metrics.popularity ??
    Math.log10(getResultStars(result) + 1) * 20 +
      Math.log10(getResultDownloads(result) + 1) * 8
  );
};

const getResultQuality = (result: MarketplaceResult): number => {
  return Math.max(
    result.metrics.quality ?? 0,
    result.metrics.rating ?? 0,
    result.metrics.security ?? 0,
  );
};

const getSearchRelevanceScore = (
  result: MarketplaceResult,
  query: string,
): number => {
  const normalized = query.trim().toLowerCase();

  if (!normalized) {
    return 0;
  }

  const title = result.title.toLowerCase();
  const name = result.entry.server.name.toLowerCase();

  if (title === normalized || name === normalized) {
    return 100;
  }

  if (title.startsWith(normalized) || name.startsWith(normalized)) {
    return 70;
  }

  if (title.includes(normalized) || name.includes(normalized)) {
    return 50;
  }

  return result.searchText.includes(normalized) ? 20 : 0;
};

export const getErrorText = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

export const isMarketplaceResultDeprecated = (
  result: Pick<MarketplaceResult, "status">,
): boolean => {
  return result.status.toLowerCase() === "deprecated";
};

export const isMarketplaceResultDeleted = (
  result: Pick<MarketplaceResult, "status">,
): boolean => {
  return result.status.toLowerCase() === "deleted";
};

const visitMetadataRecords = (
  value: unknown,
  visitor: (record: Record<string, unknown>) => void,
  depth = 0,
): void => {
  if (!isRecord(value) || depth > 3) {
    return;
  }

  visitor(value);

  for (const child of Object.values(value)) {
    if (isRecord(child)) {
      visitMetadataRecords(child, visitor, depth + 1);
    }
  }
};

const collectRegistryMetrics = (
  entry: McpRegistryServerEntry,
): MarketplaceResultMetrics => {
  const metrics: MarketplaceResultMetrics = {};
  const applyMetric = (
    key: keyof MarketplaceResultMetrics,
    value: unknown,
  ): void => {
    const normalized = key === "updatedAtMs"
      ? parseDateMs(normalizeString(value) || undefined)
      : normalizeOptionalNumber(value);

    if (normalized && normalized > 0) {
      metrics[key] = normalized;
    }
  };

  const metadataRoots = [entry._meta, entry.server._meta];

  for (const root of metadataRoots) {
    visitMetadataRecords(root, (record) => {
      applyMetric("stars", record.stars ?? record.starCount ?? record.githubStars ?? record.stargazers_count);
      applyMetric("downloads", record.downloads ?? record.downloadCount ?? record.downloadsLastWeek ?? record.weeklyDownloads ?? record.npmDownloads);
      applyMetric("popularity", record.popularity ?? record.popularityScore);
      applyMetric("quality", record.quality ?? record.qualityScore);
      applyMetric("rating", record.rating ?? record.ratingScore);
      applyMetric("security", record.security ?? record.securityScore);
      applyMetric("updatedAtMs", record.updatedAt ?? record.lastUpdatedAt ?? record.lastUpdated ?? record.pushedAt);
    });
  }

  return metrics;
};

const getServerLogoUrl = (entry: McpRegistryServerEntry): string | null => {
  const icon = entry.server.icons?.find((candidate) => {
    return candidate.theme !== "light";
  }) ?? entry.server.icons?.[0];

  return icon?.src ?? null;
};

const getPackageRegistryTypes = (entry: McpRegistryServerEntry): string[] => {
  return Array.from(
    new Set(
      (entry.server.packages ?? []).flatMap((pkg) =>
        pkg.registryType ? [pkg.registryType] : [],
      ),
    ),
  );
};

const hasRequiredCredentials = (entry: McpRegistryServerEntry): boolean => {
  const remoteInputs = (entry.server.remotes ?? []).some((remote) => {
    return (
      Object.values(remote.variables ?? {}).some((input) => input.isRequired) ||
      (remote.headers ?? []).some((input) => input.isRequired)
    );
  });
  const packageInputs = (entry.server.packages ?? []).some((pkg) => {
    return (
      (pkg.environmentVariables ?? []).some((input) => input.isRequired) ||
      (pkg.runtimeArguments ?? []).some((input) => input.isRequired) ||
      (pkg.packageArguments ?? []).some((input) => input.isRequired)
    );
  });

  return remoteInputs || packageInputs;
};

const createSearchText = (
  entry: McpRegistryServerEntry,
  registry: McpMarketplaceRegistrySource,
  categories: string[],
): string => {
  const packageIdentifiers = (entry.server.packages ?? [])
    .map((pkg) => pkg.identifier)
    .join(" ");
  const transports = [
    ...(entry.server.remotes ?? []).map((remote) => remote.type),
    ...(entry.server.packages ?? []).map((pkg) => pkg.transport.type),
  ].join(" ");

  return [
    entry.server.name,
    entry.server.title,
    entry.server.description,
    entry.server.repository?.url,
    entry.server.websiteUrl,
    registry.title,
    packageIdentifiers,
    transports,
    categories.join(" "),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
};

export const parseMarketplaceRegistryResponse = (
  value: unknown,
  registry: McpMarketplaceRegistrySource,
): MarketplaceRegistryParseResult => {
  const metadata = isRecord(value) && isRecord(value.metadata)
    ? value.metadata
    : {};
  const nextCursor = normalizeString(metadata.nextCursor) || null;
  const count = typeof metadata.count === "number" ? metadata.count : 0;

  if (!isRecord(value) || !Array.isArray(value.servers)) {
    return {
      deletedServers: [],
      results: [],
      page: {
        registryId: registry.id,
        nextCursor,
        count,
        error: null,
      },
    };
  }

  const deletedServers: MarketplaceRegistryServerReference[] = [];
  const results = value.servers.flatMap((serverEntry) => {
    const entry = coerceMcpRegistryServerEntry(serverEntry);

    if (!entry) {
      return [];
    }

    const official = getMcpRegistryOfficialMetadata(entry);

    if (official.status.toLowerCase() === "deleted") {
      deletedServers.push({
        key: `${registry.id}:${entry.server.name}:${entry.server.version}`,
        name: entry.server.name,
        registryId: registry.id,
      });
      return [];
    }

    const candidates = createMcpMarketplaceInstallCandidates(entry.server);
    const candidate = candidates[0];
    const categories = getMcpMarketplaceCategoriesForServer(entry.server);
    const recommendation = getMcpMarketplaceRecommendationForServer(entry.server);
    const metrics = collectRegistryMetrics(entry);

    return [
      {
        key: `${registry.id}:${entry.server.name}:${entry.server.version}`,
        entry,
        registry,
        recommendation,
        recommended: Boolean(recommendation),
        categories,
        title: getMcpRegistryServerTitle(entry.server),
        status: official.status,
        installKind: candidate?.kind ?? "unknown",
        installScore: candidate?.score ?? 0,
        authRequired: hasRequiredCredentials(entry),
        logoUrl: getServerLogoUrl(entry),
        metrics,
        packageRegistryTypes: getPackageRegistryTypes(entry),
        repositoryUrl: entry.server.repository?.url ?? null,
        searchText: createSearchText(entry, registry, categories),
        publishedAtMs: parseDateMs(official.publishedAt),
        updatedAtMs: parseDateMs(official.updatedAt),
      },
    ];
  });

  return {
    deletedServers,
    results,
    page: {
      registryId: registry.id,
      nextCursor,
      count,
      error: null,
    },
  };
};

export const createFailedRegistryPage = (
  registryId: string,
  error: unknown,
): MarketplaceRegistryPage => {
  return {
    registryId,
    nextCursor: null,
    count: 0,
    error: getErrorText(error),
  };
};

export const mergeMarketplaceResults = (
  current: MarketplaceResult[],
  next: MarketplaceResult[],
  deletedServers: MarketplaceRegistryServerReference[] = [],
): MarketplaceResult[] => {
  const map = new Map<string, MarketplaceResult>();
  const keysByIdentity = new Map<string, Set<string>>();
  const getResultIdentity = (result: MarketplaceResult): string =>
    `${result.registry.id}:${result.entry.server.name}`;
  const getReferenceIdentity = (
    reference: MarketplaceRegistryServerReference,
  ): string => `${reference.registryId}:${reference.name}`;
  const addIdentityKey = (identity: string, key: string): void => {
    const existing = keysByIdentity.get(identity);

    if (existing) {
      existing.add(key);
      return;
    }

    keysByIdentity.set(identity, new Set([key]));
  };

  for (const result of current) {
    map.set(result.key, result);
    addIdentityKey(getResultIdentity(result), result.key);
  }

  for (const reference of deletedServers) {
    const identity = getReferenceIdentity(reference);
    const keys = keysByIdentity.get(identity) ?? new Set([reference.key]);

    keys.add(reference.key);

    for (const key of keys) {
      map.delete(key);
    }

    keysByIdentity.delete(identity);
  }

  for (const result of next) {
    const identity = getResultIdentity(result);
    const staleKeys = keysByIdentity.get(identity) ?? new Set<string>();

    for (const key of staleKeys) {
      if (key !== result.key) {
        map.delete(key);
      }
    }

    map.set(result.key, result);
    keysByIdentity.set(identity, new Set([result.key]));
  }

  return [...map.values()];
};

export const filterMarketplaceResults = (
  results: MarketplaceResult[],
  category: string,
  query = "",
  installKindFilter: MarketplaceInstallKindFilter = "all",
): MarketplaceResult[] => {
  const normalizedQuery = query.trim().toLowerCase();

  return results.filter((result) => {
    if (category !== "all" && !result.categories.includes(category)) {
      return false;
    }

    if (installKindFilter === "remote" && result.installKind !== "remote") {
      return false;
    }

    if (installKindFilter === "local" && result.installKind === "remote") {
      return false;
    }

    if (installKindFilter === "auth-required" && !result.authRequired) {
      return false;
    }

    return !normalizedQuery || result.searchText.includes(normalizedQuery);
  });
};

export const sortMarketplaceResults = (
  results: MarketplaceResult[],
  mode: McpMarketplaceSortMode,
  query = "",
): MarketplaceResult[] => {
  const sorted = [...results];

  sorted.sort((left, right) => {
    if (mode === "relevance") {
      return (
        getSearchRelevanceScore(right, query) -
          getSearchRelevanceScore(left, query) ||
        getStatusScore(right) - getStatusScore(left) ||
        getResultPopularity(right) - getResultPopularity(left) ||
        compareStrings(getResultSortTitle(left), getResultSortTitle(right))
      );
    }

    if (mode === "popularity") {
      return (
        getResultPopularity(right) - getResultPopularity(left) ||
        getStatusScore(right) - getStatusScore(left) ||
        compareStrings(getResultSortTitle(left), getResultSortTitle(right))
      );
    }

    if (mode === "stars") {
      return (
        getResultStars(right) - getResultStars(left) ||
        getResultPopularity(right) - getResultPopularity(left) ||
        compareStrings(getResultSortTitle(left), getResultSortTitle(right))
      );
    }

    if (mode === "downloads") {
      return (
        getResultDownloads(right) - getResultDownloads(left) ||
        getResultPopularity(right) - getResultPopularity(left) ||
        compareStrings(getResultSortTitle(left), getResultSortTitle(right))
      );
    }

    if (mode === "name") {
      return compareStrings(getResultSortTitle(left), getResultSortTitle(right));
    }

    if (mode === "updated") {
      return (
        getResultUpdatedAt(right) - getResultUpdatedAt(left) ||
        compareStrings(getResultSortTitle(left), getResultSortTitle(right))
      );
    }

    if (mode === "registry") {
      return (
        compareStrings(left.registry.title, right.registry.title) ||
        compareStrings(getResultSortTitle(left), getResultSortTitle(right))
      );
    }

    if (mode === "install-method") {
      return (
        compareStrings(left.installKind, right.installKind) ||
        compareStrings(getResultSortTitle(left), getResultSortTitle(right))
      );
    }

    return (
      getStatusScore(right) - getStatusScore(left) ||
      getFeaturedScore(right) - getFeaturedScore(left) ||
      getResultQuality(right) - getResultQuality(left) ||
      getResultPopularity(right) - getResultPopularity(left) ||
      right.installScore - left.installScore ||
      getResultUpdatedAt(right) - getResultUpdatedAt(left) ||
      compareStrings(getResultSortTitle(left), getResultSortTitle(right))
    );
  });

  return sorted;
};

export const getMarketplaceResultCountLabel = ({
  visibleCount,
  loadedCount,
  hasMoreResults,
}: {
  visibleCount: number;
  loadedCount: number;
  hasMoreResults: boolean;
}): string => {
  const label = `${visibleCount} visible, ${loadedCount} loaded`;

  return hasMoreResults ? `${label}, more available` : label;
};

const redactSecretValue = (key: string, value: unknown): unknown => {
  if (typeof value !== "string") {
    return value;
  }

  if (value.includes("${env:")) {
    return value;
  }

  if (/authorization|api[_-]?key|token|secret|password/iu.test(key)) {
    return value ? "[redacted]" : value;
  }

  return value;
};

const redactConfigValue = (value: unknown, key = ""): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => redactConfigValue(entry, key));
  }

  if (!isRecord(value)) {
    return redactSecretValue(key, value);
  }

  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactConfigValue(entryValue, entryKey),
    ]),
  );
};

export const redactMcpConfigRaw = (raw: string): string => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }

  return JSON.stringify(redactConfigValue(parsed), null, 2);
};

export const parseInstalledServersRaw = (
  raw: string,
): InstalledServerSummary[] => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!isRecord(parsed)) {
    return [];
  }

  const rawServers = parsed.servers;
  const servers = Array.isArray(rawServers)
    ? rawServers.flatMap((entry) => (isRecord(entry) ? [entry] : []))
    : isRecord(rawServers)
      ? Object.entries(rawServers).flatMap(([id, entry]) =>
          isRecord(entry) ? [{ id, ...entry }] : [],
        )
      : [];

  return servers.flatMap((server) => {
    const id = normalizeString(server.id);

    if (!id) {
      return [];
    }

    const transport = isRecord(server.transport) ? server.transport : {};

    return [
      {
        id,
        title: normalizeString(server.title) || id,
        description: normalizeString(server.description),
        enabled: server.enabled !== false,
        transportType: normalizeString(transport.type) || "stdio",
        preset: normalizeString(server.preset),
      },
    ];
  });
};

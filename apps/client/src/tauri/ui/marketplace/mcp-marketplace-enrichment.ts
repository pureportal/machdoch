import type { MarketplaceResultMetrics } from "./mcp-marketplace-model";
import type { MarketplaceResult } from "./mcp-marketplace-model";

const MARKETPLACE_ENRICHMENT_STORAGE_KEY =
  "machdoch.desktop.mcp-marketplace-enrichment-cache";
const MARKETPLACE_ENRICHMENT_CACHE_VERSION = 1;
const MARKETPLACE_ENRICHMENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface MarketplaceEnrichmentSnapshot {
  downloads?: number | undefined;
  error?: string | undefined;
  fetchedAt: number;
  forks?: number | undefined;
  openIssues?: number | undefined;
  sources: string[];
  stars?: number | undefined;
  updatedAtMs?: number | undefined;
}

interface MarketplaceEnrichmentCacheDocument {
  schemaVersion: typeof MARKETPLACE_ENRICHMENT_CACHE_VERSION;
  entries: Record<string, MarketplaceEnrichmentSnapshot>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const normalizeNumber = (value: unknown): number | undefined => {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const parseDateMs = (value: unknown): number | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const getJson = async (url: string, signal?: AbortSignal): Promise<unknown> => {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`.trim());
  }

  return response.json();
};

export const parseGitHubRepositoryPath = (
  value: string | null | undefined,
): string | null => {
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

    return owner && repo ? `${owner}/${repo.replace(/\.git$/u, "")}` : null;
  } catch {
    return null;
  }
};

export const getNpmPackageIdentifier = (
  result: MarketplaceResult,
): string | null => {
  const pkg = result.entry.server.packages?.find((candidate) => {
    return candidate.registryType.toLowerCase() === "npm";
  });

  return pkg?.identifier ?? null;
};

const createEnrichmentCacheKey = (result: MarketplaceResult): string | null => {
  const githubPath = parseGitHubRepositoryPath(result.repositoryUrl);
  const npmPackage = getNpmPackageIdentifier(result);

  if (!githubPath && !npmPackage) {
    return null;
  }

  return [
    githubPath ? `github:${githubPath}` : "",
    npmPackage ? `npm:${npmPackage}` : "",
  ]
    .filter(Boolean)
    .join("|");
};

const normalizeCacheEntry = (
  value: unknown,
): MarketplaceEnrichmentSnapshot | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const fetchedAt = normalizeNumber(value.fetchedAt);

  if (!fetchedAt) {
    return undefined;
  }

  return {
    fetchedAt,
    sources: Array.isArray(value.sources)
      ? value.sources.flatMap((source) =>
          typeof source === "string" && source ? [source] : [],
        )
      : [],
    ...(normalizeNumber(value.stars) !== undefined
      ? { stars: normalizeNumber(value.stars) }
      : {}),
    ...(normalizeNumber(value.forks) !== undefined
      ? { forks: normalizeNumber(value.forks) }
      : {}),
    ...(normalizeNumber(value.openIssues) !== undefined
      ? { openIssues: normalizeNumber(value.openIssues) }
      : {}),
    ...(normalizeNumber(value.downloads) !== undefined
      ? { downloads: normalizeNumber(value.downloads) }
      : {}),
    ...(normalizeNumber(value.updatedAtMs) !== undefined
      ? { updatedAtMs: normalizeNumber(value.updatedAtMs) }
      : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
};

export const loadMarketplaceEnrichmentCache = (): Record<
  string,
  MarketplaceEnrichmentSnapshot
> => {
  try {
    const raw = window.localStorage.getItem(MARKETPLACE_ENRICHMENT_STORAGE_KEY);

    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as unknown;

    if (!isRecord(parsed) || !isRecord(parsed.entries)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed.entries).flatMap(([key, value]) => {
        const entry = normalizeCacheEntry(value);
        return entry ? [[key, entry]] : [];
      }),
    );
  } catch {
    return {};
  }
};

export const saveMarketplaceEnrichmentCache = (
  entries: Record<string, MarketplaceEnrichmentSnapshot>,
): void => {
  try {
    const document: MarketplaceEnrichmentCacheDocument = {
      schemaVersion: MARKETPLACE_ENRICHMENT_CACHE_VERSION,
      entries,
    };

    window.localStorage.setItem(
      MARKETPLACE_ENRICHMENT_STORAGE_KEY,
      JSON.stringify(document),
    );
  } catch {
    // Metrics are optional; quota or private browsing failures should not block marketplace use.
  }
};

export const getFreshMarketplaceEnrichment = (
  result: MarketplaceResult,
  cache: Record<string, MarketplaceEnrichmentSnapshot>,
): MarketplaceEnrichmentSnapshot | null => {
  const key = createEnrichmentCacheKey(result);

  if (!key) {
    return null;
  }

  const cached = cache[key];

  if (!cached || Date.now() - cached.fetchedAt > MARKETPLACE_ENRICHMENT_MAX_AGE_MS) {
    return null;
  }

  return cached;
};

export const mergeMarketplaceEnrichmentMetrics = (
  metrics: MarketplaceResultMetrics,
  enrichment: MarketplaceEnrichmentSnapshot | null,
): MarketplaceResultMetrics => {
  if (!enrichment) {
    return metrics;
  }

  return {
    ...metrics,
    ...(enrichment.stars !== undefined ? { stars: enrichment.stars } : {}),
    ...(enrichment.downloads !== undefined
      ? { downloads: enrichment.downloads }
      : {}),
    ...(enrichment.updatedAtMs !== undefined
      ? { updatedAtMs: enrichment.updatedAtMs }
      : {}),
    popularity:
      metrics.popularity ??
      Math.log10((enrichment.stars ?? 0) + 1) * 20 +
        Math.log10((enrichment.downloads ?? 0) + 1) * 8,
  };
};

export const enrichMarketplaceResults = async (
  results: MarketplaceResult[],
  cache: Record<string, MarketplaceEnrichmentSnapshot>,
  signal?: AbortSignal,
): Promise<Record<string, MarketplaceEnrichmentSnapshot>> => {
  const nextCache = { ...cache };

  for (const result of results) {
    const key = createEnrichmentCacheKey(result);

    if (!key) {
      continue;
    }

    const cached = nextCache[key];

    if (
      cached &&
      Date.now() - cached.fetchedAt <= MARKETPLACE_ENRICHMENT_MAX_AGE_MS
    ) {
      continue;
    }

    const githubPath = parseGitHubRepositoryPath(result.repositoryUrl);
    const npmPackage = getNpmPackageIdentifier(result);
    const snapshot: MarketplaceEnrichmentSnapshot = {
      fetchedAt: Date.now(),
      sources: [],
    };

    try {
      if (githubPath) {
        const github = await getJson(
          `https://api.github.com/repos/${githubPath}`,
          signal,
        );

        if (isRecord(github)) {
          snapshot.sources.push("GitHub");
          snapshot.stars = normalizeNumber(github.stargazers_count);
          snapshot.forks = normalizeNumber(github.forks_count);
          snapshot.openIssues = normalizeNumber(github.open_issues_count);
          snapshot.updatedAtMs = parseDateMs(github.pushed_at);
        }
      }

      if (npmPackage) {
        const npmDownloads = await getJson(
          `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(npmPackage)}`,
          signal,
        );

        if (isRecord(npmDownloads)) {
          snapshot.sources.push("npm");
          snapshot.downloads = normalizeNumber(npmDownloads.downloads);
        }
      }
    } catch (error) {
      snapshot.error = error instanceof Error ? error.message : String(error);
    }

    nextCache[key] = snapshot;
  }

  return nextCache;
};

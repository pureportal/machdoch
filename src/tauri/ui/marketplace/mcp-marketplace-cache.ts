import type {
  MarketplaceRegistryPage,
  MarketplaceResult,
} from "./mcp-marketplace-model";
import type { McpMarketplaceRegistrySource } from "../../../core/mcp/marketplace.js";

const MARKETPLACE_CATALOG_CACHE_STORAGE_KEY =
  "machdoch.desktop.mcp-marketplace-catalog-cache";
const MARKETPLACE_CATALOG_CACHE_VERSION = 1;
const MARKETPLACE_CATALOG_CACHE_MAX_RESULTS = 20_000;
const MARKETPLACE_CATALOG_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface MarketplaceCatalogCacheSnapshot {
  pages: Record<string, MarketplaceRegistryPage>;
  results: MarketplaceResult[];
  savedAt: number;
  signature: string;
  truncated: boolean;
}

interface MarketplaceCatalogCacheDocument extends MarketplaceCatalogCacheSnapshot {
  schemaVersion: typeof MARKETPLACE_CATALOG_CACHE_VERSION;
}

export const createMarketplaceRegistrySignature = (
  registries: McpMarketplaceRegistrySource[],
): string => {
  return registries
    .filter((registry) => registry.enabled)
    .map((registry) => `${registry.id}:${registry.baseUrl}`)
    .sort()
    .join("|");
};

const isCatalogCacheDocument = (
  value: unknown,
): value is MarketplaceCatalogCacheDocument => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Partial<MarketplaceCatalogCacheDocument>;

  return (
    record.schemaVersion === MARKETPLACE_CATALOG_CACHE_VERSION &&
    typeof record.savedAt === "number" &&
    typeof record.signature === "string" &&
    Array.isArray(record.results) &&
    typeof record.pages === "object" &&
    record.pages !== null
  );
};

export const loadMarketplaceCatalogCache = (
  signature: string,
): MarketplaceCatalogCacheSnapshot | null => {
  try {
    const raw = window.localStorage.getItem(MARKETPLACE_CATALOG_CACHE_STORAGE_KEY);

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as unknown;

    if (!isCatalogCacheDocument(parsed)) {
      return null;
    }

    if (parsed.signature !== signature) {
      return null;
    }

    if (Date.now() - parsed.savedAt > MARKETPLACE_CATALOG_CACHE_MAX_AGE_MS) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
};

export const saveMarketplaceCatalogCache = (
  snapshot: Omit<MarketplaceCatalogCacheSnapshot, "truncated">,
): void => {
  try {
    const results = snapshot.results.slice(0, MARKETPLACE_CATALOG_CACHE_MAX_RESULTS);
    const document: MarketplaceCatalogCacheDocument = {
      schemaVersion: MARKETPLACE_CATALOG_CACHE_VERSION,
      ...snapshot,
      results,
      truncated: snapshot.results.length > results.length,
    };

    window.localStorage.setItem(
      MARKETPLACE_CATALOG_CACHE_STORAGE_KEY,
      JSON.stringify(document),
    );
  } catch {
    // Catalog cache is a speed optimization only. Ignore quota/private-mode failures.
  }
};

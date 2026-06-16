import {
  AlertCircle,
  BadgeCheck,
  Clock3,
  Database,
  Download,
  ExternalLink,
  Gauge,
  KeyRound,
  Package,
  PlugZap,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Star,
  Trash2,
  TrendingUp,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";
import {
  createMcpConfigRawWithServerEnabled,
  createMcpConfigRawWithMarketplaceServer,
  createMcpConfigRawWithoutServer,
  createMcpMarketplaceInstallCandidates,
  createMcpMarketplaceInstallPlan,
  createMcpMarketplaceServersUrl,
  getMcpRegistryServerId,
  getMcpRegistryServerTitle,
  MCP_MARKETPLACE_CATEGORIES,
  MCP_OFFICIAL_REGISTRY_BASE_URL,
  normalizeMcpMarketplaceRegistryBaseUrl,
  type McpMarketplaceRegistrySource,
} from "../../../core/mcp/marketplace.js";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ScrollArea } from "../components/ui/scroll-area";
import {
  createFailedRegistryPage,
  filterMarketplaceResults,
  getErrorText,
  isMarketplaceResultDeprecated,
  mergeMarketplaceResults,
  parseInstalledServersRaw,
  parseMarketplaceRegistryResponse,
  redactMcpConfigRaw,
  sortMarketplaceResults,
  type MarketplaceDetailTab,
  type MarketplaceInstallKindFilter,
  type MarketplaceMessage,
  type MarketplaceRegistryPage,
  type MarketplaceRegistryServerReference,
  type MarketplaceResult,
  type MarketplaceView,
  type McpMarketplaceSortMode,
} from "./mcp-marketplace-model";
import {
  createMarketplaceRegistrySignature,
  loadMarketplaceCatalogCache,
  saveMarketplaceCatalogCache,
} from "./mcp-marketplace-cache";
import {
  enrichMarketplaceResults,
  getNpmPackageIdentifier,
  getFreshMarketplaceEnrichment,
  loadMarketplaceEnrichmentCache,
  mergeMarketplaceEnrichmentMetrics,
  parseGitHubRepositoryPath,
  saveMarketplaceEnrichmentCache,
  type MarketplaceEnrichmentSnapshot,
} from "./mcp-marketplace-enrichment";
import {
  CredentialInput,
  INPUT_CLASS,
  PANEL_CLASS,
  SELECT_CLASS,
  ServerBadge,
  StatusMessage,
  VIEW_OPTIONS,
  getCandidateLabel,
  getInstallKindLabel,
} from "./mcp-marketplace-ui";
import {
  DEFAULT_MCP_MARKETPLACE_STATE,
  loadMcpMarketplaceState,
  saveMcpMarketplaceState,
  type McpMarketplaceRegistrySourceState,
} from "../lib/shell-store";
import { cn } from "../lib/utils";
import {
  discoverMcpServer,
  loadMcpConfigDocument,
  saveMcpConfigDocument,
  type McpConfigDocument,
} from "../runtime";

interface McpMarketplaceProps {
  workspaceRoot: string | null | undefined;
  onOpenSettings: () => void;
}

const OFFICIAL_REGISTRY: McpMarketplaceRegistrySource = {
  id: "official",
  title: "Official MCP Registry",
  baseUrl: MCP_OFFICIAL_REGISTRY_BASE_URL,
  enabled: true,
  official: true,
};

const MARKETPLACE_REGISTRY_PAGE_SIZE = 100;
const MAX_MARKETPLACE_LOAD_ALL_PAGE_ROUNDS = 50;
const MARKETPLACE_RESULT_ROW_HEIGHT = 132;
const MARKETPLACE_RESULT_LIST_OVERSCAN = 6;
const MARKETPLACE_BACKGROUND_ENRICHMENT_BATCH_SIZE = 8;
const MARKETPLACE_SEARCH_DEBOUNCE_MS = 450;
const MARKETPLACE_CATALOG_DELTA_OVERLAP_MS = 60_000;

const COMPACT_NUMBER_FORMATTER = new Intl.NumberFormat(undefined, {
  compactDisplay: "short",
  maximumFractionDigits: 1,
  notation: "compact",
});

const formatCompactNumber = (value: number | undefined): string | null => {
  return typeof value === "number" && Number.isFinite(value)
    ? COMPACT_NUMBER_FORMATTER.format(value)
    : null;
};

const formatDateLabel = (value: number): string | null => {
  if (!value) {
    return null;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
  }).format(new Date(value));
};

const getFallbackLogoLabel = (result: MarketplaceResult): string => {
  const title = getMcpRegistryServerTitle(result.entry.server);
  const words = title
    .replace(/[^a-z0-9]+/giu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);

  if (words.length >= 2) {
    return `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`.toUpperCase();
  }

  return (words[0]?.slice(0, 2) || "MC").toUpperCase();
};

const fetchMarketplaceRegistryPage = async (
  registry: McpMarketplaceRegistrySource,
  searchTerm: string,
  cursor?: string | null,
  signal?: AbortSignal,
  updatedSince?: string,
): Promise<{
  deletedServers: MarketplaceRegistryServerReference[];
  results: MarketplaceResult[];
  page: MarketplaceRegistryPage;
}> => {
  const request = {
    search: searchTerm,
    limit: MARKETPLACE_REGISTRY_PAGE_SIZE,
    latestOnly: true,
    ...(cursor ? { cursor } : {}),
    ...(updatedSince ? { updatedSince } : {}),
  };
  const response = await fetch(
    createMcpMarketplaceServersUrl(registry, request),
    { signal },
  );

  if (!response.ok) {
    throw new Error(`${registry.title}: ${response.status}`);
  }

  return parseMarketplaceRegistryResponse(await response.json(), registry);
};

const fetchNextMarketplaceRegistryPages = async ({
  appliedQuery,
  enabledRegistryIds,
  pages,
  registries,
  signal,
  updatedSince,
}: {
  appliedQuery: string;
  enabledRegistryIds: ReadonlySet<string>;
  pages: Record<string, MarketplaceRegistryPage>;
  registries: McpMarketplaceRegistrySource[];
  signal?: AbortSignal;
  updatedSince?: string;
}): Promise<{
  deletedServers: MarketplaceRegistryServerReference[];
  fetchedPageCount: number;
  failures: string[];
  pages: Record<string, MarketplaceRegistryPage>;
  results: MarketplaceResult[];
}> => {
  const registryById = new Map(
    registries.map((registry) => [registry.id, registry]),
  );
  const requests = Object.values(pages).flatMap((page) => {
    const registry = registryById.get(page.registryId);

    return registry && enabledRegistryIds.has(page.registryId) && page.nextCursor
      ? [{ registry, registryId: page.registryId, cursor: page.nextCursor }]
      : [];
  });

  if (requests.length === 0) {
    return {
      fetchedPageCount: 0,
      failures: [],
      pages,
      deletedServers: [],
      results: [],
    };
  }

  const settled = await Promise.all(
    requests.map(async (request) => {
      try {
        return {
          registryId: request.registryId,
          status: "fulfilled" as const,
          value: await fetchMarketplaceRegistryPage(
            request.registry,
            appliedQuery,
            request.cursor,
            signal,
            updatedSince,
          ),
        };
      } catch (error) {
        return {
          registryId: request.registryId,
          status: "rejected" as const,
          reason: error,
        };
      }
    }),
  );
  const nextPages = { ...pages };
  const deletedServers: MarketplaceRegistryServerReference[] = [];
  const nextResults: MarketplaceResult[] = [];
  const failures: string[] = [];

  for (const result of settled) {
    if (result.status === "fulfilled") {
      nextPages[result.value.page.registryId] = result.value.page;
      deletedServers.push(...result.value.deletedServers);
      nextResults.push(...result.value.results);
    } else {
      nextPages[result.registryId] = createFailedRegistryPage(
        result.registryId,
        result.reason,
      );
      failures.push(getErrorText(result.reason));
    }
  }

  return {
    deletedServers,
    fetchedPageCount: requests.length,
    failures,
    pages: nextPages,
    results: nextResults,
  };
};

const createAbortError = (): DOMException => {
  return new DOMException("Marketplace request aborted", "AbortError");
};

interface MarketplaceCatalogFetchSnapshot {
  changedCount: number;
  deletedCount: number;
  failures: string[];
  incremental: boolean;
  pages: Record<string, MarketplaceRegistryPage>;
  reachedRoundLimit: boolean;
  results: MarketplaceResult[];
}

interface MarketplaceCatalogRefreshOptions {
  background?: boolean;
  basePages?: Record<string, MarketplaceRegistryPage>;
  baseResults?: MarketplaceResult[];
  updatedSince?: string;
}

const fetchMarketplaceCatalog = async ({
  basePages = {},
  baseResults = [],
  onProgress,
  registries,
  signal,
  updatedSince,
}: {
  basePages?: Record<string, MarketplaceRegistryPage>;
  baseResults?: MarketplaceResult[];
  onProgress?: (snapshot: MarketplaceCatalogFetchSnapshot) => void;
  registries: McpMarketplaceRegistrySource[];
  signal?: AbortSignal;
  updatedSince?: string;
}): Promise<MarketplaceCatalogFetchSnapshot> => {
  const enabledRegistries = registries.filter((registry) => registry.enabled);
  const enabledRegistryIds = new Set(
    enabledRegistries.map((registry) => registry.id),
  );

  if (signal?.aborted) {
    throw createAbortError();
  }

  const settled = await Promise.allSettled(
    enabledRegistries.map((registry) =>
      fetchMarketplaceRegistryPage(
        registry,
        "",
        undefined,
        signal,
        updatedSince,
      ),
    ),
  );

  if (signal?.aborted) {
    throw createAbortError();
  }

  let pages = {
    ...basePages,
    ...Object.fromEntries(
      settled.map((result, index) => {
        const registry = enabledRegistries[index];

        if (!registry) {
          return [
            "unknown",
            createFailedRegistryPage("unknown", "Missing registry"),
          ];
        }

        return result.status === "fulfilled"
          ? [registry.id, result.value.page]
          : [registry.id, createFailedRegistryPage(registry.id, result.reason)];
      }),
    ),
  };
  const initialResults = settled.flatMap((result) =>
    result.status === "fulfilled" ? result.value.results : [],
  );
  const initialDeletedServers = settled.flatMap((result) =>
    result.status === "fulfilled" ? result.value.deletedServers : [],
  );
  let results = mergeMarketplaceResults(
    baseResults,
    initialResults,
    initialDeletedServers,
  );
  const failures = settled.flatMap((result) =>
    result.status === "rejected" ? [getErrorText(result.reason)] : [],
  );
  let changedCount = initialResults.length;
  let deletedCount = initialDeletedServers.length;
  let reachedRoundLimit = false;

  onProgress?.({
    changedCount,
    deletedCount,
    failures: [...failures],
    incremental: Boolean(updatedSince),
    pages,
    reachedRoundLimit,
    results,
  });

  for (
    let round = 0;
    round < MAX_MARKETPLACE_LOAD_ALL_PAGE_ROUNDS;
    round += 1
  ) {
    const hasMorePages = Object.values(pages).some(
      (page) => enabledRegistryIds.has(page.registryId) && page.nextCursor,
    );

    if (!hasMorePages) {
      break;
    }

    if (signal?.aborted) {
      throw createAbortError();
    }

    const nextPage = await fetchNextMarketplaceRegistryPages({
      appliedQuery: "",
      enabledRegistryIds,
      pages,
      registries,
      signal,
      updatedSince,
    });

    if (signal?.aborted) {
      throw createAbortError();
    }

    if (nextPage.fetchedPageCount === 0) {
      break;
    }

    pages = nextPage.pages;
    results = mergeMarketplaceResults(
      results,
      nextPage.results,
      nextPage.deletedServers,
    );
    changedCount += nextPage.results.length;
    deletedCount += nextPage.deletedServers.length;
    failures.push(...nextPage.failures);
    reachedRoundLimit = round === MAX_MARKETPLACE_LOAD_ALL_PAGE_ROUNDS - 1;

    onProgress?.({
      changedCount,
      deletedCount,
      failures: [...failures],
      incremental: Boolean(updatedSince),
      pages,
      reachedRoundLimit,
      results,
    });
  }

  return {
    changedCount,
    deletedCount,
    failures,
    incremental: Boolean(updatedSince),
    pages,
    reachedRoundLimit,
    results,
  };
};

const getMarketplaceCatalogDeltaSince = (
  cache: ReturnType<typeof loadMarketplaceCatalogCache>,
): string | undefined => {
  if (!cache || cache.truncated) {
    return undefined;
  }

  const hasUnloadedPages = Object.values(cache.pages).some(
    (page) => page.nextCursor,
  );

  if (hasUnloadedPages) {
    return undefined;
  }

  return new Date(
    Math.max(0, cache.savedAt - MARKETPLACE_CATALOG_DELTA_OVERLAP_MS),
  ).toISOString();
};

export const McpMarketplace = ({
  workspaceRoot,
  onOpenSettings,
}: McpMarketplaceProps): JSX.Element => {
  const [view, setView] = useState<MarketplaceView>("discover");
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [installKindFilter, setInstallKindFilter] =
    useState<MarketplaceInstallKindFilter>("all");
  const [sortMode, setSortMode] =
    useState<McpMarketplaceSortMode>("recommended");
  const [detailTab, setDetailTab] = useState<MarketplaceDetailTab>("overview");
  const [marketplaceState, setMarketplaceState] = useState(
    DEFAULT_MCP_MARKETPLACE_STATE,
  );
  const [results, setResults] = useState<MarketplaceResult[]>([]);
  const [registryPages, setRegistryPages] = useState<
    Record<string, MarketplaceRegistryPage>
  >({});
  const resultsRef = useRef<MarketplaceResult[]>([]);
  const registryPagesRef = useRef<Record<string, MarketplaceRegistryPage>>({});
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [candidateId, setCandidateId] = useState<string>("");
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installedDocument, setInstalledDocument] =
    useState<McpConfigDocument | null>(null);
  const [registryTitleDraft, setRegistryTitleDraft] = useState("");
  const [registryUrlDraft, setRegistryUrlDraft] = useState("");
  const [registryTesting, setRegistryTesting] = useState(false);
  const [enrichmentCache, setEnrichmentCache] = useState<
    Record<string, MarketplaceEnrichmentSnapshot>
  >({});
  const [enrichingMetrics, setEnrichingMetrics] = useState(false);
  const [searchPending, setSearchPending] = useState(false);
  const [catalogCacheStatus, setCatalogCacheStatus] = useState<string | null>(
    null,
  );
  const [message, setMessage] = useState<MarketplaceMessage | null>(null);
  const catalogRefreshRequestRef = useRef<{
    controller: AbortController;
    id: number;
  } | null>(null);
  const resultsViewportRef = useRef<HTMLDivElement | null>(null);
  const catalogRefreshSequenceRef = useRef(0);
  const catalogCacheSignatureRef = useRef<string>("");
  const [resultListMetrics, setResultListMetrics] = useState({
    scrollTop: 0,
    viewportHeight: 480,
  });

  const registries = useMemo<McpMarketplaceRegistrySource[]>(() => {
    return [
      OFFICIAL_REGISTRY,
      ...marketplaceState.registries.map((registry) => ({
        ...registry,
        official: false,
      })),
    ];
  }, [marketplaceState.registries]);

  const enrichedResults = useMemo(() => {
    return results.map((result) => {
      const enrichment = getFreshMarketplaceEnrichment(result, enrichmentCache);
      return {
        ...result,
        metrics: mergeMarketplaceEnrichmentMetrics(result.metrics, enrichment),
      };
    });
  }, [enrichmentCache, results]);

  const visibleResults = useMemo(() => {
    return sortMarketplaceResults(
      filterMarketplaceResults(
        enrichedResults,
        selectedCategory,
        appliedQuery,
        installKindFilter,
      ),
      sortMode,
      appliedQuery,
    );
  }, [
    appliedQuery,
    enrichedResults,
    installKindFilter,
    selectedCategory,
    sortMode,
  ]);
  const firstVisibleResultKey = visibleResults[0]?.key ?? null;

  const selectedResult = useMemo(() => {
    return (
      visibleResults.find((result) => result.key === selectedKey) ??
      visibleResults[0]
    );
  }, [selectedKey, visibleResults]);

  const candidates = useMemo(() => {
    return selectedResult
      ? createMcpMarketplaceInstallCandidates(selectedResult.entry.server)
      : [];
  }, [selectedResult]);

  const plan = useMemo(() => {
    if (!selectedResult) {
      return null;
    }

    try {
      return createMcpMarketplaceInstallPlan(selectedResult.entry, {
        ...(candidateId ? { candidateId } : {}),
        credentials,
      });
    } catch {
      return null;
    }
  }, [candidateId, credentials, selectedResult]);

  const installedServers = useMemo(() => {
    return installedDocument
      ? parseInstalledServersRaw(installedDocument.raw).sort((left, right) =>
          left.title.localeCompare(right.title, undefined, {
            sensitivity: "base",
          }),
        )
      : [];
  }, [installedDocument]);
  const installedServerIds = useMemo(() => {
    return new Set(installedServers.map((server) => server.id));
  }, [installedServers]);

  const selectedSourceKey = selectedResult?.key;
  const registrySignature = useMemo(() => {
    return createMarketplaceRegistrySignature(registries);
  }, [registries]);
  const catalogUpdating = loading || loadingAll;
  const searchBusy = searchPending || catalogUpdating;
  const controlsDisabled = loading && results.length === 0;
  const marketplaceActivityLabel = useMemo(() => {
    return [
      searchPending ? "Searching marketplace" : "",
      loadingAll ? "Updating marketplace catalog" : "",
      enrichingMetrics ? "Enriching marketplace metrics" : "",
      catalogCacheStatus ?? "",
    ]
      .filter(Boolean)
      .join(". ");
  }, [catalogCacheStatus, enrichingMetrics, loadingAll, searchPending]);

  useEffect(() => {
    let cancelled = false;

    void loadMcpMarketplaceState().then((state) => {
      if (!cancelled) {
        setMarketplaceState(state);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setEnrichmentCache(loadMarketplaceEnrichmentCache());
  }, []);

  useEffect(() => {
    resultsRef.current = results;
  }, [results]);

  useEffect(() => {
    registryPagesRef.current = registryPages;
  }, [registryPages]);

  const loadInstalledDocument = useCallback(async (): Promise<void> => {
    try {
      setInstalledDocument(await loadMcpConfigDocument("user"));
    } catch (error) {
      setMessage({
        tone: "error",
        text: `Global MCP config could not be loaded: ${getErrorText(error)}`,
      });
    }
  }, []);

  const refreshMarketplaceCatalog = useCallback(
    async (options: MarketplaceCatalogRefreshOptions = {}): Promise<void> => {
      if (!registrySignature) {
        return;
      }

      const requestId = catalogRefreshSequenceRef.current + 1;
      const controller = new AbortController();

      catalogRefreshSequenceRef.current = requestId;
      catalogRefreshRequestRef.current?.controller.abort();
      catalogRefreshRequestRef.current = { controller, id: requestId };
      setLoadingAll(true);

      if (!options.background) {
        setLoading(true);
        setMessage(null);
        setCatalogCacheStatus("Refreshing catalog...");
      } else {
        setCatalogCacheStatus((current) => current ?? "Updating catalog...");
      }

      try {
        const catalog = await fetchMarketplaceCatalog({
          basePages: options.basePages,
          baseResults: options.baseResults,
          onProgress: (snapshot) => {
            if (
              controller.signal.aborted ||
              catalogRefreshRequestRef.current?.id !== requestId
            ) {
              return;
            }

            setResults(snapshot.results);
            setRegistryPages(snapshot.pages);
            setSelectedKey((current) =>
              current && snapshot.results.some((result) => result.key === current)
                ? current
                : snapshot.results[0]?.key ?? null,
            );
            setCatalogCacheStatus(
              `${
                snapshot.incremental ? "Catalog delta updating" : "Catalog updating"
              }: ${snapshot.results.length} servers loaded${
                snapshot.reachedRoundLimit ? ", more may be available" : ""
              }.`,
            );
          },
          registries,
          signal: controller.signal,
          updatedSince: options.updatedSince,
        });

        if (catalogRefreshRequestRef.current?.id !== requestId) {
          return;
        }

        setResults(catalog.results);
        setRegistryPages(catalog.pages);
        setSelectedKey((current) =>
          current && catalog.results.some((result) => result.key === current)
            ? current
            : catalog.results[0]?.key ?? null,
        );
        saveMarketplaceCatalogCache({
          pages: catalog.pages,
          results: catalog.results,
          savedAt: Date.now(),
          signature: registrySignature,
        });
        setCatalogCacheStatus(
          `${
            catalog.incremental ? "Catalog delta updated" : "Catalog updated"
          }: ${catalog.results.length} servers cached${
            catalog.reachedRoundLimit ? ", more may be available" : ""
          }${
            catalog.incremental
              ? ` (${catalog.changedCount} changed, ${catalog.deletedCount} removed)`
              : ""
          }.`,
        );

        if (catalog.failures.length > 0) {
          setMessage({
            tone: "warning",
            text: `Some registries could not be loaded: ${catalog.failures.join(", ")}`,
          });
        } else if (!options.background) {
          setMessage({
            tone: "success",
            text: "Marketplace catalog refreshed.",
          });
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }

        if (!options.background) {
          setMessage({
            tone: "error",
            text: `Marketplace refresh failed: ${getErrorText(error)}`,
          });
        } else {
          setCatalogCacheStatus(
            `Background update failed: ${getErrorText(error)}`,
          );
        }
      } finally {
        if (catalogRefreshRequestRef.current?.id === requestId) {
          setLoading(false);
          setLoadingAll(false);
        }
      }
    },
    [registries, registrySignature],
  );

  const searchRegistries = useCallback((searchTerm: string): void => {
    const normalizedSearchTerm = searchTerm.trim();

    setAppliedQuery(normalizedSearchTerm);
    setSearchPending(false);

    if (normalizedSearchTerm) {
      setSortMode("relevance");
    }
  }, []);

  const refreshMetricsForResults = useCallback(
    async (
      resultsToRefresh: MarketplaceResult[],
      options: { silent?: boolean } = {},
    ): Promise<void> => {
      if (enrichingMetrics || resultsToRefresh.length === 0) {
        return;
      }

      setEnrichingMetrics(true);

      if (!options.silent) {
        setMessage(null);
      }

      const controller = new AbortController();

      try {
        const nextCache = await enrichMarketplaceResults(
          resultsToRefresh,
          enrichmentCache,
          controller.signal,
        );

        setEnrichmentCache(nextCache);
        saveMarketplaceEnrichmentCache(nextCache);

        if (!options.silent) {
          setMessage({
            tone: "success",
            text: `Metrics refreshed for ${resultsToRefresh.length} entr${
              resultsToRefresh.length === 1 ? "y" : "ies"
            }.`,
          });
        }
      } catch (error) {
        if (!options.silent) {
          setMessage({
            tone: "warning",
            text: `Metrics refresh failed: ${getErrorText(error)}`,
          });
        }
      } finally {
        setEnrichingMetrics(false);
      }
    },
    [enrichmentCache, enrichingMetrics],
  );

  useEffect(() => {
    if (!registrySignature) {
      return;
    }

    if (catalogCacheSignatureRef.current !== registrySignature) {
      catalogCacheSignatureRef.current = registrySignature;
      const cached = loadMarketplaceCatalogCache(registrySignature);
      const updatedSince = getMarketplaceCatalogDeltaSince(cached);

      if (cached) {
        setResults(cached.results);
        setRegistryPages(cached.pages);
        setSelectedKey(cached.results[0]?.key ?? null);
        setCatalogCacheStatus(
          `${cached.results.length} cached servers restored${
            cached.truncated ? " (partial cache)" : ""
          }; ${
            updatedSince ? "checking for updates" : "updating catalog"
          }...`,
        );
        void refreshMarketplaceCatalog({
          background: true,
          basePages: cached.pages,
          baseResults: cached.results,
          updatedSince,
        });
        return;
      } else {
        setResults([]);
        setRegistryPages({});
        setSelectedKey(null);
        setCatalogCacheStatus("Updating catalog...");
        void refreshMarketplaceCatalog({
          background: true,
          basePages: {},
          baseResults: [],
        });
        return;
      }
    }

    void refreshMarketplaceCatalog({
      background: true,
      basePages: registryPagesRef.current,
      baseResults: resultsRef.current,
    });
  }, [refreshMarketplaceCatalog, registrySignature]);

  useEffect(() => {
    const normalizedQuery = query.trim();

    if (normalizedQuery === appliedQuery) {
      setSearchPending(false);
      return;
    }

    setSearchPending(true);

    const timeout = window.setTimeout(() => {
      searchRegistries(normalizedQuery);
    }, MARKETPLACE_SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [appliedQuery, query, searchRegistries]);

  useEffect(() => {
    return () => {
      catalogRefreshRequestRef.current?.controller.abort();
    };
  }, []);

  useEffect(() => {
    void loadInstalledDocument();
  }, [loadInstalledDocument]);

  useEffect(() => {
    if (view === "installed" || view === "advanced") {
      void loadInstalledDocument();
    }
  }, [loadInstalledDocument, view]);

  useEffect(() => {
    const element = resultsViewportRef.current;

    if (!element) {
      return;
    }

    const updateMetrics = (): void => {
      setResultListMetrics({
        scrollTop: element.scrollTop,
        viewportHeight: element.clientHeight || 480,
      });
    };

    updateMetrics();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(updateMetrics);
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [view]);

  useEffect(() => {
    const element = resultsViewportRef.current;
    if (element) {
      element.scrollTop = 0;
    }
    setSelectedKey(firstVisibleResultKey);
    setResultListMetrics((current) => ({
      ...current,
      scrollTop: 0,
    }));
  }, [
    appliedQuery,
    firstVisibleResultKey,
    installKindFilter,
    selectedCategory,
    sortMode,
  ]);

  useEffect(() => {
    setDetailTab("overview");
  }, [selectedSourceKey]);

  useEffect(() => {
    if (detailTab !== "trust" || !selectedResult || enrichingMetrics) {
      return;
    }

    const hasMetricSource =
      parseGitHubRepositoryPath(selectedResult.repositoryUrl) ||
      getNpmPackageIdentifier(selectedResult);

    if (!hasMetricSource) {
      return;
    }

    if (getFreshMarketplaceEnrichment(selectedResult, enrichmentCache)) {
      return;
    }

    void refreshMetricsForResults([selectedResult], { silent: true });
  }, [
    detailTab,
    enrichmentCache,
    enrichingMetrics,
    refreshMetricsForResults,
    selectedResult,
  ]);

  useEffect(() => {
    if (
      (loading && results.length === 0) ||
      enrichingMetrics ||
      enrichedResults.length === 0
    ) {
      return;
    }

    const staleMetricResults = enrichedResults
      .filter((result) => {
        const hasMetricSource =
          parseGitHubRepositoryPath(result.repositoryUrl) ||
          getNpmPackageIdentifier(result);

        return (
          hasMetricSource &&
          !getFreshMarketplaceEnrichment(result, enrichmentCache)
        );
      })
      .slice(0, MARKETPLACE_BACKGROUND_ENRICHMENT_BATCH_SIZE);

    if (staleMetricResults.length === 0) {
      return;
    }

    const timeout = window.setTimeout(() => {
      void refreshMetricsForResults(staleMetricResults, { silent: true });
    }, 750);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [
    enrichedResults,
    enrichmentCache,
    enrichingMetrics,
    loading,
    results.length,
    refreshMetricsForResults,
  ]);

  useEffect(() => {
    setCandidateId("");
    setCredentials({});
  }, [selectedSourceKey]);

  const updateMarketplaceState = async (
    registriesPatch: McpMarketplaceRegistrySourceState[],
  ): Promise<void> => {
    const nextState = {
      version: 1,
      registries: registriesPatch,
    } as const;

    setMarketplaceState(nextState);
    await saveMcpMarketplaceState(nextState);
  };

  const getRegistryDraft = (): {
    baseUrl: string;
    title: string;
  } | null => {
    const title = registryTitleDraft.trim();
    const rawUrl = registryUrlDraft.trim();

    if (!title || !rawUrl) {
      setMessage({
        tone: "error",
        text: "Enter a registry name and URL.",
      });
      return null;
    }

    try {
      const baseUrl = normalizeMcpMarketplaceRegistryBaseUrl(rawUrl);
      new URL(baseUrl);
      return { baseUrl, title };
    } catch {
      setMessage({
        tone: "error",
        text: "Registry URL must be a valid URL.",
      });
      return null;
    }
  };

  const testRegistryDraft = async (): Promise<void> => {
    const draft = getRegistryDraft();

    if (!draft) {
      return;
    }

    setRegistryTesting(true);
    setMessage(null);

    try {
      await fetchMarketplaceRegistryPage(
        {
          id: "draft",
          title: draft.title,
          baseUrl: draft.baseUrl,
          enabled: true,
        },
        "",
      );
      setMessage({
        tone: "success",
        text: `${draft.title} responded with a valid registry payload.`,
      });
    } catch (error) {
      setMessage({
        tone: "error",
        text: `Registry test failed: ${getErrorText(error)}`,
      });
    } finally {
      setRegistryTesting(false);
    }
  };

  const addRegistry = async (): Promise<void> => {
    const draft = getRegistryDraft();

    if (!draft) {
      return;
    }

    if (
      registries.some(
        (registry) =>
          normalizeMcpMarketplaceRegistryBaseUrl(registry.baseUrl) ===
          draft.baseUrl,
      )
    ) {
      setMessage({
        tone: "error",
        text: "This registry URL is already configured.",
      });
      return;
    }

    const id = `custom-${Date.now()}`;

    await updateMarketplaceState([
      ...marketplaceState.registries,
      {
        id,
        title: draft.title,
        baseUrl: draft.baseUrl,
        enabled: true,
      },
    ]);
    setRegistryTitleDraft("");
    setRegistryUrlDraft("");
    setMessage({
      tone: "success",
      text: "Custom MCP registry added.",
    });
  };

  const toggleRegistry = async (id: string, enabled: boolean): Promise<void> => {
    await updateMarketplaceState(
      marketplaceState.registries.map((registry) =>
        registry.id === id ? { ...registry, enabled } : registry,
      ),
    );
  };

  const removeRegistry = async (id: string): Promise<void> => {
    await updateMarketplaceState(
      marketplaceState.registries.filter((registry) => registry.id !== id),
    );
  };

  const installSelectedServer = async (): Promise<void> => {
    if (!selectedResult || !plan) {
      return;
    }

    if (plan.missingCredentialFields.length > 0) {
      setMessage({
        tone: "error",
        text: "Fill required credentials before installing.",
      });
      return;
    }

    if (plan.blockedReasons.length > 0) {
      setMessage({
        tone: "error",
        text: plan.blockedReasons[0] ?? "This MCP cannot be installed automatically.",
      });
      return;
    }

    setInstalling(true);
    setMessage(null);

    try {
      const document = await loadMcpConfigDocument("user");
      const nextRaw = createMcpConfigRawWithMarketplaceServer(
        document.raw,
        plan.server,
      );
      const savedDocument = await saveMcpConfigDocument("user", nextRaw);

      setInstalledDocument(savedDocument);

      if (workspaceRoot?.trim()) {
        try {
          await discoverMcpServer(workspaceRoot, plan.server.id);
          setMessage({
            tone: "success",
            text: `${plan.title} installed globally, enabled, and discovered.`,
          });
        } catch (error) {
          setMessage({
            tone: "warning",
            text: `${plan.title} installed globally, but discovery failed: ${getErrorText(error)}`,
          });
        }
      } else {
        setMessage({
          tone: "success",
          text: `${plan.title} installed globally. Select a workspace to run discovery.`,
        });
      }

      setView("installed");
    } catch (error) {
      setMessage({
        tone: "error",
        text: `Install failed: ${getErrorText(error)}`,
      });
    } finally {
      setInstalling(false);
    }
  };

  const setInstalledServerEnabled = async (
    serverId: string,
    enabled: boolean,
  ): Promise<void> => {
    try {
      const document = await loadMcpConfigDocument("user");
      const nextRaw = createMcpConfigRawWithServerEnabled(
        document.raw,
        serverId,
        enabled,
      );
      const savedDocument = await saveMcpConfigDocument("user", nextRaw);

      setInstalledDocument(savedDocument);
      setMessage({
        tone: "success",
        text: `${serverId} ${enabled ? "enabled" : "disabled"}.`,
      });
    } catch (error) {
      setMessage({
        tone: "error",
        text: `MCP server update failed: ${getErrorText(error)}`,
      });
    }
  };

  const removeInstalledServer = async (serverId: string): Promise<void> => {
    try {
      const document = await loadMcpConfigDocument("user");
      const nextRaw = createMcpConfigRawWithoutServer(document.raw, serverId);
      const savedDocument = await saveMcpConfigDocument("user", nextRaw);

      setInstalledDocument(savedDocument);
      setMessage({
        tone: "success",
        text: `${serverId} removed from global MCP config.`,
      });
    } catch (error) {
      setMessage({
        tone: "error",
        text: `MCP server removal failed: ${getErrorText(error)}`,
      });
    }
  };

  const renderServerLogo = (
    result: MarketplaceResult,
    className: string,
  ): JSX.Element => {
    const label = getFallbackLogoLabel(result);

    return (
      <span
        className={cn(
          "flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-800 bg-slate-900 text-xs font-semibold text-slate-300",
          className,
        )}
      >
        {result.logoUrl ? (
          <img
            src={result.logoUrl}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={(event) => {
              event.currentTarget.style.display = "none";
            }}
          />
        ) : (
          label
        )}
      </span>
    );
  };

  const renderMetricChip = ({
    icon: Icon,
    label,
    value,
  }: {
    icon: typeof Star;
    label: string;
    value: string | null;
  }): JSX.Element | null => {
    if (!value) {
      return null;
    }

    return (
      <span className="inline-flex h-6 items-center gap-1 rounded-full border border-slate-800 bg-slate-950 px-2 text-xs text-slate-300">
        <Icon className="h-3.5 w-3.5 text-slate-500" />
        <span className="sr-only">{label}</span>
        {value}
      </span>
    );
  };

  const renderRecommendedBadge = (
    result: Pick<MarketplaceResult, "recommendation" | "recommended">,
  ): JSX.Element | null => {
    if (!result.recommended || !result.recommendation) {
      return null;
    }

    return (
      <span
        title={result.recommendation.reason}
        className="inline-flex h-6 items-center gap-1 rounded-full border border-amber-400/25 bg-amber-400/10 px-2 text-xs font-semibold text-amber-100"
      >
        <Star className="h-3.5 w-3.5 fill-amber-300 text-amber-300" />
        {result.recommendation.label}
      </span>
    );
  };

  const renderResultCard = (
    result: MarketplaceResult,
    topOffset: number,
  ): JSX.Element => {
    const selected = result.key === selectedResult?.key;
    const server = result.entry.server;
    const serverConfigId = getMcpRegistryServerId(server);
    const installed = installedServerIds.has(serverConfigId);
    const updatedAt = formatDateLabel(
      result.metrics.updatedAtMs || result.updatedAtMs || result.publishedAtMs,
    );

    return (
      <button
        key={result.key}
        type="button"
        data-marketplace-result-card="true"
        aria-pressed={selected}
        onClick={() => setSelectedKey(result.key)}
        className={cn(
          "absolute left-0 right-0 grid h-[7.5rem] grid-cols-[2.5rem_minmax(0,1fr)] gap-3 rounded-lg border border-slate-800 bg-slate-950 p-3 text-left transition hover:border-sky-500/30 hover:bg-slate-900/70",
          selected && "border-sky-500/40 bg-sky-500/10",
        )}
        style={{ transform: `translateY(${topOffset}px)` }}
      >
        {renderServerLogo(result, "h-10 w-10")}
        <span className="grid min-w-0 gap-1">
          <span className="flex min-w-0 items-start justify-between gap-3">
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-slate-100">
                {getMcpRegistryServerTitle(server)}
              </span>
              <span className="block truncate font-mono text-xs text-slate-500">
                {server.name}
              </span>
            </span>
            <span className="shrink-0 rounded-full border border-slate-800 px-2 py-0.5 text-xs text-slate-400">
              {server.version}
            </span>
          </span>
          <span className="line-clamp-2 text-xs leading-5 text-slate-400">
            {server.description}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            {renderRecommendedBadge(result)}
            {installed ? <ServerBadge>installed</ServerBadge> : null}
            {result.status === "active" ? (
              <ServerBadge>active</ServerBadge>
            ) : (
              <ServerBadge>{result.status}</ServerBadge>
            )}
            <ServerBadge>{result.installKind}</ServerBadge>
            {result.authRequired ? <ServerBadge>auth</ServerBadge> : null}
            {renderMetricChip({
              icon: Star,
              label: "Stars",
              value: formatCompactNumber(result.metrics.stars),
            })}
            {renderMetricChip({
              icon: TrendingUp,
              label: "Downloads",
              value: formatCompactNumber(result.metrics.downloads),
            })}
            {updatedAt ? (
              <span className="inline-flex h-6 items-center gap-1 rounded-full border border-slate-800 bg-slate-950 px-2 text-xs text-slate-400">
                <Clock3 className="h-3.5 w-3.5" />
                {updatedAt}
              </span>
            ) : null}
          </span>
        </span>
      </button>
    );
  };

  const renderNavigation = (): JSX.Element => {
    return (
      <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-900 bg-slate-950/80 p-2 md:flex-col md:overflow-visible md:border-b-0 md:border-r md:p-3">
        {VIEW_OPTIONS.map((option) => {
          const Icon = option.icon;

          return (
            <Button
              key={option.id}
              type="button"
              variant="ghost"
              onClick={() => setView(option.id)}
              className={cn(
                "h-10 shrink-0 justify-start rounded-lg border border-transparent px-3 text-sm text-slate-400 hover:border-slate-800 hover:bg-slate-900 hover:text-slate-100",
                view === option.id &&
                  "border-sky-500/25 bg-sky-500/10 text-sky-100",
              )}
            >
              <Icon className="h-4 w-4" />
              {option.label}
            </Button>
          );
        })}
      </nav>
    );
  };

  const renderDiscoverResultsContent = (): JSX.Element => {
    const totalHeight = visibleResults.length * MARKETPLACE_RESULT_ROW_HEIGHT;
    const startIndex = Math.max(
      0,
      Math.floor(resultListMetrics.scrollTop / MARKETPLACE_RESULT_ROW_HEIGHT) -
        MARKETPLACE_RESULT_LIST_OVERSCAN,
    );
    const endIndex = Math.min(
      visibleResults.length,
      Math.ceil(
        (resultListMetrics.scrollTop + resultListMetrics.viewportHeight) /
          MARKETPLACE_RESULT_ROW_HEIGHT,
      ) + MARKETPLACE_RESULT_LIST_OVERSCAN,
    );
    const virtualResults = visibleResults.slice(startIndex, endIndex);

    return (
      <>
        {catalogUpdating && results.length === 0 ? (
          <div className="m-3 rounded-lg border border-slate-800 bg-slate-900/50 p-3 text-sm text-slate-400">
            Loading marketplace catalog...
          </div>
        ) : null}
        {!catalogUpdating && visibleResults.length === 0 ? (
          <div className="m-3 rounded-lg border border-slate-800 bg-slate-900/50 p-3 text-sm text-slate-400">
            No servers in this category.
          </div>
        ) : null}
        {visibleResults.length > 0 ? (
          <div className="relative mx-3" style={{ height: totalHeight }}>
            {virtualResults.map((result, index) =>
              renderResultCard(
                result,
                (startIndex + index) * MARKETPLACE_RESULT_ROW_HEIGHT,
              ),
            )}
          </div>
        ) : null}
      </>
    );
  };

  const renderDiscoverList = (): JSX.Element => {
    return (
      <div className={cn(PANEL_CLASS, "flex flex-col overflow-hidden lg:min-h-0")}>
        <div className="border-b border-slate-800 p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <Input
              value={query}
              placeholder="Search MCP servers"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  searchRegistries(query);
                }
              }}
              className={cn(INPUT_CLASS, "pl-9 pr-9")}
            />
            {searchBusy ? (
              <RefreshCw
                aria-label="Updating search results"
                className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-sky-300"
              />
            ) : null}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                searchRegistries(query);
              }}
              className="h-8 rounded-lg bg-sky-500 px-3 text-slate-950 hover:bg-sky-400"
            >
              <Search
                className={cn("h-4 w-4", searchPending && "animate-pulse")}
              />
              {searchPending ? "Searching" : "Search"}
            </Button>
          </div>
          {marketplaceActivityLabel ? (
            <span className="sr-only" aria-live="polite">
              {marketplaceActivityLabel}
            </span>
          ) : null}
        </div>

        <div className="grid gap-2 border-b border-slate-800 px-3 py-2">
          <div className="flex gap-2 overflow-x-auto">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={selectedCategory === "all"}
              onClick={() => setSelectedCategory("all")}
              className={cn(
                "h-8 shrink-0 rounded-lg border border-transparent px-3 text-xs text-slate-400 hover:border-slate-800 hover:bg-slate-900 hover:text-slate-100",
                selectedCategory === "all" &&
                  "border-sky-500/25 bg-sky-500/10 text-sky-100",
              )}
            >
              All
            </Button>
            {MCP_MARKETPLACE_CATEGORIES.map((category) => (
              <Button
                key={category.id}
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={selectedCategory === category.id}
                onClick={() => setSelectedCategory(category.id)}
                className={cn(
                  "h-8 shrink-0 rounded-lg border border-transparent px-3 text-xs text-slate-400 hover:border-slate-800 hover:bg-slate-900 hover:text-slate-100",
                  selectedCategory === category.id &&
                    "border-sky-500/25 bg-sky-500/10 text-sky-100",
                )}
              >
                {category.label}
              </Button>
            ))}
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[9.5rem_11rem] lg:justify-end">
            <label>
              <span className="sr-only">Filter install type</span>
              <select
                value={installKindFilter}
                disabled={controlsDisabled}
                onChange={(event) =>
                  setInstallKindFilter(
                    event.target.value as MarketplaceInstallKindFilter,
                  )
                }
                className={SELECT_CLASS}
              >
                <option value="all">All install types</option>
                <option value="remote">Remote</option>
                <option value="local">Local packages</option>
                <option value="auth-required">Auth required</option>
              </select>
            </label>
            <label>
              <span className="sr-only">Sort marketplace results</span>
              <select
                value={sortMode}
                disabled={controlsDisabled}
                onChange={(event) =>
                  setSortMode(event.target.value as McpMarketplaceSortMode)
                }
                className={SELECT_CLASS}
              >
                <option value="relevance">Relevance</option>
                <option value="recommended">Recommended</option>
                <option value="popularity">Popularity</option>
                <option value="stars">Most starred</option>
                <option value="downloads">Most downloaded</option>
                <option value="updated">Recently updated</option>
                <option value="name">Name</option>
                <option value="registry">Registry</option>
                <option value="install-method">Install method</option>
              </select>
            </label>
          </div>
        </div>

        <div
          ref={resultsViewportRef}
          data-marketplace-results-viewport="true"
          onScroll={(event) => {
            setResultListMetrics({
              scrollTop: event.currentTarget.scrollTop,
              viewportHeight: event.currentTarget.clientHeight || 480,
            });
          }}
          className="h-[min(42rem,58vh)] min-h-0 overflow-y-auto lg:h-auto lg:flex-1"
        >
          {renderDiscoverResultsContent()}
        </div>
      </div>
    );
  };

  const renderCredentialFields = (): JSX.Element | null => {
    if (!plan || plan.credentialFields.length === 0) {
      return null;
    }

    return (
      <div className="grid gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
          <KeyRound className="h-4 w-4 text-sky-300" />
          Credentials
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {plan.credentialFields.map((field) => (
            <label key={field.id} className="grid gap-1 text-xs text-slate-400">
              <span className="flex items-center gap-2">
                <span>{field.label}</span>
                {field.secret ? (
                  <span className="text-sky-300">Env var</span>
                ) : null}
                {field.required ? (
                  <span className="text-rose-300">Required</span>
                ) : null}
              </span>
              <CredentialInput
                field={field}
                value={credentials[field.id] ?? ""}
                disabled={installing}
                onChange={(value) =>
                  setCredentials((current) => ({
                    ...current,
                    [field.id]: value,
                  }))
                }
              />
              {field.description ? (
                <span className="leading-5 text-slate-500">
                  {field.description}
                </span>
              ) : null}
              {field.secret ? (
                <span className="leading-5 text-slate-500">
                  Enter the environment variable name. The secret value is not stored in the MCP config.
                </span>
              ) : null}
            </label>
          ))}
        </div>
      </div>
    );
  };

  const renderServerDetail = (): JSX.Element => {
    if (!selectedResult || !plan) {
      return (
        <div className={cn(PANEL_CLASS, "flex min-h-[12rem] items-center justify-center p-6 text-sm text-slate-500 lg:min-h-0")}>
          Select an MCP server.
        </div>
      );
    }

    const server = selectedResult.entry.server;
    const selectedServerInstalled = installedServerIds.has(plan.server.id);
    const deprecated = isMarketplaceResultDeprecated(selectedResult);
    const installDisabled =
      installing ||
      plan.missingCredentialFields.length > 0 ||
      plan.blockedReasons.length > 0;

    const renderWarningBlocks = (): JSX.Element | null => {
      const blocks = [
        ...(deprecated
          ? ["This registry entry is deprecated. Review the project before installing."]
          : []),
        ...plan.blockedReasons,
        ...plan.warnings,
      ];

      if (blocks.length === 0) {
        return null;
      }

      return (
        <div className="grid gap-2">
          {blocks.map((warning) => (
            <div
              key={warning}
              className={cn(
                "flex gap-2 rounded-lg border p-3 text-sm",
                plan.blockedReasons.includes(warning)
                  ? "border-rose-500/20 bg-rose-500/10 text-rose-100"
                  : "border-amber-500/20 bg-amber-500/10 text-amber-100",
              )}
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{warning}</span>
            </div>
          ))}
        </div>
      );
    };

    const renderOverviewTab = (): JSX.Element => {
      const packageTypes = selectedResult.packageRegistryTypes.join(", ");

      return (
        <div className="grid gap-4">
          <p className="max-w-3xl text-sm leading-6 text-slate-300">
            {server.description}
          </p>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border border-slate-800 bg-slate-900/30 p-3">
              <div className="flex items-center gap-2 text-xs font-medium uppercase text-slate-500">
                <PlugZap className="h-4 w-4" />
                Method
              </div>
              <div className="mt-2 text-sm font-medium text-slate-100">
                {getCandidateLabel(plan.candidate)}
              </div>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-900/30 p-3">
              <div className="flex items-center gap-2 text-xs font-medium uppercase text-slate-500">
                <Package className="h-4 w-4" />
                Packages
              </div>
              <div className="mt-2 text-sm font-medium text-slate-100">
                {packageTypes || "Remote only"}
              </div>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-900/30 p-3">
              <div className="flex items-center gap-2 text-xs font-medium uppercase text-slate-500">
                <Database className="h-4 w-4" />
                Exposure
              </div>
              <div className="mt-2 text-sm font-medium text-slate-100">
                All capabilities
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {server.repository?.url ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => window.open(server.repository?.url, "_blank")}
                className="h-8 rounded-lg border-slate-800 bg-slate-950 px-3 text-slate-200 hover:bg-slate-900"
              >
                <ExternalLink className="h-4 w-4" />
                Repository
              </Button>
            ) : null}
            {server.websiteUrl ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => window.open(server.websiteUrl, "_blank")}
                className="h-8 rounded-lg border-slate-800 bg-slate-950 px-3 text-slate-200 hover:bg-slate-900"
              >
                <ExternalLink className="h-4 w-4" />
                Website
              </Button>
            ) : null}
          </div>
        </div>
      );
    };

    const renderInstallTab = (): JSX.Element => {
      return (
        <div className="grid gap-4">
          {candidates.length > 1 ? (
            <label className="grid gap-1 text-xs font-medium text-slate-400">
              <span>Advanced install method</span>
              <select
                value={candidateId || candidates[0]?.id || ""}
                disabled={installing}
                onChange={(event) => setCandidateId(event.target.value)}
                className={SELECT_CLASS}
              >
                {candidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {getCandidateLabel(candidate)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {renderCredentialFields()}
          {renderWarningBlocks()}
          {plan.generatedCommand ? (
            <div className="grid gap-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                <Package className="h-4 w-4 text-sky-300" />
                Generated command
              </div>
              <pre className="max-h-32 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs leading-5 text-slate-300">
                {[plan.generatedCommand.command, ...plan.generatedCommand.args].join(" ")}
              </pre>
            </div>
          ) : null}
        </div>
      );
    };

    const renderTrustTab = (): JSX.Element => {
      const updatedAt = formatDateLabel(
        selectedResult.metrics.updatedAtMs ||
          selectedResult.updatedAtMs ||
          selectedResult.publishedAtMs,
      );
      const githubPath = parseGitHubRepositoryPath(selectedResult.repositoryUrl);
      const npmPackage = getNpmPackageIdentifier(selectedResult);
      const hasMetricSource = Boolean(githubPath || npmPackage);
      const metricSourceLabel = [
        githubPath ? "GitHub" : "",
        npmPackage ? "npm" : "",
      ]
        .filter(Boolean)
        .join(" and ");
      const renderTrustMetric = ({
        emptyLabel,
        icon: Icon,
        label,
        value,
      }: {
        emptyLabel: string;
        icon: typeof Star;
        label: string;
        value: string | null;
      }): JSX.Element => {
        return (
          <div className="rounded-lg border border-slate-800 bg-slate-950 p-3">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <Icon className="h-4 w-4" />
              {label}
            </div>
            <div
              className={cn(
                "mt-2 text-lg font-semibold",
                value ? "text-slate-100" : "text-slate-500",
              )}
            >
              {value ?? emptyLabel}
            </div>
          </div>
        );
      };

      return (
        <div className="grid gap-4">
          <div className="rounded-lg border border-slate-800 bg-slate-950 p-3 text-sm text-slate-400">
            {hasMetricSource
              ? `Popularity metrics are enriched locally from ${metricSourceLabel}.`
              : "This entry does not expose a GitHub repository or npm package for local popularity metrics."}
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border border-slate-800 bg-slate-900/30 p-3">
              <div className="flex items-center gap-2 text-xs font-medium uppercase text-slate-500">
                <BadgeCheck className="h-4 w-4" />
                Registry
              </div>
              <div className="mt-2 text-sm font-medium text-slate-100">
                {selectedResult.registry.title}
              </div>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-900/30 p-3">
              <div className="flex items-center gap-2 text-xs font-medium uppercase text-slate-500">
                <ShieldCheck className="h-4 w-4" />
                Status
              </div>
              <div className="mt-2 text-sm font-medium text-slate-100">
                {selectedResult.status}
              </div>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-900/30 p-3">
              <div className="flex items-center gap-2 text-xs font-medium uppercase text-slate-500">
                <Clock3 className="h-4 w-4" />
                Updated
              </div>
              <div className="mt-2 text-sm font-medium text-slate-100">
                {updatedAt ?? "Unknown"}
              </div>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-4">
            {renderTrustMetric({
              emptyLabel: githubPath
                ? enrichingMetrics
                  ? "Checking"
                  : "Not loaded"
                : "No GitHub repo",
              icon: Star,
              label: "Stars",
              value: formatCompactNumber(selectedResult.metrics.stars),
            })}
            {renderTrustMetric({
              emptyLabel: npmPackage
                ? enrichingMetrics
                  ? "Checking"
                  : "Not loaded"
                : "No npm package",
              icon: TrendingUp,
              label: "Downloads",
              value: formatCompactNumber(selectedResult.metrics.downloads),
            })}
            {renderTrustMetric({
              emptyLabel: "Not published",
              icon: Gauge,
              label: "Quality",
              value: formatCompactNumber(selectedResult.metrics.quality),
            })}
            {renderTrustMetric({
              emptyLabel: "Not published",
              icon: ShieldCheck,
              label: "Security",
              value: formatCompactNumber(selectedResult.metrics.security),
            })}
          </div>
          {renderWarningBlocks()}
        </div>
      );
    };

    const renderRawTab = (): JSX.Element => {
      return (
        <pre className="max-h-[32rem] overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs leading-5 text-slate-300">
          {JSON.stringify(selectedResult.entry, null, 2)}
        </pre>
      );
    };

    const renderServerDetailContent = (): JSX.Element => {
      return (
        <div className="grid gap-5 p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 gap-4">
              {renderServerLogo(selectedResult, "h-14 w-14 rounded-xl text-sm")}
              <div className="grid min-w-0 gap-2">
                <div className="flex flex-wrap gap-2">
                  {renderRecommendedBadge(selectedResult)}
                  <ServerBadge>{selectedResult.registry.title}</ServerBadge>
                  <ServerBadge>{server.version}</ServerBadge>
                  <ServerBadge>{getInstallKindLabel(plan)}</ServerBadge>
                  {selectedResult.authRequired ? <ServerBadge>auth required</ServerBadge> : null}
                </div>
                <div>
                  <h2 className="truncate text-2xl font-semibold text-white">
                    {getMcpRegistryServerTitle(server)}
                  </h2>
                  <p className="mt-1 break-all font-mono text-xs text-slate-500">
                    {server.name}
                  </p>
                </div>
              </div>
            </div>

            <Button
              type="button"
              disabled={installDisabled}
              onClick={() => {
                void installSelectedServer();
              }}
              className="h-10 rounded-lg bg-sky-500 px-4 font-semibold text-slate-950 hover:bg-sky-400"
            >
              <Download className="h-4 w-4" />
              {installing
                ? "Installing"
                : selectedServerInstalled
                  ? "Reinstall & Enable"
                  : "Install & Enable"}
            </Button>
          </div>

          <div className="flex gap-1 overflow-x-auto border-b border-slate-800">
            {[
              { id: "overview", label: "Overview" },
              { id: "install", label: "Install" },
              { id: "trust", label: "Trust" },
              { id: "raw", label: "Raw" },
            ].map((tab) => (
              <Button
                key={tab.id}
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={detailTab === tab.id}
                onClick={() => setDetailTab(tab.id as MarketplaceDetailTab)}
                className={cn(
                  "h-9 rounded-none border-b-2 border-transparent px-3 text-slate-400 hover:bg-slate-900 hover:text-slate-100",
                  detailTab === tab.id && "border-sky-400 text-sky-100",
                )}
              >
                {tab.label}
              </Button>
            ))}
          </div>

          {detailTab === "overview" ? renderOverviewTab() : null}
          {detailTab === "install" ? renderInstallTab() : null}
          {detailTab === "trust" ? renderTrustTab() : null}
          {detailTab === "raw" ? renderRawTab() : null}
        </div>
      );
    };

    return (
      <div className={cn(PANEL_CLASS, "overflow-hidden lg:flex lg:min-h-0 lg:flex-col")}>
        <div className="lg:hidden">
          {renderServerDetailContent()}
        </div>
        <ScrollArea className="hidden min-h-0 flex-1 lg:block" type="always">
          {renderServerDetailContent()}
        </ScrollArea>
      </div>
    );
  };

  const renderDiscover = (): JSX.Element => {
    return (
      <>
        <ScrollArea className="h-full min-h-0 lg:hidden" type="always">
          <div className="grid content-start gap-4 p-4">
            {renderDiscoverList()}
            {renderServerDetail()}
          </div>
        </ScrollArea>
        <div className="hidden h-full min-h-0 gap-4 p-4 lg:grid lg:grid-cols-[minmax(18rem,0.85fr)_minmax(0,1.35fr)] lg:grid-rows-[minmax(0,1fr)]">
          {renderDiscoverList()}
          {renderServerDetail()}
        </div>
      </>
    );
  };

  const renderInstalled = (): JSX.Element => {
    return (
      <div className="grid min-h-0 content-start gap-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-white">Installed MCPs</h2>
            <p className="mt-1 text-sm text-slate-500">
              Marketplace installs are saved to the global MCP config.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void loadInstalledDocument();
            }}
            className="h-9 rounded-lg border-slate-800 bg-slate-950 px-3 text-slate-200 hover:bg-slate-900"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          {installedServers.length === 0 ? (
            <div className={cn(PANEL_CLASS, "p-4 text-sm text-slate-500")}>
              No global MCP servers are configured.
            </div>
          ) : null}
          {installedServers.map((server) => (
            <div key={server.id} className={cn(PANEL_CLASS, "grid gap-3 p-4")}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-base font-semibold text-slate-100">
                    {server.title}
                  </h3>
                  <p className="break-all font-mono text-xs text-slate-500">
                    {server.id}
                  </p>
                </div>
                <ServerBadge>{server.enabled ? "enabled" : "disabled"}</ServerBadge>
              </div>
              {server.description ? (
                <p className="line-clamp-2 text-sm leading-6 text-slate-400">
                  {server.description}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <ServerBadge>{server.transportType}</ServerBadge>
                {server.preset ? <ServerBadge>{server.preset}</ServerBadge> : null}
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!workspaceRoot?.trim()}
                  onClick={async () => {
                    try {
                      await discoverMcpServer(workspaceRoot, server.id);
                      setMessage({
                        tone: "success",
                        text: `${server.title} discovery completed.`,
                      });
                    } catch (error) {
                      setMessage({
                        tone: "error",
                        text: `Discovery failed: ${getErrorText(error)}`,
                      });
                    }
                  }}
                  className="h-8 rounded-lg border-slate-800 bg-slate-950 px-3 text-slate-200 hover:bg-slate-900"
                >
                  <RefreshCw className="h-4 w-4" />
                  Discover
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void setInstalledServerEnabled(server.id, !server.enabled);
                  }}
                  className="h-8 rounded-lg border-slate-800 bg-slate-950 px-3 text-slate-200 hover:bg-slate-900"
                >
                  {server.enabled ? "Disable" : "Enable"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void removeInstalledServer(server.id);
                  }}
                  className="h-8 rounded-lg border-rose-500/20 bg-rose-500/10 px-3 text-rose-200 hover:bg-rose-500/15"
                >
                  <Trash2 className="h-4 w-4" />
                  Remove
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderRegistries = (): JSX.Element => {
    return (
      <div className="grid min-h-0 content-start gap-4 p-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Registries</h2>
          <p className="mt-1 text-sm text-slate-500">
            Registry sources are global. The official registry is always available.
          </p>
        </div>

        <div className={cn(PANEL_CLASS, "grid gap-3 p-4")}>
          <div className="grid gap-3 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_auto_auto]">
            <Input
              value={registryTitleDraft}
              placeholder="Registry name"
              onChange={(event) => setRegistryTitleDraft(event.target.value)}
              className={INPUT_CLASS}
            />
            <Input
              value={registryUrlDraft}
              placeholder="https://example.com or https://example.com/v0.1"
              onChange={(event) => setRegistryUrlDraft(event.target.value)}
              className={INPUT_CLASS}
            />
            <Button
              type="button"
              variant="outline"
              disabled={registryTesting}
              onClick={() => {
                void testRegistryDraft();
              }}
              className="h-9 rounded-lg border-slate-800 bg-slate-950 px-3 text-slate-200 hover:bg-slate-900"
            >
              <RefreshCw
                className={cn("h-4 w-4", registryTesting && "animate-spin")}
              />
              Test
            </Button>
            <Button
              type="button"
              onClick={() => {
                void addRegistry();
              }}
              className="h-9 rounded-lg bg-sky-500 px-3 text-slate-950 hover:bg-sky-400"
            >
              <Plus className="h-4 w-4" />
              Add
            </Button>
          </div>
        </div>

        <div className="grid gap-3">
          {registries.map((registry) => (
            <div key={registry.id} className={cn(PANEL_CLASS, "flex flex-wrap items-center justify-between gap-3 p-4")}>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-semibold text-slate-100">
                    {registry.title}
                  </h3>
                  {registry.official ? <ServerBadge>official</ServerBadge> : null}
                  <ServerBadge>{registry.enabled ? "enabled" : "disabled"}</ServerBadge>
                </div>
                <p className="mt-1 break-all font-mono text-xs text-slate-500">
                  {normalizeMcpMarketplaceRegistryBaseUrl(registry.baseUrl)}
                </p>
              </div>
              {!registry.official ? (
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void toggleRegistry(registry.id, !registry.enabled);
                    }}
                    className="h-8 rounded-lg border-slate-800 bg-slate-950 px-3 text-slate-200 hover:bg-slate-900"
                  >
                    {registry.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void removeRegistry(registry.id);
                    }}
                    className="h-8 rounded-lg border-rose-500/20 bg-rose-500/10 px-3 text-rose-200 hover:bg-rose-500/15"
                  >
                    <Trash2 className="h-4 w-4" />
                    Remove
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderAdvanced = (): JSX.Element => {
    return (
      <div className="grid min-h-0 content-start gap-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-white">Advanced MCP</h2>
            <p className="mt-1 text-sm text-slate-500">
              Raw global config and deeper controls remain in Settings.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void loadInstalledDocument();
              }}
              className="h-9 rounded-lg border-slate-800 bg-slate-950 px-3 text-slate-200 hover:bg-slate-900"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
            <Button
              type="button"
              onClick={onOpenSettings}
              className="h-9 rounded-lg bg-sky-500 px-3 text-slate-950 hover:bg-sky-400"
            >
              <Settings2 className="h-4 w-4" />
              MCP Settings
            </Button>
          </div>
        </div>

        <div className={cn(PANEL_CLASS, "grid gap-3 p-4")}>
          <div className="text-sm text-slate-400">
            {installedDocument?.path ?? "Global MCP config path is available in the desktop app."}
          </div>
          <pre className="max-h-[28rem] overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs leading-5 text-slate-300">
            {installedDocument
              ? redactMcpConfigRaw(installedDocument.raw)
              : "Global MCP config has not been loaded."}
          </pre>
        </div>
      </div>
    );
  };

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-slate-950 md:flex-row">
      {renderNavigation()}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="border-b border-slate-900 px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold text-white">MCP Marketplace</h1>
              <p className="mt-1 text-sm text-slate-500">
                Add global MCP connections and expose all capabilities to MachDoch.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <ServerBadge>{registries.filter((registry) => registry.enabled).length} registries</ServerBadge>
              <ServerBadge>{results.length} servers loaded</ServerBadge>
            </div>
          </div>
          <div className="mt-3">
            <StatusMessage message={message} />
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-hidden">
          {view === "discover" ? renderDiscover() : null}
          {view === "installed" ? (
            <ScrollArea className="h-full min-h-0" type="always">
              {renderInstalled()}
            </ScrollArea>
          ) : null}
          {view === "registries" ? (
            <ScrollArea className="h-full min-h-0" type="always">
              {renderRegistries()}
            </ScrollArea>
          ) : null}
          {view === "advanced" ? (
            <ScrollArea className="h-full min-h-0" type="always">
              {renderAdvanced()}
            </ScrollArea>
          ) : null}
        </div>
      </section>
    </main>
  );
};

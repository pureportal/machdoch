import {
  SUPPORTED_PROVIDER_ORDER,
  type ProviderModelCatalogSnapshot,
  type RuntimeProvider,
  type RuntimeProviderModelCatalog,
} from "./model-catalog";

const REFRESH_INTERVAL_MS = 60_000;
const FAILURE_TTL_MS = 10_000;

export interface ProviderModelCatalogState {
  catalog: ProviderModelCatalogSnapshot | null;
  loadingProviders: ReadonlySet<RuntimeProvider>;
}

type CatalogLoader = (
  provider: RuntimeProvider,
  forceRefresh: boolean,
) => Promise<ProviderModelCatalogSnapshot>;

export class ProviderModelCatalogStore {
  private state: ProviderModelCatalogState = {
    catalog: null,
    loadingProviders: new Set(),
  };
  private readonly listeners = new Set<() => void>();
  private readonly providers = new Map<
    RuntimeProvider,
    RuntimeProviderModelCatalog
  >();
  private readonly fetchedAt = new Map<RuntimeProvider, number>();
  private readonly requests = new Map<RuntimeProvider, Promise<void>>();
  private interval: ReturnType<typeof setInterval> | undefined;
  private generation = 0;

  constructor(
    private readonly fetchCatalog: CatalogLoader,
    private readonly onProviderChanged?: (
      provider: RuntimeProviderModelCatalog,
    ) => void,
  ) {}

  getSnapshot = (): ProviderModelCatalogState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      void this.refresh();
      this.interval = setInterval(
        () => void this.refresh(undefined, true),
        REFRESH_INTERVAL_MS,
      );
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        clearInterval(this.interval);
        this.interval = undefined;
      }
    };
  };

  private publish(): void {
    this.state = {
      catalog:
        this.providers.size > 0
          ? {
              generatedAt: Date.now(),
              providers: SUPPORTED_PROVIDER_ORDER.flatMap((id) => {
                const provider = this.providers.get(id);
                return provider ? [provider] : [];
              }),
            }
          : null,
      loadingProviders: new Set(this.requests.keys()),
    };
    for (const listener of this.listeners) listener();
  }

  private refreshProvider(
    provider: RuntimeProvider,
    forceRefresh: boolean,
  ): Promise<void> {
    const pending = this.requests.get(provider);
    if (pending) return pending;
    const cached = this.providers.get(provider);
    const ttl = cached?.error ? FAILURE_TTL_MS : REFRESH_INTERVAL_MS;
    if (
      !forceRefresh &&
      Date.now() - (this.fetchedAt.get(provider) ?? -Infinity) < ttl
    ) {
      return Promise.resolve();
    }
    const generation = this.generation;
    const request = Promise.resolve()
      .then(() => this.fetchCatalog(provider, forceRefresh))
      .then((catalog) => {
        const result = catalog.providers.find(
          (entry) => entry.provider === provider,
        );
        if (!result)
          throw new Error("The provider returned an incomplete model catalog.");
        if (generation === this.generation) {
          this.providers.set(provider, result);
          this.onProviderChanged?.(result);
        }
      })
      .catch((error: unknown) => {
        if (generation !== this.generation) return;
        const message = error instanceof Error ? error.message : String(error);
        const credentialsRejected =
          /(?:HTTP\s*(?:401|403)|unauthorized|forbidden|not configured)/iu.test(
            message,
          );
        const result = {
          provider,
          available: !credentialsRejected && cached?.available === true,
          models: credentialsRejected ? [] : (cached?.models ?? []),
          error: message,
        };
        this.providers.set(provider, result);
        this.onProviderChanged?.(result);
      })
      .finally(() => {
        if (generation !== this.generation) return;
        this.fetchedAt.set(provider, Date.now());
        this.requests.delete(provider);
        this.publish();
      });
    this.requests.set(provider, request);
    this.publish();
    return request;
  }

  refresh = async (
    provider?: RuntimeProvider,
    forceRefresh = false,
  ): Promise<void> => {
    await Promise.all(
      (provider ? [provider] : SUPPORTED_PROVIDER_ORDER).map((id) =>
        this.refreshProvider(id, forceRefresh),
      ),
    );
  };

  load = async (): Promise<ProviderModelCatalogSnapshot> => {
    const refresh = this.refresh();
    if (this.providers.size < SUPPORTED_PROVIDER_ORDER.length) await refresh;
    if (!this.state.catalog) return this.load();
    return this.state.catalog;
  };

  invalidate(): void {
    this.generation += 1;
    for (const provider of this.providers.keys()) {
      this.onProviderChanged?.({ provider, available: false, models: [] });
    }
    this.providers.clear();
    this.fetchedAt.clear();
    this.requests.clear();
    this.publish();
    if (this.listeners.size > 0) void this.refresh(undefined, true);
  }
}

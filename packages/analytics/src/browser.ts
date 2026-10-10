import {
  AnalyticsClient,
  type EventMetadata,
} from "@machdoch/analytics/client";
import {
  consentKey,
  hasPrivacySignal,
  readConsent,
  writeConsent,
} from "./consent";
import {
  FEATURES,
  VIEW_FEATURES,
  isFeature,
  routeFor,
  type AnalyticsApp,
  type Feature,
} from "@machdoch/analytics/catalog";
import { setOperationAnalytics } from "@machdoch/analytics/operations";
import { navigationTimings, observePerformance } from "./performance";

export interface BrowserAnalyticsConfiguration {
  app: AnalyticsApp;
  version: string;
  development: boolean;
  native?: boolean;
}
export interface ConsentSnapshot {
  enabled: boolean;
  blocked: boolean;
  error: string | null;
}
const serverSnapshot: ConsentSnapshot = {
  enabled: false,
  blocked: false,
  error: null,
};
let snapshot = serverSnapshot;
let configuration: BrowserAnalyticsConfiguration | null = null;
let client: AnalyticsClient | null = null;
let stopMonitoring: (() => void) | null = null;
let page = "/";
const listeners = new Set<() => void>();
const exposed = new Set<Feature>();
const used = new Set<Feature>();
const jobs = new Map<
  string,
  { feature: Feature; started: number; finished: boolean }
>();

export const getConsentSnapshot = (): ConsentSnapshot => snapshot;
export const getServerConsentSnapshot = (): ConsentSnapshot => serverSnapshot;
export function subscribeConsent(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const publish = (value: ConsentSnapshot): void => {
  snapshot = value;
  listeners.forEach((listener) => listener());
};
const hasConsent = (): boolean => {
  if (
    !configuration ||
    configuration.development ||
    hasPrivacySignal(navigator)
  )
    return false;
  try {
    return readConsent(localStorage, configuration.app)?.enabled === true;
  } catch {
    return false;
  }
};
const stop = (): void => {
  setOperationAnalytics(null);
  client?.stop();
  client = null;
  stopMonitoring?.();
  stopMonitoring = null;
  exposed.clear();
  used.clear();
  jobs.clear();
};

export function exposeFeature(feature: Feature): void {
  if (!client || !isFeature(feature) || exposed.has(feature)) return;
  exposed.add(feature);
  client.track("feature.exposed", { feature });
}
export function useFeature(
  feature: Feature,
  source: EventMetadata["source"] = "pointer",
): void {
  if (!client || !isFeature(feature)) return;
  exposeFeature(feature);
  used.add(feature);
  client.track("feature.used", { feature, source });
}

export function observeJob(id: string, feature: Feature, status: string): void {
  if (!client || !isFeature(feature)) return;
  const terminal = [
    "completed",
    "succeeded",
    "failed",
    "canceled",
    "cancelled",
    "interrupted",
  ].includes(status);
  let job = jobs.get(id);
  if (!job) {
    if (
      terminal ||
      ![
        "queued",
        "running",
        "needs-review",
        "waiting-for-review",
        "canceling",
        "active",
      ].includes(status)
    )
      return;
    if (jobs.size >= 128) jobs.delete(jobs.keys().next().value!);
    job = { feature, started: performance.now(), finished: false };
    jobs.set(id, job);
    client.track("job.started", { feature });
  }
  if (!terminal || job.finished) return;
  job.finished = true;
  const event = ["completed", "succeeded"].includes(status)
    ? "job.completed"
    : status === "failed"
      ? "job.failed"
      : "job.cancelled";
  client.track(event, {
    feature: job.feature,
    duration_ms: performance.now() - job.started,
  });
}
const summarizeFeatures = (): void => {
  for (const feature of exposed)
    client?.track("feature.summary", { feature, used: used.has(feature) });
  exposed.clear();
  used.clear();
};

export function trackView(view: string): void {
  const feature = Object.hasOwn(VIEW_FEATURES, view)
    ? VIEW_FEATURES[view]
    : undefined;
  if (!feature) return;
  const nextPage = `/app/${feature.replaceAll(".", "/")}`;
  if (page !== nextPage) {
    summarizeFeatures();
    page = nextPage;
    client?.pageview(page);
  }
  exposeFeature(feature);
}

export function trackRoute(pathname: string): void {
  if (!configuration) return;
  const nextPage = routeFor(configuration.app, pathname);
  if (page === nextPage) return;
  summarizeFeatures();
  page = nextPage;
  client?.pageview(page);
}

function monitor(activeClient: AnalyticsClient): () => void {
  const metrics = observePerformance(activeClient);
  let lastActivity = performance.now();
  let visibleSince =
    document.visibilityState === "visible" ? performance.now() : null;
  let depth = 0;
  const seenElements = new WeakSet<Element>();
  const intersection =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting || entry.intersectionRatio < 0.1)
                continue;
              const element = entry.target as HTMLElement;
              const feature = element.dataset.analyticsFeature;
              if (
                feature &&
                isFeature(feature) &&
                !element.matches(":disabled, [aria-disabled='true']")
              )
                exposeFeature(feature);
            }
          },
          { threshold: 0.1 },
        );
  const observeElements = (root: Element): void => {
    const elements = [
      root,
      ...root.querySelectorAll("[data-analytics-feature]"),
    ];
    for (const element of elements) {
      if (
        !element.hasAttribute("data-analytics-feature") ||
        seenElements.has(element)
      )
        continue;
      seenElements.add(element);
      intersection?.observe(element);
    }
  };
  observeElements(document.documentElement);
  const mutations = new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.addedNodes)
        if (node instanceof Element) observeElements(node);
  });
  mutations.observe(document.body, { childList: true, subtree: true });
  const activity = (): void => {
    lastActivity = performance.now();
  };
  const click = (event: MouseEvent): void => {
    activity();
    if (!(event.target instanceof Element)) return;
    const element = event.target.closest<HTMLElement>(
      "[data-analytics-feature]",
    );
    const feature = element?.dataset.analyticsFeature;
    if (feature && isFeature(feature)) {
      useFeature(feature, event.detail === 0 ? "keyboard" : "pointer");
      if (
        element?.matches("a.download-card") &&
        feature === "landing.download"
      ) {
        const filename = new URL((element as HTMLAnchorElement).href).pathname
          .split("/")
          .at(-1);
        const platforms = {
          "machdoch-windows-x64-setup.exe": "windows-x64",
          "machdoch-linux-amd64.deb": "linux-amd64",
          "machdoch-linux-arm64.deb": "linux-arm64",
          "machdoch-linux-x86_64.rpm": "linux-rpm",
          "machdoch-linux-amd64.AppImage": "linux-appimage",
        } as const;
        const platform =
          filename && Object.hasOwn(platforms, filename)
            ? platforms[filename as keyof typeof platforms]
            : undefined;
        activeClient.track(
          "landing.download.clicked",
          platform ? { platform } : {},
        );
      }
      if (feature === "landing.github")
        activeClient.track("landing.github.clicked");
    }
  };
  const reportEngagement = (): void => {
    metrics.flush();
    if (visibleSince !== null) {
      const end = Math.min(performance.now(), lastActivity + 300_000);
      if (end > visibleSince)
        activeClient.track("engagement", { duration_ms: end - visibleSince });
    }
    visibleSince =
      document.visibilityState === "visible" ? performance.now() : null;
  };
  const visibility = (): void => {
    reportEngagement();
    if (document.visibilityState === "hidden") summarizeFeatures();
    else activity();
  };
  const unload = (): void => {
    reportEngagement();
    summarizeFeatures();
  };
  const scroll = (): void => {
    activity();
    if (configuration?.app !== "landing") return;
    const available =
      document.documentElement.scrollHeight - window.innerHeight;
    if (available <= 0) return;
    const percent = Math.min(
      100,
      Math.round((window.scrollY / available) * 100),
    );
    for (const milestone of [25, 50, 75, 100] as const)
      if (percent >= milestone && depth < milestone) {
        activeClient.track("scroll-depth", { depth: milestone });
        depth = milestone;
      }
  };
  const error = (event: ErrorEvent): void => activeClient.error(event.error);
  const rejection = (event: PromiseRejectionEvent): void =>
    activeClient.error(event.reason);
  const timer = setInterval(() => {
    if (!hasConsent()) {
      refreshConsent();
      return;
    }
    if (
      document.visibilityState === "visible" &&
      performance.now() - lastActivity < 300_000
    ) {
      activeClient.heartbeat();
      reportEngagement();
    }
  }, 30_000);
  document.addEventListener("click", click);
  document.addEventListener("keydown", activity);
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("scroll", scroll, { passive: true });
  window.addEventListener("pagehide", unload);
  window.addEventListener("error", error);
  window.addEventListener("unhandledrejection", rejection);
  return () => {
    clearInterval(timer);
    metrics.stop();
    intersection?.disconnect();
    mutations.disconnect();
    document.removeEventListener("click", click);
    document.removeEventListener("keydown", activity);
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("scroll", scroll);
    window.removeEventListener("pagehide", unload);
    window.removeEventListener("error", error);
    window.removeEventListener("unhandledrejection", rejection);
  };
}

function refreshConsent(): void {
  const enabled = hasConsent();
  const blocked = hasPrivacySignal(navigator);
  if (!enabled) stop();
  if (
    enabled &&
    !client &&
    configuration &&
    document.readyState === "complete"
  ) {
    client = new AnalyticsClient({
      app: configuration.app,
      version: configuration.version,
      surface: configuration.native ? "native" : "browser",
      enabled: hasConsent,
      language: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    setOperationAnalytics({
      client,
      onUse: (feature) => useFeature(feature, "api"),
    });
    client.pageview(page, navigationTimings());
    client.track("session.started");
    stopMonitoring = monitor(client);
    const feature = FEATURES.find(
      (feature) => `/app/${feature.replaceAll(".", "/")}` === page,
    );
    if (feature) exposeFeature(feature);
  }
  publish({ enabled, blocked, error: null });
}

export function startBrowserAnalytics(
  value: BrowserAnalyticsConfiguration,
): () => void {
  if (configuration) return () => undefined;
  configuration = value;
  page = routeFor(value.app, window.location.pathname);
  const storage = (event: StorageEvent): void => {
    if (event.key === consentKey(value.app) || event.key === null)
      refreshConsent();
  };
  const privacySignal = (): void => {
    if (hasPrivacySignal(navigator)) refreshConsent();
  };
  let loadTimer: ReturnType<typeof setTimeout> | undefined;
  const loaded = (): void => {
    loadTimer = setTimeout(refreshConsent, 0);
  };
  window.addEventListener("storage", storage);
  window.addEventListener("focus", privacySignal);
  window.addEventListener("load", loaded);
  refreshConsent();
  return () => {
    stop();
    window.removeEventListener("storage", storage);
    window.removeEventListener("focus", privacySignal);
    window.removeEventListener("load", loaded);
    clearTimeout(loadTimer);
    configuration = null;
    page = "/";
    publish(serverSnapshot);
  };
}

export function setAnalyticsConsent(enabled: boolean): void {
  if (!configuration) return;
  if (!enabled) stop();
  try {
    writeConsent(
      localStorage,
      configuration.app,
      enabled && !hasPrivacySignal(navigator),
    );
    refreshConsent();
  } catch {
    stop();
    publish({
      enabled: false,
      blocked: hasPrivacySignal(navigator),
      error:
        "Your choice could not be saved. Enable browser storage and try again.",
    });
  }
}

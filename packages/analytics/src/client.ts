import {
  ANALYTICS_ENDPOINT,
  FEATURES,
  OPERATIONS,
  NOTICE_REVISION,
  PROJECTS,
  routeFor,
  type AnalyticsApp,
  type Feature,
  type Operation,
} from "@machdoch/analytics/catalog";

export const EVENTS = [
  "session.started",
  "feature.exposed",
  "feature.used",
  "feature.summary",
  "operation.started",
  "operation.completed",
  "operation.failed",
  "job.started",
  "job.completed",
  "job.failed",
  "job.cancelled",
  "landing.download.clicked",
  "landing.github.clicked",
  "web-vital",
  "engagement",
  "scroll-depth",
] as const;
export type EventName = (typeof EVENTS)[number];
export interface EventMetadata {
  feature?: Feature;
  operation?: Operation;
  duration_ms?: number;
  value?: number;
  used?: boolean;
  metric?: "CLS" | "FCP" | "INP" | "LCP" | "TTFB";
  rating?: "good" | "needs-improvement" | "poor";
  source?: "pointer" | "keyboard" | "api" | "native" | "cli";
  platform?:
    | "windows-x64"
    | "linux-amd64"
    | "linux-arm64"
    | "linux-rpm"
    | "linux-appimage";
  depth?: 25 | 50 | 75 | 100;
  status?: number;
  error_kind?:
    | "Error"
    | "TypeError"
    | "RangeError"
    | "ReferenceError"
    | "SyntaxError"
    | "URIError"
    | "EvalError"
    | "AbortError";
}
export type PerformanceTimings = Partial<
  Record<
    | "dns"
    | "tls"
    | "conn"
    | "response"
    | "render"
    | "dom_load"
    | "page_load"
    | "ttfb",
    number
  >
>;
export interface AnalyticsConfiguration {
  app: AnalyticsApp;
  version: string;
  surface: "browser" | "native" | "cli";
  enabled: () => boolean;
  language?: string;
  timezone?: string;
  fetch?: typeof globalThis.fetch;
}

const enumMetadata = {
  feature: FEATURES,
  operation: Object.keys(OPERATIONS),
  metric: ["CLS", "FCP", "INP", "LCP", "TTFB"],
  rating: ["good", "needs-improvement", "poor"],
  source: ["pointer", "keyboard", "api", "native", "cli"],
  platform: [
    "windows-x64",
    "linux-amd64",
    "linux-arm64",
    "linux-rpm",
    "linux-appimage",
  ],
  error_kind: [
    "Error",
    "TypeError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "URIError",
    "EvalError",
    "AbortError",
  ],
} as const;

function cleanMetadata(
  metadata: EventMetadata,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, allowed] of Object.entries(enumMetadata)) {
    const value = metadata[key as keyof EventMetadata];
    if (
      typeof value === "string" &&
      (allowed as readonly string[]).includes(value)
    )
      result[key] = value;
  }
  for (const key of ["duration_ms", "value", "status"] as const) {
    const value = metadata[key];
    if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 86_400_000
    )
      result[key] = Math.round(value * 1000) / 1000;
  }
  if (typeof metadata.used === "boolean") result.used = metadata.used;
  if ([25, 50, 75, 100].includes(metadata.depth ?? 0))
    result.depth = metadata.depth!;
  return result;
}

export class AnalyticsClient {
  private readonly configuration: AnalyticsConfiguration;
  private readonly pending = new Set<AbortController>();
  private minuteStarted = Date.now();
  private sent = 0;
  private stopped = false;
  private page = "/";
  private readonly reportedErrors = new Set<string>();
  private readonly requests = new Set<Promise<void>>();

  constructor(configuration: AnalyticsConfiguration) {
    this.configuration = configuration;
  }

  private metadata(): Record<string, string> {
    return {
      app: this.configuration.app,
      version: /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(
        this.configuration.version,
      )
        ? this.configuration.version
        : "unversioned",
      surface: this.configuration.surface,
      consent_revision: NOTICE_REVISION,
    };
  }

  private send(
    endpoint: "" | "/custom" | "/error" | "/hb",
    payload: Record<string, unknown>,
  ): void {
    if (
      this.stopped ||
      !this.configuration.enabled() ||
      this.pending.size >= 16
    )
      return;
    this.resetRateLimit();
    if (this.sent >= 240) return;
    this.sent += 1;
    const controller = new AbortController();
    this.pending.add(controller);
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const request = (this.configuration.fetch ?? globalThis.fetch)(
      `${ANALYTICS_ENDPOINT}${endpoint}`,
      {
        method: "POST",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: {
          "Content-Type": "application/json",
          ...(this.configuration.surface === "cli"
            ? { "User-Agent": `Machdoch/${this.metadata().version} (CLI)` }
            : {}),
        },
        body: JSON.stringify({
          pid: PROJECTS[this.configuration.app],
          ...payload,
        }),
        keepalive: true,
        signal: controller.signal,
      },
    )
      .then((response) => {
        if (!response.ok) throw new Error("Analytics delivery failed");
      })
      .catch(() => {
        this.deliveryFailures += 1;
      })
      .finally(() => {
        clearTimeout(timeout);
        this.pending.delete(controller);
        this.requests.delete(request);
      });
    this.requests.add(request);
  }

  deliveryFailures = 0;

  private resetRateLimit(): void {
    if (Date.now() - this.minuteStarted < 60_000) return;
    this.minuteStarted = Date.now();
    this.sent = 0;
    this.reportedErrors.clear();
  }

  pageview(page: string, perf?: PerformanceTimings): void {
    const featurePage = FEATURES.some(
      (feature) => page === `/app/${feature.replaceAll(".", "/")}`,
    );
    const cliPage = Object.keys(OPERATIONS).some(
      (operation) =>
        operation.startsWith("cli.") && page === `/cli/${operation.slice(4)}`,
    );
    if (
      page !== routeFor(this.configuration.app, page) &&
      !featurePage &&
      !cliPage
    )
      return;
    this.page = page;
    const safePerformance: PerformanceTimings = {};
    for (const key of [
      "dns",
      "tls",
      "conn",
      "response",
      "render",
      "dom_load",
      "page_load",
      "ttfb",
    ] as const) {
      const value = perf?.[key];
      if (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= 300_000
      )
        safePerformance[key] = Math.round(value);
    }
    this.send("", {
      pg: this.page,
      lc: this.configuration.language,
      tz: this.configuration.timezone,
      perf: safePerformance,
      meta: this.metadata(),
    });
  }

  track(event: EventName, metadata: EventMetadata = {}): void {
    if (!(EVENTS as readonly string[]).includes(event)) return;
    this.send("/custom", {
      ev: event,
      pg: this.page,
      meta: { ...cleanMetadata(metadata), ...this.metadata() },
    });
  }

  heartbeat(): void {
    this.send("/hb", {});
  }

  error(reason: unknown): void {
    this.resetRateLimit();
    const rawName = reason instanceof Error ? reason.name : "Error";
    const name = (enumMetadata.error_kind as readonly string[]).includes(
      rawName,
    )
      ? rawName
      : "Error";
    const stack = reason instanceof Error ? (reason.stack ?? "") : "";
    const frames = [
      ...stack.matchAll(
        /(?:\/assets\/|\/_next\/static\/chunks\/)([a-zA-Z0-9._-]+\.js):(\d+):(\d+)/g,
      ),
    ]
      .slice(0, 8)
      .map((match) => `${match[1]}:${match[2]}:${match[3]}`);
    const signature = `${name}:${frames.join("\n")}`;
    if (this.reportedErrors.has(signature) || this.reportedErrors.size >= 10)
      return;
    this.reportedErrors.add(signature);
    this.send("/error", {
      name,
      message: `Application ${name}`,
      pg: this.page,
      ...(frames.length ? { stackTrace: frames.join("\n") } : {}),
      meta: this.metadata(),
    });
  }

  stop(): void {
    this.stopped = true;
    for (const controller of this.pending) controller.abort();
    this.pending.clear();
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.requests]);
  }
}

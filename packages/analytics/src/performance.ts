import type {
  AnalyticsClient,
  PerformanceTimings,
} from "@machdoch/analytics/client";

export function navigationTimings(): PerformanceTimings {
  const navigation = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  if (!navigation) return {};
  return {
    dns: navigation.domainLookupEnd - navigation.domainLookupStart,
    tls:
      navigation.secureConnectionStart > 0
        ? navigation.connectEnd - navigation.secureConnectionStart
        : 0,
    conn: navigation.connectEnd - navigation.connectStart,
    response: navigation.responseEnd - navigation.responseStart,
    render: navigation.domComplete - navigation.domInteractive,
    dom_load: navigation.domContentLoadedEventEnd - navigation.startTime,
    page_load:
      navigation.loadEventEnd > 0
        ? navigation.loadEventEnd - navigation.startTime
        : 0,
    ttfb: navigation.responseStart - navigation.startTime,
  };
}

interface LayoutShiftEntry extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
}
interface InteractionEntry extends PerformanceEntry {
  interactionId: number;
}

export function observePerformance(client: AnalyticsClient): {
  flush: () => void;
  stop: () => void;
} {
  const observers: PerformanceObserver[] = [];
  const supported =
    typeof PerformanceObserver === "undefined"
      ? []
      : PerformanceObserver.supportedEntryTypes;
  const values = new Map<"CLS" | "FCP" | "INP" | "LCP" | "TTFB", number>();
  const reported = new Map<string, number>();
  let shiftStart = 0;
  let shiftEnd = 0;
  let shiftTotal = 0;
  let smallestInteractionId = Infinity;
  let largestInteractionId = 0;
  const interactions: { id: number; duration: number }[] = [];
  const interactionBaseline =
    (performance as Performance & { interactionCount?: number })
      .interactionCount ?? 0;
  const observe = (
    type: string,
    receive: (entry: PerformanceEntry) => void,
    buffered: boolean,
  ): void => {
    if (!supported.includes(type)) return;
    const observer = new PerformanceObserver((list) =>
      list.getEntries().forEach(receive),
    );
    observer.observe(
      type === "event"
        ? ({ type, buffered, durationThreshold: 40 } as PerformanceObserverInit)
        : { type, buffered },
    );
    observers.push(observer);
  };
  const ttfb = navigationTimings().ttfb;
  if (ttfb && ttfb > 0) values.set("TTFB", ttfb);
  observe(
    "paint",
    (entry) => {
      if (entry.name === "first-contentful-paint")
        values.set("FCP", entry.startTime);
    },
    true,
  );
  observe(
    "largest-contentful-paint",
    (entry) => values.set("LCP", entry.startTime),
    true,
  );
  observe(
    "layout-shift",
    (entry) => {
      const shift = entry as LayoutShiftEntry;
      if (shift.hadRecentInput) return;
      if (
        shift.startTime - shiftEnd < 1000 &&
        shift.startTime - shiftStart < 5000
      )
        shiftTotal += shift.value;
      else {
        shiftStart = shift.startTime;
        shiftTotal = shift.value;
      }
      shiftEnd = shift.startTime;
      values.set("CLS", Math.max(values.get("CLS") ?? 0, shiftTotal));
    },
    false,
  );
  observe(
    "event",
    (entry) => {
      const interaction = entry as InteractionEntry;
      if (!interaction.interactionId) return;
      smallestInteractionId = Math.min(
        smallestInteractionId,
        interaction.interactionId,
      );
      largestInteractionId = Math.max(
        largestInteractionId,
        interaction.interactionId,
      );
      const existing = interactions.find(
        (value) => value.id === interaction.interactionId,
      );
      if (existing)
        existing.duration = Math.max(existing.duration, interaction.duration);
      else
        interactions.push({
          id: interaction.interactionId,
          duration: interaction.duration,
        });
      interactions.sort((a, b) => b.duration - a.duration);
      if (interactions.length > 10) interactions.pop();
      const count = (performance as Performance & { interactionCount?: number })
        .interactionCount;
      const interactionCount =
        count === undefined
          ? (largestInteractionId - smallestInteractionId) / 7 + 1
          : count - interactionBaseline;
      const candidate =
        interactions[
          Math.min(interactions.length - 1, Math.floor(interactionCount / 50))
        ];
      if (candidate) values.set("INP", candidate.duration);
    },
    false,
  );
  const thresholds = {
    CLS: [0.1, 0.25],
    FCP: [1800, 3000],
    INP: [200, 500],
    LCP: [2500, 4000],
    TTFB: [800, 1800],
  } as const;
  const flush = (): void => {
    for (const [metric, value] of values) {
      if (reported.get(metric) === value) continue;
      reported.set(metric, value);
      const limits = thresholds[metric];
      client.track("web-vital", {
        metric,
        value,
        rating:
          value <= limits[0]
            ? "good"
            : value <= limits[1]
              ? "needs-improvement"
              : "poor",
      });
    }
  };
  return {
    flush,
    stop: () => observers.forEach((observer) => observer.disconnect()),
  };
}

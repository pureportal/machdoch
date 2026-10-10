import type { AnalyticsClient } from "@machdoch/analytics/client";
import {
  operationFeature,
  type Feature,
  type Operation,
} from "@machdoch/analytics/catalog";

interface OperationAnalytics {
  client: AnalyticsClient;
  onUse: (feature: Feature) => void;
}

let current: OperationAnalytics | null = null;

export function setOperationAnalytics(value: OperationAnalytics | null): void {
  current = value;
}

export function trackOperation<T>(
  operation: string,
  action: () => Promise<T>,
): Promise<T> {
  const feature = operationFeature(operation);
  const context = feature ? current : null;
  if (!context || !feature) return action();
  return (async () => {
    const started = performance.now();
    context.onUse(feature);
    context.client.track("operation.started", {
      feature,
      operation: operation as Operation,
    });
    try {
      const result = await action();
      if (current === context)
        context.client.track("operation.completed", {
          operation: operation as Operation,
          duration_ms: performance.now() - started,
        });
      return result;
    } catch (error) {
      if (current === context) {
        context.client.track("operation.failed", {
          operation: operation as Operation,
          duration_ms: performance.now() - started,
        });
        context.client.error(error);
      }
      throw error;
    }
  })();
}

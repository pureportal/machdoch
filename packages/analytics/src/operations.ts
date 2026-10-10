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

export async function trackOperation<T>(
  operation: string,
  action: () => Promise<T>,
): Promise<T> {
  const feature = operationFeature(operation);
  const context = feature ? current : null;
  const started = context ? performance.now() : 0;
  if (context && feature) {
    context.onUse(feature);
    context.client.track("operation.started", {
      feature,
      operation: operation as Operation,
    });
  }
  try {
    const result = await action();
    if (current === context)
      context?.client.track("operation.completed", {
        operation: operation as Operation,
        duration_ms: performance.now() - started,
      });
    return result;
  } catch (error) {
    if (current === context && context) {
      context.client.track("operation.failed", {
        operation: operation as Operation,
        duration_ms: performance.now() - started,
      });
      context.client.error(error);
    }
    throw error;
  }
}

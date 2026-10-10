import { AnalyticsClient } from "@machdoch/analytics/client";
import {
  NOTICE_REVISION,
  operationFeature,
  type Operation,
} from "@machdoch/analytics/catalog";
import { getProductVersion } from "../../helpers/product-version.js";

export async function trackCliCommand<T>(
  command: string,
  action: () => Promise<T>,
): Promise<T> {
  const operation = `cli.${command}`;
  const feature = operationFeature(operation);
  const enabled = (): boolean =>
    process.env.MACHDOCH_ANALYTICS_CONSENT === NOTICE_REVISION &&
    process.env.NODE_ENV !== "development" &&
    !process.env.VITEST;
  if (!feature || !enabled()) return action();
  const client = new AnalyticsClient({
    app: "software",
    version: getProductVersion(),
    surface: "cli",
    enabled,
  });
  const started = performance.now();
  client.pageview(`/cli/${command}`);
  client.track("session.started");
  client.track("feature.used", { feature, source: "cli" });
  client.track("operation.started", { operation: operation as Operation });
  try {
    const result = await action();
    client.track("operation.completed", {
      operation: operation as Operation,
      duration_ms: performance.now() - started,
    });
    return result;
  } catch (error) {
    client.track("operation.failed", {
      operation: operation as Operation,
      duration_ms: performance.now() - started,
    });
    client.error(error);
    throw error;
  } finally {
    await client.flush();
    client.stop();
  }
}

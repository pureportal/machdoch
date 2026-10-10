import { startBrowserAnalytics } from "@machdoch/analytics/browser";
import packageManifest from "../../../package.json";

startBrowserAnalytics({
  app: "fleet",
  version: packageManifest.version,
  development: import.meta.env.DEV,
});

import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function buildSettingsHarness() {
  const requireClient = createRequire(
    new URL("../../apps/client/package.json", import.meta.url),
  );
  const { build } = await import(
    pathToFileURL(requireClient.resolve("vite")).href
  );
  const { default: tailwind } = await import(
    pathToFileURL(requireClient.resolve("@tailwindcss/vite")).href
  );
  const result = await build({
    configFile: false,
    root: resolve("apps/fleet-manager"),
    logLevel: "error",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [tailwind()],
    resolve: { alias: { "@": resolve("apps/fleet-manager/src") } },
    css: { postcss: { plugins: [] } },
    build: {
      write: false,
      lib: {
        entry: resolve("scripts/fleet-review/settings-harness.tsx"),
        formats: ["iife"],
        name: "FleetSettingsReview",
      },
    },
  });
  const chunks = result.flatMap((bundle) => bundle.output);
  const script = chunks.find((item) => item.type === "chunk").code;
  const css = chunks
    .filter((item) => item.fileName.endsWith(".css"))
    .map((item) => item.source)
    .join("\n");
  return async (page) => {
    await page.route("**/__fleet_review_settings", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Settings review</title><link rel="stylesheet" href="/__fleet_review_settings.css"></head><body><div id="root"></div><script src="/__fleet_review_settings.js"></script></body></html>',
      }),
    );
    await page.route("**/__fleet_review_settings.js", (route) =>
      route.fulfill({
        contentType: "text/javascript; charset=utf-8",
        body: script,
      }),
    );
    await page.route("**/__fleet_review_settings.css", (route) =>
      route.fulfill({ contentType: "text/css; charset=utf-8", body: css }),
    );
  };
}

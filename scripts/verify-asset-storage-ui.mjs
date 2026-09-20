import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const requireClient = createRequire(
  new URL("../apps/client/package.json", import.meta.url),
);
const { build } = await import(
  pathToFileURL(requireClient.resolve("vite")).href
);
const { default: tailwind } = await import(
  pathToFileURL(requireClient.resolve("@tailwindcss/vite")).href
);
const result = await build({
  configFile: false,
  root: resolve("apps/client"),
  logLevel: "error",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [tailwind()],
  build: {
    write: false,
    lib: {
      entry: resolve(
        "apps/client/src/tauri/ui/__test__/asset-storage-review.tsx",
      ),
      formats: ["iife"],
      name: "AssetStorageReview",
    },
  },
});
const chunks = result.flatMap((bundle) => bundle.output);
const script = chunks.find((item) => item.type === "chunk").code;
const css = chunks
  .filter((item) => item.fileName.endsWith(".css"))
  .map((item) => item.source)
  .join("\n");
const output = resolve("apps/client/.cache/asset-storage-review");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const checks = [];
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("http://127.0.0.1/storage-review", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html lang="en" class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>',
      }),
    );
    await page.goto("http://127.0.0.1/storage-review");
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: script });
    await page.getByRole("button", { name: "Choose folder" }).click();
    await page
      .getByRole("button", { name: "Move assets", exact: true })
      .waitFor();
    await page.screenshot({ path: resolve(output, `confirm-${width}.png`) });
    await page
      .getByRole("button", { name: "Move assets", exact: true })
      .click();
    await page.getByText("Moving assets", { exact: true }).waitFor();
    assert.equal(
      await page.getByRole("progressbar").getAttribute("value"),
      "25",
    );
    await page.screenshot({ path: resolve(output, `moving-${width}.png`) });
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("storage-review-state", { detail: "paused" }),
      ),
    );
    await page.getByRole("button", { name: "Resume move" }).waitFor();
    await page.screenshot({ path: resolve(output, `paused-${width}.png`) });
    await page.getByRole("button", { name: "Resume move" }).click();
    await page.getByText("Moving assets", { exact: true }).waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.deepEqual(errors, []);
    checks.push({
      width,
      confirmation: true,
      progress: true,
      resume: true,
      overflow: false,
    });
    await page.close();
  }
} finally {
  await browser.close();
}
await writeFile(
  resolve(output, "results.json"),
  JSON.stringify(checks, null, 2),
);
console.log(JSON.stringify(checks, null, 2));

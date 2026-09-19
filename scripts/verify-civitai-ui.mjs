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
        "apps/client/src/tauri/ui/__test__/civitai-browser-review.tsx",
      ),
      formats: ["iife"],
      name: "CivitaiReview",
    },
  },
});
const chunks = result.flatMap((bundle) => bundle.output);
const script = chunks.find((item) => item.type === "chunk").code;
const css = chunks
  .filter((item) => item.fileName.endsWith(".css"))
  .map((item) => item.source)
  .join("\n");
const output = resolve("apps/client/.cache/civitai-review");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  channel: process.env.CHROME_CHANNEL ?? "chrome",
  headless: true,
});
let reviewPage;
const errors = [];
const checks = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  reviewPage = page;
  page.setDefaultTimeout(12000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("http://127.0.0.1/civitai-review", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="en" class="dark" data-theme="dark"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Civitai review</title></head><body><div id="root"></div></body></html>',
    }),
  );
  await page.route("https://image.civitai.com/review/**", (route) => {
    const second = route.request().url().includes("-2.");
    return route.fulfill({
      contentType: "image/svg+xml",
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="${second ? "#7b536c" : "#40677f"}"/><stop offset="1" stop-color="#d7bea5"/></linearGradient></defs><rect width="800" height="600" fill="url(#sky)"/><circle cx="560" cy="190" r="66" fill="#f2d4a0"/><path d="M0 490L180 210L370 470L550 320L800 500V600H0" fill="#334d5e"/><path d="M0 570L280 400L520 550L730 460L800 520V600H0" fill="#203c4f"/></svg>`,
    });
  });
  await page.goto("http://127.0.0.1/civitai-review");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  await page
    .getByRole("button", { name: "View Watercolor Landscapes", exact: true })
    .waitFor();
  assert.equal(await page.getByRole("dialog").count(), 1);
  assert.equal(
    await page
      .getByLabel("Search Civitai")
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page.screenshot({ path: resolve(output, "catalog-desktop.png") });
  checks.push("Catalog renders, focuses search, and displays previews");
  assert.deepEqual(
    await page
      .getByLabel("Resource type", { exact: true })
      .locator("option")
      .evaluateAll((options) => options.map((option) => option.value)),
    ["", "Checkpoint", "LORA", "LoCon", "DoRA", "TextualInversion"],
  );
  await page
    .getByLabel("Base model", { exact: true })
    .selectOption("Wan Video 2.2 TI2V-5B");
  await page
    .getByLabel("Resource type", { exact: true })
    .selectOption("Checkpoint");
  assert.equal(
    await page.getByLabel("Base model", { exact: true }).inputValue(),
    "",
  );
  assert.equal(
    await page
      .getByLabel("Base model", { exact: true })
      .locator('option[value="Wan Video 2.2 TI2V-5B"]')
      .count(),
    0,
  );
  await page
    .getByLabel("Resource type", { exact: true })
    .selectOption("TextualInversion");
  assert.equal(
    await page
      .getByLabel("Base model", { exact: true })
      .locator('option[value="Krea 2"]')
      .count(),
    0,
  );
  await page.getByLabel("Resource type", { exact: true }).selectOption("");
  await page
    .getByRole("button", { name: "View Watercolor Landscapes", exact: true })
    .waitFor();
  checks.push(
    "Filters expose usable types and reset incompatible base models when the type changes",
  );
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  await page
    .getByRole("button", { name: "View More Watercolors", exact: true })
    .waitFor();
  await page.getByLabel("Mature content").check();
  await page
    .getByRole("button", { name: "View Mature catalog fixture", exact: true })
    .waitFor();
  await page.getByLabel("Mature content").uncheck();
  await page
    .getByRole("button", { name: "View Mature catalog fixture", exact: true })
    .waitFor({ state: "hidden" });
  checks.push("Cursor pagination and mature-content switching");
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByLabel("My favorites").click();
  await page.getByLabel("API key").fill("test-session-key");
  await page
    .getByRole("button", { name: "Connect for this session", exact: true })
    .click();
  await page.getByRole("button", { name: "Connected", exact: true }).waitFor();
  await page.getByLabel("My favorites").check();
  await page
    .getByRole("button", { name: "View Watercolor Landscapes", exact: true })
    .click();
  await page.getByRole("button", { name: /Download & import/ }).waitFor();
  await page
    .getByRole("button", { name: "Copy trigger words", exact: true })
    .click();
  assert.equal(
    await page.evaluate(() => window.civitaiReview.copied.at(-1)),
    "watercolor, soft edges",
  );
  await page.getByRole("button", { name: "Preview 2", exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "Preview 2", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await page.getByText("Preview prompt", { exact: true }).click();
  await page.getByRole("button", { name: "Copy prompt", exact: true }).click();
  assert.match(
    await page.evaluate(() => window.civitaiReview.copied.at(-1)),
    /watercolor mountain/,
  );
  await page.getByRole("button", { name: "Save preview", exact: true }).click();
  await page
    .getByRole("button", { name: "Preview saved", exact: true })
    .waitFor();
  await page.getByLabel("Version", { exact: true }).selectOption("12");
  await page.getByLabel("File", { exact: true }).selectOption("122");
  await page.waitForFunction(() =>
    window.civitaiReview.requests.some(
      ({ command, args }) =>
        command === "media_inspect_civitai_file" && args.fileId === 122,
    ),
  );
  await page.screenshot({ path: resolve(output, "detail-desktop.png") });
  checks.push(
    "Session connection, favorites, versions, files, trigger words, prompt copy, preview saving",
  );
  await page.evaluate(() => {
    window.civitaiReview.downloadMode = "hold";
  });
  await page.getByRole("button", { name: /Download & import/ }).click();
  await page.getByRole("progressbar", { name: "Download progress" }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Close Civitai", exact: true })
      .isDisabled(),
    true,
  );
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 1);
  await page
    .getByRole("button", { name: "Cancel download", exact: true })
    .click();
  await page.getByText("Download cancelled", { exact: true }).waitFor();
  await page.evaluate(() => {
    window.civitaiReview.downloadMode = "error";
  });
  await page.getByRole("button", { name: /Download & import/ }).click();
  await page.getByText(/failed SHA-256/).waitFor();
  assert.equal(
    await page.evaluate(() => window.civitaiReview.imports.length),
    0,
  );
  await page.evaluate(() => {
    window.civitaiReview.downloadMode = "complete";
  });
  await page.getByRole("button", { name: /Download & import/ }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  const imported = await page.evaluate(() => window.civitaiReview.imports[0]);
  assert.equal(imported.kind, "addon");
  assert.equal(imported.request.reviewToken, "local-review");
  assert.deepEqual(imported.request.triggerWords, ["watercolor", "soft edges"]);
  assert.equal(imported.metadata.sampleImages.length, 2);
  checks.push(
    "Progress, close protection, cancellation, hash failure, enriched import callback",
  );
  await page
    .getByRole("button", { name: "Browse Civitai", exact: true })
    .click();
  await page
    .getByRole("button", { name: "View Studio XL", exact: true })
    .click();
  await page.getByRole("button", { name: /Download & import/ }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(
    await page.evaluate(() => window.civitaiReview.imports.at(-1).kind),
    "model",
  );
  await page
    .getByRole("button", { name: "Browse Civitai", exact: true })
    .click();
  await page.getByLabel("Search Civitai").fill("a".repeat(64));
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByLabel("Version", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Version", { exact: true }).inputValue(),
    "12",
  );
  await page.getByRole("button", { name: "Results", exact: true }).click();
  await page.getByLabel("Search Civitai").fill("empty");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByText("No matching models", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  assert.equal(await page.getByLabel("Search Civitai").inputValue(), "empty");
  await page.getByLabel("Search Civitai").fill("");
  await page.getByLabel("Search Civitai").press("Enter");
  await page.evaluate(() => {
    window.civitaiReview.failSearch = true;
  });
  await page.getByLabel("Resource type").selectOption("LORA");
  await page.getByText(/Civitai rate limit reached/).waitFor();
  await page.evaluate(() => {
    window.civitaiReview.failSearch = false;
  });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page
    .getByRole("button", { name: "View Watercolor Landscapes", exact: true })
    .waitFor();
  checks.push(
    "Checkpoint imports, hash lookup version pinning, empty results, errors and retry",
  );
  await page.getByLabel("Search Civitai").fill("slow");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByLabel("Resource type").selectOption("Checkpoint");
  await page.getByLabel("Search Civitai").fill("fresh");
  await page.getByLabel("Search Civitai").press("Enter");
  await page
    .getByRole("button", { name: "View Studio XL", exact: true })
    .waitFor();
  await page.waitForTimeout(800);
  assert.equal(
    await page
      .getByRole("button", { name: "View Stale result", exact: true })
      .count(),
    0,
  );
  checks.push("Out-of-order search responses cannot replace newer results");
  await page.getByLabel("Resource type").selectOption("");
  await page.getByLabel("Search Civitai").fill("Age");
  await page.getByLabel("Search Civitai").press("Enter");
  await page
    .getByRole("button", { name: "View Age Slider LoRA", exact: true })
    .waitFor();
  const ageRequests = await page.evaluate(() =>
    window.civitaiReview.requests
      .filter(
        ({ command, args }) =>
          command === "media_search_civitai" && args.request.query === "Age",
      )
      .map(({ args }) => args.request),
  );
  assert.deepEqual(
    ageRequests.map(({ cursor }) => cursor),
    [null, "age-2", "age-3"],
  );
  assert.ok(
    ageRequests.every(({ period, nsfw }) => period === "AllTime" && !nsfw),
  );
  await page.screenshot({ path: resolve(output, "age-search-desktop.png") });
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByLabel("Period", { exact: true }).selectOption("Month");
  await page.getByText("No matching models", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await page
    .getByRole("button", { name: "View Age Slider LoRA", exact: true })
    .waitFor();
  assert.equal(await page.getByLabel("Search Civitai").inputValue(), "Age");
  assert.equal(
    await page.getByLabel("Period", { exact: true }).inputValue(),
    "AllTime",
  );
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  checks.push(
    "Age searches all time, skips empty pages, and keeps the query when clearing filters",
  );
  await page.getByLabel("Search Civitai").fill("sparse");
  await page.getByLabel("Search Civitai").press("Enter");
  await page
    .getByRole("button", { name: "Search more", exact: true })
    .waitFor();
  assert.equal(
    await page.getByText("No matching models", { exact: true }).count(),
    0,
  );
  assert.equal(
    await page.evaluate(
      () =>
        window.civitaiReview.requests.filter(
          ({ command, args }) =>
            command === "media_search_civitai" &&
            args.request.query === "sparse",
        ).length,
    ),
    5,
  );
  await page.getByRole("button", { name: "Search more", exact: true }).click();
  await page
    .getByRole("button", { name: "View Age Slider LoRA", exact: true })
    .waitFor();
  await page.getByLabel("Search Civitai").fill("cycle");
  await page.getByLabel("Search Civitai").press("Enter");
  await page
    .getByText("Civitai repeated a results page. Try searching again.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await page.getByText("No matching models", { exact: true }).count(),
    0,
  );
  checks.push(
    "Sparse searches remain resumable after five pages; cursor cycles surface an error",
  );
  await page.getByLabel("Search Civitai").fill("slow-empty");
  await page.getByLabel("Search Civitai").press("Enter");
  await page.waitForFunction(() =>
    window.civitaiReview.requests.some(
      ({ command, args }) =>
        command === "media_search_civitai" &&
        args.request.query === "slow-empty",
    ),
  );
  await page.getByLabel("Search Civitai").fill("fresh");
  await page.getByLabel("Search Civitai").press("Enter");
  await page
    .getByRole("button", { name: "View Watercolor Landscapes", exact: true })
    .waitFor();
  await page.waitForTimeout(800);
  assert.equal(
    await page.evaluate(() =>
      window.civitaiReview.requests.some(
        ({ command, args }) =>
          command === "media_search_civitai" &&
          args.request.cursor === "stale-page",
      ),
    ),
    false,
  );
  checks.push("Superseded searches stop fetching empty pages");
  await page.getByLabel("Resource type").selectOption("");
  await page
    .getByRole("button", { name: "View Watercolor Landscapes", exact: true })
    .waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(output, "catalog-mobile.png") });
  const overflow = () =>
    page
      .getByRole("dialog")
      .evaluate(
        (element) =>
          element.scrollWidth > element.clientWidth + 1 ||
          element.getBoundingClientRect().right > innerWidth,
      );
  assert.equal(await overflow(), false);
  await page
    .getByRole("button", { name: "View Watercolor Landscapes", exact: true })
    .click();
  await page.getByRole("button", { name: /Download & import/ }).waitFor();
  assert.equal(await overflow(), false);
  await page.screenshot({ path: resolve(output, "detail-mobile.png") });
  await page.addScriptTag({
    path: requireClient.resolve("axe-core/axe.min.js"),
  });
  const accessibility = await page.evaluate(async () =>
    (
      await axe.run(document.querySelector('[role="dialog"]'), {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
      })
    ).violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      count: nodes.length,
      nodes: nodes.map(({ target, failureSummary }) => ({
        target,
        failureSummary,
      })),
    })),
  );
  await writeFile(
    resolve(output, "accessibility.json"),
    JSON.stringify(accessibility, null, 2),
  );
  assert.deepEqual(
    accessibility.filter(
      ({ impact }) => impact === "critical" || impact === "serious",
    ),
    [],
  );
  checks.push(
    "390px layout: no horizontal overflow; no serious or critical accessibility violations",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify({ checks, errors, accessibility }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors, output }, null, 2));
} catch (error) {
  if (reviewPage) {
    await reviewPage.screenshot({ path: resolve(output, "failure.png") });
    console.error(await reviewPage.locator("body").innerText());
    console.error(
      await reviewPage.getByRole("combobox").evaluateAll((elements) =>
        elements.map((element) => ({
          label: element.labels?.[0]?.textContent,
          name: element.getAttribute("aria-label"),
        })),
      ),
    );
  }
  throw error;
} finally {
  await browser.close();
}

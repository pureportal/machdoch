import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const output =
  process.env.MACHDOCH_MEDIA_UI_SCREENSHOT_DIR ??
  path.join(os.tmpdir(), "machdoch-activity-review");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.setDefaultTimeout(15_000);
const errors = [];
let phase = "startup";
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`${phase}: ${message.text()}`);
});
const fixtureRuns = createRuns();
const checks = [];
const require = createRequire(
  new URL("../apps/client/package.json", import.meta.url),
);
try {
  await page.route("**/media-runtime.ts*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `${await response.text()}\nwindow.setActivityFixtures = (runs) => { browserRuns.clear(); for (const run of runs) browserRuns.set(run.id, run); };`,
    });
  });
  await page.goto(
    process.env.MACHDOCH_CLIENT_UI_URL ?? "http://127.0.0.1:4173",
    { waitUntil: "networkidle" },
  );
  const skip = page.getByRole("button", { name: "Skip first-startup setup" });
  await skip.waitFor();
  await skip.click();
  await skip.waitFor({ state: "hidden" });
  await page
    .locator('.app-shell-rail button[aria-label^="Media Studio"]')
    .click();
  await page
    .locator('.m-media-navigation button[aria-label="Activity"]')
    .click();
  await page.getByRole("heading", { name: "Run history" }).waitFor();
  await setRuns(fixtureRuns);
  phase = "responsive list";
  await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
  const accessibility = await page.evaluate(async () => {
    const result = await window.axe.run(
      document.querySelector(".m-media-studio-layout"),
      { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } },
    );
    return result.violations.map(({ id, nodes }) => ({
      id,
      elements: nodes.map((node) => node.target),
    }));
  });
  assert.deepEqual(accessibility, []);

  for (const [width, height] of [
    [1440, 960],
    [1272, 900],
    [1024, 768],
    [768, 700],
    [430, 740],
    [320, 568],
  ]) {
    await page.setViewportSize({ width, height });
    const metrics = await inspectLayout();
    assert.ok(metrics.documentWidth <= width + 1, JSON.stringify(metrics));
    assert.ok(metrics.documentHeight <= height + 1, JSON.stringify(metrics));
    assert.ok(metrics.listBottom <= height + 1, JSON.stringify(metrics));
    assert.ok(metrics.rowOverflow === 0, JSON.stringify(metrics));
    assert.ok(metrics.previewMaxWidth <= 64, JSON.stringify(metrics));
    assert.ok(metrics.progressCount === 2, JSON.stringify(metrics));
    await page.screenshot({ path: path.join(output, `activity-${width}.png`) });
    checks.push(metrics);
  }

  await page.setViewportSize({ width: 1272, height: 900 });
  const search = page.getByRole("searchbox", { name: "Search run history" });
  await search.fill("lantern");
  await page.waitForFunction(
    () => document.querySelectorAll("[data-run-id]").length === 1,
  );
  await page
    .getByRole("combobox", { name: "Filter runs by status" })
    .selectOption("failed");
  await page.getByText("No matching runs").waitFor();
  await page.getByRole("button", { name: "Clear filters" }).click();
  assert.equal(await page.locator("[data-run-id]").count(), fixtureRuns.length);

  const list = page.getByLabel("Run history list", { exact: true });
  await list.evaluate((element) => {
    element.scrollTop = 160;
  });
  const row = page.locator('[data-run-id="activity-completed-3"]');
  await row.scrollIntoViewIfNeeded();
  await row.focus();
  const scrollTop = await list.evaluate((element) => element.scrollTop);
  await row.press("Enter");
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await dialog
    .getByRole("heading", { name: "Edit image", exact: true })
    .waitFor();
  await dialog.locator("img").first().waitFor();
  assert.equal(await dialog.getByRole("progressbar").count(), 0);
  await dialog.getByText("Settings", { exact: true }).click();
  await dialog.getByText("Events (2)", { exact: true }).click();
  const dialogAccessibility = await page.evaluate(async () => {
    const result = await window.axe.run(
      document.querySelector('[role="dialog"]'),
      { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } },
    );
    return result.violations.map(({ id, nodes }) => ({
      id,
      elements: nodes.map((node) => node.target),
    }));
  });
  assert.deepEqual(dialogAccessibility, []);
  await page.screenshot({
    path: path.join(output, "activity-details-desktop.png"),
  });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await list.evaluate((element) => element.scrollTop), scrollTop);
  assert.equal(
    await row.evaluate((element) => element === document.activeElement),
    true,
  );

  await row.click();
  phase = "open asset";
  await dialog
    .getByRole("button", { name: "View Image 1", exact: true })
    .click();
  await page
    .locator(
      '.m-media-navigation button[aria-label="Assets"][aria-current="page"]',
    )
    .waitFor();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page
    .locator('.m-media-navigation button[aria-label="Activity"]')
    .click();
  if (await dialog.count()) await page.keyboard.press("Escape");

  await page.locator('[data-run-id="activity-running-0"]').click();
  phase = "cancel";
  await dialog.getByRole("button", { name: "Cancel run", exact: true }).click();
  await dialog.getByText("Canceling", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await setRuns(fixtureRuns);
  phase = "rerun";
  await page.locator('[data-run-id="activity-canceled-4"]').click();
  await dialog
    .getByRole("button", { name: "Edit and rerun", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: "Dismiss Media Studio error" })
    .click();

  await page.setViewportSize({ width: 430, height: 740 });
  phase = "mobile dialog";
  await page.locator('[data-run-id="activity-completed-3"]').click();
  await dialog.getByText("Settings", { exact: true }).click();
  await dialog.getByText("Events (2)", { exact: true }).click();
  const dialogMetrics = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const scroller = element.querySelector(":scope > div.overflow-y-auto");
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
      scrollable: scroller && scroller.scrollHeight > scroller.clientHeight,
    };
  });
  assert.ok(
    dialogMetrics.left >= 0 &&
      dialogMetrics.right <= 431 &&
      dialogMetrics.top >= 0 &&
      dialogMetrics.bottom <= 741,
    JSON.stringify(dialogMetrics),
  );
  assert.ok(
    dialogMetrics.scrollWidth <= dialogMetrics.width + 1,
    JSON.stringify(dialogMetrics),
  );
  assert.equal(dialogMetrics.scrollable, true);
  await page.screenshot({
    path: path.join(output, "activity-details-mobile.png"),
  });
  await dialog.getByRole("button", { name: "Close", exact: true }).click();

  await page.setViewportSize({ width: 1272, height: 900 });
  phase = "pagination";
  await setRuns(
    Array.from({ length: 65 }, (_, index) => ({
      ...fixtureRuns[3],
      id: `page-${index}`,
      createdAt: new Date(Date.UTC(2026, 8, 17, 12, index)).toISOString(),
      assets: [],
    })),
  );
  await page.getByRole("button", { name: "Next runs page" }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('select[aria-label="Current runs page"]')
        ?.value === "2",
  );
  assert.equal(await list.evaluate((element) => element.scrollTop), 0);
  await page.getByRole("button", { name: "Last runs page" }).click();
  assert.equal(await page.locator("[data-run-id]").count(), 5);
  await search.fill("no matching prompt");
  await page.getByText("No matching runs").waitFor();
  await page.getByRole("button", { name: "Clear filters" }).click();
  assert.equal(await page.locator("[data-run-id]").count(), 30);
  await page.screenshot({ path: path.join(output, "activity-pagination.png") });
  await setRuns([]);
  await page.getByRole("heading", { name: "No runs yet" }).waitFor();
  await page.getByRole("button", { name: "New recipe" }).click();
  await page
    .locator(
      '.m-media-navigation button[aria-label="Basic"][aria-current="page"]',
    )
    .waitFor();
  assert.deepEqual(errors, []);
  process.stdout.write(
    `${JSON.stringify({ checks, dialogMetrics, accessibility, dialogAccessibility, errors, screenshots: output }, null, 2)}\n`,
  );
} catch (error) {
  await page.screenshot({
    path: path.join(output, "activity-verification-failure.png"),
  });
  process.stderr.write(`${await page.locator("body").innerText()}\n`);
  throw error;
} finally {
  await browser.close();
}

async function setRuns(runs) {
  await page.evaluate((records) => window.setActivityFixtures(records), runs);
  await page.getByRole("button", { name: "Refresh runs" }).click();
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll("[data-run-id]").length === Math.min(30, count),
    runs.length,
  );
  await page.waitForFunction(() =>
    [...document.querySelectorAll("[data-run-id] img")].every(
      (image) => image.complete,
    ),
  );
}

async function inspectLayout() {
  return page.evaluate(() => {
    const list = document.querySelector('[aria-label="Run history list"]');
    const rows = [...document.querySelectorAll("[data-run-id]")];
    return {
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      listBottom: list.getBoundingClientRect().bottom,
      listHeight: list.clientHeight,
      scrollHeight: list.scrollHeight,
      rowHeight: rows[3].getBoundingClientRect().height,
      rowOverflow: rows.filter((row) => row.scrollWidth > row.clientWidth + 1)
        .length,
      previewMaxWidth: Math.max(
        0,
        ...rows.flatMap((row) =>
          [...row.querySelectorAll("img, video")].map(
            (image) => image.getBoundingClientRect().width,
          ),
        ),
      ),
      progressCount: list.querySelectorAll('[role="progressbar"]').length,
    };
  });
}

function createRuns() {
  const samples = [
    [
      "running",
      "Create image",
      "A paper lantern glowing in a quiet mountain village",
      "Sampling · 14 / 28",
      "FLUX.1 Dev",
    ],
    [
      "queued",
      "Create video",
      "A slow orbit around a ceramic sculpture",
      "Queued",
      "Wan 2.2",
    ],
    [
      "waiting-for-review",
      "Product variations",
      "Studio photographs of a cobalt blue coffee cup",
      "Awaiting review",
      "Stable Diffusion XL",
    ],
    [
      "completed",
      "Edit image",
      "Warm afternoon light across the kitchen counter",
      "Completed",
      "realismByStableYogi v30INT8FP8Extended fp8Scaled",
    ],
    [
      "canceled",
      "Edit image",
      "Add wildflowers along the garden path",
      "Canceled",
      "Stable Diffusion XL",
    ],
    [
      "failed",
      "Create video",
      "Clouds drifting above a mountain lake",
      "Failed",
      "Wan 2.2",
    ],
    [
      "canceling",
      "Create image",
      "A lighthouse in a winter storm",
      "Finishing the current step",
      "FLUX.1 Dev",
    ],
    [
      "needs-review",
      "Create image",
      "Minimal geometric poster in blue and ochre",
      "Review provider request",
      "GPT Image",
    ],
    [
      "completed",
      "Analyze image",
      "Check the composition and image quality",
      "Completed",
      "Local analysis",
    ],
    [
      "completed",
      "Create image",
      "A glass vase with branches on a wooden table",
      "Completed",
      "Stable Diffusion XL",
    ],
    [
      "completed",
      "Long workflow name that must remain readable in a narrow window",
      "A long prompt " + "with useful visual details ".repeat(12),
      "Completed",
      "VeryLongModelFilename".repeat(8),
    ],
    [
      "completed",
      "Edit image",
      "Soft evening colors across a city skyline",
      "Completed",
      "Stable Diffusion XL",
    ],
  ];
  return samples.map(
    ([status, flowName, prompt, currentStep, modelLabel], index) => {
      const id = `activity-${status}-${index}`;
      const createdAt = new Date(
        Date.now() -
          (index < 7 ? index * 600_000 : 86_400_000 + index * 600_000),
      ).toISOString();
      const assets =
        ["completed", "waiting-for-review"].includes(status) && index !== 10
          ? [
              {
                id: `preview-${index}`,
                runId: id,
                digest: ["324659ca9948", "6648467ba199", "527885c1a176"][
                  index % 3
                ].padEnd(64, "a"),
                kind: index === 8 ? "report" : "image",
                mimeType: index === 8 ? "application/json" : "image/png",
                byteSize: 1024,
                width: index % 2 ? 1280 : 640,
                height: index % 2 ? 720 : 960,
                createdAt,
                outputIndex: 0,
                fixture: true,
                operation: null,
                sourceAssetIds: [],
                tags: [],
              },
            ]
          : [];
      return {
        id,
        flowId: "activity-test-flow",
        flowRevisionId: index === 4 ? "activity-test-revision" : null,
        flowName,
        planId: "activity-test-plan",
        status,
        createdAt,
        updatedAt: createdAt,
        prompt,
        modelLabel,
        target: index === 7 ? "remote" : "local",
        outputCount: 1,
        diagnosticCount: status === "failed" ? 1 : 0,
        progress: status === "completed" ? 1 : 0.5,
        currentStep,
        executor: "local-image-flow",
        error:
          status === "failed"
            ? "The model could not finish this run. Try a smaller output."
            : null,
        failure: null,
        assets,
        events: [
          "run_queued",
          status === "completed" ? "run_completed" : "run_started",
        ].map((kind, eventIndex) => ({
          id: `${id}-event-${eventIndex}`,
          runId: id,
          kind,
          createdAt,
          message: eventIndex
            ? "Saved the generated output."
            : "Added to the generation queue.",
        })),
        humanReviews: [],
        providerJobs: [],
        nodeExecutions: [],
        planSnapshot: null,
      };
    },
  );
}

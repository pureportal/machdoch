import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const endpoint = process.argv[2];
const fixture = JSON.parse(await readFile(process.argv[3], "utf8"));
const output = path.resolve(process.argv[4]);
await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP(endpoint);
const page = browser
  .contexts()[0]
  .pages()
  .find((page) => page.url().includes("tauri"));
assert.ok(page, "The isolated Tauri window is missing");
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(30_000);
try {
  await page.getByRole("button", { name: "Basic", exact: true }).click();
  await page.locator("#media-quick-model").click();
  await page.locator("[cmdk-input]").fill(fixture.modelName);
  await page.locator(`[cmdk-item][data-value="${fixture.modelId}"]`).click();
  await page
    .locator("#media-quick-prompt")
    .fill((await readFile(fixture.promptFile, "utf8")).trim());
  const more = page.getByRole("button", { name: /^More options/ });
  if ((await more.getAttribute("aria-expanded")) === "false")
    await more.click();
  await page
    .getByRole("combobox", { name: /^Aspect ratio/ })
    .selectOption(fixture.aspectRatio);
  await page
    .getByLabel("Sampler", { exact: true })
    .selectOption(fixture.sampler);
  await page
    .getByRole("combobox", { name: /^Resolution/ })
    .selectOption("custom");
  await page.getByLabel("Width", { exact: true }).fill(String(fixture.width));
  await page.getByLabel("Height", { exact: true }).fill(String(fixture.height));
  await page.getByRole("combobox", { name: /^Seed/ }).selectOption("fixed");
  await page.getByLabel("Value", { exact: true }).fill(String(fixture.seed));
  const previous = await page.evaluate(() =>
    window.__TAURI__.core.invoke("media_list_runs", { limit: 100 }),
  );
  await page.screenshot({
    path: path.join(output, "basic-request.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Generate image", exact: true })
    .click();
  console.log(
    JSON.stringify({
      phase: "submitted",
      modelId: fixture.modelId,
      referenceId: fixture.referenceId,
    }),
  );
  const started = Date.now();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 20_000));
    const runs = await page.evaluate(() =>
      window.__TAURI__.core.invoke("media_list_runs", { limit: 100 }),
    );
    const run = runs.find(
      (candidate) => !previous.some((entry) => entry.id === candidate.id),
    );
    const elapsedSeconds = Math.round((Date.now() - started) / 1000);
    console.log(
      JSON.stringify({
        runId: run?.id,
        status: run?.status,
        currentStep: run?.currentStep,
        progress: run?.progress,
        elapsedSeconds,
      }),
    );
    if (run && ["completed", "failed", "canceled"].includes(run.status)) {
      const detail = await page.evaluate(
        (runId) =>
          window.__TAURI__.core.invoke("media_get_run_detail", { runId }),
        run.id,
      );
      await writeFile(
        path.join(output, "run-detail.json"),
        JSON.stringify(detail, null, 2) + "\n",
      );
      await page.screenshot({
        path: path.join(output, "basic-result.png"),
        fullPage: true,
      });
      await writeFile(
        path.join(output, "playwright-results.json"),
        JSON.stringify(
          {
            actualTauriIPC: true,
            fixture,
            runId: run.id,
            status: run.status,
            elapsedSeconds,
            errors,
          },
          null,
          2,
        ) + "\n",
      );
      assert.equal(
        run.status,
        "completed",
        JSON.stringify(detail.failure ?? detail.error),
      );
      assert.ok(
        detail.assets.length > 0,
        "The completed native run has no assets",
      );
      assert.deepEqual(errors, []);
      break;
    }
    assert.ok(
      elapsedSeconds < 14_400,
      "Native generation exceeded its four-hour execution limit",
    );
  }
} catch (error) {
  await page.screenshot({
    path: path.join(output, "failure.png"),
    fullPage: true,
  });
  await writeFile(
    path.join(output, "failure-dom.txt"),
    await page.locator("body").innerText(),
  );
  throw error;
} finally {
  await browser.close();
}

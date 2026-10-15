import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const endpoint = process.argv[2];
const fixture = JSON.parse(await readFile(process.argv[3], "utf8"));
const output = path.resolve(process.argv[4]);
const mode = process.argv[5];
assert.ok(["basic", "advanced"].includes(mode), "Pass basic or advanced");
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
  await page.reload();
  await page.getByRole("button", { name: "Media Studio", exact: true }).click();
  await page.getByRole("button", { name: "Basic", exact: true }).click();
  await page.locator("#media-quick-model").click();
  await page.locator("[cmdk-input]").fill(fixture.modelName);
  await page.locator(`[cmdk-item][data-value="${fixture.modelId}"]`).click();
  const prompt = (await readFile(fixture.promptFile, "utf8")).trim();
  await page.locator("#media-quick-prompt").fill(prompt);
  const more = page.getByRole("button", { name: /^More options/ });
  if ((await more.getAttribute("aria-expanded")) === "false")
    await more.click();
  const reset = page.getByRole("button", { name: "Reset custom sampling" });
  if (await reset.count()) await reset.click();
  await page
    .getByRole("combobox", { name: /^Resolution/ })
    .selectOption({ label: "Automatic" });
  await page
    .getByRole("combobox", { name: /^Aspect ratio/ })
    .selectOption(fixture.aspectRatio);
  await page
    .getByLabel("Sampler", { exact: true })
    .selectOption(fixture.sampler);
  if (fixture.numInferenceSteps != null)
    await page
      .getByLabel("Sampling steps", { exact: true })
      .fill(String(fixture.numInferenceSteps));
  if (fixture.guidanceScale != null)
    await page
      .getByLabel("Guidance", { exact: true })
      .fill(String(fixture.guidanceScale));
  await page
    .getByRole("combobox", { name: /^Resolution/ })
    .selectOption("custom");
  await page.getByLabel("Width", { exact: true }).fill(String(fixture.width));
  await page.getByLabel("Height", { exact: true }).fill(String(fixture.height));
  await page.getByRole("combobox", { name: /^Seed/ }).selectOption("fixed");
  await page.getByLabel("Value", { exact: true }).fill(String(fixture.seed));
  if (mode === "advanced") {
    await page
      .getByRole("button", { name: "Convert to Advanced", exact: true })
      .click();
    await page.locator('.react-flow__node[data-id="generate"]').click();
    await page.getByRole("tab", { name: "Creative", exact: true }).click();
    assert.equal(
      await page.getByLabel("Sampler", { exact: true }).inputValue(),
      fixture.sampler,
    );
    if (fixture.numInferenceSteps != null)
      assert.equal(
        await page.getByLabel("Sampling steps", { exact: true }).inputValue(),
        String(fixture.numInferenceSteps),
      );
    if (fixture.guidanceScale != null)
      assert.equal(
        await page.getByLabel("Guidance", { exact: true }).inputValue(),
        String(fixture.guidanceScale),
      );
  }
  const previous = await page.evaluate(() =>
    window.__TAURI__.core.invoke("media_list_runs", { limit: 100 }),
  );
  await page.screenshot({
    path: path.join(output, `${mode}-request.png`),
    fullPage: true,
  });
  await page
    .getByRole("button", {
      name: mode === "basic" ? "Generate image" : "Run",
      exact: true,
    })
    .click();
  console.log(
    JSON.stringify({
      phase: "submitted",
      mode,
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
        path: path.join(output, `${mode}-result.png`),
        fullPage: true,
      });
      assert.equal(
        run.status,
        "completed",
        JSON.stringify(detail.failure ?? detail.error),
      );
      assert.ok(
        detail.assets.length > 0,
        "The completed native run has no assets",
      );
      assert.equal(detail.prompt, prompt);
      for (const asset of detail.assets) {
        assert.equal(asset.width, fixture.width);
        assert.equal(asset.height, fixture.height);
        assert.equal(asset.operation.modelId, fixture.modelId);
        assert.equal(asset.operation.prompt, prompt);
        assert.equal(asset.operation.output.seed, fixture.seed);
        if (fixture.numInferenceSteps != null)
          assert.equal(
            asset.operation.numInferenceSteps,
            fixture.numInferenceSteps,
          );
        assert.match(asset.digest, /^[a-f0-9]{64}$/u);
        if (fixture.workerVersion) {
          assert.equal(asset.operation.workerVersion, fixture.workerVersion);
        }
      }
      assert.deepEqual(errors, []);
      await writeFile(
        path.join(output, "playwright-results.json"),
        JSON.stringify(
          {
            passed: true,
            actualTauriIPC: true,
            mode,
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
      break;
    }
    assert.ok(
      elapsedSeconds < 14_400,
      "Native generation exceeded its four-hour execution limit",
    );
  }
} catch (error) {
  await writeFile(
    path.join(output, "playwright-results.json"),
    JSON.stringify(
      {
        passed: false,
        actualTauriIPC: true,
        mode,
        fixture,
        error: error instanceof Error ? error.message : String(error),
        errors,
      },
      null,
      2,
    ) + "\n",
  );
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

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const output = path.resolve(process.argv[2]);
await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP("http://127.0.0.1:9228");
const page = browser
  .contexts()[0]
  .pages()
  .find((item) => item.url().includes("tauri"));
assert.ok(page);
page.setDefaultTimeout(30_000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.reload();
  await page.waitForFunction(() => window.__TAURI__?.core?.invoke);
  const catalog = await page.evaluate(() =>
    window.__TAURI__.core.invoke("media_get_model_catalog", {
      configuredProviderIds: [],
      includeRuntimeReadiness: false,
    }),
  );
  const model = catalog.models.find(
    (entry) =>
      entry.architecture === "stable-diffusion-3" &&
      entry.installationStatus === "installed",
  );
  assert.ok(model);
  await page.getByRole("button", { name: "Media Studio", exact: true }).click();
  await page.getByRole("button", { name: "Basic", exact: true }).click();
  await page.locator("#media-quick-model").click();
  await page.locator("[cmdk-input]").fill(model.displayName);
  await page.locator(`[cmdk-item][data-value="${model.id}"]`).click();
  const more = page.getByRole("button", { name: /^More options/ });
  if ((await more.getAttribute("aria-expanded")) === "false")
    await more.click();
  const reset = page.getByRole("button", { name: "Reset custom sampling" });
  if (await reset.count()) await reset.click();
  await page.getByLabel("Sampler", { exact: true }).selectOption("flow-heun");
  await page.getByLabel("Sampling steps", { exact: true }).fill("50");
  await page.getByLabel("Guidance", { exact: true }).fill("5");
  await page.screenshot({
    path: path.join(output, "basic.png"),
    fullPage: true,
  });
  const previous = await page.evaluate(() =>
    window.__TAURI__.core.invoke("media_list_flows"),
  );
  await page
    .getByRole("button", { name: "Convert to Advanced", exact: true })
    .click();
  await page.locator('.react-flow__node[data-id="generate"]').click();
  await page.getByRole("tab", { name: "Creative", exact: true }).click();
  for (const [label, expected] of [
    ["Sampler", "flow-heun"],
    ["Sampling steps", "50"],
    ["Guidance", "5"],
  ]) {
    assert.equal(
      await page.getByLabel(label, { exact: true }).inputValue(),
      expected,
    );
  }
  await page
    .getByRole("button", { name: "Save first revision", exact: true })
    .click();
  await page.waitForFunction(
    async (ids) =>
      (await window.__TAURI__.core.invoke("media_list_flows")).some(
        (flow) => !ids.includes(flow.flowId),
      ),
    previous.map((flow) => flow.flowId),
  );
  const saved = await page.evaluate(
    async (ids) => {
      const flows = await window.__TAURI__.core.invoke("media_list_flows");
      return window.__TAURI__.core.invoke("media_get_flow", {
        flowId: flows.find((flow) => !ids.includes(flow.flowId)).flowId,
      });
    },
    previous.map((flow) => flow.flowId),
  );
  const task = saved.revisions[0].flow.nodes.find(
    (node) => node.type === "task.generate-image",
  );
  assert.equal(task.config.modelId, model.id);
  assert.equal(task.config.sampler, "flow-heun");
  assert.equal(task.config.numInferenceSteps, 50);
  assert.equal(task.config.guidanceScale, 5);
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, "saved-flow.json"),
    JSON.stringify(saved, null, 2) + "\n",
  );
  await page.screenshot({
    path: path.join(output, "advanced.png"),
    fullPage: true,
  });
  const result = {
    passed: true,
    actualTauriIPC: true,
    modelId: model.id,
    sampling: {
      sampler: task.config.sampler,
      steps: task.config.numInferenceSteps,
      guidance: task.config.guidanceScale,
    },
    errors,
  };
  await writeFile(
    path.join(output, "playwright-results.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} catch (error) {
  await page.screenshot({
    path: path.join(output, "failure.png"),
    fullPage: true,
  });
  await writeFile(
    path.join(output, "playwright-results.json"),
    JSON.stringify({ passed: false, error: String(error), errors }, null, 2) +
      "\n",
  );
  throw error;
} finally {
  await browser.close();
}

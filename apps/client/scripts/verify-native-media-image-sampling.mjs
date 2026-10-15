import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const endpoint = process.argv[2];
const output = path.resolve(process.argv[3]);
const expectedModels = Number(process.argv[4]);
assert.ok(
  Number.isInteger(expectedModels) && expectedModels > 0,
  "Pass the expected installed model count",
);
await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP(endpoint);
let page;
const pageDeadline = Date.now() + 30_000;
while (Date.now() < pageDeadline) {
  page = browser
    .contexts()[0]
    ?.pages()
    .find((candidate) => candidate.url().includes("tauri"));
  if (page) break;
  await new Promise((resolve) => setTimeout(resolve, 200));
}
assert.ok(page, "The isolated Tauri window is missing");
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(30_000);
try {
  await page.reload();
  await page.waitForFunction(() => window.__TAURI__?.core?.invoke);
  const catalog = await page.evaluate(() =>
    window.__TAURI__.core.invoke("media_get_model_catalog", {
      configuredProviderIds: [],
      includeRuntimeReadiness: false,
    }),
  );
  await writeFile(
    path.join(output, "native-catalog.json"),
    JSON.stringify(catalog, null, 2) + "\n",
  );
  await page.getByRole("button", { name: "Media Studio", exact: true }).click();
  await page.getByRole("button", { name: "Basic", exact: true }).click();
  const installed = catalog.models.filter(
    (model) =>
      model.installationStatus === "installed" &&
      model.target === "local" &&
      model.capabilities.includes("text-to-image"),
  );
  assert.equal(installed.length, expectedModels);
  const checks = [];
  for (const model of installed) {
    await page.locator("#media-quick-model").click();
    await page.locator("[cmdk-input]").fill(model.displayName);
    await page.locator(`[cmdk-item][data-value="${model.id}"]`).click();
    const more = page.getByRole("button", {
      name: /^More options/,
    });
    if ((await more.getAttribute("aria-expanded")) === "false")
      await more.click();
    const reset = page.getByRole("button", { name: "Reset custom sampling" });
    if (await reset.count()) await reset.click();
    const steps = Number(
      await page
        .getByLabel("Sampling steps", { exact: true })
        .getAttribute("placeholder"),
    );
    const samplers = await page
      .getByLabel("Sampler", { exact: true })
      .locator("option")
      .allTextContents();
    if (model.architecture === "krea-2") {
      assert.equal(steps, 12);
      const guidance = page.getByLabel("Guidance", { exact: true });
      assert.equal(await guidance.isEnabled(), true);
      await guidance.fill("2");
      await page
        .getByRole("img", { name: /Guidance outside suggested range/ })
        .waitFor();
      await page
        .locator('[data-sampling-range="guidance"]')
        .evaluate((range) => range.scrollIntoView({ block: "center" }));
      await page.screenshot({
        path: path.join(output, "extended-krea-guidance-warning.png"),
        fullPage: true,
      });
      await guidance.fill("0.5");
      await page
        .getByRole("img", { name: /Guidance outside suggested range/ })
        .waitFor({ state: "detached" });
      await page.screenshot({
        path: path.join(output, "extended-krea.png"),
        fullPage: true,
      });
    }
    if (model.architecture === "qwen-image-2.1")
      assert.equal(
        await page.getByLabel("Guidance", { exact: true }).isEnabled(),
        true,
      );
    if (model.architecture === "stable-diffusion-3") {
      const guidanceRange = page.locator('[data-sampling-range="guidance"]');
      assert.equal(
        await guidanceRange.locator("span[title]").getAttribute("title"),
        "Suggested guidance: 3.5–7",
      );
      assert.equal(
        await guidanceRange
          .locator("span.absolute")
          .evaluate((marker) => marker.style.left),
        "22.5%",
      );
      const guidance = page.getByLabel("Guidance", { exact: true });
      await guidance.fill("3");
      await page
        .getByRole("img", { name: /Guidance outside suggested range/ })
        .waitFor();
      await guidance.fill("4.5");
      await page
        .getByRole("img", { name: /Guidance outside suggested range/ })
        .waitFor({ state: "detached" });
      assert.ok(samplers.includes("Flow Heun"));
      await page
        .getByLabel("Sampler", { exact: true })
        .selectOption("flow-heun");
      assert.equal(
        await page.getByLabel("Sampler", { exact: true }).inputValue(),
        "flow-heun",
      );
    }
    if (model.architecture === "stable-diffusion-3.5-large-turbo") {
      assert.equal(steps, 4);
      assert.equal(
        await page.getByLabel("Sampling steps", { exact: true }).isDisabled(),
        true,
      );
      assert.equal(
        await page.getByLabel("Guidance", { exact: true }).count(),
        0,
      );
      assert.ok(!samplers.includes("Flow Heun"));
    }
    if (
      ["stable-diffusion-1", "stable-diffusion-xl", "pony"].includes(
        model.architecture,
      )
    )
      assert.ok(samplers.includes("DEIS"));
    checks.push({
      id: model.id,
      architecture: model.architecture,
      steps,
      samplers,
    });
  }
  const extended = installed.find((model) => model.architecture === "krea-2");
  await page.locator("#media-quick-model").click();
  await page.locator("[cmdk-input]").fill(extended.displayName);
  await page.locator(`[cmdk-item][data-value="${extended.id}"]`).click();
  await page.getByLabel("Sampler", { exact: true }).selectOption("flow-euler");
  await page.getByLabel("Guidance", { exact: true }).fill("0.5");
  const previousFlows = await page.evaluate(() =>
    window.__TAURI__.core.invoke("media_list_flows"),
  );
  await page
    .getByRole("button", { name: "Convert to Advanced", exact: true })
    .click();
  await page.locator('.react-flow__node[data-id="generate"]').click();
  await page.getByRole("tab", { name: "Creative", exact: true }).click();
  assert.equal(
    await page.getByLabel("Guidance", { exact: true }).inputValue(),
    "0.5",
  );
  assert.equal(
    await page.getByLabel("Sampler", { exact: true }).inputValue(),
    "flow-euler",
  );
  await page
    .getByRole("button", { name: "Save first revision", exact: true })
    .click();
  await page.waitForFunction(
    async (previousIds) => {
      const flows = await window.__TAURI__.core.invoke("media_list_flows");
      return flows.some((flow) => !previousIds.includes(flow.flowId));
    },
    previousFlows.map((flow) => flow.flowId),
  );
  const history = await page.evaluate(
    async (previousIds) => {
      const flows = await window.__TAURI__.core.invoke("media_list_flows");
      const created = flows.find((flow) => !previousIds.includes(flow.flowId));
      return window.__TAURI__.core.invoke("media_get_flow", {
        flowId: created.flowId,
      });
    },
    previousFlows.map((flow) => flow.flowId),
  );
  await writeFile(
    path.join(output, "saved-flow.json"),
    JSON.stringify(history, null, 2) + "\n",
  );
  const task = history.revisions[0].flow.nodes.find(
    (node) => node.type === "task.generate-image",
  );
  assert.equal(task.config.sampler, "flow-euler");
  assert.equal(task.config.guidanceScale, 0.5);
  await page.screenshot({
    path: path.join(output, "extended-krea-advanced.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, "playwright-results.json"),
    JSON.stringify(
      {
        actualTauriIPC: true,
        fixtureCatalog: false,
        installedModels: installed.length,
        extendedKreaGuidancePreserved: true,
        checks,
        errors,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ installedModels: installed.length, errors }));
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

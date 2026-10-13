import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const output = path.resolve(
  process.argv[2] ?? "docs/validation/image-engines/ui",
);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--allow-file-access-from-files"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(
    pathToFileURL(
      path.resolve("apps/client/dist/image-sampling-verification/index.html"),
    ).href,
    { waitUntil: "networkidle" },
  );
  await page.getByRole("button", { name: "More options" }).click();
  const sampler = page.getByLabel("Sampler", { exact: true });
  await sampler.waitFor();
  assert.equal(await sampler.locator("option").count(), 10);
  await sampler
    .getByRole("option", { name: "DEIS", exact: true })
    .waitFor({ state: "attached" });
  await sampler.selectOption("dpmpp-2m-karras");
  await page.getByLabel("Sampling steps", { exact: true }).fill("10");
  await page.getByLabel("Guidance", { exact: true }).fill("11");
  await page
    .getByRole("img", { name: /Sampling steps outside suggested range/ })
    .waitFor();
  await page
    .getByRole("img", { name: /Guidance outside suggested range/ })
    .waitFor();
  await page.locator('[data-sampling-range="steps"]').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(output, "basic-warnings.png"),
    fullPage: true,
  });
  await page.getByLabel("Sampling steps", { exact: true }).fill("32");
  await page.getByLabel("Guidance", { exact: true }).fill("5");
  await page
    .getByRole("img", { name: /outside suggested range/ })
    .first()
    .waitFor({ state: "detached" });
  await page.screenshot({
    path: path.join(output, "basic-sampling.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Convert to Advanced" }).click();
  await page.waitForFunction(
    () =>
      JSON.parse(
        localStorage.getItem("machdoch.desktop.media-studio-state") ?? "{}",
      ).activeSection === "flow",
  );
  const state = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("machdoch.desktop.media-studio-state")),
  );
  const task = state.flow.nodes.find(
    (node) => node.type === "task.generate-image",
  );
  assert.equal(task.config.sampler, "dpmpp-2m-karras");
  await page.locator(`.react-flow__node[data-id="${task.id}"]`).click();
  await page.getByRole("tab", { name: "Creative", exact: true }).click();
  await page.getByLabel("Sampler", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Sampler", { exact: true }).inputValue(),
    "dpmpp-2m-karras",
  );
  await page.getByLabel("Sampling steps", { exact: true }).fill("10");
  await page
    .getByRole("img", { name: /Sampling steps outside suggested range/ })
    .waitFor();
  await page.screenshot({
    path: path.join(output, "advanced-sampling.png"),
    fullPage: true,
  });
  await page.getByRole("tab", { name: "Basic", exact: true }).click();
  await page.getByRole("combobox").filter({ hasText: "SDXL" }).click();
  await page.locator("[cmdk-input]").fill("Qwen-Image 2.1 Turbo");
  await page
    .locator("[cmdk-item]")
    .filter({ hasText: "Qwen-Image 2.1 Turbo" })
    .click();
  await page.getByRole("tab", { name: "Creative", exact: true }).click();
  assert.equal(
    await page.getByLabel("Sampler", { exact: true }).inputValue(),
    "",
  );
  assert.equal(
    await page.getByLabel("Sampler", { exact: true }).locator("option").count(),
    2,
  );
  assert.equal(
    await page.getByLabel("Sampling steps", { exact: true }).inputValue(),
    "8",
  );
  assert.equal(
    await page
      .getByRole("img", { name: /Sampling steps outside suggested range/ })
      .count(),
    0,
  );
  await page.getByRole("tab", { name: "Basic", exact: true }).click();
  await page
    .getByRole("combobox")
    .filter({ hasText: "Qwen-Image 2.1 Turbo" })
    .click();
  await page.locator("[cmdk-input]").fill("Qwen-Image 2.1");
  await page.locator('[cmdk-item][data-value="test:qwen-2.1"]').click();
  await page.getByRole("tab", { name: "Creative", exact: true }).click();
  assert.equal(
    await page.getByLabel("Guidance", { exact: true }).isDisabled(),
    false,
  );
  await page.getByLabel("Guidance", { exact: true }).fill("4");
  await page
    .getByRole("img", { name: /Guidance outside suggested range/ })
    .waitFor();
  await page.getByRole("button", { name: "Basic", exact: true }).click();
  const engineDefaults = [];
  const engineFixtures = await page.evaluate(
    () => window.imageSamplingEngineFixtures,
  );
  assert.equal(engineFixtures.length, 31);
  for (const {
    id,
    name,
    architecture,
    steps,
    samplerChoices,
  } of engineFixtures) {
    await page.locator("#media-quick-model").click();
    await page.locator("[cmdk-input]").fill(name);
    await page.locator(`[cmdk-item][data-value="${id}"]`).click();
    const more = page.getByRole("button", { name: "More options" });
    if ((await more.getAttribute("aria-expanded")) === "false")
      await more.click();
    const reset = page.getByRole("button", { name: "Reset custom sampling" });
    if (await reset.count()) await reset.click();
    const defaultSteps = Number(
      await page
        .getByLabel("Sampling steps", { exact: true })
        .getAttribute("placeholder"),
    );
    assert.ok(
      defaultSteps >= steps[0] && defaultSteps <= steps[1],
      architecture,
    );
    assert.equal(
      await page
        .getByLabel("Sampler", { exact: true })
        .locator("option")
        .count(),
      samplerChoices,
    );
    assert.equal(
      await page
        .getByRole("img", { name: /Sampling steps outside suggested range/ })
        .count(),
      0,
    );
    if (["qwen-image-2.1", "krea-2"].includes(architecture))
      assert.equal(
        await page.getByLabel("Guidance", { exact: true }).isEnabled(),
        true,
      );
    if (architecture === "krea-2") {
      assert.equal(defaultSteps, 12);
      const guidance = page.getByLabel("Guidance", { exact: true });
      assert.equal(await guidance.getAttribute("placeholder"), "Automatic");
      assert.match(
        await page
          .locator('[data-sampling-range="guidance"] span.absolute')
          .getAttribute("style"),
        /left: 2\.5%/u,
      );
      await guidance.fill("2");
      await page
        .getByRole("img", { name: /Guidance outside suggested range/ })
        .waitFor();
      await guidance.fill("0.5");
      await page
        .getByRole("img", { name: /Guidance outside suggested range/ })
        .waitFor({ state: "detached" });
      await page.getByRole("button", { name: "Reset custom sampling" }).click();
    }
    engineDefaults.push({
      name,
      architecture,
      steps: defaultSteps,
      samplerChoices,
    });
  }
  await page.screenshot({
    path: path.join(output, "engine-sampling.png"),
    fullPage: true,
  });
  const incompatibleSavedState = await page.evaluate(() => {
    const key = "machdoch.desktop.media-studio-state";
    const saved = JSON.parse(localStorage.getItem(key));
    saved.activeSection = "generate";
    saved.recipe.modelId = "test:sdxl";
    saved.recipe.sampling = {
      numInferenceSteps: 32,
      guidanceScale: 5,
      sampler: "flow-euler",
    };
    return saved;
  });
  await page.addInitScript((saved) => {
    localStorage.setItem(
      "machdoch.desktop.media-studio-state",
      JSON.stringify(saved),
    );
  }, incompatibleSavedState);
  await page.reload({ waitUntil: "networkidle" });
  await page
    .getByText("Choose a compatible sampler for this model.", { exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Generate image", exact: true })
      .isDisabled(),
    true,
  );
  const recoveredOptions = page.getByRole("button", { name: "More options" });
  if ((await recoveredOptions.getAttribute("aria-expanded")) === "false")
    await recoveredOptions.click();
  await page.getByLabel("Sampler", { exact: true }).selectOption("euler");
  await page
    .getByText("Choose a compatible sampler for this model.", { exact: true })
    .waitFor({ state: "detached" });
  assert.equal(
    await page
      .getByRole("button", { name: "Generate image", exact: true })
      .isEnabled(),
    true,
  );
  assert.deepEqual(errors, []);
  const result = {
    basicSamplerChoices: 10,
    warnings: ["steps", "guidance"],
    warningsCleared: true,
    advancedSampler: task.config.sampler,
    incompatibleSamplerCleared: true,
    incompatibleSavedSamplerBlocked: true,
    incompatibleSavedSamplerRecovered: true,
    engineDefaults,
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
    path.join(output, "failure-dom.txt"),
    await page.locator("body").innerText(),
  );
  throw error;
} finally {
  await browser.close();
}

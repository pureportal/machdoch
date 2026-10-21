import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const output = path.resolve("docs/validation/upscalers/ui-review");
const fixtures = path.resolve("docs/validation/upscalers");
await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP("http://127.0.0.1:9237");
const page = browser.contexts()[0].pages()[0];
await page.reload();
const pageErrors = [];
const checks = [];
const runs = [];
let completed = false;
let device = null;
page.on("pageerror", (error) => pageErrors.push(error.message));
const shot = (name) =>
  page.screenshot({ path: path.join(output, `${name}.png`) });
const check = (name) => {
  checks.push(name);
  console.log(`Passed: ${name}`);
};
const invoke = (command, args) =>
  page.evaluate(
    ({ command, args }) => window.__TAURI__.core.invoke(command, args),
    { command, args },
  );
await page
  .getByRole("button", { name: "Upscale", exact: true })
  .first()
  .click({ timeout: 120000 });
await page.getByRole("heading", { name: "Upscale", exact: true }).waitFor();
await page.setViewportSize({ width: 1440, height: 960 });
await page.evaluate(() => {
  const original = window.fetch.bind(window);
  window.uiReview = { calls: [], openPath: null, savePath: null };
  window.fetch = async (input, options) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "ipc.localhost") {
      const command = decodeURIComponent(url.pathname.slice(1));
      const args =
        typeof options?.body === "string" ? JSON.parse(options.body) : null;
      const dialogPath =
        command === "plugin:dialog|open"
          ? window.uiReview.openPath
          : command === "plugin:dialog|save"
            ? window.uiReview.savePath
            : null;
      if (dialogPath)
        return new Response(JSON.stringify(dialogPath), {
          headers: {
            "Content-Type": "application/json",
            "Tauri-Response": "ok",
          },
        });
      if (command === "media_execute_workflow")
        window.uiReview.calls.push(args.request);
    }
    return original(input, options);
  };
});
const workspace = page.getByRole("region", {
  name: "Upscale workspace",
  exact: true,
});
const settings = page.getByRole("region", {
  name: "Upscale settings",
  exact: true,
});
const source = () =>
  workspace.locator("article").filter({
    has: page.getByRole("heading", { name: "Source", exact: true }),
  });
const result = () =>
  workspace.locator("article").filter({
    has: page.getByRole("heading", { name: "Result", exact: true }),
  });
const model = async (name) => {
  await settings.getByRole("combobox", { name: "Model", exact: true }).click();
  await page.getByRole("option", { name, exact: true }).click();
};
const importMedia = async (name) => {
  await page.evaluate(
    (value) => {
      window.uiReview.openPath = value;
    },
    path.join(fixtures, name),
  );
  await settings
    .getByRole("button", { name: "Import media", exact: true })
    .click();
  await source().waitFor();
  await page.waitForFunction(
    () => !document.querySelector("#upscale-media-picker"),
  );
};
const waitForRun = async (id, statuses) => {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const detail = await page.evaluate(async (runId) => {
      try {
        return await window.__TAURI__.core.invoke("media_get_run_detail", {
          runId,
        });
      } catch (error) {
        if (error?.code === "RESOURCE_NOT_FOUND") return null;
        throw new Error(JSON.stringify(error));
      }
    }, id);
    if (detail && statuses.includes(detail.status)) return detail;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Run ${id} did not reach ${statuses.join(", ")}`);
};
const submit = async () => {
  const count = await page.evaluate(() => window.uiReview.calls.length);
  await settings.getByRole("button", { name: "Upscale", exact: true }).click();
  await page.waitForFunction(
    (count) => window.uiReview.calls.length > count,
    count,
    { timeout: 45000 },
  );
  return page.evaluate(() => window.uiReview.calls.at(-1));
};
const run = async (label, width, height) => {
  const request = await submit();
  console.log(`Running ${label}: ${request.runId}`);
  const detail = await waitForRun(request.runId, [
    "completed",
    "failed",
    "canceled",
  ]);
  assert.equal(
    detail.status,
    "completed",
    JSON.stringify(detail.failure ?? detail.error),
  );
  await result().waitFor({ timeout: 10000 });
  assert.equal(await result().count(), 1);
  const asset = detail.assets.find(
    (asset) => asset.operation?.details.finalOutput === true,
  );
  assert.equal(asset.width, width);
  assert.equal(asset.height, height);
  await result()
    .locator(asset.kind === "video" ? "video" : "img")
    .waitFor();
  if (asset.kind === "image")
    await page.waitForFunction(() =>
      [...document.querySelectorAll("img")].every(
        (img) => img.complete && img.naturalWidth > 0,
      ),
    );
  await writeFile(
    path.join(output, `${label}-run.json`),
    JSON.stringify(detail, null, 2),
  );
  await shot(label);
  runs.push({
    label,
    runId: detail.id ?? request.runId,
    status: detail.status,
    width: asset.width,
    height: asset.height,
    kind: asset.kind,
  });
  check(label);
  return asset;
};
try {
  const runtime = await invoke("media_initialize_runtime");
  assert.equal(
    runtime.localDiffusers.ready,
    true,
    runtime.localDiffusers.diagnostic,
  );
  device = runtime.localDiffusers.deviceLabel;
  await workspace
    .getByRole("heading", { name: "Choose media", exact: true })
    .waitFor();
  const geometry = await Promise.all([
    settings.boundingBox(),
    workspace.boundingBox(),
  ]);
  assert.ok(geometry[1].x >= geometry[0].x + geometry[0].width - 1);
  await workspace
    .getByRole("searchbox", { name: "Search media", exact: true })
    .fill("no-such-media-for-ui-review");
  await workspace.getByText("No matching media", { exact: true }).waitFor();
  await workspace
    .getByRole("searchbox", { name: "Search media", exact: true })
    .fill("");
  await workspace.locator("img,video").first().waitFor();
  await shot("after-library");
  check("library occupies main workspace and shared search filters assets");
  await model("SwinIR · 17 MB");
  await settings.getByRole("combobox", { name: "Model", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Search model", exact: true })
    .fill("SwinIR");
  await page.waitForFunction(
    () => document.querySelectorAll("[cmdk-item]:not([hidden])").length === 1,
  );
  await page
    .getByRole("combobox", { name: "Search model", exact: true })
    .press("Enter");
  assert.match(
    await settings
      .getByRole("combobox", { name: "Model", exact: true })
      .innerText(),
    /SwinIR/,
  );
  await model("SPAN · 9 MB");
  check("shared model picker supports searching and keyboard selection");
  await importMedia("source.png");
  await settings.getByRole("button", { name: "4×", exact: true }).click();
  assert.equal(
    await settings
      .getByRole("button", { name: "4×", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await settings.getByText("Output · 388 × 580", { exact: true }).waitFor();
  await settings.getByText("Advanced settings", { exact: true }).click();
  await settings.getByLabel("Tile size", { exact: true }).fill("0");
  assert.equal(
    await settings
      .getByLabel("Tile size", { exact: true })
      .getAttribute("aria-invalid"),
    "true",
  );
  assert.equal(
    await settings
      .getByRole("button", { name: "Upscale", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await settings
      .getByRole("button", { name: "Open in Advanced", exact: true })
      .isDisabled(),
    true,
  );
  await shot("after-invalid-tile");
  await settings.getByLabel("Tile size", { exact: true }).fill("64");
  check(
    "scale selection updates output size and invalid tiles block both actions",
  );
  const image = await run("after-span-image-4x", 388, 580);
  const sourceBox = await source().boundingBox();
  const resultBox = await result().boundingBox();
  assert.ok(
    Math.abs(sourceBox.y - resultBox.y) < 2 && resultBox.x > sourceBox.x,
  );
  check("source and result align side by side on wide layouts");
  for (const width of [1280, 1000, 800]) {
    await page.setViewportSize({ width, height: 740 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.equal(
      await settings.evaluate(
        (element) => element.scrollWidth > element.clientWidth + 1,
      ),
      false,
    );
    assert.equal(
      await workspace.evaluate(
        (element) => element.scrollWidth > element.clientWidth + 1,
      ),
      false,
    );
    await shot(`after-width-${width}`);
  }
  check("1280, 1000 and 800 pixel layouts have no horizontal overflow");
  await page.setViewportSize({ width: 1440, height: 960 });
  const exported = path.join(output, "exported-image.png");
  await page.evaluate((value) => {
    window.uiReview.savePath = value;
  }, exported);
  await result()
    .getByRole("button", { name: "Save image", exact: true })
    .click();
  await result().getByRole("button", { name: "Saved", exact: true }).waitFor();
  assert.ok((await readFile(exported)).length > 0);
  check("shared save action exports the real image");
  await result()
    .getByRole("heading", { name: "Result", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Upscale", exact: true }).click();
  await source()
    .getByText(`${image.width} × ${image.height}`, { exact: true })
    .waitFor();
  assert.equal(await result().count(), 0);
  check("result context action selects new source and clears previous result");
  await settings
    .getByRole("button", { name: "Change media", exact: true })
    .click();
  assert.equal(
    await settings
      .getByRole("button", { name: "Close selection", exact: true })
      .getAttribute("aria-expanded"),
    "true",
  );
  await workspace
    .getByRole("searchbox", { name: "Search media", exact: true })
    .waitFor();
  await settings
    .getByRole("button", { name: "Close selection", exact: true })
    .click();
  await source().waitFor();
  check("change media can open and close the main picker");
  await importMedia("source.webm");
  await model("Real-ESRGAN · 67 MB");
  await settings.getByRole("button", { name: "2×", exact: true }).click();
  await run("after-realesrgan-video-2x", 192, 128);
  await result()
    .locator("video")
    .evaluate(async (video) => {
      video.muted = true;
      await video.play();
    });
  await page.waitForFunction(
    () => [...document.querySelectorAll("video")].at(-1)?.currentTime > 0.25,
  );
  await result()
    .locator("video")
    .evaluate((video) => video.pause());
  check("source and output video previews support playback");
  await model("Custom model");
  await settings.getByLabel("Model file", { exact: true }).fill("");
  assert.equal(
    await settings
      .getByRole("button", { name: "Upscale", exact: true })
      .isDisabled(),
    true,
  );
  await settings
    .getByLabel("Model file", { exact: true })
    .fill("C:/missing-ui-review-upscaler.pth");
  await submit();
  await settings
    .getByText(
      "The model file is missing. Choose another model or browse to its file.",
      { exact: true },
    )
    .waitFor();
  await shot("after-missing-model");
  check("custom model validation and shared failure notification");
  await importMedia("source.png");
  await model("SwinIR · 17 MB");
  await run("after-swinir-image-2x", 194, 290);
  check("failed run recovers with a different source and model");
  await importMedia("cancel-source.webm");
  await model("SPAN · 9 MB");
  await settings.getByRole("button", { name: "4×", exact: true }).click();
  const cancelRequest = await submit();
  await waitForRun(cancelRequest.runId, ["running"]);
  assert.equal(
    await settings
      .getByRole("combobox", { name: "Model", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await settings
      .getByRole("button", { name: "Import media", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await settings
      .getByRole("button", { name: "4×", exact: true })
      .isDisabled(),
    true,
  );
  await workspace.getByRole("button", { name: "Cancel", exact: true }).click();
  const canceled = await waitForRun(cancelRequest.runId, ["canceled"]);
  await writeFile(
    path.join(output, "canceled-run.json"),
    JSON.stringify(canceled, null, 2),
  );
  await workspace.getByText("canceled", { exact: true }).waitFor();
  await shot("after-canceled");
  check("shared job component cancels real running work and locks settings");
  await settings
    .getByRole("button", { name: "Open in Advanced", exact: true })
    .click();
  await page.getByText("Upscale video", { exact: true }).first().waitFor();
  await shot("after-advanced");
  check("advanced flow opens with the selected upscale configuration");
  await page
    .getByRole("button", { name: "Upscale", exact: true })
    .first()
    .click();
  await workspace
    .getByRole("button", { name: "View activity", exact: true })
    .click();
  await page.getByLabel("Run inspector", { exact: true }).waitFor();
  await shot("after-activity");
  check("shared job activity action opens the run inspector");
  assert.deepEqual(pageErrors, []);
  check("no renderer exceptions");
  completed = true;
} finally {
  await writeFile(
    path.join(output, "playwright-results.json"),
    JSON.stringify(
      {
        completed,
        verifiedAt: new Date().toISOString(),
        device,
        checks,
        runs,
        pageErrors,
        nativeSha256: createHash("sha256")
          .update(await readFile(".cache/upscale-native/machdoch.exe"))
          .digest("hex"),
      },
      null,
      2,
    ),
  );
  await browser.close();
}

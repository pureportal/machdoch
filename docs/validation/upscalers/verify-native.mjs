import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const directory = path.resolve("docs/validation/upscalers");
await mkdir(directory, { recursive: true });
const browser = await chromium.connectOverCDP("http://127.0.0.1:9237");
const context = browser.contexts()[0];
const page = context.pages()[0] ?? (await context.waitForEvent("page"));
await page.waitForURL(/tauri\.localhost/, { timeout: 30000 });
const errors = [];
const uploads = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  if (
    ["POST", "PUT", "PATCH"].includes(request.method()) &&
    /^https?:/.test(request.url()) &&
    !new URL(request.url()).hostname.endsWith(".localhost")
  )
    uploads.push({ method: request.method(), url: request.url() });
});
await page.evaluate(() => {
  const original = window.fetch.bind(window);
  window.upscaleValidation = { calls: [], openPath: null, savePath: null };
  window.fetch = async (input, options) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "ipc.localhost") {
      const command = decodeURIComponent(url.pathname.slice(1));
      const args =
        typeof options?.body === "string" ? JSON.parse(options.body) : null;
      if (command === "plugin:dialog|open" && window.upscaleValidation.openPath)
        return new Response(JSON.stringify(window.upscaleValidation.openPath), {
          headers: {
            "Content-Type": "application/json",
            "Tauri-Response": "ok",
          },
        });
      if (command === "plugin:dialog|save" && window.upscaleValidation.savePath)
        return new Response(JSON.stringify(window.upscaleValidation.savePath), {
          headers: {
            "Content-Type": "application/json",
            "Tauri-Response": "ok",
          },
        });
      if (command === "media_execute_workflow")
        window.upscaleValidation.calls.push(args.request);
    }
    return original(input, options);
  };
});
const invoke = (command, args) =>
  page.evaluate(
    ({ command, args }) => window.__TAURI__.core.invoke(command, args),
    { command, args },
  );
const shot = (name) =>
  page.screenshot({ path: path.join(directory, name), fullPage: true });
const selectModel = async (name) => {
  await page.getByRole("combobox", { name: "Model", exact: true }).click();
  await page.getByRole("option", { name, exact: true }).click();
};
if (await page.getByRole("button", { name: "Skip setup", exact: true }).count())
  await page.getByRole("button", { name: "Skip setup", exact: true }).click();
await page.getByRole("button", { name: "Media Studio", exact: true }).click();
await page
  .getByRole("button", { name: "Upscale", exact: true })
  .first()
  .click();
const runtime = await invoke("media_initialize_runtime");
await writeFile(
  path.join(directory, "native-runtime.json"),
  JSON.stringify(runtime, null, 2),
);
assert.equal(
  runtime.localDiffusers.ready,
  true,
  runtime.localDiffusers.diagnostic,
);
await shot("ui-empty.png");
const importMedia = async (name) => {
  await page.evaluate(
    (value) => {
      window.upscaleValidation.openPath = value;
    },
    path.join(directory, name),
  );
  await page.getByRole("button", { name: "Import media", exact: true }).click();
  await page
    .getByRole("heading", { name: "Source", exact: true })
    .waitFor({ timeout: 30000 });
  await page
    .getByRole("button", { name: "Change media", exact: true })
    .waitFor();
};
const results = [];
const waitForRun = async (id, statuses) => {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    try {
      const detail = await invoke("media_get_run_detail", { runId: id });
      if (statuses.includes(detail.status)) return detail;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Run ${id} did not reach ${statuses.join(", ")}`);
};
const run = async (label) => {
  const before = await page.evaluate(
    () => window.upscaleValidation.calls.length,
  );
  await page
    .getByRole("button", { name: "Upscale", exact: true })
    .last()
    .click();
  await page.waitForFunction(
    (before) => window.upscaleValidation.calls.length > before,
    before,
    { timeout: 30000 },
  );
  const request = await page.evaluate(() =>
    window.upscaleValidation.calls.at(-1),
  );
  console.log(
    JSON.stringify({ label, runId: request.runId, state: "submitted" }),
  );
  const detail = await waitForRun(request.runId, [
    "completed",
    "failed",
    "canceled",
  ]);
  await writeFile(
    path.join(directory, `${label}-run.json`),
    JSON.stringify(detail, null, 2),
  );
  assert.equal(
    detail.status,
    "completed",
    JSON.stringify(detail.failure ?? detail.error),
  );
  await page
    .getByRole("heading", { name: "Result", exact: true })
    .waitFor({ timeout: 10000 });
  assert.equal(
    await page.getByRole("heading", { name: "Result", exact: true }).count(),
    1,
  );
  const asset = detail.assets.find(
    (asset) =>
      asset.operation?.kind === "workflow" &&
      asset.operation.details.finalOutput === true,
  );
  assert.ok(asset);
  results.push({ label, runId: request.runId, asset });
  const preview = page
    .getByRole("heading", { name: "Result", exact: true })
    .locator("../..");
  await preview.locator(asset.kind === "video" ? "video" : "img").waitFor();
  await preview.locator(asset.kind === "video" ? "video" : "img").evaluate(
    (element) =>
      new Promise((resolve, reject) => {
        if (
          element.tagName === "IMG"
            ? element.complete && element.naturalWidth > 0
            : element.readyState >= 2
        )
          resolve();
        else {
          element.addEventListener(
            element.tagName === "IMG" ? "load" : "loadeddata",
            resolve,
            { once: true },
          );
          element.addEventListener("error", reject, { once: true });
        }
      }),
  );
  await shot(`${label}.png`);
  console.log(
    JSON.stringify({
      label,
      state: detail.status,
      width: asset.width,
      height: asset.height,
    }),
  );
  return asset;
};

await importMedia("source.png");
assert.equal(
  await page.getByRole("searchbox", { name: "Search media" }).count(),
  0,
);
await page.getByText("Advanced settings", { exact: true }).click();
await page.getByLabel("Tile size", { exact: true }).fill("0");
assert.equal(
  await page
    .getByRole("button", { name: "Upscale", exact: true })
    .last()
    .isDisabled(),
  true,
);
await shot("ui-invalid-tile.png");
await page.getByLabel("Tile size", { exact: true }).fill("64");
await page.getByRole("button", { name: "4×", exact: true }).click();
const imageAsset = await run("ui-image-span-4x");
assert.equal(imageAsset.width, 388);
assert.equal(imageAsset.height, 580);

const exportedImage = path.join(
  directory,
  `native-export-image-${imageAsset.runId}.png`,
);
await page.evaluate((value) => {
  window.upscaleValidation.savePath = value;
}, exportedImage);
await page.getByRole("button", { name: "Save image", exact: true }).click();
await page.getByRole("button", { name: "Saved", exact: true }).waitFor();
assert.ok((await readFile(exportedImage)).length > 0);

await page
  .getByRole("heading", { name: "Result", exact: true })
  .click({ button: "right" });
await page.getByRole("menuitem", { name: "Upscale", exact: true }).click();
await page
  .getByRole("heading", { name: "Source", exact: true })
  .locator("..")
  .getByText("388 × 580", { exact: true })
  .waitFor();
await shot("ui-result-context.png");

await importMedia("source.webm");
await page
  .getByRole("heading", { name: "Source", exact: true })
  .locator("..")
  .getByText("96 × 64", { exact: true })
  .waitFor();
await page.getByRole("button", { name: "2×", exact: true }).click();
await selectModel("Real-ESRGAN · 67 MB");
const videoAsset = await run("ui-video-realesrgan-2x");
assert.equal(videoAsset.kind, "video");
assert.equal(videoAsset.width, 192);
assert.equal(videoAsset.height, 128);
const exportedVideo = path.join(
  directory,
  `native-export-video-${videoAsset.runId}.webm`,
);
await page.evaluate((value) => {
  window.upscaleValidation.savePath = value;
}, exportedVideo);
await page.getByRole("button", { name: "Save video", exact: true }).click();
await page.getByRole("button", { name: "Saved", exact: true }).waitFor();
assert.ok((await readFile(exportedVideo)).length > 0);

const video = page.locator("video").last();
await video.evaluate(async (element) => {
  element.muted = true;
  await element.play();
});
await page.waitForFunction(
  () => [...document.querySelectorAll("video")].at(-1)?.currentTime > 0.25,
);
await video.evaluate((element) => element.pause());
await shot("ui-video-playback.png");

await page
  .getByRole("button", { name: "Open in Advanced", exact: true })
  .click();
await page.getByRole("button", { name: "Advanced", exact: true }).waitFor();
await page.getByText("Upscale video", { exact: true }).first().waitFor();
await shot("ui-advanced-video.png");
await page
  .getByRole("button", { name: "Upscale", exact: true })
  .first()
  .click();
await selectModel("Custom model");
await page
  .getByLabel("Model file", { exact: true })
  .fill("C:/missing-upscale-model.pth");
await page.getByRole("button", { name: "Upscale", exact: true }).last().click();
await page.getByRole("alert").last().waitFor({ timeout: 30000 });
await page
  .getByText(
    "The model file is missing. Choose another model or browse to its file.",
    { exact: true },
  )
  .waitFor();
await shot("ui-missing-model.png");
await selectModel("SPAN · 9 MB");
await importMedia("cancel-source.webm");
await page
  .getByRole("heading", { name: "Source", exact: true })
  .locator("..")
  .getByText("320 × 240", { exact: true })
  .waitFor();
await page.getByRole("button", { name: "4×", exact: true }).click();
await page.getByRole("button", { name: "Upscale", exact: true }).last().click();
await page
  .getByRole("button", { name: "Cancel", exact: true })
  .waitFor({ timeout: 30000 });
await page.waitForFunction(() => window.upscaleValidation.calls.length >= 4);
const cancelRequest = await page.evaluate(() =>
  window.upscaleValidation.calls.at(-1),
);
await waitForRun(cancelRequest.runId, ["running"]);
await page.getByRole("button", { name: "Cancel", exact: true }).click();
await page.getByText("canceled", { exact: true }).waitFor({ timeout: 30000 });
const canceled = await waitForRun(cancelRequest.runId, ["canceled"]);
await writeFile(
  path.join(directory, "ui-canceled-run.json"),
  JSON.stringify(canceled, null, 2),
);
await shot("ui-canceled.png");

await page.setViewportSize({ width: 1000, height: 740 });
assert.equal(
  await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
  false,
);
await shot("ui-compact.png");
await page.setViewportSize({ width: 1440, height: 960 });
assert.deepEqual(errors, []);
assert.deepEqual(uploads, []);
await writeFile(
  path.join(directory, "playwright-results.json"),
  JSON.stringify(
    {
      runtime: runtime.localDiffusers.deviceLabel,
      results,
      pageErrors: errors,
      uploads,
      checks: [
        "menu",
        "image and video imports",
        "tile validation",
        "4x image",
        "2x video",
        "single final result",
        "native exports",
        "result context action",
        "video playback",
        "advanced flow",
        "missing model recovery",
        "running job cancellation",
        "compact layout",
      ],
    },
    null,
    2,
  ),
);
await browser.close();
console.log("Native Playwright validation passed");

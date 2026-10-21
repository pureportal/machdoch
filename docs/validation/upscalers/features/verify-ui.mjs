import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const output = path.resolve("docs/validation/upscalers/features");
const browser = await chromium.connectOverCDP("http://127.0.0.1:9237");
const page = browser.contexts()[0].pages()[0];
const checks = [],
  runs = [],
  pageErrors = [];
let completed = false,
  device;
page.on("pageerror", (error) => pageErrors.push(error.message));
page.setDefaultTimeout(20000);
await page.reload();
const skipSetup = page.getByRole("button", {
  name: "Skip first-startup setup",
  exact: true,
});
await skipSetup
  .or(page.getByRole("button", { name: "Media Studio", exact: true }))
  .first()
  .waitFor({ timeout: 120000 });
if (await skipSetup.isVisible()) await skipSetup.click();
await page
  .getByRole("button", { name: "Media Studio", exact: true })
  .click({ timeout: 120000 });
await page
  .getByRole("button", { name: "Upscale", exact: true })
  .first()
  .click({ timeout: 120000 });
await page.setViewportSize({ width: 1440, height: 960 });
const settings = page.getByRole("region", {
  name: "Upscale settings",
  exact: true,
});
const workspace = page.getByRole("region", {
  name: "Upscale workspace",
  exact: true,
});
const action = settings.getByRole("button", { name: "Upscale", exact: true });
const advanced = settings.getByRole("button", {
  name: "Open in Advanced",
  exact: true,
});
const check = (name) => {
  checks.push(name);
  console.log(`Passed: ${name}`);
};
const shot = (name) =>
  page.screenshot({ path: path.join(output, `${name}.png`) });
const invoke = async (command, args) => {
  const response = await page.evaluate(
    async ({ command, args }) => {
      try {
        return {
          ok: true,
          value: await window.__TAURI__.core.invoke(command, args),
        };
      } catch (error) {
        return { ok: false, error };
      }
    },
    { command, args },
  );
  if (!response.ok)
    throw Object.assign(
      new Error(JSON.stringify(response.error)),
      response.error,
    );
  return response.value;
};
await page.evaluate(() => {
  const original = window.fetch.bind(window);
  window.upscaleFeatures = { calls: [], openPath: null };
  window.fetch = async (input, options) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "ipc.localhost") {
      const command = decodeURIComponent(url.pathname.slice(1));
      if (command === "plugin:dialog|open" && window.upscaleFeatures.openPath)
        return new Response(JSON.stringify(window.upscaleFeatures.openPath), {
          headers: {
            "Content-Type": "application/json",
            "Tauri-Response": "ok",
          },
        });
      if (command === "media_execute_workflow")
        window.upscaleFeatures.calls.push(JSON.parse(options.body).request);
    }
    return original(input, options);
  };
});
const select = async (label, name) => {
  await settings.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name, exact: true }).click();
};
const importMedia = async (file) => {
  await page.evaluate((file) => {
    window.upscaleFeatures.openPath = file;
  }, file);
  await settings
    .getByRole("button", { name: "Import media", exact: true })
    .click();
  await workspace
    .getByRole("heading", { name: "Source", exact: true })
    .waitFor();
  await page.waitForFunction(
    () => !document.querySelector("#upscale-media-picker"),
  );
};
const run = async (name, width, height, button = action, showResult = true) => {
  const count = await page.evaluate(() => window.upscaleFeatures.calls.length);
  await button.click();
  await page.waitForFunction(
    (count) => window.upscaleFeatures.calls.length > count,
    count,
    { timeout: 60000 },
  );
  const request = await page.evaluate(() =>
    window.upscaleFeatures.calls.at(-1),
  );
  console.log(`Running: ${name} (${request.runId})`);
  const deadline = Date.now() + 600000;
  let detail;
  while (Date.now() < deadline) {
    detail = await invoke("media_get_run_detail", {
      runId: request.runId,
    }).catch((error) => {
      if (error?.code === "RESOURCE_NOT_FOUND") return null;
      throw error;
    });
    if (detail && ["completed", "failed", "canceled"].includes(detail.status))
      break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await writeFile(
    path.join(output, `${name}-run.json`),
    JSON.stringify(detail, null, 2),
  );
  assert.equal(
    detail?.status,
    "completed",
    JSON.stringify(detail?.failure ?? detail?.error),
  );
  const asset = detail.assets.find(
    (asset) => asset.operation?.details.finalOutput === true,
  );
  assert.equal(asset.width, width);
  assert.equal(asset.height, height);
  const exportPath = path.join(
    output,
    `${name}-output.${asset.kind === "video" ? "webm" : "png"}`,
  );
  const exported = await invoke("media_export_asset", {
    request: {
      assetId: asset.id,
      destinationPath: exportPath,
      mode: "verified-original",
    },
  });
  assert.equal(exported.digest, asset.digest);
  assert.equal(
    createHash("sha256")
      .update(await readFile(exportPath))
      .digest("hex"),
    asset.digest,
  );
  if (showResult) {
    const result = workspace
      .locator("article")
      .filter({
        has: page.getByRole("heading", { name: "Result", exact: true }),
      });
    await result.locator(asset.kind === "video" ? "video" : "img").waitFor();
    await page.waitForFunction(() =>
      [...document.querySelectorAll("img")].every(
        (img) => img.complete && img.naturalWidth > 0,
      ),
    );
  }
  await shot(name);
  runs.push({
    name,
    runId: request.runId,
    width,
    height,
    kind: asset.kind,
    assetId: asset.id,
    details: detail.assets.find(
      (item) => item.operation?.sourceNodeId === "upscale",
    )?.operation.details,
    exportPath,
    digest: asset.digest,
  });
  check(name);
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
  await importMedia(path.join(output, "source.png"));
  await settings.getByText("Advanced settings", { exact: true }).click();
  await select("Tiles", "Manual");
  await settings.getByLabel("Tile size (px)", { exact: true }).fill("");
  assert.equal(await action.isDisabled(), true);
  assert.equal(await advanced.isDisabled(), true);
  await select("Tiles", "Automatic");
  assert.equal(await action.isEnabled(), true);
  check(
    "empty manual tiles block actions; Automatic recovers without stale errors",
  );

  await settings.getByRole("button", { name: "4×", exact: true }).click();
  assert.equal(
    await settings
      .getByRole("button", { name: "4×", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  const slider = settings.getByRole("slider", {
    name: "Scale factor",
    exact: true,
  });
  await slider.focus();
  await slider.press("ArrowLeft");
  assert.equal(
    await settings.getByLabel("Custom scale", { exact: true }).inputValue(),
    "3.95",
  );
  await settings.getByLabel("Custom scale", { exact: true }).fill("");
  assert.equal(await action.isDisabled(), true);
  await settings.getByLabel("Custom scale", { exact: true }).fill("2.75");
  await settings.getByText("Output · 440 × 264", { exact: true }).waitFor();
  check("presets, keyboard slider, and custom numeric scale stay synchronized");
  await run("span-custom-2.75x", 440, 264);

  await select("Sizing", "Minimum width & height");
  await settings.getByLabel("Min. width", { exact: true }).fill("");
  await settings.getByLabel("Min. height", { exact: true }).fill("");
  assert.equal(await action.isDisabled(), true);
  await settings.getByLabel("Min. height", { exact: true }).fill("192");
  await settings
    .getByText("Output · 320 × 192 · 2×", { exact: true })
    .waitFor();
  assert.equal(await action.isEnabled(), true);
  check(
    "minimum targets reject empty pairs and allow a single constrained dimension",
  );
  await settings.getByLabel("Min. width", { exact: true }).fill("384");
  await settings
    .getByText("Output · 384 × 231 · 2.4×", { exact: true })
    .waitFor();
  await select("Model", "Real-ESRGAN · 67 MB");
  await select("Tiles", "Manual");
  await settings.getByLabel("Tile size (px)", { exact: true }).fill("64");
  await run("realesrgan-minimum-dimensions", 384, 231);

  await importMedia(path.join(output, "portrait.png"));
  await select("Sizing", "Minimum long & short edge");
  await settings.getByLabel("Min. long edge", { exact: true }).fill("290");
  await settings.getByLabel("Min. short edge", { exact: true }).fill("200");
  await settings
    .getByText("Output · 200 × 299 · 2.06×", { exact: true })
    .waitFor();
  await select("Model", "SwinIR · 17 MB");
  await select("Tiles", "Divide by factor");
  await settings.getByLabel("Tile divisor", { exact: true }).fill("4");
  await run("swinir-portrait-minimum-edges", 200, 299);

  for (const width of [1280, 1000, 800]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    for (const region of [settings, workspace])
      assert.equal(
        await region.evaluate(
          (element) => element.scrollWidth > element.clientWidth + 1,
        ),
        false,
      );
    await shot(`layout-${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  check(
    "target fields and tile controls fit 1280, 1000, and 800 pixel layouts",
  );

  await importMedia(path.resolve("docs/validation/upscalers/source.webm"));
  await select("Model", "SPAN · 9 MB");
  await select("Sizing", "Minimum shortest edge");
  await settings.getByLabel("Min. shortest edge", { exact: true }).fill("96");
  await select("Tiles", "Automatic");
  await run("video-minimum-short-edge", 144, 96);
  await workspace
    .locator("video")
    .last()
    .evaluate(async (video) => {
      video.muted = true;
      await video.play();
    });
  await page.waitForFunction(
    () => [...document.querySelectorAll("video")].at(-1)?.currentTime > 0.25,
  );
  await workspace
    .locator("video")
    .last()
    .evaluate((video) => video.pause());
  check("video minimum size preserves playable output");
  await select("Sizing", "Scale factor");
  await settings.getByLabel("Custom scale", { exact: true }).fill("1.1");
  await select("Tiles", "Full frame");
  await run("video-custom-1.1x-full-frame", 106, 71);

  await importMedia(path.join(output, "source.png"));
  await select("Sizing", "Scale factor");
  await settings.getByRole("button", { name: "8×", exact: true }).click();
  await select("Tiles", "Manual");
  await settings.getByLabel("Tile size (px)", { exact: true }).fill("128");
  await run("span-8x-multiple-passes", 1280, 768);

  await select("Sizing", "Minimum width & height");
  await settings.getByLabel("Min. width", { exact: true }).fill("100");
  await settings.getByLabel("Min. height", { exact: true }).fill("80");
  await run("already-meets-minimum", 160, 96);

  await importMedia(path.join(output, "memory-source.png"));
  await select("Sizing", "Scale factor");
  await settings.getByRole("button", { name: "2×", exact: true }).click();
  await select("Model", "SwinIR · 17 MB");
  await select("Tiles", "Full frame");
  await settings.getByText(/GPU memory may be insufficient/).waitFor();
  assert.equal(await action.isEnabled(), true);
  await shot("vram-warning");
  await select("Tiles", "Automatic");
  assert.equal(
    await settings.getByText(/GPU memory may be insufficient/).count(),
    0,
  );
  check("estimated VRAM warning is advisory and clears with Automatic tiles");
  await settings.getByRole("button", { name: "8×", exact: true }).click();
  await settings
    .getByRole("alert")
    .filter({ hasText: "Output is too large" })
    .waitFor();
  assert.equal(await action.isDisabled(), true);
  check(
    "large output and intermediate allocations are blocked before submission",
  );

  await importMedia(path.join(output, "portrait.png"));
  await select("Sizing", "Minimum long & short edge");
  await settings.getByLabel("Min. long edge", { exact: true }).fill("290");
  await settings.getByLabel("Min. short edge", { exact: true }).fill("200");
  await select("Tiles", "Divide by factor");
  await settings.getByLabel("Tile divisor", { exact: true }).fill("4");
  await advanced.click();
  await page.getByText("AI upscale", { exact: true }).first().waitFor();
  await shot("advanced-flow");
  check("target dimensions and tile strategy open in Advanced");
  await run(
    "advanced-minimum-edges",
    200,
    299,
    page.getByRole("button", { name: "Run", exact: true }),
    false,
  );
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
        executableSha256: createHash("sha256")
          .update(await readFile(".cache/upscale-features-native/machdoch.exe"))
          .digest("hex"),
      },
      null,
      2,
    ),
  );
  await browser.close();
}

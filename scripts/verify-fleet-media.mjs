import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { productFixture } from "./fixtures/fleet-product.mjs";
import { createMediaFixture } from "./fixtures/fleet-media.ts";
import { FleetMediaWorker } from "../apps/client/src/cli/_helpers/cli-fleet-media.ts";

import nextConfig from "../apps/fleet-manager/next.config.ts";

const configuredHeaders = await nextConfig.headers();
const native = process.argv.includes("--native");
const worker = native ? new FleetMediaWorker() : null;
const fixture = createMediaFixture();
const localOperations = new Set();
const root = path.resolve("apps/fleet-manager/public/media-studio");
const output = path.resolve(".cache/fleet-media-review");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 960 },
  });
  const errors = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  await page.route("https://fleet.test/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/review")
      return route.fulfill({
        contentType: "text/html",
        headers: Object.fromEntries(
          configuredHeaders[0].headers.map(({ key, value }) => [key, value]),
        ),
        body: '<html><body style="margin:0"><iframe title="Media Studio" src="/media-studio/index.html?instance=review" style="border:0;width:100%;height:100dvh" allow="clipboard-read; clipboard-write"></iframe></body></html>',
      });
    if (url.pathname.endsWith("/snapshot"))
      return route.fulfill({ json: productFixture() });
    if (url.pathname.endsWith("/media")) {
      const request = route.request().postDataJSON();
      if (
        request.kind === "invoke" &&
        ["media_read_studio_state", "media_write_studio_state"].includes(
          request.command,
        )
      )
        localOperations.add(request.id);
      return route.fulfill({
        json: await (worker && !localOperations.has(request.id)
          ? worker.request(request)
          : fixture.request(request)),
      });
    }
    const file = path.resolve(
      root,
      url.pathname.replace(/^\/media-studio\//, ""),
    );
    assert(file.startsWith(`${root}${path.sep}`));
    const contentType = file.endsWith(".html")
      ? "text/html"
      : file.endsWith(".js")
        ? "text/javascript"
        : "text/css";
    return route.fulfill({
      contentType,
      headers: Object.fromEntries(
        configuredHeaders.flatMap(({ headers }) =>
          headers.map(({ key, value }) => [key, value]),
        ),
      ),
      body: await readFile(file),
    });
  });
  await page.goto("https://fleet.test/review");
  const studio = page.frame({ url: /media-studio\/index/ });
  assert(studio, "Shared Media Studio frame did not load");
  await studio
    .getByRole("button", { name: "Advanced", exact: true })
    .waitFor({ timeout: 120_000 });
  await page.screenshot({ path: path.join(output, "before-assets.png") });
  await studio.getByRole("button", { name: "Assets", exact: true }).click();
  await studio
    .getByRole("button", { name: "Browse Civitai", exact: true })
    .waitFor({ timeout: 120_000 });
  await studio.getByRole("button", { name: "Images", exact: true }).click();
  await studio.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('img[src^="blob:"]')).some(
        (image) => image.complete && image.naturalWidth > 0,
      ),
    undefined,
    { timeout: 120_000 },
  );
  await page.screenshot({
    path: path.join(output, `assets-${native ? "native" : "fixture"}.png`),
  });
  if (!native)
    assert(
      fixture.calls.some(
        (call) =>
          call.command === "media_list_asset_page" && call.args.offset === 250,
      ),
    );
  await studio
    .getByRole("button", { name: "Browse Civitai", exact: true })
    .click();
  await studio.getByRole("textbox", { name: "Search Civitai" }).fill("Age");
  if (!native)
    await studio
      .getByRole("button", { name: "View Age Slider LoRA" })
      .waitFor();
  await page.screenshot({
    path: path.join(output, `civitai-${native ? "native" : "fixture"}.png`),
  });
  await studio.getByRole("button", { name: "Close Civitai" }).click();
  await studio.getByRole("button", { name: "Advanced", exact: true }).click();
  if (!native) {
    await studio.getByRole("button", { name: "AI assistant" }).click();
    await studio
      .getByRole("textbox", { name: "Message the flow assistant" })
      .fill("Add an image output");
    await studio.getByRole("button", { name: "Send", exact: true }).click();
    await studio.getByText("The flow is ready.").waitFor();
    assert(
      fixture.calls.some(
        (call) =>
          call.command === "run_media_flow_agent" &&
          call.args.request.prompt === "Add an image output",
      ),
    );
  }
  await page.screenshot({ path: path.join(output, "advanced.png") });
  await studio.getByRole("button", { name: "Basic", exact: true }).click();
  if (!native) {
    await studio
      .getByPlaceholder("Describe the image", { exact: true })
      .fill("A cobalt paper sculpture with soft shadows");
    await studio
      .getByRole("button", { name: "Generate image", exact: true })
      .click();
    for (
      let attempt = 0;
      attempt < 100 &&
      !fixture.calls.some((call) => call.command === "media_generate_images");
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    await page.screenshot({ path: path.join(output, "generation.png") });
    assert(
      fixture.calls.some(
        (call) =>
          call.command === "media_generate_images" &&
          call.args.request.prompt ===
            "A cobalt paper sculpture with soft shadows",
      ),
      JSON.stringify(
        fixture.calls.filter(
          (call) =>
            !["media_read_asset_preview", "media_list_asset_page"].includes(
              call.command,
            ),
        ),
      ),
    );
  }
  await page.screenshot({ path: path.join(output, "basic.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await studio.getByRole("button", { name: "Assets", exact: true }).click();
  await studio
    .getByRole("button", { name: "Browse Civitai", exact: true })
    .click();
  await studio.getByRole("textbox", { name: "Search Civitai" }).waitFor();
  const overflow = await studio.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  assert.equal(overflow, false, "Mobile viewport overflow");
  await page.screenshot({ path: path.join(output, "mobile-civitai.png") });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        native,
        pages: ["Basic", "Advanced", "Assets", "Civitai", "mobile Civitai"],
        requestedAllAssets: native
          ? null
          : fixture.calls.some((call) => call.args.offset === 250),
        errors,
        screenshots: output,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  worker?.close();
}

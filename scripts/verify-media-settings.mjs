import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const requireClient = createRequire(
  new URL("../apps/client/package.json", import.meta.url),
);
const { build } = await import(
  pathToFileURL(requireClient.resolve("vite")).href
);
const { default: tailwind } = await import(
  pathToFileURL(requireClient.resolve("@tailwindcss/vite")).href
);
const result = await build({
  configFile: false,
  root: resolve("apps/client"),
  logLevel: "error",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [tailwind()],
  build: {
    write: false,
    lib: {
      entry: resolve(
        "apps/client/src/tauri/ui/__test__/media-settings-review.tsx",
      ),
      formats: ["iife"],
      name: "MediaSettingsReview",
    },
  },
});
const chunks = result.flatMap((bundle) => bundle.output);
const script = chunks.find((item) => item.type === "chunk").code;
const css = chunks
  .filter((item) => item.fileName.endsWith(".css"))
  .map((item) => item.source)
  .join("\n");
const output = resolve("apps/client/.cache/media-settings-review");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const checks = [];
try {
  for (const fleet of [false, true]) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") {
        errors.push(message.text());
        console.error(message.text());
      }
    });
    await page.route("https://image.civitai.com/settings-review/**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#4a6779"/><circle cx="290" cy="95" r="45" fill="#edd3a9"/><path d="M0 320L120 110L240 290L330 200L400 310V400H0" fill="#294451"/></svg>',
      }),
    );
    await page.route("http://127.0.0.1/settings-review*", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html lang="en" class="dark" data-theme="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>',
      }),
    );
    const mount = async () => {
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: script });
      await page
        .getByRole("button", { name: "Choose LoRAs", exact: true })
        .waitFor();
    };
    await page.goto(`http://127.0.0.1/settings-review${fleet ? "?fleet" : ""}`);
    await mount();
    await page
      .getByRole("button", { name: "Choose LoRAs", exact: true })
      .click();
    let dialog = page.getByRole("dialog", { name: "LoRAs", exact: true });
    await dialog
      .getByRole("button", { name: "Portrait Detail", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Watercolor Landscapes", exact: true })
      .click();
    await dialog
      .getByLabel("Portrait Detail strength value", { exact: true })
      .fill("0.65");
    await dialog
      .getByLabel("Watercolor Landscapes strength value", { exact: true })
      .fill("-0.4");
    await page.screenshot({
      path: resolve(output, `${fleet ? "fleet" : "client"}-lora-desktop.png`),
    });
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: /More options/ }).click();
    await page
      .getByLabel("Prompt", { exact: true })
      .fill("A quiet lakeside cabin");
    await page.getByLabel("Seed", { exact: true }).fill("4281");
    await page
      .getByRole("button", { name: "Leave studio", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Enter studio", exact: true })
      .click();
    await page
      .getByLabel("Portrait Detail strength value", { exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByLabel("Portrait Detail strength value", { exact: true })
        .inputValue(),
      "0.65",
    );
    assert.equal(
      await page
        .getByLabel("Watercolor Landscapes strength value", { exact: true })
        .inputValue(),
      "-0.4",
    );
    assert.equal(
      await page.getByLabel("Prompt", { exact: true }).inputValue(),
      "A quiet lakeside cabin",
    );
    assert.equal(
      await page.getByLabel("Seed", { exact: true }).inputValue(),
      "4281",
    );
    checks.push(
      `${fleet ? "Fleet" : "Client"}: immediate leave/re-entry retains prompt, seed, two LoRAs, strengths and expanded options`,
    );
    await page.getByRole("button", { name: "Assets", exact: true }).click();
    await page.getByRole("button", { name: "LoRAs", exact: true }).click();
    await page.getByLabel("Search assets", { exact: true }).fill("Portrait");
    await page.getByRole("button", { name: "Basic", exact: true }).click();
    await page.getByRole("button", { name: "Assets", exact: true }).click();
    assert.equal(
      await page.getByLabel("Search assets", { exact: true }).inputValue(),
      "Portrait",
    );
    await page.getByRole("button", { name: "Basic", exact: true }).click();
    await page.screenshot({
      path: resolve(output, `${fleet ? "fleet" : "client"}-studio-desktop.png`),
    });
    await page.reload();
    await mount();
    assert.equal(
      await page
        .getByLabel("Portrait Detail strength value", { exact: true })
        .inputValue(),
      "0.65",
    );
    assert.equal(
      await page.getByLabel("Seed", { exact: true }).inputValue(),
      "4281",
    );
    checks.push(
      `${fleet ? "Fleet" : "Client"}: full reload with a delayed catalog retains settings; Assets filters survive navigation`,
    );
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page
        .getByRole("button", { name: "Choose LoRAs", exact: true })
        .click();
      dialog = page.getByRole("dialog", { name: "LoRAs", exact: true });
      await dialog.getByLabel("Search add-ons").fill("Portrait");
      assert.equal(
        await dialog
          .getByRole("button", { name: "Portrait Detail", exact: true })
          .getAttribute("aria-pressed"),
        "true",
      );
      await dialog
        .getByRole("button", { name: "Reset filters", exact: true })
        .click();
      const bounds = await dialog.boundingBox();
      assert(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
      assert(
        await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      );
      await page.screenshot({
        path: resolve(
          output,
          `${fleet ? "fleet" : "client"}-lora-${width}.png`,
        ),
      });
      await dialog.getByRole("button", { name: "Done", exact: true }).click();
      await page.screenshot({ path: resolve(output, `studio-${width}.png`) });
      const overflow = await page.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
        elements: [...document.querySelectorAll("*")]
          .filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
          .slice(0, 15)
          .map((el) => ({
            tag: el.tagName,
            class: el.className,
            right: el.getBoundingClientRect().right,
          })),
      }));
      assert(overflow.scroll <= overflow.width, JSON.stringify(overflow));
    }
    checks.push(
      `${fleet ? "Fleet" : "Client"}: 390px and 320px LoRA search, selection and dialog layout pass without horizontal overflow`,
    );
    assert.equal(await page.getByRole("button", { name: "Dismiss Media Studio error", exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
  }
  await writeFile(
    resolve(output, "results.json"),
    JSON.stringify(checks, null, 2),
  );
  console.log(JSON.stringify(checks, null, 2));
} finally {
  await browser.close();
}

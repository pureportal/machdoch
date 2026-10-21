import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const directory = path.resolve("docs/validation/upscalers/features");
const browser = await chromium.connectOverCDP("http://127.0.0.1:9237");
const page = browser.contexts()[0].pages()[0];
const exceptions = [],
  invalidNumberWarnings = [],
  checks = [];
page.on("pageerror", (error) => exceptions.push(error.message));
page.on("console", (message) => {
  if (/NaN/.test(message.text())) invalidNumberWarnings.push(message.text());
});
page.setDefaultTimeout(30000);
await page
  .getByRole("button", { name: "Media Studio", exact: true })
  .click({ timeout: 120000 });
await page
  .getByRole("button", { name: "Upscale", exact: true })
  .first()
  .click();
await page.setViewportSize({ width: 1440, height: 960 });
const settings = page.getByRole("region", {
  name: "Upscale settings",
  exact: true,
});
const action = settings.getByRole("button", { name: "Upscale", exact: true });
const check = (name) => {
  checks.push(name);
  console.log(`Passed: ${name}`);
};
await page.evaluate(async () => {
  const status = await window.__TAURI__.core.invoke("media_initialize_runtime");
  if (!status.localDiffusers.ready)
    throw new Error(status.localDiffusers.diagnostic);
});
await page.evaluate(
  (file) => {
    const original = window.fetch.bind(window);
    window.finalUiFixture = file;
    window.fetch = async (input, options) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (
        url.hostname === "ipc.localhost" &&
        decodeURIComponent(url.pathname.slice(1)) === "plugin:dialog|open"
      )
        return new Response(JSON.stringify(window.finalUiFixture), {
          headers: {
            "Content-Type": "application/json",
            "Tauri-Response": "ok",
          },
        });
      return original(input, options);
    };
  },
  path.join(directory, "source.png"),
);
const select = async (label, name) => {
  await settings.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name, exact: true }).click();
};
await settings
  .getByRole("button", { name: "Import media", exact: true })
  .click();
await page.getByRole("heading", { name: "Source", exact: true }).waitFor();
await settings.getByText("Advanced settings", { exact: true }).click();
await select("Tiles", "Divide by factor");
const divisor = settings.getByLabel("Tile divisor", { exact: true });
await divisor.fill("");
assert.equal(await divisor.getAttribute("aria-invalid"), "true");
assert.equal(await action.isDisabled(), true);
await select("Tiles", "Automatic");
assert.equal(await action.isEnabled(), true);
await select("Tiles", "Divide by factor");
assert.equal(await divisor.inputValue(), "");
await divisor.fill("4");
assert.equal(await action.isEnabled(), true);
assert.deepEqual(invalidNumberWarnings, []);
check(
  "clearing the tile divisor remains empty and recovers without invalid-number warnings",
);

await settings.getByLabel("Custom scale", { exact: true }).fill("2.35");
await settings.getByText("Output · 376 × 226", { exact: true }).waitFor();
await select("Sizing", "Minimum width & height");
await settings.getByLabel("Min. width", { exact: true }).fill("");
await settings.getByLabel("Min. height", { exact: true }).fill("");
assert.equal(await action.isDisabled(), true);
await select("Sizing", "Scale factor");
assert.equal(await action.isEnabled(), true);
check("custom sizing and mode changes recover from empty inactive fields");

await page.evaluate(
  (file) => {
    window.finalUiFixture = file;
  },
  path.join(directory, "memory-source.png"),
);
await settings
  .getByRole("button", { name: "Import media", exact: true })
  .click();
await select("Model", "SwinIR · 17 MB");
await select("Tiles", "Full frame");
await settings.getByText(/GPU memory may be insufficient/).waitFor();
assert.equal(await action.isEnabled(), true);
await page.screenshot({ path: path.join(directory, "final-vram-warning.png") });
await select("Tiles", "Automatic");
assert.equal(
  await settings.getByText(/GPU memory may be insufficient/).count(),
  0,
);
check(
  "final build shows an advisory VRAM warning and clears it with Automatic tiles",
);
await page.evaluate(
  (file) => {
    window.finalUiFixture = file;
  },
  path.join(directory, "portrait.png"),
);
await settings
  .getByRole("button", { name: "Import media", exact: true })
  .click();
await select("Sizing", "Minimum long & short edge");
await settings.getByLabel("Min. long edge", { exact: true }).fill("290");
await settings.getByLabel("Min. short edge", { exact: true }).fill("200");
await select("Tiles", "Divide by factor");
await divisor.fill("4");
await settings
  .getByRole("button", { name: "Open in Advanced", exact: true })
  .click();
await page
  .getByText("Long edge ≥ 290 · Short edge ≥ 200", { exact: true })
  .waitFor();
await page.screenshot({
  path: path.join(directory, "final-advanced-summary.png"),
});
check(
  "Advanced cards summarize the selected edge constraints instead of inactive dimensions",
);
assert.deepEqual(exceptions, []);
await writeFile(
  path.join(directory, "final-ui-results.json"),
  JSON.stringify(
    {
      completed: true,
      checks,
      exceptions,
      invalidNumberWarnings,
      executableSha256: createHash("sha256")
        .update(await readFile(".cache/upscale-features-final/machdoch.exe"))
        .digest("hex"),
      verifiedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
await browser.close();

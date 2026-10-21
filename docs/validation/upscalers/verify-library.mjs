import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9237");
const page = browser.contexts()[0].pages()[0];
const contexts = [];
for (const filter of ["Videos", "Images"]) {
  await page.getByRole("button", { name: "Assets", exact: true }).click();
  await page.getByRole("button", { name: filter, exact: true }).click();
  const card = page.locator("article").first();
  await card
    .getByRole("button", { name: "Asset actions", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Upscale", exact: true }).waitFor();
  await page.screenshot({
    path: `docs/validation/upscalers/ui-library-${filter.toLowerCase()}-context.png`,
  });
  await page.getByRole("menuitem", { name: "Upscale", exact: true }).click();
  const source = page
    .getByRole("heading", { name: "Source", exact: true })
    .locator("../..");
  await source.locator(filter === "Videos" ? "video" : "img").waitFor();
  contexts.push({
    kind: filter,
    dimensions: await source.locator("header span").innerText(),
  });
}
const reportPath = "docs/validation/upscalers/playwright-results.json";
const report = JSON.parse(await readFile(reportPath, "utf8"));
report.libraryContexts = contexts;
report.cancellation = JSON.parse(
  await readFile("docs/validation/upscalers/ui-canceled-run.json", "utf8"),
);
report.cancellation = {
  runId: report.cancellation.id,
  status: report.cancellation.status,
  assets: report.cancellation.assets.length,
};
report.checks.push("generated image/video library context actions");
assert.equal(report.cancellation.status, "canceled");
await writeFile(reportPath, JSON.stringify(report, null, 2));
await browser.close();
console.log("Generated image/video library context actions passed");

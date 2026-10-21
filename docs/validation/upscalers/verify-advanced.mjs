import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9237");
const page = browser.contexts()[0].pages()[0];
await page.getByRole("button", { name: "Advanced", exact: true }).click();
const before = await page.evaluate(() => window.upscaleValidation.calls.length);
await page.getByRole("button", { name: "Run", exact: true }).click();
await page.waitForFunction(
  (before) => window.upscaleValidation.calls.length > before,
  before,
);
const request = await page.evaluate(() =>
  window.upscaleValidation.calls.at(-1),
);
console.log(JSON.stringify({ runId: request.runId, state: "submitted" }));
let detail;
const deadline = Date.now() + 180000;
while (Date.now() < deadline) {
  try {
    detail = await page.evaluate(
      (runId) =>
        window.__TAURI__.core.invoke("media_get_run_detail", { runId }),
      request.runId,
    );
    if (["completed", "failed", "canceled"].includes(detail.status)) break;
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 500));
}
assert.equal(detail?.status, "completed", JSON.stringify(detail?.error));
assert.equal(
  detail.assets.some(
    (asset) => asset.kind === "video" && asset.operation?.details.finalOutput,
  ),
  true,
);
await writeFile(
  "docs/validation/upscalers/ui-advanced-run.json",
  JSON.stringify(detail, null, 2),
);
await page.screenshot({
  path: "docs/validation/upscalers/ui-advanced-completed.png",
});
const reportPath = "docs/validation/upscalers/playwright-results.json";
const report = JSON.parse(await readFile(reportPath, "utf8"));
report.advancedRun = { runId: request.runId, status: detail.status };
report.checks.push("native execution from Advanced canvas");
await writeFile(reportPath, JSON.stringify(report, null, 2));
await browser.close();
console.log("Advanced canvas video upscale passed");

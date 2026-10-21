import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9228");
try {
  const page = browser.contexts()[0].pages().find((page) => page.url().includes("tauri"));
  const runtime = await page.evaluate(() => window.__TAURI__.core.invoke("media_refresh_local_diffusers_runtime"));
  await writeFile(process.argv[3], JSON.stringify(runtime, null, 2));
  assert.equal(runtime.ready, true, runtime.diagnostic);
  assert.equal(runtime.workerVersion, process.argv[2]);
  await page.reload();
  console.log(JSON.stringify({ ready: runtime.ready, workerVersion: runtime.workerVersion }));
} finally {
  await browser.close();
}

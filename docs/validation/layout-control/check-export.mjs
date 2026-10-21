import { chromium } from "playwright-core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const [storage, runId, name] = process.argv.slice(2);
const directory = path.resolve(storage, "layout-control/evidence", name);
await mkdir(directory);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9239");
try {
  const page = browser.contexts()[0].pages().find(page => page.url().includes("tauri.localhost"));
  const invoke = (command, args) => page.evaluate(({ command, args }) => window.__TAURI__.core.invoke(command, args), { command, args });
  const run = await invoke("media_get_run_detail", { runId });
  assert.equal(run.status, "completed");
  const asset = run.assets.find(asset => asset.operation?.details?.provenance?.imageLayout);
  assert.ok(asset);
  const exports = [];
  for (const mode of ["verified-original", "metadata-stripped"]) {
    const destinationPath = path.join(directory, `${mode}.png`);
    const result = await invoke("media_export_asset", { request: { assetId: asset.id, destinationPath, mode } });
    const digest = createHash("sha256").update(await readFile(destinationPath)).digest("hex");
    assert.equal(digest, result.digest);
    if (mode === "verified-original") assert.equal(digest, asset.digest);
    exports.push(result);
  }
  await writeFile(path.join(directory, "result.json"), JSON.stringify({ runId, asset, exports }, null, 2));
  console.log(JSON.stringify({ runId, assetId: asset.id, exports }));
} finally { await browser.close(); }

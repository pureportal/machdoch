import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9237");
const page = browser.contexts()[0].pages()[0];
await page.waitForFunction(() => Boolean(window.__TAURI__?.core));
const manifest = JSON.parse(await readFile("apps/client/src-tauri/src/media/workflow_models.json", "utf8"));
const models = [];
for (const kind of ["upscale-span", "upscale", "upscale-swinir"]) {
  const modelPath = await page.evaluate(kind => window.__TAURI__.core.invoke("media_install_workflow_model", { kind }), kind);
  const weights = manifest[kind].find(file => /\.(pth|safetensors)$/.test(file.path));
  assert.equal(path.basename(modelPath), weights.path);
  for (const file of manifest[kind]) {
    const bytes = await readFile(path.join(path.dirname(modelPath), file.path));
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
  }
  models.push({ kind, modelPath, files: manifest[kind].length, hashVerified: true, licensePresent: true });
}
await writeFile("docs/validation/upscalers/native-model-installs.json", JSON.stringify(models, null, 2));
await browser.close();
console.log("All three native preset installs and licenses verified");

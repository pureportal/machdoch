import { chromium } from "playwright-core";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const root = process.argv[2];
if (!root) throw new Error("Provide the configured storage root");
const recorded = JSON.parse(await readFile(path.join(root, "layout-control/runs/moss-base-native-scene-canonical-01/request.json"), "utf8"));
const imageLayout = JSON.parse(await readFile("docs/artifacts/layout-control-2026-10-18/scene.json", "utf8"));
const base = {
  schemaVersion: 1, flowId: recorded.request.flowId, flowRevisionId: recorded.request.flowRevisionId,
  flowName: "Masked output validation", planId: recorded.request.planId, planSnapshot: recorded.request.planSnapshot,
  prompt: "", modelId: "local:masked-output-validation", modelLabel: "Validation", outputCount: 1, diagnosticCount: 0,
  aspectRatio: "1:1", outputFormat: "png", modelPolicy: "quality", transparentBackground: false,
  referenceImages: [], seed: 713, imageLayout, layoutMethod: "masked", memoryProfile: "invalid-validation-probe",
  outputBranches: [{ id: "output", outputNodeId: "output", format: "png", quality: 95, jpegBackground: "#ffffff", operations: [] }],
};
const browser = await chromium.connectOverCDP("http://127.0.0.1:9239");
try {
  const page = browser.contexts()[0].pages().find(page => page.url().includes("tauri.localhost"));
  const results = [];
  for (const name of ["jpeg-generation", "webp-branch", "resize-branch", "png", "png-metadata-strip"]) {
    const request = structuredClone(base);
    request.runId = `validation-masked-output-${name}-${Date.now()}`;
    if (name === "jpeg-generation") request.outputFormat = "jpeg";
    if (name === "webp-branch") request.outputBranches[0].format = "webp";
    if (name === "resize-branch") request.outputBranches[0].operations.push({ kind: "resize", nodeId: "resize", width: 512, height: 384, fit: "stretch" });
    if (name === "png-metadata-strip") request.outputBranches[0].operations.push({ kind: "metadata-strip", nodeId: "strip", preserveColorProfile: false });
    const result = await page.evaluate(async request => {
      try { return { accepted: true, result: await window.__TAURI__.core.invoke("media_generate_images", { request }) }; }
      catch (error) { return { accepted: false, error }; }
    }, request);
    assert.equal(result.accepted, false);
    const expected = name.startsWith("png") ? /memoryProfile must be/ : /Masked layout output must be PNG without pixel-changing operations/;
    assert.match(JSON.stringify(result.error), expected);
    assert.equal(result.error.category, "validation");
    assert.equal(result.error.code, "INVALID_REQUEST");
    results.push({ name, runId: request.runId, error: result.error });
  }
  const runs = await page.evaluate(() => window.__TAURI__.core.invoke("media_list_runs", { limit: 100 }));
  assert.ok(results.every(result => !runs.some(run => run.id === result.runId)));
  const evidence = { passed: true, scope: "Actual native request validation; deliberately invalid memoryProfile prevents inference in every case.", results };
  await writeFile(path.join(root, "layout-control/evidence/masked-output-validation.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally { await browser.close(); }

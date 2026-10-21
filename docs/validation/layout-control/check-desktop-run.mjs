import { chromium } from "playwright-core";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";

const [storage, name, flowId, scenePath, resumedRunId] = process.argv.slice(2);
if (!scenePath) throw new Error("Provide storage, run name, saved flow ID and scene file");
const directory = path.resolve(storage, "layout-control/runs", name);
await mkdir(directory, { recursive: Boolean(resumedRunId) });
const expected = JSON.parse(await readFile(scenePath, "utf8"));
const browser = await chromium.connectOverCDP("http://127.0.0.1:9239");
try {
  const page = browser.contexts()[0].pages().find(page => page.url().includes("tauri.localhost"));
  assert.ok(page);
  await page.getByTestId("rf__node-image-layout").waitFor();
  await page.getByTestId("rf__node-image-layout").click();
  assert.equal(await page.getByLabel("Canvas width", { exact: true }).inputValue(), String(expected.canvas.width));
  assert.equal(await page.getByLabel("Canvas height", { exact: true }).inputValue(), String(expected.canvas.height));
  assert.equal(await page.locator("[data-element-id]").count(), expected.elements.length);
  const history = await page.evaluate(flowId => window.__TAURI__.core.invoke("media_get_flow", { flowId }), flowId);
  const revision = history.revisions.find(revision => revision.isHead);
  assert.deepEqual(revision.flow.nodes.find(node => node.type === "source.image-layout").config.imageLayout, expected);
  await writeFile(path.join(directory, "saved-history.json"), JSON.stringify(history, null, 2));
  await page.screenshot({ path: path.join(directory, "editor-reopened.png") });
  let runId = resumedRunId;
  const invoke = (command, args) => page.evaluate(({ command, args }) => window.__TAURI__.core.invoke(command, args), { command, args });
  async function until(read, timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await read();
      if (value) return value;
      await setTimeout(5000);
    }
    throw new Error("Desktop run did not reach the expected state before the deadline");
  }
  if (!runId) {
    const before = await invoke("media_list_runs", { limit: 100 });
    await page.getByRole("button", { name: "Run", exact: true }).click();
    const started = await until(async () => {
      const runs = await invoke("media_list_runs", { limit: 100 });
      return runs.find(run => run.flowId === flowId && !before.some(previous => previous.id === run.id));
    }, 120000);
    runId = started.id;
  }
  const started = await page.evaluate(runId => window.__TAURI__.core.invoke("media_get_run_detail", { runId }), runId);
  await writeFile(path.join(directory, "started-run.json"), JSON.stringify(started, null, 2));
  console.log(JSON.stringify({ runId, flowRevisionId: started.flowRevisionId }));
  const progress = [];
  const result = await until(async () => {
    const run = await invoke("media_get_run_detail", { runId });
    const previous = progress.at(-1);
    if (!previous || previous.progress !== run.progress || previous.currentStep !== run.currentStep || previous.status !== run.status) {
      const sample = { observedAt: new Date().toISOString(), status: run.status, progress: run.progress, currentStep: run.currentStep };
      progress.push(sample);
      await writeFile(path.join(directory, "progress.json"), JSON.stringify(progress, null, 2));
      console.log(JSON.stringify(sample));
    }
    return ["completed", "failed", "canceled"].includes(run.status) ? run : false;
  }, 4 * 60 * 60 * 1000);
  const response = { result, elapsedSeconds: (Date.parse(result.updatedAt) - Date.parse(result.createdAt)) / 1000 };
  await writeFile(path.join(directory, "response.json"), JSON.stringify(response, null, 2));
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  assert.equal(response.result.status, "completed", response.result.error?.slice(0, 2000) ?? "Workflow did not complete");
  const generated = response.result.assets.find(asset => asset.operation?.details?.provenance?.imageLayout);
  assert.ok(generated, "Generated asset must retain layout provenance");
  const evidence = generated.operation.details.provenance.imageLayout;
  assert.deepEqual(evidence.layout, expected);
  await page.screenshot({ path: path.join(directory, "generated.png") });
  console.log(JSON.stringify({ status: response.result.status, elapsedSeconds: response.elapsedSeconds, assetId: generated.id, digest: generated.digest }));
} catch (error) {
  await writeFile(path.join(directory, "failure.txt"), String(error.stack));
  throw error;
} finally {
  await browser.close();
}

import { chromium } from "playwright-core";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const storage = process.argv[2];
if (!storage) throw new Error("Provide the configured storage root");
const directory = path.join(storage, "layout-control/evidence");
await mkdir(directory, { recursive: true });
const browser = await chromium.connectOverCDP("http://127.0.0.1:9239");
try {
  const context = browser.contexts()[0];
  const page = context.pages().find(page => page.url().includes("tauri.localhost")) ?? context.pages()[0] ?? await context.waitForEvent("page");
  await page.waitForURL(/tauri.localhost/);
  await page.waitForFunction(() => Boolean(window.__TAURI__?.core?.invoke));
  const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI__.core.invoke(command, args), { command, args });
  if (await page.getByRole("button", { name: "Skip setup", exact: true }).count()) await page.getByRole("button", { name: "Skip setup", exact: true }).click();
  await invoke("media_initialize_runtime");
  const jobs = [];
  for (const modelId of process.argv.slice(3)) {
    const plan = await invoke("media_plan_model_install", { modelId });
    const request = { modelId, reviewToken: plan.reviewToken, manifestDigest: plan.manifestDigest, licenseDigest: plan.licenseDigest, acceptLicense: true };
    const job = await invoke("media_start_model_install", { request });
    jobs.push(job);
    console.log(JSON.stringify({ modelId, jobId: job.id, status: job.status }));
  }
  await writeFile(path.join(directory, "desktop-install-jobs.json"), JSON.stringify(jobs, null, 2));
  const catalog = await invoke("media_get_model_catalog", { configuredProviderIds: [], includeRuntimeReadiness: false });
  await writeFile(path.join(directory, "desktop-catalog.json"), JSON.stringify(catalog, null, 2));
} finally { await browser.close(); }

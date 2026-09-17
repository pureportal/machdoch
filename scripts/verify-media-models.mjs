import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import {
  mkdir,
  writeFile,
  unlink,
  readdir,
  link,
  access,
} from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const baseUrl = process.env.MACHDOCH_CLIENT_UI_URL ?? "http://127.0.0.1:4173";
const output = path.resolve(
  "apps/client/.cache/model-verification",
  String(Date.now()),
);
const liveRoot = path.join(
  process.env.APPDATA,
  "com.machdoch.desktop/media-studio",
);
const root = path.join(output, "store");
const cases = JSON.parse(process.env.MACHDOCH_MODEL_TEST_CASES ?? "[]");
assert.ok(
  cases.length &&
    cases.every(
      ({ source, architecture, expectedReadiness }) =>
        source &&
        architecture &&
        ["ready", "failed"].includes(expectedReadiness),
    ),
  "Set MACHDOCH_MODEL_TEST_CASES to checkpoint sources, architectures and expected readiness",
);
assert.ok(
  process.env.MACHDOCH_MODEL_TEST_BINARY,
  "Set MACHDOCH_MODEL_TEST_BINARY to the compiled Rust test executable",
);
assert.equal(
  (await fetch(baseUrl)).status,
  200,
  "Use the existing client server",
);
await mkdir(root, { recursive: true });
const componentRoot = path.join(liveRoot, "models/components/krea-2");
for (const entry of await readdir(componentRoot, {
  recursive: true,
  withFileTypes: true,
})) {
  if (!entry.isFile() || entry.name === "components.lock") continue;
  const source = path.join(entry.parentPath, entry.name);
  const destination = path.join(
    root,
    "models/components/krea-2",
    path.relative(componentRoot, source),
  );
  await mkdir(path.dirname(destination), { recursive: true });
  await link(source, destination);
}
const binary = path.resolve(process.env.MACHDOCH_MODEL_TEST_BINARY);
const backend = spawn(
  binary,
  ["playwright_model_store", "--ignored", "--nocapture", "--test-threads=1"],
  {
    windowsHide: true,
    env: {
      ...process.env,
      MACHDOCH_MODEL_TEST_ROOT: root,
      MACHDOCH_MODEL_TEST_PYTHON: path.join(
        liveRoot,
        "runtime/environment/Scripts/python.exe",
      ),
    },
    stdio: ["pipe", "pipe", "pipe"],
  },
);
const replies = [];
const commands = [];
const diagnostics = [];
createInterface({ input: backend.stdout }).on("line", (line) => {
  const marker = line.indexOf("MEDIA_REPLY:");
  if (marker < 0) return;
  const reply = JSON.parse(line.slice(marker + 12));
  const pending = replies.shift();
  if (reply.error) pending.reject(new Error(reply.error));
  else pending.resolve(reply.value);
});
backend.stderr.on("data", (data) => diagnostics.push(data.toString()));
backend.on("exit", (code) => {
  for (const pending of replies.splice(0))
    pending.reject(new Error(`Native model test exited: ${code}`));
});
const invokeNative = (command, args = {}) =>
  new Promise((resolve, reject) => {
    commands.push({ command, args, at: new Date().toISOString() });
    replies.push({ resolve, reject });
    backend.stdin.write(`${JSON.stringify({ command, args })}\n`);
  });
const fixture = path.resolve(
  `apps/client/src/tauri/ui/preview/.model-verification-${process.pid}.tsx`,
);
await writeFile(
  fixture,
  `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MediaStudio } from '../media/media-studio';
window.isTauri = true;
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
window.__TAURI_INTERNALS__ = {
  invoke: window.modelTestInvoke,
  convertFileSrc: value => value,
  transformCallback: () => 1,
  unregisterCallback: () => {},
  metadata: { currentWindow: { label: 'model-test' }, currentWebview: { label: 'model-test' } },
};
function Fixture() {
  return <div style={{ height: '100vh' }}><MediaStudio providerStatuses={[]} workspaceRoot={null}
    onOpenProviderSettings={() => {}} openSection="library" /></div>;
}
window.modelVerificationRoot ??= createRoot(document.getElementById('root'));
window.modelVerificationRoot.render(<Fixture />);
`,
);
const browser = await chromium.launch({ channel: "msedge", headless: true });
const report = {
  output,
  root,
  models: [],
  pageErrors: [],
  removalMessages: [],
};
const stored = {};
let selectedSource = null;
let testPage;
try {
  report.runtime = await invokeNative("media_initialize_runtime");
  assert.equal(
    report.runtime.localDiffusers.ready,
    true,
    report.runtime.localDiffusers.diagnostic,
  );
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  testPage = page;
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") diagnostics.push(message.text());
  });
  await page.exposeFunction("modelTestInvoke", async (command, args = {}) => {
    if (command === "plugin:dialog|open") return selectedSource;
    if (command === "plugin:store|load") return 1;
    if (command === "plugin:store|get")
      return [stored[args.key], args.key in stored];
    if (command === "plugin:store|set") {
      stored[args.key] = args.value;
      return;
    }
    if (command === "plugin:store|save") {
      await writeFile(
        path.join(output, "shell-state.json"),
        JSON.stringify(stored),
      );
      return;
    }
    if (command === "plugin:event|listen") return 1;
    if (["plugin:event|unlisten", "plugin:event|emit"].includes(command))
      return;
    if (command === "set_window_pending_media_work") return;
    if (command === "media_get_runtime_setup")
      return {
        phase: "ready",
        message: "",
        diagnostic: null,
        downloadPercent: null,
      };
    if (["media_list_run_page", "media_list_asset_page"].includes(command))
      return {
        schemaVersion: 1,
        revision: "empty",
        offset: 0,
        totalItems: 0,
        unchanged: false,
        items: [],
      };
    if (["media_list_runs", "media_list_flows"].includes(command)) return [];
    if (command === "media_get_flow")
      return {
        schemaVersion: 1,
        flowId: args.flowId,
        head: null,
        revisions: [],
      };
    return invokeNative(command, args);
  });
  const url = `${baseUrl}/model-verification`;
  const fixtureUrl = `/@fs/${fixture.replaceAll("\\", "/")}`;
  const styleUrl = `/@fs/${path.resolve("apps/client/src/tauri/ui/styles.css").replaceAll("\\", "/")}`;
  await page.route(url, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html class="dark"><head><link rel="stylesheet" href="${styleUrl}"></head><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>(type)=>type; window.__vite_plugin_react_preamble_installed__=true; await import('${fixtureUrl}');</script></body></html>`,
    }),
  );
  await page.goto(url);
  await page
    .getByRole("button", { name: "Import", exact: true })
    .waitFor({ timeout: 240000 });
  for (const [
    index,
    { source, architecture, expectedReadiness },
  ] of cases.entries()) {
    console.log(`Importing model ${index + 1}: ${source}`);
    selectedSource = source;
    await page.getByRole("button", { name: "Import", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Import", exact: true });
    await dialog
      .getByRole("button", { name: "Drop or select a file", exact: true })
      .click();
    await dialog
      .getByLabel("Name", { exact: true })
      .waitFor({ timeout: 60000 });
    const name = `Model verification ${index + 1}`;
    await dialog.getByLabel("Name", { exact: true }).fill(name);
    await dialog.getByLabel("Tags", { exact: true }).fill("verification");
    await dialog.getByLabel("Base model").selectOption(architecture);
    await dialog
      .getByRole("button", { name: "Import model", exact: true })
      .click({ timeout: 240000 });
    await page
      .getByRole("button", { name: `View ${name}`, exact: true })
      .waitFor({ timeout: 900000 });
    const catalog = await invokeNative("media_get_model_catalog");
    const model = catalog.models.find((entry) => entry.displayName === name);
    assert.ok(model?.installed);
    assert.equal(model.runtimeReadiness, "unverified");
    await page.screenshot({
      path: path.join(output, `model-${index + 1}-unverified.png`),
    });
    const closeDetails = page.getByRole("button", {
      name: "Close asset details",
    });
    if (!(await closeDetails.isVisible()))
      await page
        .getByRole("button", { name: `View ${name}`, exact: true })
        .click();
    const detail = page.locator("aside").filter({ has: closeDetails });
    const verify = detail.getByRole("button", {
      name: "Verify model",
      exact: true,
    });
    const started = Date.now();
    await verify.click();
    await detail
      .getByRole("button", { name: "Verifying…", exact: true })
      .waitFor();
    await page.screenshot({
      path: path.join(output, `model-${index + 1}-verifying.png`),
    });
    console.log(`Verifying model ${index + 1}`);
    await detail
      .getByRole("button", { name: "Verifying…", exact: true })
      .waitFor({ state: "hidden", timeout: 900000 });
    const updated = (await invokeNative("media_get_model_catalog")).models.find(
      (entry) => entry.id === model.id,
    );
    assert.equal(updated.runtimeReadiness, expectedReadiness);
    assert.equal(
      await detail
        .getByRole("button", { name: "Use model", exact: true })
        .isVisible(),
      updated.runtimeReadiness === "ready",
    );
    const result = {
      name,
      source,
      id: model.id,
      status: updated.runtimeReadiness,
      diagnostic: updated.runtimeReadinessDiagnostic,
      elapsedMs: Date.now() - started,
    };
    report.models.push(result);
    console.log(JSON.stringify(result));
    await page.screenshot({
      path: path.join(output, `model-${index + 1}-result.png`),
    });
    await page.reload();
    await page
      .getByRole("button", { name: `View ${name}`, exact: true })
      .waitFor({ timeout: 240000 });
    await page
      .getByRole("button", { name: `View ${name}`, exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("button", { name: "Verifying…", exact: true })
        .count(),
      0,
    );
    assert.equal(
      await detail
        .getByRole("button", { name: "Use model", exact: true })
        .isVisible(),
      expectedReadiness === "ready",
    );
    assert.equal(
      (await invokeNative("media_get_model_catalog")).models.find(
        (entry) => entry.id === model.id,
      ).runtimeReadiness,
      expectedReadiness,
    );
    await page.evaluate(() => {
      window.removalMessages = [];
      window.removalObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations)
          for (const node of mutation.addedNodes) {
            const text = node.textContent ?? "";
            if (
              /removed successfully|model (?:was |has been )?removed|successfully removed/i.test(
                text,
              )
            )
              window.removalMessages.push(text);
          }
      });
      window.removalObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });
    });
    await page
      .getByRole("button", { name: "Remove model", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: `Remove ${name}?`, exact: true })
      .getByRole("button", { name: "Remove", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: `Remove ${name}?`, exact: true })
      .waitFor({ state: "detached", timeout: 120000 });
    await page
      .getByRole("button", { name: `View ${name}`, exact: true })
      .waitFor({ state: "hidden", timeout: 120000 });
    assert.equal(
      await page.getByRole("button", { name: "Close asset details" }).count(),
      0,
    );
    report.removalMessages.push(
      ...(await page.evaluate(() => {
        window.removalObserver.disconnect();
        return window.removalMessages;
      })),
    );
    const db = new DatabaseSync(path.join(root, "media.sqlite3"), {
      readOnly: true,
    });
    for (const table of [
      "media_models",
      "media_model_installations",
      "media_model_runtime_probes",
      "media_model_lifecycle_snapshots",
      "media_model_license_acceptances",
      "media_model_install_jobs",
      "media_model_removals",
    ]) {
      const key = table === "media_models" ? "id" : "model_id";
      assert.equal(
        db
          .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${key} = ?`)
          .get(model.id).count,
        0,
        table,
      );
    }
    db.close();
    const packageRoot = path.join(
      root,
      "models/packages",
      `user-${model.id.slice("local:user:".length, "local:user:".length + 32)}`,
    );
    await assert.rejects(access(packageRoot));
    if (architecture === "krea-2")
      await assert.rejects(access(path.join(root, "models/components/krea-2")));
    await access(source);
    await invokeNative("recover");
    await page.reload();
    await page
      .getByRole("button", { name: "Import", exact: true })
      .waitFor({ timeout: 240000 });
    assert.equal(
      await page
        .getByRole("button", { name: `View ${name}`, exact: true })
        .count(),
      0,
    );
    assert.equal(
      await page
        .getByText("Import the compatible model file again.", { exact: true })
        .count(),
      0,
    );
    assert.equal(
      stored["machdoch.desktop.media-studio-state"].assetMetadata[model.id],
      undefined,
    );
    result.removalVerified = true;
    await page.screenshot({
      path: path.join(output, `model-${index + 1}-removed.png`),
    });
  }
  assert.deepEqual(report.removalMessages, []);
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} catch (error) {
  if (testPage) {
    console.error(await testPage.locator("body").innerText());
    await testPage.screenshot({ path: path.join(output, "failure.png") });
  }
  report.error = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ ...report, commands, diagnostics }, null, 2),
  );
  await unlink(fixture);
  backend.stdin.end();
  await browser.close();
  console.log(`Report: ${path.join(output, "report.json")}`);
}

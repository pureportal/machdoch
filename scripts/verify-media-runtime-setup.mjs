import assert from "node:assert/strict";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const baseUrl = process.env.MACHDOCH_CLIENT_UI_URL ?? "http://127.0.0.1:4173";
const output = path.resolve("apps/client/.cache/media-runtime-setup");
const fixture = path.resolve(
  `apps/client/src/tauri/ui/preview/.media-setup-verification-${process.pid}.tsx`,
);
await mkdir(output, { recursive: true });
assert.equal(
  (await fetch(baseUrl)).status,
  200,
  "The existing client must be running",
);
await writeFile(
  fixture,
  `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { createMediaModelCatalogSnapshot } from "../../../core/media/catalog";
import { MediaAssetsView } from "../media/components/media-assets-view";
import { MediaRuntimeSetupNotice } from "../media/components/media-runtime-setup-notice";
import { EMPTY_MEDIA_RUNTIME_SETUP } from "../media/media-runtime-setup";
import { useMediaRuntimeSetup } from "../media/use-media-runtime-setup";
window.isTauri = true;
window.setupCalls = 0;
window.usedModels = 0;
window.nativeSetup = EMPTY_MEDIA_RUNTIME_SETUP;
window.__TAURI_INTERNALS__ = {
  invoke: async (command) => {
    if (command === "media_get_runtime_setup") return window.nativeSetup;
    if (command === "media_start_runtime_setup") {
      window.setupCalls += 1;
      window.nativeSetup = { ...EMPTY_MEDIA_RUNTIME_SETUP, phase: "dependencies" };
      return window.nativeSetup;
    }
    throw new Error("Unexpected command: " + command);
  },
  convertFileSrc: () => "",
};
const noop = () => {};
function Fixture() {
  const [ready, setReady] = useState(false);
  const setup = useMediaRuntimeSetup(async () => { setReady(true); });
  const catalog = createMediaModelCatalogSnapshot({ isOpenAiConfigured: false, isLocalFluxInstalled: true });
  const source = catalog.models.find(model => model.id === "local:flux-2-klein-4b");
  catalog.models = [{ ...source, userImported: true, runtimeReadiness: ready ? "ready" : "runtime-unavailable", runtimeReadinessDiagnostic: "Missing diffusers; torch=2.2.2; incompatible transformers=4.57.6" }];
  return <main style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
    <MediaRuntimeSetupNotice status={setup.status} needed={!ready} supported refreshFailed={setup.refreshFailed} statusUnavailable={setup.statusUnavailable} onSetup={() => void setup.start()} onRefresh={() => void setup.refresh()} />
    <div style={{ flex: 1, minHeight: 0 }}>
      <MediaAssetsView
        discoveredFiles={[]}
        assets={[]}
        catalog={catalog}
        categories={[]}
        metadata={{}}
        selectedModelId={null}
        importSupported
        importLoading={false}
        importProgress={null}
        modelImportInspection={null}
        addonImportInspection={null}
        civitaiInspection={null}
        importError={null}
        persistenceError={null}
        onInspectModel={noop}
        onInspectAddon={noop}
        onInspectCivitai={noop}
        onImportMedia={async () => null}
        onImportModel={async () => false}
        onImportAddon={async () => false}
        onImportSampleUrl={async () => null}
        onRetryPersistence={noop}
        onDismissImport={noop}
        onUseModel={() => { window.usedModels += 1; }}
        onSetupRuntime={() => void setup.start()}
        onVerifyModel={noop}
        onRefreshModels={async () => {}}
        onScanModels={noop}
        runtimeSetup={setup.status}
        runtimeReady={ready}
        verifyingModelId={null}
        onUseAddon={noop}
        onUseAsReference={noop}
        onEditImage={noop}
        onAnimateImage={noop}
        onOpenVideoAsFlow={noop}
        onInspectSettings={noop}
        onReuseSettings={noop}
        onPlanAssetDeletion={async () => null}
        onDeleteAsset={async () => {}}
        onUpdateTags={noop}
        onUpdateMetadata={noop}
        onCategoryStateChange={noop}
        tagLoadingAssetId={null}
      />
    </div>
  </main>;
}
createRoot(document.getElementById("root")).render(<Fixture />);
`,
);
const browser = await chromium.launch({
  channel: process.env.MACHDOCH_BROWSER_CHANNEL ?? "chrome",
  headless: true,
});
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
  page.on("pageerror", (error) => errors.push(error.message));
  const url = `${baseUrl}/media-setup-verification`;
  const fixtureUrl = `/@fs/${fixture.replaceAll("\\", "/")}`;
  const styleUrl = `/@fs/${path.resolve("apps/client/src/tauri/ui/styles.css").replaceAll("\\", "/")}`;
  await page.route(url, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html class="dark" data-theme="dark"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${styleUrl}"></head><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>(type)=>type; window.__vite_plugin_react_preamble_installed__=true; await import('${fixtureUrl}');</script></body></html>`,
    }),
  );
  await page.goto(url);
  const card = page.locator("article").first();
  await card
    .getByRole("button", { name: "Set up Media Studio", exact: true })
    .waitFor();
  await page.screenshot({ path: path.join(output, "setup-needed.png") });
  await card
    .getByRole("button", { name: "Set up Media Studio", exact: true })
    .click();
  await page
    .getByText("Installing components…", { exact: true })
    .first()
    .waitFor();
  assert.equal(
    await card
      .getByRole("button", { name: "Installing components…" })
      .isDisabled(),
    true,
  );
  assert.equal(await page.evaluate(() => window.setupCalls), 1);
  await page.screenshot({ path: path.join(output, "setup-progress.png") });
  await page.evaluate(() => {
    window.nativeSetup = {
      phase: "failed",
      downloadPercent: null,
      message:
        "Setup could not finish downloading. Check your connection, then retry setup.",
      diagnostic:
        "Missing diffusers; torch=2.2.2; incompatible transformers=4.57.6",
    };
  });
  await page
    .getByText(
      "Setup could not finish downloading. Check your connection, then retry setup.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await page
      .getByText(
        "Missing diffusers; torch=2.2.2; incompatible transformers=4.57.6",
        { exact: true },
      )
      .isVisible(),
    false,
  );
  await page.getByText("Show details", { exact: true }).click();
  assert.equal(
    await page
      .getByText(
        "Missing diffusers; torch=2.2.2; incompatible transformers=4.57.6",
        { exact: true },
      )
      .isVisible(),
    true,
  );
  await page.getByText("Show details", { exact: true }).click();
  await page.screenshot({ path: path.join(output, "setup-failed.png") });
  await page
    .getByRole("button", { name: "Retry setup", exact: true })
    .first()
    .click();
  await page
    .getByText("Installing components…", { exact: true })
    .first()
    .waitFor();
  await page.evaluate(() => {
    window.nativeSetup = {
      phase: "ready",
      downloadPercent: null,
      message: "",
      diagnostic: null,
    };
  });
  await page.getByText("Media Studio is ready", { exact: true }).waitFor();
  await card.getByRole("button", { name: "Use model", exact: true }).click();
  assert.equal(await page.evaluate(() => window.usedModels), 1);
  assert.equal(await page.evaluate(() => window.setupCalls), 2);
  await page.screenshot({ path: path.join(output, "setup-ready.png") });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollHeight > innerHeight,
    ),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Setup, progress, failure details, retry, and enabled model action passed at 960 × 720.",
  );
  console.log(`Screenshots: ${output}`);
} catch (error) {
  console.error(errors);
  throw error;
} finally {
  await browser.close();
  await unlink(fixture);
}

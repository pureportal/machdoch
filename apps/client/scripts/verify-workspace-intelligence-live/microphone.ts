import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const base = fileURLToPath(
  new URL("../../../../.machdoch/validation/", import.meta.url),
);
await mkdir(base, { recursive: true });
const artifacts = await mkdtemp(join(base, "microphone-capture-"));
const report: Record<string, unknown> = { startedAt: new Date().toISOString() };
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext({ permissions: ["microphone"] });
  const page = await context.newPage();
  await page.route("http://localhost/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Microphone acquisition check</title>",
    }),
  );
  await page.goto("http://localhost/");
  report.capture = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error("No microphone track was returned.");
    try {
      const settings = track.getSettings();
      return {
        state: track.readyState,
        enabled: track.enabled,
        sampleRate: settings.sampleRate,
        channelCount: settings.channelCount,
      };
    } finally {
      stream.getTracks().forEach((current) => current.stop());
      if (track.readyState !== "ended")
        throw new Error("Microphone track did not stop.");
    }
  });
  assert.equal((report.capture as { state: string }).state, "live");
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await browser.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(
    join(artifacts, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(`Microphone acquisition verification: ${artifacts}`);
}

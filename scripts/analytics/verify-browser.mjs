import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { chromium } from "playwright-core";
import { PROJECTS } from "../../packages/analytics/src/catalog.ts";
import { AnalyticsClient } from "../../packages/analytics/src/client.ts";
import { swetrixRequest } from "./swetrix-api.mjs";

const fixtureOrigin = "https://analytics-verification.invalid";
const directory = resolve("apps/landing/dist");
const mimeTypes = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};
const reports = [];
const verificationProject = await swetrixRequest("/project", {
  method: "POST",
  body: { name: `Machdoch Analytics Verification ${Date.now()}` },
});
assert.match(verificationProject.id, /^[a-zA-Z0-9]{12}$/);
assert.ok(!Object.values(PROJECTS).includes(verificationProject.id));
let browser;
try {
  await swetrixRequest(`/project/${verificationProject.id}`, {
    method: "PUT",
    body: { public: false, botsProtectionLevel: "off" },
  });
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext();
  const collected = [];
  const deliveries = [];
  await context.route(`${fixtureOrigin}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const file = resolve(
      directory,
      `.${pathname === "/" ? "/index.html" : pathname}`,
    );
    assert.ok(file.startsWith(`${directory}${sep}`));
    const contentType =
      Object.entries(mimeTypes).find(([extension]) =>
        file.endsWith(extension),
      )?.[1] ?? "application/octet-stream";
    await stat(file);
    await route.fulfill({ body: await readFile(file), contentType });
  });
  await context.route(
    "https://swetrix.pureportal.io/backend/log**",
    async (route) => {
      const body = route.request().postDataJSON();
      collected.push(body);
      const response = await route.fetch({
        postData: JSON.stringify({ ...body, pid: verificationProject.id }),
      });
      assert.equal(response.status(), 201);
      const responseText = await response.text();
      assert.ok(!responseText.includes("ignored"), responseText);
      deliveries.push({
        endpoint: new URL(route.request().url()).pathname,
        status: response.status(),
      });
      await route.fulfill({ response });
    },
  );
  const page = await context.newPage();
  await page.goto(fixtureOrigin, { waitUntil: "networkidle" });
  assert.equal(collected.length, 0);
  await page.getByText("Analytics", { exact: true }).click();
  assert.equal(collected.length, 0);
  const initialResponse = page.waitForResponse((response) =>
    response.url().endsWith("/backend/log"),
  );
  await page.getByLabel("Share usage and diagnostics").check();
  await initialResponse;
  await page.waitForFunction(() =>
    localStorage
      .getItem("machdoch:analytics:landing")
      ?.includes('"enabled":true'),
  );
  await page.waitForLoadState("networkidle");
  assert.ok(collected.some((payload) => payload.ev === "session.started"));
  const rememberedResponse = page.waitForResponse((response) =>
    response.url().endsWith("/backend/log"),
  );
  await page.reload({ waitUntil: "networkidle" });
  await rememberedResponse;
  const rememberedPage = collected.filter((payload) => payload.perf).at(-1);
  assert.ok(rememberedPage.perf.page_load > 0);
  assert.equal(Object.keys(rememberedPage.perf).length, 8);
  await page.getByText("Analytics", { exact: true }).click();
  await page.evaluate(() => {
    document.addEventListener("click", (event) => {
      if (
        event.target instanceof Element &&
        event.target.closest("a.download-card")
      )
        event.preventDefault();
    });
  });
  await page.locator("a.download-card").first().click();
  await page.waitForLoadState("networkidle");
  assert.ok(
    collected.some(
      (payload) =>
        payload.ev === "landing.download.clicked" &&
        payload.meta.platform === "windows-x64",
    ),
  );
  const errorResponse = page.waitForResponse((response) =>
    response.url().endsWith("/backend/log/error"),
  );
  await page.evaluate(() => {
    const reason = new TypeError("private-person@example.com private prompt");
    reason.stack =
      "TypeError: private prompt\n at https://private-host/assets/main-abc.js:12:4";
    window.dispatchEvent(new ErrorEvent("error", { error: reason }));
  });
  await errorResponse;
  assert.ok(collected.some((payload) => payload.name === "TypeError"));
  assert.ok(!JSON.stringify(collected).includes("private-person"));
  assert.ok(!JSON.stringify(collected).includes("private prompt"));
  await page.getByLabel("Share usage and diagnostics").uncheck();
  await page.waitForLoadState("networkidle");
  const withdrawnCount = collected.length;
  await page.locator("a.download-card").first().click();
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await page.waitForLoadState("networkidle");
  assert.equal(collected.length, withdrawnCount);
  assert.equal(await page.evaluate(() => document.cookie), "");
  assert.equal(
    await page.evaluate(
      () =>
        Object.keys(localStorage).filter((key) =>
          key.startsWith("machdoch:analytics:"),
        ).length,
    ),
    1,
  );
  let stats;
  const deadline = Date.now() + 20_000;
  do {
    stats = await swetrixRequest(
      `/log?pid=${verificationProject.id}&period=1d&timeBucket=hour`,
    );
    if (
      stats.params.pg.length &&
      JSON.stringify(stats.customs).includes("landing.download.clicked")
    )
      break;
    await new Promise((complete) => setTimeout(complete, 1000));
  } while (Date.now() < deadline);
  assert.ok(
    stats.params.pg.some(
      (entry) => entry.name === "/" || entry.value === "/" || entry.pg === "/",
    ),
    JSON.stringify(stats.params.pg),
  );
  assert.ok(
    JSON.stringify(stats.customs).includes("landing.download.clicked"),
    JSON.stringify(stats.customs),
  );
  await swetrixRequest(
    `/log/performance?pid=${verificationProject.id}&period=1d&timeBucket=hour`,
  );
  const metrics = new URLSearchParams({
    pid: verificationProject.id,
    period: "1d",
    timeBucket: "hour",
    metrics: JSON.stringify([
      {
        customEventName: "web-vital",
        metricKey: "value",
        metaValueType: "float",
        metaKey: "metric",
        metaValue: "LCP",
      },
    ]),
  });
  await swetrixRequest(`/log?${metrics}`);
  const eventQuery = new URLSearchParams({
    pid: verificationProject.id,
    period: "1d",
    timeBucket: "hour",
    customEvents: JSON.stringify(["landing.download.clicked", "feature.used"]),
  });
  await swetrixRequest(`/log/custom-events?${eventQuery}`);
  reports.push({
    app: "landing",
    consent: "passed",
    withdrawal: "passed",
    privacy: "passed",
    liveDelivery: deliveries,
    statisticsReadback: "passed",
    performanceReadback: "passed",
    rememberedConsentNavigation: "passed",
    customMetricsReadback: "passed",
  });
  await context.close();
  const privacyContext = await browser.newContext();
  await privacyContext.addInitScript(() =>
    Object.defineProperty(navigator, "globalPrivacyControl", { value: true }),
  );
  await privacyContext.route(`${fixtureOrigin}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const file = resolve(
      directory,
      `.${pathname === "/" ? "/index.html" : pathname}`,
    );
    assert.ok(file.startsWith(`${directory}${sep}`));
    const contentType =
      Object.entries(mimeTypes).find(([extension]) =>
        file.endsWith(extension),
      )?.[1] ?? "application/octet-stream";
    await route.fulfill({ body: await readFile(file), contentType });
  });
  let privacyRequests = 0;
  await privacyContext.route(
    "https://swetrix.pureportal.io/**",
    async (route) => {
      privacyRequests += 1;
      await route.abort();
    },
  );
  const privacyPage = await privacyContext.newPage();
  await privacyPage.goto(fixtureOrigin, { waitUntil: "networkidle" });
  await privacyPage.getByText("Analytics", { exact: true }).click();
  assert.equal(
    await privacyPage.getByLabel("Share usage and diagnostics").isDisabled(),
    true,
  );
  assert.equal(privacyRequests, 0);
  reports.push({ globalPrivacyControl: "passed" });
  await privacyContext.close();
  await swetrixRequest(`/project/${verificationProject.id}`, {
    method: "PUT",
    body: { botsProtectionLevel: "basic" },
  });
  const cliClient = new AnalyticsClient({
    app: "software",
    version: "30.1.0",
    surface: "cli",
    enabled: () => true,
    fetch: async (url, init) => {
      const payload = JSON.parse(init.body);
      const response = await fetch(url, {
        ...init,
        body: JSON.stringify({ ...payload, pid: verificationProject.id }),
      });
      assert.equal(response.status, 201);
      assert.ok(!(await response.clone().text()).includes("ignored"));
      return response;
    },
  });
  cliClient.pageview("/cli/run");
  cliClient.track("operation.completed", {
    operation: "cli.run",
    duration_ms: 123,
  });
  await cliClient.flush();
  assert.equal(cliClient.deliveryFailures, 0);
  cliClient.stop();
  const cliMetricQuery = new URLSearchParams({
    pid: verificationProject.id,
    period: "1d",
    timeBucket: "hour",
    metrics: JSON.stringify([
      {
        customEventName: "operation.completed",
        metricKey: "duration_ms",
        metaValueType: "integer",
      },
    ]),
  });
  const cliMetricDeadline = Date.now() + 20_000;
  let cliStatistics;
  do {
    cliStatistics = await swetrixRequest(`/log?${cliMetricQuery}`);
    if (
      cliStatistics.meta?.some(
        (metric) => metric.key === "duration_ms" && metric.current.avg === 123,
      )
    )
      break;
    await new Promise((complete) => setTimeout(complete, 1000));
  } while (Date.now() < cliMetricDeadline);
  assert.ok(
    cliStatistics.meta?.some(
      (metric) => metric.key === "duration_ms" && metric.current.avg === 123,
    ),
  );
  reports.push({
    cliCollectionWithBotProtection: "passed",
    numericOperationMetricReadback: "passed",
  });
  process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
} finally {
  await browser?.close();
  await swetrixRequest(`/project/${verificationProject.id}`, {
    method: "DELETE",
  });
}

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import puppeteer, { type Page } from "puppeteer-core";
import { FleetCliProductRuntime } from "../apps/client/src/cli/_helpers/cli-fleet-product.ts";
import { runFleetGatewayConnection } from "../apps/client/src/cli/_helpers/cli-fleet-gateway.ts";
import { loadRuntimeConfig } from "../apps/client/src/core/config.ts";
import { writeFleetConnectionConfig } from "../apps/client/src/core/fleet-connection.ts";
import { createServer } from "node:net";
import { createRequire } from "node:module";

const baseUrl = process.env.MACHDOCH_FLEET_UI_URL ?? "http://127.0.0.1:43188";
const username = process.env.MACHDOCH_FLEET_UI_USERNAME;
const password = process.env.MACHDOCH_FLEET_UI_PASSWORD;
assert.ok(
  username && password && process.env.MACHDOCH_FLEET_UI_FIXTURE === "true",
  "Use an isolated seeded Fleet Manager and set MACHDOCH_FLEET_UI_USERNAME, MACHDOCH_FLEET_UI_PASSWORD, and MACHDOCH_FLEET_UI_FIXTURE=true.",
);
const candidates = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean) as string[];
let executablePath: string | undefined;
for (const candidate of candidates) {
  try {
    await access(candidate);
    executablePath = candidate;
    break;
  } catch {}
}
assert.ok(executablePath, "Install Chrome/Edge or set CHROME_PATH.");
const output = path.resolve(
  process.env.MACHDOCH_PREVIEWS_OUTPUT ??
    "apps/fleet-manager/.cache/previews-results",
);
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(tmpdir(), "machdoch-preview-browser-"));
process.env.MACHDOCH_USER_CONFIG_DIR = path.join(root, "config");
process.env.MACHDOCH_WORKSPACE_ROOT = path.join(root, "projects");
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ["--host-resolver-rules=MAP *.preview.localhost 127.0.0.1"],
});
let page: Page;
const errors: string[] = [];
const controller = new AbortController();
let gateway: Promise<unknown> | undefined;
let instanceId: string | undefined;
let runtime: FleetCliProductRuntime | undefined;
const createRuntime = () =>
  FleetCliProductRuntime.create(root, {
    loadRuntimeConfig: async (...args) => ({
      ...(await loadRuntimeConfig(...args)),
      provider: "openai",
      model: "fixture-model",
      offline: false,
      providerAvailability: [{ provider: "openai", configured: true }],
    }),
    createTaskExecutionController: (task, config) => ({
      signal: new AbortController().signal,
      cancel: () => undefined,
      execute: async () => {
        await writeFile(
          path.join(config.workspaceRoot, "fleet-browser-task.txt"),
          "Task reached the selected project.",
        );
        return {
          task,
          mode: config.mode,
          status: "executed",
          summary: "The task reached the selected project.",
          executedTools: [],
          outputSections: [],
        };
      },
    }),
  });

async function api(route: string, method = "GET", body?: unknown) {
  return await page.evaluate(
    async ({ route, method, body }) => {
      const csrf = document.cookie
        .split(";")
        .map((part) => part.trim().split("="))
        .find(([key]) => key === "__Host-machdoch_fleet_csrf")?.[1];
      const response = await fetch(route, {
        method,
        headers: {
          "X-Machdoch-Fleet-CSRF": csrf ?? "",
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error ?? `HTTP ${response.status}`);
      return result;
    },
    { route, method, body },
  );
}

async function click(label: string, scope = "") {
  await page.waitForFunction(
    ({ label, scope }) =>
      [...document.querySelectorAll<HTMLButtonElement>(`${scope}button`)].some(
        (button) => button.textContent?.trim() === label && !button.disabled,
      ),
    {},
    { label, scope },
  );
  for (const element of await page.$$(`${scope}button`)) {
    if (
      (await element.evaluate(
        (element, label) =>
          element.textContent?.trim() === label &&
          !(element as HTMLButtonElement).disabled,
        label,
      )) &&
      (await element.isVisible())
    ) {
      await element.scrollIntoView();
      await element.click();
      return;
    }
    await element.dispose();
  }
  throw new Error(`Control not found: ${label}`);
}

async function checkLayout(label: string) {
  await page.$eval("main", (main) => main.scrollTo(0, 0));
  const viewport = page.viewport()!;
  const width = await page.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  assert.equal(
    width.viewport,
    viewport.width,
    `${label}: expanded mobile viewport`,
  );
  assert.ok(
    width.document <= viewport.width + 1,
    `${label}: horizontal overflow`,
  );
  const dialog = await page.$('[role="dialog"]');
  if (dialog) {
    const rect = await dialog.boundingBox();
    assert.ok(
      rect &&
        rect.x >= 0 &&
        rect.y >= 0 &&
        rect.x + rect.width <= viewport.width + 1 &&
        rect.y + rect.height <= viewport.height + 1,
      `${label}: dialog overflow`,
    );
  }
  await page.screenshot({
    path: path.join(
      output,
      `${viewport.width}-${viewport.height}-${label}.png`,
    ),
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

try {
  page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  runtime = await createRuntime();
  await page.setViewport({
    width: 390,
    height: 844,
    isMobile: true,
    hasTouch: true,
  });
  await page.goto(`${baseUrl}/login`, { waitUntil: "networkidle2" });
  await page.type("#username", username);
  await page.type("#password", password);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => location.pathname === "/instances");
  const grant = await api("/api/enrollment-keys", "POST");
  const instanceSecret = `mch_instance_${randomBytes(32).toString("base64url")}`;
  const enrolled = await fetch(`${baseUrl}/api/enroll`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${grant.enrollmentKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      displayName: "Preview browser verification",
      instanceSecret,
      productVersion: "10.1.1",
      protocolVersion: 4,
    }),
  });
  assert.ok(enrolled.ok, `Enrollment failed: ${enrolled.status}`);
  const enrollment = await enrolled.json();
  instanceId = enrollment.instanceId;
  const config = {
    schemaVersion: 1 as const,
    enabled: true,
    managerUrl: baseUrl,
    managerId: enrollment.managerId,
    instanceId: instanceId!,
    displayName: "Preview browser verification",
    instanceSecret,
  };
  await writeFleetConnectionConfig(config, { allowLoopbackHttp: true });
  let connected!: () => void;
  const ready = new Promise<void>((done) => {
    connected = done;
  });
  gateway = runFleetGatewayConnection({
    config,
    signal: controller.signal,
    productVersion: "10.1.1",
    handleRequest: async (request) => {
      const response = await runtime!.handleRequest(request);
      if (request.type === "openPreviewTunnel" && response.type === "error")
        console.error("Host tunnel error:", response.message);
      return response;
    },
    onConnected: connected,
  });
  await Promise.race([
    ready,
    gateway.then(() => {
      throw new Error("Gateway stopped.");
    }),
  ]);
  const webPort = await freePort();
  const backendPort = await freePort();
  const wsPath = createRequire(
    new URL("../apps/client/package.json", import.meta.url),
  ).resolve("ws");
  const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Private preview fixture</title><h1>Fleet preview works</h1><p id="backend">Waiting for API</p><p id="socket">Waiting for WebSocket</p><script>fetch('/api/status').then(r=>r.json()).then(v=>document.getElementById('backend').textContent=v.message); const ws=new WebSocket(location.origin.replace('http','ws')+'/hmr');ws.onopen=()=>ws.send('HMR connected');ws.onmessage=e=>document.getElementById('socket').textContent=e.data;ws.onclose=()=>document.getElementById('socket').textContent='Disconnected';</script>`;
  await writeFile(
    path.join(root, "frontend.cjs"),
    `const {createServer}=require('node:http'); const {WebSocketServer}=require(${JSON.stringify(wsPath)}); const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(${JSON.stringify(html)});});const wss=new WebSocketServer({server});wss.on('connection',ws=>ws.on('message',v=>ws.send(v.toString())));server.listen(${webPort},'127.0.0.1',()=>console.log('Frontend ready'));`,
  );
  await writeFile(
    path.join(root, "backend.cjs"),
    `require('node:http').createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({message:'Backend connected',cookie:req.headers.cookie||''}));}).listen(${backendPort},'127.0.0.1',()=>console.log('Backend ready'));`,
  );
  await page.goto(`${baseUrl}/instances/${instanceId}/runs`, {
    waitUntil: "networkidle2",
  });
  await page.waitForFunction(() =>
    document.body.textContent?.includes("Run your project here"),
  );
  await page.evaluate(() => {
    for (const details of document.querySelectorAll("details"))
      if (details.querySelector("summary")?.textContent === "Add service")
        details.open = true;
  });
  await page.type('input[placeholder="Frontend"]', "Frontend");
  await page.type(
    'input[placeholder="pnpm run dev --host 127.0.0.1"]',
    `"${process.execPath}" frontend.cjs`,
  );
  await page.type('input[placeholder="3000"]', String(webPort));
  await click("Save service");
  await page.waitForFunction(
    () => document.querySelector("article h2")?.textContent === "Frontend",
  );
  const runsPath = `/api/instances/${instanceId}/runs?workspace=${encodeURIComponent(root)}`;
  let runStatus = await api(runsPath);
  const frontend = runStatus.snapshot.document.configurations[0];
  const backend = {
    ...frontend,
    id: "backend",
    name: "Backend",
    primary: false,
    command: `"${process.execPath}" backend.cjs`,
    ports: [backendPort],
    urls: [`http://127.0.0.1:${backendPort}`],
    healthCheck: {
      kind: "tcp",
      host: "127.0.0.1",
      port: backendPort,
      restartOnFailure: false,
    },
  };
  await api(runsPath, "POST", {
    action: "save",
    commandId: randomUUID(),
    expectedRevision: runStatus.snapshot.revision,
    document: { schemaVersion: 2, configurations: [frontend, backend] },
  });
  await api(runsPath, "POST", {
    action: "start",
    commandId: randomUUID(),
    configurationId: "backend",
  });
  await click("Start", "article:first-of-type ");
  await page.waitForFunction(
    (port) =>
      [...document.querySelectorAll("button")].some(
        (button) =>
          button.textContent?.includes(`Preview :${port}`) && !button.disabled,
      ),
    {},
    webPort,
  );
  await page.evaluate(() => {
    for (const details of document.querySelectorAll("details"))
      if (
        details
          .querySelector("summary")
          ?.textContent?.includes("Connect a backend")
      )
        details.open = true;
  });
  await page.select("details select", `backend:${backendPort}`);
  const target = browser.waitForTarget(
    (target) => target.url().includes(".preview.localhost"),
    { timeout: 30000 },
  );
  await click(`Preview :${webPort}`);
  const preview = await (await target).page();
  assert.ok(preview);
  await preview.waitForFunction(
    () =>
      document.querySelector("#backend")?.textContent === "Backend connected" &&
      document.querySelector("#socket")?.textContent === "HMR connected",
    { timeout: 30000 },
  );
  assert.equal(await preview.evaluate(() => window.opener), null);
  assert.equal(
    await preview.evaluate(
      async () => (await fetch("/api/status").then((r) => r.json())).cookie,
    ),
    "",
  );
  await preview.screenshot({
    path: path.join(output, "private-preview.png"),
    fullPage: true,
  });
  await page.bringToFront();
  await click("Restart", "article:first-of-type ");
  await page.waitForFunction(
    (port) =>
      [...document.querySelectorAll("button")].some(
        (button) =>
          button.textContent?.includes(`Preview :${port}`) && !button.disabled,
      ),
    {},
    webPort,
  );
  await preview.reload({ waitUntil: "networkidle2" });
  await preview.waitForFunction(
    () => document.querySelector("#socket")?.textContent === "HMR connected",
  );
  await page.bringToFront();
  for (const viewport of [
    { width: 320, height: 844 },
    { width: 390, height: 844 },
    { width: 768, height: 844 },
    { width: 1440, height: 900 },
    { width: 390, height: 360 },
  ]) {
    await page.setViewport({
      ...viewport,
      isMobile: viewport.width < 768,
      hasTouch: viewport.width <= 900,
    });
    await checkLayout("services");
  }
  await click("Stop", "article:first-of-type ");
  await preview.waitForFunction(
    () => document.querySelector("#socket")?.textContent === "Disconnected",
  );
  await click("Close preview");
  await page.waitForFunction(
    () => !document.querySelector('[aria-label="Private previews"]'),
  );
  await api(runsPath, "POST", {
    action: "stop",
    commandId: randomUUID(),
    configurationId: "backend",
  });
  await click("Refresh");
  await click("Edit run.json");
  for (const viewport of [
    { width: 320, height: 844 },
    { width: 390, height: 360 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewport({
      ...viewport,
      isMobile: viewport.width < 768,
      hasTouch: viewport.width <= 900,
    });
    await checkLayout("run-editor");
  }
  assert.deepEqual(errors, []);
  console.log(
    `Passed real headless service start/restart/stop, private preview launch, API routing, WebSocket hot reload, cookie isolation, revocation, and 8 responsive checks. Screenshots: ${output}`,
  );
} catch (error) {
  if (page!) {
    for (const tab of await browser.pages())
      if (tab.url().includes(".preview.localhost"))
        console.error(
          "Preview result:",
          await tab
            .$eval("body", (el) => el.textContent?.slice(0, 200))
            .catch(() => "unavailable"),
        );
    await page
      .screenshot({ path: path.join(output, "failure.png"), fullPage: true })
      .catch(() => undefined);
    console.error(
      "Browser alerts:",
      await page
        .$$eval('[role="alert"]', (elements) =>
          elements.map((e) => e.textContent),
        )
        .catch(() => []),
    );
    console.error(
      "Open page paths:",
      (await browser.pages()).map((p) => {
        const url = new URL(p.url());
        return `${url.origin}${url.pathname}`;
      }),
    );
  }
  throw error;
} finally {
  controller.abort();
  const stopped = await Promise.allSettled([gateway, runtime?.shutdown()]);
  if (instanceId && page!)
    await api(
      `/api/instances/${encodeURIComponent(instanceId)}`,
      "DELETE",
    ).catch(() => undefined);
  await browser.close();
  const relative = path.relative(path.resolve(tmpdir()), path.resolve(root));
  assert.ok(
    relative.startsWith("machdoch-preview-browser-") &&
      !relative.includes(path.sep),
    "Refusing to remove unexpected test directory",
  );
  await rm(root, { recursive: true, force: true });
  assert.ok(
    stopped.every((result) => result.status === "fulfilled"),
    "Fixture shutdown failed",
  );
}

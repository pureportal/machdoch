import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { verifyAndroidController } from "./verify-android.mjs";

const managerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const clientRoot = resolve(managerRoot, "../client");
const bundledClient = process.env.FLEET_VERIFY_CLIENT_BUNDLE === "1";
const clientEntry = bundledClient
  ? ["dist/machdoch-cli.cjs"]
  : ["--import", "@oxc-node/core/register", "src/cli/main.ts"];
const fixtureRoot = join(
  managerRoot,
  ".next",
  "fleet-verification",
  String(Date.now()),
);
const children = new Set();
let proxy;
let browser;
const evidence = [];

function launch(args, cwd, environment = {}) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...environment },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let logs = "";
  child.stdout.on("data", (data) => {
    logs = (logs + data).slice(-8000);
  });
  child.stderr.on("data", (data) => {
    logs = (logs + data).slice(-8000);
  });
  child.finished = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  child.logs = () => logs;
  return child;
}

async function stop(child) {
  if (child.exitCode === null) child.kill("SIGTERM");
  await child.finished;
  children.delete(child);
}

async function eventually(check, message, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(message, { cause: lastError });
}

async function availablePort() {
  const listener = createTcpServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function runOpenSsl(args) {
  const child = spawn(
    process.env.OPENSSL_PATH ?? "C:/Program Files/Git/usr/bin/openssl.exe",
    args,
    { windowsHide: true, stdio: "ignore" },
  );
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(code, 0, "Test TLS certificate could not be generated.");
}

async function main() {
  await mkdir(fixtureRoot, { recursive: true });
  const managerPort = await availablePort();
  const keyPath = join(fixtureRoot, "tls.key");
  const certificatePath = join(fixtureRoot, "tls.crt");
  await runOpenSsl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certificatePath,
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
  ]);
  proxy = createHttpsServer(
    { key: await readFile(keyPath), cert: await readFile(certificatePath) },
    (request, response) => {
      const upstream = httpRequest(
        {
          hostname: "127.0.0.1",
          port: managerPort,
          method: request.method,
          path: request.url,
          headers: request.headers,
        },
        (result) => {
          response.writeHead(result.statusCode, result.headers);
          result.pipe(response);
        },
      );
      upstream.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      request.pipe(upstream);
    },
  );
  proxy.on("upgrade", (request, socket, head) => {
    const upstream = httpRequest({
      hostname: "127.0.0.1",
      port: managerPort,
      method: request.method,
      path: request.url,
      headers: request.headers,
    });
    upstream.on("upgrade", (response, remote, remoteHead) => {
      socket.write(
        `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${response.rawHeaders.reduce((lines, value, index, all) => (index % 2 === 0 ? `${lines}${value}: ${all[index + 1]}\r\n` : lines), "")}\r\n`,
      );
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      remote.on("error", () => socket.destroy());
      socket.on("error", () => remote.destroy());
      remote.pipe(socket);
      socket.pipe(remote);
    });
    upstream.on("response", (response) => {
      socket.end(
        `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\nConnection: close\r\n\r\n`,
      );
      response.resume();
    });
    upstream.on("error", () => socket.destroy());
    upstream.end();
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const origin = `https://127.0.0.1:${proxy.address().port}`;
  const configurationPath = join(fixtureRoot, "manager.json");
  const settingsKeyPath = join(fixtureRoot, "settings.key");
  await writeFile(settingsKeyPath, randomBytes(32).toString("base64url"), {
    mode: 0o600,
  });
  await writeFile(
    configurationPath,
    JSON.stringify({
      schemaVersion: 1,
      externalBaseUrl: origin,
      listen: { address: "127.0.0.1", port: managerPort },
      database: { path: join(fixtureRoot, "manager.sqlite") },
      settingsManager: { enabled: true, encryptionKeyFile: settingsKeyPath },
    }),
  );
  const password = randomBytes(24).toString("base64url");
  const seed = launch(
    [
      "--import",
      "@oxc-node/core/register",
      "src/server.ts",
      "seed",
      "--config",
      configurationPath,
    ],
    managerRoot,
    {
      FLEET_MANAGER_SEED_USERNAME: "verification",
      FLEET_MANAGER_SEED_PASSWORD: password,
    },
  );
  assert.equal(await seed.finished, 0, seed.logs());
  children.delete(seed);
  const launchManager = () =>
    launch(
      [
        "--import",
        "@oxc-node/core/register",
        "src/server.ts",
        "serve",
        "--config",
        configurationPath,
      ],
      managerRoot,
    );
  let manager = launchManager();
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ??
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await eventually(
    async () => (await context.request.get(`${origin}/healthz`)).ok(),
    "Production manager did not start.",
  );
  const login = await context.request.post(`${origin}/api/auth/login`, {
    headers: { Origin: origin },
    data: { username: "verification", password },
  });
  assert.equal(login.status(), 200);
  const csrfCookie = (await context.cookies()).find(
    (cookie) => cookie.name === "__Host-machdoch_fleet_csrf",
  );
  assert.ok(csrfCookie);
  const mutationHeaders = {
    Origin: origin,
    "X-Machdoch-Fleet-CSRF": csrfCookie.value,
  };
  const api = async (path, method = "GET", data) => {
    const response = await context.request.fetch(`${origin}/api${path}`, {
      method,
      ...(method === "GET" ? {} : { headers: mutationHeaders }),
      ...(data === undefined ? {} : { data }),
    });
    assert.ok(
      response.ok(),
      `${method} ${path}: ${response.status()} ${await response.text()}`,
    );
    return response.status() === 204 ? null : response.json();
  };
  const created = await api("/settings/profiles", "POST", { name: "Shared" });
  process.stdout.write("Production manager authenticated.\n");
  let profile = created.profile;
  profile.document.defaults = {
    ...profile.document.defaults,
    provider: "openai",
    model: "gpt-5.4",
    mode: "ask",
  };
  profile.document.instructions = [
    {
      id: randomUUID(),
      name: "Review",
      body: "Review the existing profile.",
      global: true,
      enabled: true,
      tags: [],
    },
  ];
  profile = (
    await api(`/settings/profiles/${profile.profileId}`, "PUT", {
      expectedRevision: profile.revision,
      name: profile.name,
      document: profile.document,
    })
  ).profile;
  const devices = [];
  for (const name of ["alpha", "beta"]) {
    const deviceRoot = join(fixtureRoot, name);
    const userRoot = join(deviceRoot, "user");
    const workspace = join(deviceRoot, "workspace");
    await mkdir(join(userRoot, "prompts"), { recursive: true });
    await mkdir(join(workspace, ".machdoch"), { recursive: true });
    await writeFile(
      join(workspace, ".machdoch", "config.json"),
      JSON.stringify({
        provider: "openai",
        model: "gpt-5.4",
        defaultMode: "machdoch",
        offline: true,
      }),
    );
    await writeFile(
      join(userRoot, "user-config.json"),
      JSON.stringify({ apiKeys: { openai: `fixture-${name}-key` } }),
      { mode: 0o600 },
    );
    await writeFile(
      join(userRoot, "prompts", `${name}.prompt.md`),
      `Review ${name} changes.`,
    );
    const now = new Date().toISOString();
    await writeFile(
      join(userRoot, "instruction-library.json"),
      JSON.stringify({
        schemaVersion: 2,
        revision: 1,
        profiles: [
          {
            id: randomUUID(),
            name: "Review",
            body: `Review ${name} before shipping.`,
            enabled: true,
            global: true,
            tags: [],
            createdAt: now,
            updatedAt: now,
          },
        ],
        workspaces: [],
      }),
    );
    const grant = await api("/enrollment-keys", "POST");
    const environment = {
      MACHDOCH_USER_CONFIG_DIR: userRoot,
      NODE_EXTRA_CA_CERTS: certificatePath,
      npm_package_version: name === "beta" ? "28.0.0" : "29.0.0",
    };
    const enrolled = launch(
      [
        ...clientEntry,
        "fleet",
        "enroll",
        "--manager-url",
        origin,
        "--enrollment-key",
        grant.enrollmentKey,
        "--display-name",
        name,
        "--cwd",
        workspace,
        "--json",
      ],
      clientRoot,
      environment,
    );
    assert.equal(await enrolled.finished, 0, enrolled.logs());
    children.delete(enrolled);
    const connection = JSON.parse(
      await readFile(join(userRoot, "fleet-connection.json"), "utf8"),
    );
    await api(
      `/settings/instances/${connection.instanceId}/assignment`,
      "PUT",
      { profileId: profile.profileId },
    );
    const launchService = () =>
      launch(
        [...clientEntry, "fleet", "service", "--cwd", workspace, "--json"],
        clientRoot,
        environment,
      );
    devices.push({
      name,
      userRoot,
      workspace,
      connection,
      launchService,
      process: launchService(),
    });
  }
  await eventually(async () => {
    const status = await api("/fleet/status");
    const assignments = (await api("/settings/assignments")).assignments;
    return (
      status.devices.length === 2 &&
      status.devices.every(
        (device) =>
          device.online && !device.error && device.sessions.length > 0,
      ) &&
      assignments.every((assignment) => assignment.syncStatus === "applied")
    );
  }, "Devices did not enroll, connect and apply the shared profile.");
  const captured = (await api("/settings/enrollment")).devices;
  assert.equal(captured.length, 2);
  evidence.push(
    `Two ${bundledClient ? "bundled" : "source"} CLI services enrolled over TLS, captured original local settings, connected through the real gateway, and acknowledged the shared profile.`,
  );
  process.stdout.write("Both clients enrolled and synchronized.\n");
  const page = await context.newPage();
  await page.goto(`${origin}/settings`);
  await page.getByRole("tab", { name: "Device settings", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Device settings", exact: true })
    .selectOption(devices[0].connection.instanceId);
  await page.getByText("Instruction: Review", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Merge settings", exact: true })
      .isDisabled(),
    true,
  );
  await page
    .locator("fieldset")
    .filter({ has: page.locator("legend", { hasText: "Mode" }) })
    .getByText("Keep profile", { exact: true })
    .click();
  await page
    .locator("fieldset")
    .filter({ has: page.locator("legend", { hasText: "Instruction: Review" }) })
    .getByText("Use device", { exact: true })
    .click();
  await page.screenshot({
    path: join(fixtureRoot, "merge-desktop.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Merge settings", exact: true })
    .click();
  await eventually(async () => {
    const result = await api(`/settings/profiles/${profile.profileId}`);
    return result.profile.revision > profile.revision;
  }, "Reviewed merge was not saved.");
  const merged = (await api(`/settings/profiles/${profile.profileId}`)).profile;
  assert.equal(merged.document.defaults.mode, "ask");
  assert.equal(
    merged.document.instructions[0].body,
    "Review alpha before shipping.",
  );
  assert.equal(merged.document.prompts[0].relativePath, "alpha.prompt.md");
  await eventually(
    async () =>
      (await api("/settings/assignments")).assignments.every(
        (assignment) => assignment.lastAppliedRevision === merged.revision,
      ),
    "Both devices did not acknowledge the merged revision.",
  );
  evidence.push(
    "The production browser UI merged a device baseline into a shared profile with per-conflict choices; both devices applied the new revision.",
  );
  process.stdout.write("Reviewed merge applied on both clients.\n");
  const conflict = await context.request.put(
    `${origin}/api/settings/profiles/${profile.profileId}`,
    {
      headers: mutationHeaders,
      data: {
        expectedRevision: profile.revision,
        name: profile.name,
        document: profile.document,
      },
    },
  );
  assert.equal(conflict.status(), 409);
  const small = await context.newPage();
  await small.setViewportSize({ width: 390, height: 844 });
  await small.goto(`${origin}/settings`);
  await small.getByLabel("Profile section").selectOption("device-settings");
  await small
    .getByRole("combobox", { name: "Device settings", exact: true })
    .selectOption(devices[1].connection.instanceId);
  await small.getByText("Instruction: Review", { exact: true }).waitFor();
  assert.ok(
    await small.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await small.screenshot({
    path: join(fixtureRoot, "merge-mobile.png"),
    fullPage: true,
  });
  evidence.push(
    "Revision conflicts returned 409. The merge screen rendered at 390px without horizontal page overflow.",
  );
  process.stdout.write("Desktop and mobile merge checks passed.\n");
  if (process.env.FLEET_VERIFY_ANDROID_SERIAL) {
    evidence.push(
      await verifyAndroidController({
        serial: process.env.FLEET_VERIFY_ANDROID_SERIAL,
        origin,
        fixtureRoot,
        apkPath: resolve(
          managerRoot,
          "../fleet-android/app/build/outputs/apk/debug/app-debug.apk",
        ),
      }),
    );
    process.stdout.write(
      "Android origin, certificate, and recovery checks passed.\n",
    );
  }
  await stop(manager);
  await eventually(
    async () =>
      devices.every((device) => device.process.logs().includes("reconnecting")),
    "Devices did not detect the manager disconnect.",
  );
  for (const device of devices) {
    const cached = JSON.parse(
      await readFile(
        join(device.userRoot, "fleet-managed-settings.json"),
        "utf8",
      ),
    );
    assert.equal(cached.delivery.profile.revision, merged.revision);
  }
  manager = launchManager();
  await eventually(
    async () => (await context.request.get(`${origin}/healthz`)).ok(),
    "Production manager did not restart.",
  );
  await eventually(async () => {
    const status = await api("/fleet/status");
    return (
      status.devices.length === 2 &&
      status.devices.every(
        (device) =>
          device.online && !device.error && device.sessions.length > 0,
      )
    );
  }, "Devices did not reconnect after the manager restart.");
  evidence.push(
    "Both devices retained the last managed revision through a manager outage and reconnected after its restart.",
  );
  await api(`/instances/${devices[1].connection.instanceId}`, "DELETE");
  await eventually(
    async () => devices[1].process.exitCode !== null,
    "The revoked CLI service did not stop.",
  );
  assert.equal((await api("/fleet/status")).devices.length, 1);
  evidence.push(
    "Revoking a device closed its real gateway connection, stopped its CLI service, and removed it from fleet collection.",
  );
  await writeFile(
    join(fixtureRoot, "result.json"),
    JSON.stringify(
      {
        passed: true,
        verifiedAt: new Date().toISOString(),
        evidence,
        limits: [
          "Offline test model configuration; no provider-backed tasks or generated media.",
          "The older version was advertised by the current client; no historical binary was used.",
          process.env.FLEET_VERIFY_ANDROID_SERIAL
            ? "Android connection security only; authenticated Android workflows were not tested."
            : "Browser mobile viewport only; no Android device or emulator in this run.",
          "Temporary locally trusted TLS certificate; no production proxy audit.",
        ],
      },
      null,
      2,
    ),
  );
  process.stdout.write(
    `${JSON.stringify({ passed: true, fixtureRoot, evidence }, null, 2)}\n`,
  );
}

try {
  await main();
} catch (error) {
  await writeFile(
    join(fixtureRoot, "result.json"),
    JSON.stringify({ passed: false, evidence, error: error.message }, null, 2),
  );
  process.stderr.write(`${JSON.stringify({ fixtureRoot, evidence })}\n`);
  process.stderr.write(`${error.stack}\n`);
  for (const child of children) process.stderr.write(`${child.logs()}\n`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await Promise.allSettled([...children].map(stop));
  proxy?.closeAllConnections();
  if (proxy?.listening) await new Promise((resolve) => proxy.close(resolve));
}

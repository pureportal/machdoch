import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { WebSocket } from "ws";
import { createMobileDevice } from "./mobile-device-fixture.mjs";
import { createSecret } from "../src/server/crypto.ts";
import {
  gatewayProtocolVersion,
  productCapability,
} from "@machdoch/fleet-protocol";
const managerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = resolve(
  managerRoot,
  "../../.tmp/mobile-verification",
  String(Date.now()),
);
const children = new Set();
let proxy;
let browser;
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

async function createMobileFixture() {
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
  launchManager();
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ??
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    isMobile: true,
    hasTouch: true,
    viewport: { width: 390, height: 844 },
  });
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
  const grant = await api("/enrollment-keys", "POST");
  const instanceSecret = createSecret("mch_instance");
  const enrollment = await context.request.post(`${origin}/api/enroll`, {
    headers: { Authorization: `Bearer ${grant.enrollmentKey}` },
    data: {
      instanceSecret,
      displayName: "Legion Go S",
      productVersion: "30.2.1",
      protocolVersion: gatewayProtocolVersion,
    },
  });
  assert.ok(enrollment.ok(), await enrollment.text());
  const { instanceId } = await enrollment.json();
  const socket = new WebSocket(
    `${origin.replace("https:", "wss:")}/api/gateway/connect/${instanceId}`,
    {
      headers: { Authorization: `Bearer ${instanceSecret}` },
      rejectUnauthorized: false,
    },
  );
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const device = createMobileDevice(socket);
  socket.send(
    JSON.stringify({
      type: "hello",
      instanceId,
      protocolVersion: gatewayProtocolVersion,
      productVersion: "30.2.1",
      capabilities: [productCapability, "workspace-tools.v1"],
    }),
  );
  await eventually(
    async () =>
      (await api("/instances")).instances.some(
        (instance) =>
          instance.instanceId === instanceId && instance.status === "online",
      ),
    "Fixture device did not connect.",
  );
  return {
    browser,
    context,
    origin,
    api,
    fixtureRoot,
    instanceId,
    ...device,
    close: async () => {
      socket.terminate();
      await browser.close();
      await Promise.allSettled([...children].map(stop));
      proxy.closeAllConnections();
      await new Promise((resolve) => proxy.close(resolve));
    },
  };
}

export async function startMobileFixture() {
  try {
    return await createMobileFixture();
  } catch (error) {
    await writeFile(
      join(fixtureRoot, "startup-failure.txt"),
      `${error.stack}\n${[...children].map((child) => child.logs()).join("\n")}`,
    );
    await browser?.close();
    await Promise.allSettled([...children].map(stop));
    proxy?.closeAllConnections();
    proxy?.close();
    throw error;
  }
}

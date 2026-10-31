import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { chromium } from "playwright-core";

const managerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function cloudBrowserFixture({
  serverEntry = "src/server.ts",
  dropResponse,
  initialize = true,
  prepareLegacy,
} = {}) {
  assert.ok(
    process.env.MACHDOCH_CLOUD_DATABASE_URL,
    "Set MACHDOCH_CLOUD_DATABASE_URL to the test PostgreSQL server.",
  );
  const schema = `cloud_verify_${randomUUID().replaceAll("-", "")}`;
  const directory = join(managerRoot, "../../.tmp/cloud-verification", schema);
  const pool = new pg.Pool({
    connectionString: process.env.MACHDOCH_CLOUD_DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  const children = new Set();
  const proxySockets = new Set();
  const pageErrors = [];
  let proxy;
  let browser;
  let manager;
  let schemaCreated = false;
  let scopedDatabase;
  function launch(args, environment = {}) {
    const child = spawn(process.execPath, args, {
      cwd: managerRoot,
      env: { ...process.env, ...environment },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let logs = "";
    child.stdout.on("data", (data) => {
      logs = (logs + data).slice(-12000);
    });
    child.stderr.on("data", (data) => {
      logs = (logs + data).slice(-12000);
    });
    child.finished = new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", resolveExit);
    });
    child.logs = () => logs;
    return child;
  }
  async function stop(child) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await child.finished;
    children.delete(child);
  }
  async function close() {
    await browser?.close();
    for (const child of children) await stop(child);
    if (proxy) {
      for (const socket of proxySockets) socket.destroy();
      proxy.closeAllConnections();
      await new Promise((done) => proxy.close(done));
    }
    await scopedDatabase?.end();
    if (schemaCreated)
      await pool.query(`DROP DATABASE "${schema}" WITH (FORCE)`);
    await pool.end();
  }
  try {
    await mkdir(directory, { recursive: true });
    await pool.query(`CREATE DATABASE "${schema}"`);
    schemaCreated = true;
    const connection = new URL(process.env.MACHDOCH_CLOUD_DATABASE_URL);
    connection.pathname = `/${schema}`;
    connection.searchParams.delete("options");
    scopedDatabase = new pg.Pool({
      connectionString: connection.href,
      max: 3,
      connectionTimeoutMillis: 5000,
    });
    const reservation = createTcpServer();
    await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
    const managerPort = reservation.address().port;
    await new Promise((done) => reservation.close(done));
    const keyPath = join(directory, "tls.key");
    const certificatePath = join(directory, "tls.crt");
    const ssl = spawn(
      process.env.OPENSSL_PATH ?? "C:/Program Files/Git/usr/bin/openssl.exe",
      [
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
        "subjectAltName=IP:127.0.0.1,DNS:localhost",
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    assert.equal(
      await new Promise((done, reject) => {
        ssl.once("error", reject);
        ssl.once("exit", done);
      }),
      0,
    );
    proxy = createHttpsServer(
      { key: await readFile(keyPath), cert: await readFile(certificatePath) },
      (request, response) => {
        const upstream = httpRequest(
          {
            hostname: "127.0.0.1",
            port: managerPort,
            path: request.url,
            method: request.method,
            headers: request.headers,
          },
          (result) => {
            if (
              dropResponse?.({ path: request.url, status: result.statusCode })
            ) {
              result.resume();
              response.destroy();
              return;
            }
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
        socket.on("close", () => remote.destroy());
        remote.on("close", () => socket.destroy());
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
    proxy.on("connection", (socket) => {
      proxySockets.add(socket);
      socket.once("close", () => proxySockets.delete(socket));
    });
    await new Promise((done) => proxy.listen(0, "127.0.0.1", done));
    const origin = `https://127.0.0.1:${proxy.address().port}`;
    const configurationPath = join(directory, "import.json");
    await writeFile(
      configurationPath,
      JSON.stringify({
        schemaVersion: 1,
        externalBaseUrl: origin,
        listen: { address: "127.0.0.1", port: managerPort },
        database: { path: join(directory, "unused.sqlite") },
      }),
    );
    const password = randomBytes(24).toString("base64url");
    await prepareLegacy?.({
      directory,
      origin,
      password,
      configurationPath,
      managerPort,
    });
    const environment = {
      MACHDOCH_CLOUD_DATABASE_URL: connection.href,
      MACHDOCH_CLOUD_IMPORT_CONFIG: prepareLegacy ? configurationPath : "",
      PORT: String(managerPort),
      MACHDOCH_CLOUD_LISTEN_ADDRESS: "127.0.0.1",
      MACHDOCH_CLOUD_ORIGIN: "",
      MACHDOCH_CLOUD_ENCRYPTION_KEY: undefined,
      ...(serverEntry === "src/server.ts"
        ? {}
        : {
            MACHDOCH_CLOUD_ORIGIN: origin,
            MACHDOCH_CLOUD_ENCRYPTION_KEY:
              randomBytes(32).toString("base64url"),
          }),
    };
    const start = () =>
      launch(
        ["--import", "@oxc-node/core/register", serverEntry, "serve"],
        environment,
      );
    manager = start();
    browser = await chromium.launch({
      executablePath:
        process.env.CHROME_PATH ??
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
      headless: true,
    });
    const createContext = async (options = {}) => {
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1440, height: 1000 },
        ...options,
      });
      context.on("page", (page) =>
        page.on("pageerror", (error) => pageErrors.push(error.message)),
      );
      return context;
    };
    const ownerContext = await createContext();
    const waitForServer = async () => {
      const started = Date.now();
      await assertEventually(
        async () => {
          if (manager.exitCode !== null)
            throw new Error(
              `Manager exited: ${manager.exitCode}. ${manager.logs()}`,
            );
          return (await ownerContext.request.get(`${origin}/healthz`)).ok();
        },
        () => `Production server did not become ready. ${manager.logs()}`,
        180000,
      );
      process.stdout.write(
        `Production server ready in ${Date.now() - started}ms.\n`,
      );
    };
    await waitForServer();
    if (initialize) {
      const initialized = await ownerContext.request.post(
        `${origin}/api/v1/auth/setup`,
        {
          headers: { Origin: origin },
          data: {
            organization: "Cloud verification",
            name: "Owner",
            email: "owner@example.test",
            password,
          },
        },
      );
      assert.equal(initialized.status(), 201, await initialized.text());
    }
    const installation = (
      await scopedDatabase.query(
        "SELECT credentials_key FROM cloud_installation WHERE id=1",
      )
    ).rows[0];
    environment.MACHDOCH_CLOUD_ENCRYPTION_KEY = installation.credentials_key;
    environment.MACHDOCH_CLOUD_ORIGIN = origin;
    return {
      directory,
      browser,
      environment,
      origin,
      password,
      ownerContext,
      createContext,
      pageErrors,
      database: scopedDatabase,
      close,
      restart: async (beforeStart) => {
        await stop(manager);
        if (beforeStart) await beforeStart();
        manager = start();
        await waitForServer();
      },
      logs: () => manager.logs(),
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function assertEventually(
  check,
  describe = () => "Condition did not become true.",
  timeout = 15000,
) {
  const deadline = Date.now() + timeout;
  let cause;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      cause = error;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(describe(), { cause });
}

export async function cloudApi(
  fixture,
  context,
  path,
  method = "GET",
  data,
  key = randomUUID(),
) {
  if (
    method !== "GET" &&
    path.startsWith("schedules") &&
    data &&
    !data.account
  ) {
    const workspace = await cloudApi(fixture, context, "workspace");
    data = {
      ...data,
      account: {
        organizationId: workspace.organization.id,
        userId: workspace.actor.id,
      },
    };
  }
  const csrf = (await context.cookies()).find(
    (cookie) => cookie.name === "__Host-machdoch_cloud_csrf",
  );
  const response = await context.request.fetch(
    `${fixture.origin}/api/v1/${path}`,
    {
      method,
      headers: {
        Origin: fixture.origin,
        "x-machdoch-cloud-csrf": csrf?.value ?? "",
        "Idempotency-Key": key,
      },
      ...(data === undefined ? {} : { data }),
    },
  );
  assert.ok(
    response.ok(),
    `${method} ${path}: ${response.status()} ${await response.text()}`,
  );
  return response.json();
}

export async function executionProviderFixture(
  fixture,
  context,
  {
    name = "Execution fixture",
    models = ["fixture"],
    dailyTokenBudget = 100000,
  } = {},
) {
  return cloudApi(fixture, context, "ai-providers", "POST", {
    name,
    models,
    provider: "openai",
    region: null,
    apiKey: "verification-provider-key",
    maxOutputTokens: 512,
    dailyTokenBudget,
    maxConcurrentRequests: 4,
  });
}

export async function statusReference(fixture, context, teamId, category) {
  const workflow = await cloudApi(fixture, context, `teams/${teamId}/workflow`);
  const status = workflow.statuses.find(
    (entry) => entry.category === category && !entry.archived,
  );
  assert.ok(status, `No active status in category ${category}`);
  return { id: status.id, revision: status.revision };
}

export async function createPasswordInvitation(fixture, context, input) {
  const workspace = await cloudApi(fixture, context, "workspace");
  return cloudApi(fixture, context, "invitations", "POST", {
    ...input,
    organizationId: workspace.organization.id,
    authentication: { kind: "password" },
  });
}
export async function acceptPasswordInvitation(fixture, context, url, input) {
  const preview = await cloudApi(
    fixture,
    context,
    "invitations/prepare",
    "POST",
    { token: new URL(url).hash.slice(1) },
  );
  return cloudApi(fixture, context, "invitations/accept", "POST", {
    ...input,
    confirmationId: preview.confirmationId,
    sessionId: preview.currentSessionId,
  });
}

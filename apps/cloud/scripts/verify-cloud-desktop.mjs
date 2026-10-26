import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cloudApi,
  cloudBrowserFixture,
  executionProviderFixture,
  assertEventually,
} from "./cloud-browser-fixture.mjs";
import { workspaceGit } from "../../client/src/core/cloud/repository.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
assert.ok(
  process.env.MACHDOCH_NATIVE_TEST_BINARY,
  "Set MACHDOCH_NATIVE_TEST_BINARY to the current compiled desktop Rust test binary",
);
const ui = JSON.parse(
  await readFile(join(root, ".tmp/cloud-desktop-ui/current.json"), "utf8"),
);
const fixture = await cloudBrowserFixture();
const context = await fixture.createContext();
const page = await context.newPage();
const api = (path, method, body) =>
  cloudApi(fixture, fixture.ownerContext, path, method, body);
const configDirectory = join(fixture.directory, "desktop-config");
const workspace = join(fixture.directory, "source");
const children = new Set();
const tokens = new Set();
const calls = [];
const checks = [];
const unexpectedNativeCalls = [];
let initialReply;
let releaseInitial;
let holdInitial = true;
let remoteStatus = { enabled: false, phase: "disabled" };
let openedUrl;
const server = createServer(async (request, response) => {
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }
    const path = resolve(
      ui.directory,
      "." +
        decodeURIComponent(new URL(request.url, "http://localhost").pathname),
    );
    const child = relative(ui.directory, path);
    if (child.startsWith("..") || isAbsolute(child)) {
      response.writeHead(403).end();
      return;
    }
    const bytes = await readFile(path);
    response.setHeader(
      "Content-Type",
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".woff2": "font/woff2",
      }[extname(path)] ?? "application/octet-stream",
    );
    response.end(request.method === "HEAD" ? undefined : bytes);
  } catch {
    response.writeHead(404).end();
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
async function nativeRequest(request) {
  const directory = join(fixture.directory, "native-requests", randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const input = join(directory, "request.json");
  await writeFile(input, JSON.stringify(request), { mode: 0o600, flag: "wx" });
  const child = spawn(
    process.env.MACHDOCH_NATIVE_TEST_BINARY,
    [
      "--exact",
      "cloud_workspaces::tests::cloud_bridge_request_fixture",
      "--ignored",
    ],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...(process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
        PATH: process.env.PATH,
        MACHDOCH_USER_CONFIG_DIR: configDirectory,
        MACHDOCH_CLOUD_VERIFY_DIRECTORY: directory,
        NODE_EXTRA_CA_CERTS: join(fixture.directory, "tls.crt"),
      },
    },
  );
  children.add(child);
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (bytes) => {
    stdout += bytes;
    if (stdout.length > 4 * 1024 * 1024) child.kill();
  });
  child.stderr.on("data", (bytes) => {
    stderr += bytes;
    if (stderr.length > 65536) child.kill();
  });
  const guard = setTimeout(() => child.kill(), 90000);
  const finished = once(child, "exit");
  child.finished = finished;
  child.stdin.end();
  try {
    const [code] = await finished;
    assert.equal(code, 0, stderr);
    const reply = await readFile(join(directory, "reply.json"), "utf8");
    for (const token of tokens) {
      assert.ok(!JSON.stringify(child.spawnargs).includes(token));
      assert.ok(!stdout.includes(token));
      assert.ok(!stderr.includes(token));
      assert.ok(!reply.includes(token));
    }
    calls.push({
      action: request.action,
      tokenInArguments: false,
      tokenInReply: false,
    });
    return JSON.parse(reply);
  } finally {
    clearTimeout(guard);
    children.delete(child);
    await unlink(input);
  }
}
await page.exposeFunction("cloudFixtureInvoke", async (command, args) => {
  if (command === "cloud_workspace_request") {
    const reply = await nativeRequest(args.request);
    if (holdInitial && args.request.action === "list") {
      holdInitial = false;
      initialReply = reply;
      await new Promise((resolveReply) => {
        releaseInitial = resolveReply;
      });
    }
    return reply;
  }
  if (command === "plugin:dialog|open") return workspace;
  if (command === "plugin:opener|open_url") {
    openedUrl = args.url;
    return null;
  }
  if (command === "get_fleet_connection_status") return remoteStatus;
  if (command === "enroll_cloud_server") {
    remoteStatus = {
      enabled: true,
      phase: "connected",
      managerUrl: args.managerUrl,
      displayName: args.displayName,
    };
    return remoteStatus;
  }
  if (command === "reconnect_cloud_server") return remoteStatus;
  if (command === "plugin:event|listen") return 1;
  if (command === "plugin:event|unlisten") return null;
  unexpectedNativeCalls.push(command);
  throw new Error(`Unexpected native command: ${command}`);
});
await page.addInitScript(() => {
  window.isTauri = true;
  window.cloudNativePending = 0;
  let callback = 0;
  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    },
    transformCallback: () => ++callback,
    unregisterCallback: () => {},
    invoke: async (command, args) => {
      window.cloudNativePending++;
      try {
        return await window.cloudFixtureInvoke(command, args ?? {});
      } finally {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            window.cloudNativePending--;
          }),
        );
      }
    },
  };
});
function passed(name) {
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}
try {
  await api("auth/login", "POST", {
    email: "owner@example.test",
    password: fixture.password,
  });
  await mkdir(workspace);
  await workspaceGit(workspace, [
    "init",
    "--initial-branch=main",
    "--template=",
  ]);
  await workspaceGit(workspace, [
    "config",
    "remote.origin.url",
    "git@github.com:example/project.git",
  ]);
  await writeFile(join(workspace, "README"), "Desktop verification\n");
  await workspaceGit(workspace, ["add", "README"]);
  await workspaceGit(workspace, [
    "-c",
    "user.name=Verification",
    "-c",
    "user.email=verify@example.test",
    "commit",
    "-m",
    "Base",
  ]);
  const baseCommit = (
    await workspaceGit(workspace, ["rev-parse", "HEAD"])
  ).trim();
  const team = await api("teams", "POST", {
    name: "Desktop",
    key: "DESK",
    visibility: "organization",
    estimateScale: [
      { label: "1", points: 1 },
      { label: "2", points: 2 },
    ],
  });
  const project = await api("projects", "POST", {
    teamId: team.id,
    name: "Desktop project",
    description: "",
  });
  const provider = await executionProviderFixture(
    fixture,
    fixture.ownerContext,
  );
  const profile = await api("execution-profiles", "POST", {
    projectId: project.id,
    name: "Development",
    target: "client",
    repository: "https://github.com/example/project",
    baseCommit,
    providerId: provider.id,
    model: "fixture",
    maxDurationSeconds: 300,
    maxTokens: 10000,
    requiredChecks: [
      { name: "README", command: "node --test", timeoutSeconds: 30 },
    ],
  });
  const worker = await api("execution-workers", "POST", {
    profileId: profile.id,
    name: "Desktop machine",
  });
  tokens.add(worker.token);
  const other = await api("execution-workers", "POST", {
    profileId: profile.id,
    name: "Another machine",
  });
  tokens.add(other.token);
  await page.goto(
    `http://127.0.0.1:${server.address().port}/cloud-workspace-fixture.html`,
  );
  await page
    .getByRole("heading", { name: "machdoch.cloud", exact: true })
    .waitFor();
  await assertEventually(
    async () => Boolean(releaseInitial),
    () => "Initial connection snapshot was not captured",
  );
  await page
    .getByRole("button", { name: "Link workspace", exact: true })
    .click();
  const form = page.locator("form");
  await form.getByLabel("Cloud URL", { exact: true }).fill(fixture.origin);
  await form.getByRole("button", { name: "Get runner token" }).click();
  assert.equal(openedUrl, `${fixture.origin}/cloud/execution`);
  await form.getByRole("button", { name: "Choose workspace" }).click();
  await form.getByLabel("Name", { exact: true }).fill("Desktop checkout");
  await form.getByLabel("Runner token", { exact: true }).fill(worker.token);
  await form
    .getByRole("button", { name: "Link workspace", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Desktop project", exact: true })
    .waitFor();
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  assert.deepEqual(initialReply, { ok: true, connections: [] });
  releaseInitial();
  await page.waitForFunction(() => window.cloudNativePending === 0);
  assert.equal(
    await page
      .getByRole("heading", { name: "Desktop project", exact: true })
      .count(),
    1,
  );
  passed(
    "The desktop form links the chosen workspace and ignores a late empty refresh without retaining the token field",
  );

  const rotated = await api(
    `execution-workers/${worker.id}/rotate`,
    "POST",
    {},
  );
  tokens.add(rotated.token);
  await page
    .getByRole("button", { name: "Refresh workspace connections" })
    .click();
  await page.getByText("Token required", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Update token", exact: true }).click();
  await form.getByLabel("Runner token", { exact: true }).fill(other.token);
  await form.getByRole("button", { name: "Reconnect", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "another runner" }).waitFor();
  assert.equal(
    (await api(`execution-workers?profileId=${profile.id}`)).workers.find(
      (value) => value.id === other.id,
    ).workspaceBinding,
    null,
  );
  await form.getByLabel("Runner token", { exact: true }).fill(rotated.token);
  await form.getByRole("button", { name: "Reconnect", exact: true }).click();
  await page.getByText("Linked", { exact: true }).waitFor();
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  passed(
    "Credential recovery rejects another runner's token and reconnects the original workspace with a rotated token",
  );

  const nextToken = await api(
    `execution-workers/${worker.id}/rotate`,
    "POST",
    {},
  );
  tokens.add(nextToken.token);
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  const confirmation = page.getByRole("dialog", {
    name: "Disconnect workspace",
    exact: true,
  });
  await confirmation
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  await confirmation
    .getByLabel("Current runner token", { exact: true })
    .waitFor();
  await confirmation
    .getByLabel("Current runner token", { exact: true })
    .fill(nextToken.token);
  await confirmation
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  await page.getByText("Disconnected", { exact: true }).waitFor();
  assert.equal(
    (await api(`execution-workers?profileId=${profile.id}`)).workers.find(
      (value) => value.id === worker.id,
    ).enabled,
    false,
  );
  passed(
    "A disconnect interrupted by token rotation can be completed from the dialog with the current credential",
  );

  const reopened = await api(
    `execution-workers/${worker.id}/rotate`,
    "POST",
    {},
  );
  tokens.add(reopened.token);
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await form.getByLabel("Runner token", { exact: true }).fill(reopened.token);
  await form.getByRole("button", { name: "Reconnect", exact: true }).click();
  await page.getByText("Linked", { exact: true }).waitFor();
  assert.equal(
    (await api(`execution-workers?profileId=${profile.id}`)).workers.find(
      (value) => value.id === worker.id,
    ).enabled,
    true,
  );
  await fixture.restart(async () => {
    await page
      .getByRole("button", { name: "Refresh workspace connections" })
      .click();
    await page.getByText("Cloud unavailable", { exact: true }).waitFor();
  });
  await page
    .getByRole("button", { name: "Refresh workspace connections" })
    .click();
  await page.getByText("Linked", { exact: true }).waitFor();
  passed(
    "A renewed grant reconnects a disconnected workspace and a server outage recovers without losing the link",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => {
    const bounds = document
      .querySelector('[role="dialog"]')
      ?.getBoundingClientRect();
    return (
      bounds &&
      bounds.left >= 0 &&
      bounds.right <= innerWidth &&
      bounds.top >= 0 &&
      bounds.bottom <= innerHeight
    );
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: join(fixture.directory, "desktop-cloud-mobile.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Update token", exact: true }).click();
  const tokenField = form.getByLabel("Runner token", { exact: true });
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("type") === "password",
  );
  assert.equal(
    await tokenField.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return (
        bounds.left >= 0 &&
        bounds.right <= innerWidth &&
        bounds.top >= 0 &&
        bounds.bottom <= innerHeight
      );
    }),
    true,
  );
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "Update token", exact: true })
      .evaluate((element) => document.activeElement === element),
    true,
  );
  await page.getByRole("tab", { name: "Remote access", exact: true }).click();
  await page.getByLabel("Cloud URL", { exact: true }).fill(fixture.origin);
  await page
    .getByLabel("Enrollment key", { exact: true })
    .fill("verification-enrollment-key");
  await page
    .getByLabel("Instance name", { exact: true })
    .fill("Desktop remote access");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByText("Desktop remote access", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "Remote access", exact: true }).focus();
  await page.keyboard.press("ArrowLeft");
  await page.getByText("Linked", { exact: true }).waitFor();
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  assert.deepEqual(fixture.pageErrors, []);
  assert.deepEqual(unexpectedNativeCalls, []);
  passed(
    "The mobile dialog supports keyboard tab switching and retains the existing remote-access enrollment controls",
  );
  await writeFile(
    join(fixture.directory, "desktop-results.json"),
    JSON.stringify(
      {
        checks,
        calls,
        pageErrors: fixture.pageErrors,
        ipc: "Native Rust bridge and packaged CLI; Tauri transport and OS dialogs provided by the Playwright fixture",
        agentExecuted: false,
      },
      null,
      2,
    ),
  );
  process.stdout.write(`Desktop cloud evidence: ${fixture.directory}\n`);
} catch (error) {
  await page
    .screenshot({
      path: join(fixture.directory, "desktop-failure.png"),
      fullPage: true,
    })
    .catch(() => {});
  process.stderr.write(
    `${error instanceof Error ? error.stack : error}\n${fixture.logs()}\n`,
  );
  process.exitCode = 1;
} finally {
  releaseInitial?.();
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await child.finished;
  }
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await fixture.close();
}

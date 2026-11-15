import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { gatewayProtocolVersion } from "@machdoch/fleet-protocol";
import packageJson from "../package.json" with { type: "json" };
import { createTestCloudDatabase } from "../src/server/cloud/test-database.ts";
import { FleetDatabase } from "../src/server/database.ts";
import { initializeInstallation } from "../src/server/cloud/installation-storage.ts";
import { cloudCredentialsCipher } from "../src/server/cloud/credential-storage.ts";
import {
  createCloudRuntime,
  initializeCloudRuntime,
} from "../src/server/cloud/runtime.ts";
import {
  completeSecondFactor,
  passSecondFactor,
} from "./cloud-two-factor-fixture.mjs";
import {
  acceptPasswordInvitation,
  assertEventually,
  cloudApi,
  createPasswordInvitation,
} from "./cloud-browser-fixture.mjs";

const port = Number(process.env.PORT ?? 4322);
const origin = `http://localhost:${port}`;
const output = resolve(
  import.meta.dirname,
  "../../../.tmp/cloud-client-sign-in-verification",
);
const password = randomUUID();

const database = await createTestCloudDatabase();
await new FleetDatabase(database).initialize();
const installation = await initializeInstallation(database);
await initializeCloudRuntime(async () =>
  createCloudRuntime(database, installation.origin ?? "", {
    credentialsCipher: cloudCredentialsCipher(installation.credentials_key),
  }),
);
Object.assign(process.env, {
  PORT: String(port),
  MACHDOCH_CLOUD_LISTEN_ADDRESS: "127.0.0.1",
});
process.argv = [process.argv[0]!, "src/server.ts", "dev"];
await import("../src/server.ts");

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
const newContext = () =>
  browser.newContext({ viewport: { width: 1280, height: 900 } });
const ownerContext = await newContext();
const fixture = {
  origin,
  ownerContext,
  password,
  database: {
    query: (text: string, values?: unknown[]) =>
      database.engine.query(text, values),
  },
};
const checks: string[] = [];

async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - innerWidth,
  );
  assert.ok(overflow <= 1, `${name}: the page overflows by ${overflow}px`);
  await page.screenshot({ path: resolve(output, `${name}.png`) });
  checks.push(name);
}

interface DesktopSignIn {
  startUrl: string;
  result: Promise<"signed-in" | "canceled" | "failed">;
  close: () => void;
}

async function desktopApp(name: string): Promise<DesktopSignIn> {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(24).toString("base64url");
  let settle: (value: "signed-in" | "canceled" | "failed") => void = () =>
    undefined;
  const result = new Promise<"signed-in" | "canceled" | "failed">(
    (done) => (settle = done),
  );
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback" || url.searchParams.get("state") !== state)
      return response.writeHead(404).end();
    let outcome: "signed-in" | "canceled" | "failed" = "canceled";
    const code = url.searchParams.get("code");
    if (code) {
      const enrolled = await fetch(`${origin}/api/enroll`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${code}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          codeVerifier: verifier,
          displayName: name,
          instanceSecret: `mch_instance_${randomBytes(32).toString("base64url")}`,
          productVersion: packageJson.version,
          protocolVersion: gatewayProtocolVersion,
        }),
      });
      outcome = enrolled.ok ? "signed-in" : "failed";
    }
    response
      .writeHead(303, {
        Location: `${origin}/cloud/signed-in?result=${outcome}`,
      })
      .end();
    settle(outcome);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const callback = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
  return {
    startUrl: `${origin}/api/v1/oauth/client-sign-in?${new URLSearchParams({
      redirect_uri: callback,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      name,
    })}`,
    result,
    close: () => server.close(),
  };
}

async function signInFromBrowser(
  context: BrowserContext,
  name: string,
  choose: (page: Page) => Promise<void>,
  screenshot: string,
) {
  const desktop = await desktopApp(name);
  const page = await context.newPage();
  await page.goto(desktop.startUrl);
  await page.getByRole("heading", { name: "Sign in to Machdoch" }).waitFor();
  await page.getByText(name, { exact: true }).waitFor();
  await choose(page);
  await capture(page, screenshot);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "You're signed in" }).waitFor();
  assert.equal(await desktop.result, "signed-in");
  desktop.close();
  return page;
}

try {
  await mkdir(output, { recursive: true });
  await assertEventually(
    async () => (await ownerContext.request.get(`${origin}/healthz`)).ok(),
    () => "The Cloud server did not start.",
    300_000,
  );
  const setup = await ownerContext.request.post(`${origin}/api/v1/auth/setup`, {
    headers: { Origin: origin },
    data: {
      organization: "Northstar Studio",
      name: "Alex Morgan",
      email: "owner@example.test",
      password,
    },
  });
  assert.equal(setup.status(), 201, await setup.text());
  await completeSecondFactor(fixture, ownerContext);

  const laptop = await desktopApp("Alex MacBook");
  const desktopBrowser = await newContext();
  const login = await desktopBrowser.newPage();
  await login.goto(laptop.startUrl);
  await login.waitForURL("**/cloud/login?authorize=**");
  await capture(login, "01-sign-in-required");
  await login.getByLabel("Username or email").fill("owner@example.test");
  await login.getByLabel("Password").fill(password);
  await login.getByRole("button", { name: "Sign in", exact: true }).click();
  await passSecondFactor(fixture, login);
  await login.getByRole("heading", { name: "Sign in to Machdoch" }).waitFor();
  assert.ok(await login.getByLabel("Only me").isChecked());
  await capture(login, "02-consent-personal");
  await login.getByRole("button", { name: "Sign in", exact: true }).click();
  await login.getByRole("heading", { name: "You're signed in" }).waitFor();
  assert.equal(await laptop.result, "signed-in");
  laptop.close();
  await capture(login, "03-signed-in");

  await signInFromBrowser(
    desktopBrowser,
    "Build server",
    async (page) => {
      await page.getByLabel("The organization").check();
      await page
        .getByText("Agent tasks stay off until you allow them.")
        .waitFor();
    },
    "04-consent-organization",
  );

  const invitation = await createPasswordInvitation(fixture, ownerContext, {
    email: "ada@example.test",
    role: "member",
  });
  const adaContext = await newContext();
  await acceptPasswordInvitation(fixture, adaContext, invitation.url, {
    name: "Ada Lovelace",
    password,
  });
  await signInFromBrowser(
    adaContext,
    "Ada ThinkPad",
    async (page) => {
      assert.equal(await page.getByLabel("The organization").count(), 0);
    },
    "05-consent-member",
  );

  const clients = await desktopBrowser.newPage();
  await clients.goto(`${origin}/instances`);
  const devices = clients.getByRole("list", { name: "Devices" });
  await devices.getByText("Alex MacBook").waitFor();
  assert.ok(await devices.getByText("You", { exact: true }).isVisible());
  assert.ok(
    await devices.getByText("Ada Lovelace", { exact: true }).isVisible(),
  );
  await devices.getByText("Organization · Agent tasks off").waitFor();
  await capture(clients, "06-clients-admin");

  await clients
    .getByRole("button", { name: "Details for Build server" })
    .click();
  const dialog = clients.getByRole("dialog");
  await dialog.getByLabel("Who can assign agent tasks").waitFor();
  await capture(clients, "07-agent-access-off");
  await dialog.getByLabel("Who can assign agent tasks").selectOption("people");
  await dialog.getByLabel("Ada Lovelace").check();
  await assertEventually(
    async () => await dialog.getByLabel("Ada Lovelace").isEnabled(),
    () => "Saving agent access did not finish.",
  );
  await capture(clients, "08-agent-access-people");
  await clients.keyboard.press("Escape");
  await devices.getByText("Organization · Agent tasks: 1 person").waitFor();

  await clients.getByRole("button", { name: "Add client" }).click();
  const add = clients.getByRole("dialog");
  await add.getByRole("heading", { name: "Add a client" }).waitFor();
  await capture(clients, "09-add-client");
  await add.getByText("Show more").click();
  await add.getByRole("button", { name: "Create enrollment key" }).waitFor();
  await capture(clients, "10-add-client-key");
  await clients.keyboard.press("Escape");

  const adaClients = await adaContext.newPage();
  await adaClients.goto(`${origin}/instances`);
  const adaDevices = adaClients.getByRole("list", { name: "Devices" });
  await adaDevices.getByText("Ada ThinkPad").waitFor();
  await adaDevices.getByText("Build server").waitFor();
  assert.equal(await adaDevices.getByText("Alex MacBook").count(), 0);
  await capture(adaClients, "11-clients-member");

  const instances = (
    await (await desktopBrowser.request.get(`${origin}/api/instances`)).json()
  ).instances as { instanceId: string; displayName: string }[];
  const adaDevice = instances.find(
    (entry) => entry.displayName === "Ada ThinkPad",
  )!;
  const csrf = (await desktopBrowser.cookies()).find(
    (cookie) => cookie.name === "__Host-machdoch_cloud_csrf",
  )!.value;
  const forbidden = await desktopBrowser.request.post(
    `${origin}/api/fleet/sessions`,
    {
      headers: { Origin: origin, "x-machdoch-cloud-csrf": csrf },
      data: {
        commandId: randomUUID(),
        targets: [{ instanceId: adaDevice.instanceId, workspace: "/repo" }],
      },
    },
  );
  assert.equal(forbidden.status(), 403);
  checks.push("admin-blocked-from-personal-client");

  const canceled = await desktopApp("Spare laptop");
  const cancelPage = await adaContext.newPage();
  await cancelPage.goto(canceled.startUrl);
  await cancelPage.getByRole("button", { name: "Cancel" }).click();
  await cancelPage.getByRole("heading", { name: "Sign-in canceled" }).waitFor();
  assert.equal(await canceled.result, "canceled");
  canceled.close();
  await capture(cancelPage, "12-canceled");

  const workspace = await cloudApi(fixture, adaContext, "workspace");
  assert.equal(workspace.actor.name, "Ada Lovelace");
  console.log(`Verified ${checks.length} checks: ${checks.join(", ")}`);
} catch (error) {
  console.error(error);
  for (const context of browser.contexts())
    for (const page of context.pages())
      await page
        .screenshot({ path: resolve(output, `failure-${randomUUID()}.png`) })
        .catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser.close();
  process.exit(process.exitCode ?? 0);
}

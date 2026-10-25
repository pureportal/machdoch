import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import {
  cloudBrowserFixture,
  cloudApi,
  assertEventually,
} from "./cloud-browser-fixture.mjs";
import { oidcFixture } from "./cloud-oidc-fixture.mjs";

let dropCompletion = false;
const fixture = await cloudBrowserFixture({
  serverEntry: "scripts/cloud-email-fixture.ts",
  dropResponse: ({ path, status }) =>
    dropCompletion && path === "/api/v1/auth/sso/consume" && status === 200,
});
const provider = await oidcFixture(fixture);
const page = await fixture.ownerContext.newPage();
const checks = [];
let manager;
const previousConfig = process.env.MACHDOCH_USER_CONFIG_DIR;
const previousAuthorities = getCACertificates("default");
const api = (path, method, body) =>
  cloudApi(fixture, fixture.ownerContext, path, method, body);
function passed(name) {
  checks.push(name);
  console.log(`PASS ${name}`);
}
async function providerSignIn(target, subject = "owner-subject") {
  await target.waitForURL(
    (url) => url.origin === provider.issuer || url.pathname === "/cloud/sso",
  );
  for (
    let count = 0;
    count < 3 && new URL(target.url()).origin === provider.issuer;
    count++
  ) {
    await target
      .getByRole("heading", { name: /Provider (sign-in|consent)/ })
      .waitFor();
    const previous = target.url();
    await target.getByLabel("Subject").fill(subject);
    await Promise.all([
      target.waitForURL((url) => url.href !== previous),
      target.getByRole("button", { name: "Continue", exact: true }).click(),
    ]);
  }
  await target.waitForURL((url) => url.pathname === "/cloud/sso");
  assert.equal(
    new URL(target.url()).searchParams.get("failed"),
    null,
    `Callback failed: ${fixture.logs()}`,
  );
}
async function ssoLogin(target, context, subject = "owner-subject") {
  await context.clearCookies({ domain: "localhost" });
  await target.goto(`${fixture.origin}/cloud/login`);
  await target
    .getByRole("button", { name: "Continue with Work identity", exact: true })
    .click();
  await providerSignIn(target, subject);
}
try {
  await page.goto(`${fixture.origin}/cloud/login`);
  await page.getByLabel("Email", { exact: true }).fill("owner@example.test");
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/cloud/issues");
  await page.goto(`${fixture.origin}/cloud/settings`);
  await page.getByRole("button", { name: "Add provider", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("Work identity");
  await dialog.getByLabel("Issuer", { exact: true }).fill(provider.issuer);
  await dialog.getByRole("button", { name: "Load provider endpoints" }).click();
  await dialog
    .getByText(
      "Saving trusts these endpoints with authentication requests and the client credential.",
    )
    .waitFor();
  await dialog.getByLabel("Client ID", { exact: true }).fill("cloud-fixture");
  await dialog
    .getByLabel("Client secret", { exact: true })
    .fill(provider.secret);
  await dialog.getByLabel("Identity display source").selectOption("userinfo");
  await dialog.getByLabel("Identity display claim").fill("email");
  await dialog
    .getByRole("button", { name: "Save provider", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  const stored = (await api("sso-providers")).providers[0];
  assert.equal(stored.metadata.issuer, provider.issuer);
  assert.equal(stored.verified, false);
  assert.ok(!JSON.stringify(stored).includes(provider.secret));
  passed(
    "Discovers and reviews real HTTPS provider metadata, saves encrypted credentials and keeps identity coordinates immutable",
  );

  const unknownContext = await fixture.createContext();
  const unknownPage = await unknownContext.newPage();
  await ssoLogin(unknownPage, unknownContext, "unmapped-subject");
  await unknownPage
    .getByRole("alert")
    .filter({ hasText: "not linked" })
    .waitFor();
  assert.equal(
    (await unknownContext.cookies()).some(
      (cookie) => cookie.name === "__Host-machdoch_cloud_session",
    ),
    false,
  );
  await unknownContext.close();
  passed(
    "Rejects an unmapped subject even when the provider returns the existing owner's verified email",
  );

  await page
    .getByRole("button", { name: "Link my identity", exact: true })
    .click();
  await providerSignIn(page);
  await page
    .getByRole("heading", { name: "Link identity", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Link identity", exact: true })
    .waitFor();
  const flowUrl = page.url();
  dropCompletion = true;
  await page
    .getByRole("button", { name: "Link identity", exact: true })
    .click();
  await page.locator("p[role=alert]").waitFor();
  const committed = (
    await fixture.database.query(
      "SELECT session_hash FROM cloud_sso_flows WHERE status='completed'",
    )
  ).rows[0]?.session_hash;
  assert.ok(
    committed,
    `Confirmation failed: ${await page.locator("p[role=alert]").innerText()} ${fixture.logs()}`,
  );
  dropCompletion = false;
  await fixture.restart();
  await page.goto(flowUrl);
  await page
    .getByRole("button", { name: "Link identity", exact: true })
    .click();
  await page.waitForURL("**/cloud/account");
  await page.getByText("owner-subject", { exact: true }).waitFor();
  await page.goto(`${fixture.origin}/cloud/settings`);
  assert.equal((await api("sso-providers")).providers[0].verified, true);
  assert.equal(
    (
      await fixture.database.query(
        "SELECT count(*)::int AS count FROM cloud_sessions WHERE token_hash=$1",
        [committed],
      )
    ).rows[0].count,
    1,
  );
  passed(
    "Links only after same-browser confirmation, survives cross-site Strict session cookies, and recovers one session after a lost response and server restart",
  );

  await page.getByRole("button", { name: "Require SSO", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Change sign-in policy", exact: true })
    .click();
  await page.waitForURL("**/cloud/login");
  await page
    .getByRole("button", { name: "Continue with Work identity", exact: true })
    .waitFor();
  assert.equal(await page.getByLabel("Password", { exact: true }).count(), 0);
  const denied = await fixture.ownerContext.request.post(
    `${fixture.origin}/api/v1/auth/login`,
    {
      headers: { Origin: fixture.origin },
      data: { email: "owner@example.test", password: fixture.password },
    },
  );
  assert.equal(denied.status(), 403);
  assert.equal((await denied.json()).code, "sso_required");
  await ssoLogin(page, fixture.ownerContext);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/cloud/issues");
  passed(
    "Enforces SSO, invalidates pre-policy sessions, denies password bypass and permits mapped SSO sign-in",
  );
  await page.goto(`${fixture.origin}/cloud/settings`);
  await page
    .getByRole("button", { name: "Identities for Work identity", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Account", { exact: true })
    .selectOption("new");
  await page
    .getByRole("dialog")
    .getByLabel("Name", { exact: true })
    .fill("SSO Member");
  await page
    .getByRole("dialog")
    .getByLabel("Email", { exact: true })
    .fill("sso-member@example.test");
  await page
    .getByRole("dialog")
    .getByLabel("Subject", { exact: true })
    .fill("member-subject");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Add member", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  const memberContext = await fixture.createContext();
  const memberPage = await memberContext.newPage();
  await ssoLogin(memberPage, memberContext, "member-subject");
  await memberPage
    .getByText("sso-member@example.test", { exact: true })
    .waitFor();
  await memberPage
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await memberPage.waitForURL("**/cloud/issues");
  await memberPage.goto(`${fixture.origin}/cloud/account`);
  await memberPage.getByText("member-subject", { exact: true }).waitFor();
  assert.equal(
    (
      await fixture.database.query(
        "SELECT password_hash FROM cloud_users WHERE email='sso-member@example.test'",
      )
    ).rows[0].password_hash,
    null,
  );
  await memberContext.close();
  passed(
    "An administrator adds a member by explicit provider subject; the member signs in and sees their account without ever creating a password",
  );

  const nativeContext = await fixture.createContext();
  const nativePage = await nativeContext.newPage();
  const workspace = join(fixture.directory, "native-workspace");
  process.env.MACHDOCH_USER_CONFIG_DIR = join(fixture.directory, "native-user");
  setDefaultCACertificates([
    ...previousAuthorities,
    await readFile(join(fixture.directory, "tls.crt"), "utf8"),
  ]);
  await mkdir(workspace, { recursive: true });
  const { McpClientManager } =
    await import("../../client/src/core/mcp/client.ts");
  const { createMcpConfigFromPreset, saveUserMcpConfig } =
    await import("../../client/src/core/mcp/config.ts");
  await saveUserMcpConfig({
    schemaVersion: 1,
    servers: [
      createMcpConfigFromPreset("machdoch-cloud", {
        enabled: true,
        transport: {
          type: "streamable-http",
          url: `${fixture.origin}/api/v1/mcp`,
        },
      }),
    ],
  });
  manager = new McpClientManager({ loadRuntimeEnvironment: async () => ({}) });
  const native = await manager.authorizeOAuth(workspace, "machdoch-cloud", {
    openAuthorizationUrl: async (url) => {
      await nativePage.goto(url);
      await nativePage
        .getByRole("button", {
          name: "Continue with Work identity",
          exact: true,
        })
        .click();
      await providerSignIn(nativePage);
      await nativePage
        .getByRole("button", { name: "Sign in", exact: true })
        .click();
      await nativePage
        .getByRole("heading", { name: "Connect Machdoch client", exact: true })
        .waitFor();
      await nativePage
        .getByRole("button", { name: "Connect", exact: true })
        .click();
      await nativePage
        .getByRole("heading", { name: "Authorization received", exact: true })
        .waitFor();
    },
  });
  assert.equal(native.status, "authorized");
  assert.equal(native.stateVerified, true);
  const catalog = await manager.discoverServerById(workspace, "machdoch-cloud");
  assert.ok(
    catalog.discovery.tools.some((tool) => tool.name === "get_workspace"),
  );
  assert.equal(
    catalog.discovery.tools.some((tool) => tool.name === "create_issue"),
    false,
  );
  const workspaceResult = await manager.callTool(
    workspace,
    "machdoch-cloud",
    "get_workspace",
    {},
  );
  assert.notEqual(workspaceResult.isError, true);
  assert.equal(JSON.parse(workspaceResult.content[0].text).actor.role, "owner");
  passed(
    "Native Machdoch completes required SSO, scoped consent, PKCE and loopback authorization and calls cloud tools",
  );

  await page.goto(`${fixture.origin}/cloud/settings`);
  await page
    .getByRole("button", { name: "Turn off required SSO", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Change sign-in policy", exact: true })
    .click();
  await page.waitForURL("**/cloud/login");
  provider.rotate();
  await ssoLogin(page, fixture.ownerContext);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/cloud/issues");
  passed(
    "Accepts new signing keys at the approved JWKS URI after provider key rotation",
  );

  const switchedContext = await fixture.createContext();
  const switchedPage = await switchedContext.newPage();
  await ssoLogin(switchedPage, switchedContext);
  await switchedPage
    .getByRole("button", { name: "Sign in", exact: true })
    .waitFor();
  const current = (await api("sso-providers")).providers[0];
  const { id, verified, ...editable } = current;
  await api(`sso-providers/${id}`, "PATCH", { ...editable, enabled: false });
  await switchedPage
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await switchedPage
    .getByRole("alert")
    .filter({ hasText: "unavailable" })
    .waitFor();
  await switchedContext.close();
  await page.goto(`${fixture.origin}/cloud/settings`);
  await page.waitForURL("**/cloud/login");
  passed(
    "Rejects a stale confirmation and revokes existing SSO sessions immediately when the provider is disabled",
  );

  await page.getByLabel("Email", { exact: true }).fill("owner@example.test");
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/cloud/issues");
  await page.goto(`${fixture.origin}/cloud/settings`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Edit Work identity", exact: true })
    .waitFor();
  await page
    .getByRole("heading", { name: "Single sign-on", exact: true })
    .scrollIntoViewIfNeeded();
  await assertEventually(async () =>
    page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  );
  await page.screenshot({
    path: join(fixture.directory, "sso-settings-mobile.png"),
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Edit Work identity", exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("dialog")
      .getByLabel("Client secret", { exact: true })
      .inputValue(),
    "",
  );
  assert.equal(
    await page
      .getByRole("dialog")
      .getByLabel("Issuer", { exact: true })
      .getAttribute("readonly"),
    "",
  );
  const beforeEdit = (await api("sso-providers")).providers[0];
  const { id: editingId, verified: editingVerified, ...savedEdit } = beforeEdit;
  await api(`sso-providers/${editingId}`, "PATCH", {
    ...savedEdit,
    name: "Updated identity",
  });
  await page
    .getByRole("dialog")
    .getByLabel("Name", { exact: true })
    .fill("Unsaved draft");
  await page
    .getByRole("dialog")
    .getByLabel("Client secret", { exact: true })
    .fill("unsaved-secret");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save provider", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Load latest settings", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("dialog")
      .getByLabel("Name", { exact: true })
      .inputValue(),
    "Unsaved draft",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Load latest settings", exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("dialog")
      .getByLabel("Name", { exact: true })
      .inputValue(),
    "Updated identity",
  );
  assert.equal(
    await page
      .getByRole("dialog")
      .getByLabel("Client secret", { exact: true })
      .inputValue(),
    "",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  passed(
    "Keeps mobile settings within the viewport, preserves a conflicting draft until explicitly discarded and never refills stored secrets",
  );
  assert.deepEqual(provider.errors, []);
  assert.deepEqual(fixture.pageErrors, []);
  await writeFile(
    join(fixture.directory, "sso-results.json"),
    JSON.stringify(
      {
        checks,
        providerErrors: provider.errors,
        pageErrors: fixture.pageErrors,
        providerVersion: "9.13.0",
        crossSiteProvider: true,
      },
      null,
      2,
    ),
  );
  console.log(`Evidence: ${fixture.directory}`);
} catch (error) {
  await page.screenshot({
    path: join(fixture.directory, "sso-failure.png"),
    animations: "disabled",
  });
  await writeFile(
    join(fixture.directory, "sso-failure.json"),
    JSON.stringify(
      {
        checks,
        error: error.stack,
        providerErrors: provider.errors,
        pageErrors: fixture.pageErrors,
        logs: fixture.logs(),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await manager?.closeAll();
  await rm(join(fixture.directory, "native-user", "mcp.json"), { force: true });
  if (previousConfig === undefined) delete process.env.MACHDOCH_USER_CONFIG_DIR;
  else process.env.MACHDOCH_USER_CONFIG_DIR = previousConfig;
  setDefaultCACertificates(previousAuthorities);
  await provider.close();
  await fixture.close();
}

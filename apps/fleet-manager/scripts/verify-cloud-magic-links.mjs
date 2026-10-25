import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { SMTPServer } from "smtp-server";
import { writeConsent } from "../../../packages/analytics/src/consent.ts";
import {
  createPasswordInvitation,
  acceptPasswordInvitation,
  assertEventually,
  cloudApi,
  cloudBrowserFixture,
} from "./cloud-browser-fixture.mjs";

let dropConfirmation = false;
let manager;
const previousConfig = process.env.MACHDOCH_USER_CONFIG_DIR;
const previousAuthorities = getCACertificates("default");
const fixture = await cloudBrowserFixture({
  serverEntry: "scripts/cloud-email-fixture.ts",
  dropResponse: ({ path, status }) =>
    dropConfirmation && path === "/api/v1/auth/magic/consume" && status === 200,
});
const owner = await fixture.ownerContext.newPage();
const requesterContext = await fixture.createContext();
const requester = await requesterContext.newPage();
const recipientContext = await fixture.createContext({
  viewport: { width: 390, height: 844 },
});
const recipient = await recipientContext.newPage();
const messages = [],
  checks = [];
let authenticated = 0;
let insecureAuthentication = false;
const password = "smtp-fixture-secret";
const server = new SMTPServer({
  secure: true,
  key: await readFile(join(fixture.directory, "tls.key")),
  cert: await readFile(join(fixture.directory, "tls.crt")),
  logger: false,
  onAuth(auth, session, callback) {
    if (!session.secure) {
      insecureAuthentication = true;
      callback(new Error("TLS required"));
      return;
    }
    if (auth.username !== "smtp-user" || auth.password !== password) {
      callback(
        Object.assign(new Error("Credentials rejected"), { responseCode: 535 }),
      );
      return;
    }
    authenticated++;
    callback(null, { user: "fixture" });
  },
  onData(stream, session, callback) {
    const chunks = [];
    let bytes = 0;
    stream.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes <= 65536) chunks.push(chunk);
    });
    stream.once("end", () => {
      if (bytes > 65536) {
        callback(new Error("Fixture message exceeds its limit"));
        return;
      }
      messages.push({
        recipient: session.envelope.rcptTo[0].address,
        raw: Buffer.concat(chunks).toString("utf8"),
      });
      callback();
    });
    stream.once("error", callback);
  },
});
server.on("error", (error) => {
  if (!["ECONNRESET", "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA"].includes(error.code))
    process.stderr.write(`SMTP fixture: ${error.code ?? error.name}\n`);
});
await new Promise((done, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", done);
});
const port = server.server.address().port;
const api = (path, method, body) =>
  cloudApi(fixture, fixture.ownerContext, path, method, body);
function passed(name) {
  checks.push(name);
  console.log(`PASS ${name}`);
}
function linkFor(index) {
  const raw = messages[index].raw;
  const separator = raw.indexOf("\r\n\r\n");
  const headers = raw.slice(0, separator),
    body = raw.slice(separator + 4);
  const text = /Content-Transfer-Encoding: base64/i.test(headers)
    ? Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf8")
    : body
        .replace(/=\r?\n/g, "")
        .replace(/=([0-9A-F]{2})/gi, (_match, hex) =>
          String.fromCharCode(Number.parseInt(hex, 16)),
        );
  const link = text.match(
    /https:\/\/[^\s]+\/cloud\/sign-in#mch_cloud_magic_[A-Za-z0-9_-]+/u,
  )?.[0];
  assert.ok(link, "The delivered message has no sign-in link");
  return link;
}
async function requestLink(email, context = requesterContext) {
  const before = messages.length;
  await cloudApi(fixture, context, "auth/magic/request", "POST", { email });
  await assertEventually(
    () => messages.length > before,
    () => "Sign-in email was not delivered",
  );
  return linkFor(before);
}
try {
  await api("auth/login", "POST", {
    email: "owner@example.test",
    password: fixture.password,
  });
  const invite = await createPasswordInvitation(fixture, fixture.ownerContext, {
    email: "member@example.test",
    role: "member",
  });
  await acceptPasswordInvitation(fixture, requesterContext, invite.url, {
    name: "Member",
    password: fixture.password,
  });
  await cloudApi(fixture, requesterContext, "auth/logout", "POST", {});
  await owner.goto(`${fixture.origin}/cloud/settings`);
  await owner
    .getByRole("button", { name: "Configure email", exact: true })
    .click();
  const dialog = owner.getByRole("dialog", {
    name: "Email sign-in",
    exact: true,
  });
  await dialog.getByLabel("Host", { exact: true }).fill("127.0.0.1");
  await dialog.getByLabel("Port", { exact: true }).fill(String(port));
  await dialog.getByLabel("Encryption", { exact: true }).selectOption("tls");
  await dialog.getByLabel("Username", { exact: true }).fill("smtp-user");
  await dialog.getByLabel("Password", { exact: true }).fill(password);
  await dialog
    .getByLabel("Sender address", { exact: true })
    .fill("signin@example.test");
  await dialog
    .getByRole("button", { name: "Save email settings", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  await owner
    .getByRole("button", { name: "Check connection", exact: true })
    .click();
  await owner
    .getByRole("status")
    .filter({ hasText: "Connection verified" })
    .waitFor();
  assert.ok(authenticated > 0);
  assert.equal(insecureAuthentication, false);
  const stored = (
    await fixture.database.query("SELECT secret FROM cloud_email_settings")
  ).rows[0].secret;
  assert.equal(stored.includes(Buffer.from(password)), false);
  assert.equal(
    JSON.stringify(await api("email-settings")).includes(password),
    false,
  );
  passed(
    "SMTP settings are encrypted and the configured TLS connection authenticates without sending a message",
  );

  await requester.goto(`${fixture.origin}/cloud/login`);
  await requester
    .getByRole("button", { name: "Email link", exact: true })
    .click();
  await requester
    .getByLabel("Email", { exact: true })
    .fill("member@example.test");
  await requester
    .getByRole("button", { name: "Send sign-in link", exact: true })
    .click();
  await requester
    .getByRole("status")
    .filter({ hasText: "If this account can sign in" })
    .waitFor();
  await assertEventually(() => messages.length === 1);
  const link = linkFor(0),
    token = new URL(link).hash.slice(1);
  const scan = await recipientContext.request.get(link);
  assert.equal(scan.status(), 200);
  assert.equal(
    (
      await fixture.database.query(
        "SELECT count(*)::int AS count FROM cloud_sessions WHERE user_id=(SELECT id FROM cloud_users WHERE email='member@example.test')",
      )
    ).rows[0].count,
    0,
  );
  const consent = [];
  writeConsent(
    { setItem: (key, value) => consent.push([key, value]) },
    "fleet",
    true,
  );
  await recipientContext.addInitScript((entries) => {
    for (const [key, value] of entries) localStorage.setItem(key, value);
  }, consent);
  const external = [];
  let checkingAuthentication = true;
  let tokenInTelemetry = false;
  await recipientContext.route("https://swetrix.pureportal.io/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "{}",
      headers: {
        "Access-Control-Allow-Origin": fixture.origin,
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    }),
  );
  recipient.on("request", (request) => {
    if (new URL(request.url()).origin !== fixture.origin) {
      if (checkingAuthentication) external.push(request.url());
      if (request.url().includes(token) || request.postData()?.includes(token))
        tokenInTelemetry = true;
    }
  });
  const navigation = await recipient.goto(link);
  assert.ok(
    navigation
      .headers()
      ["content-security-policy"].includes("frame-ancestors 'none'"),
  );
  assert.equal(
    navigation.headers()["content-security-policy"].includes("swetrix"),
    false,
  );
  await recipient
    .getByRole("button", { name: "Sign in", exact: true })
    .waitFor();
  await recipient.getByText("member@example.test", { exact: true }).waitFor();
  assert.equal(recipient.url().includes(token), false);
  assert.equal(
    (
      await fixture.database.query(
        "SELECT count(*)::int AS count FROM cloud_magic_links WHERE consumed_at IS NOT NULL",
      )
    ).rows[0].count,
    0,
  );
  assert.equal(
    (await recipientContext.cookies()).find(
      (cookie) => cookie.name === "__Host-machdoch_cloud_magic",
    ).httpOnly,
    true,
  );
  await recipient.reload();
  await recipient
    .getByRole("button", { name: "Sign in", exact: true })
    .waitFor();
  await recipient.screenshot({
    path: join(fixture.directory, "magic-confirmation-mobile.png"),
    fullPage: true,
  });
  assert.deepEqual(external, []);
  checkingAuthentication = false;
  await recipient.getByRole("button", { name: "Sign in", exact: true }).click();
  await recipient.waitForURL(`${fixture.origin}/cloud/issues`);
  assert.equal(
    (await cloudApi(fixture, recipientContext, "workspace")).actor.name,
    "Member",
  );
  assert.equal(tokenInTelemetry, false);
  passed(
    "Scanner GETs and previews do not sign in; cross-device confirmation survives reload and authentication pages make no analytics requests",
  );

  await recipient.goto(link);
  await recipient
    .getByRole("alert")
    .filter({ hasText: "sign-in link is unavailable" })
    .waitFor();
  const expired = await requestLink("member@example.test");
  await fixture.database.query(
    "UPDATE cloud_magic_links SET expires_at=clock_timestamp()-interval '1 second' WHERE id=(SELECT id FROM cloud_magic_links WHERE consumed_at IS NULL AND user_id=(SELECT id FROM cloud_users WHERE email='member@example.test') ORDER BY created_at DESC LIMIT 1)",
  );
  await requester.goto(expired);
  await requester
    .getByRole("alert")
    .filter({ hasText: "sign-in link is unavailable" })
    .waitFor();
  const before = messages.length;
  await cloudApi(fixture, requesterContext, "auth/magic/request", "POST", {
    email: "absent@example.test",
  });
  await assertEventually(
    async () =>
      (
        await fixture.database.query(
          "SELECT count(*)::int AS count FROM cloud_magic_links WHERE user_id IS NULL AND delivery_state='discarded'",
        )
      ).rows[0].count === 1,
  );
  assert.equal(messages.length, before);
  passed(
    "Reused and expired links fail; unknown accounts receive the same request response without receiving mail",
  );

  const switchLink = await requestLink("member@example.test");
  await owner.goto(switchLink);
  await owner
    .getByRole("heading", { name: "Switch account", exact: true })
    .waitFor();
  await owner
    .getByText("You are signed in as owner@example.test.", { exact: true })
    .waitFor();
  assert.equal((await api("workspace")).actor.role, "owner");
  await owner
    .getByRole("button", { name: "Switch account", exact: true })
    .click();
  await owner.waitForURL(`${fixture.origin}/cloud/issues`);
  assert.equal((await api("workspace")).actor.role, "member");
  await api("auth/login", "POST", {
    email: "owner@example.test",
    password: fixture.password,
  });
  passed("An existing session is not silently switched to another account");

  const queued = await requestLink("member@example.test");
  await requester.goto(queued);
  await requester
    .getByRole("button", { name: "Sign in", exact: true })
    .waitFor();
  const confirmationId = new URL(requester.url()).searchParams.get(
    "confirmation",
  );
  dropConfirmation = true;
  await requester.getByRole("button", { name: "Sign in", exact: true }).click();
  await requester
    .getByRole("alert")
    .filter({ hasText: "Cloud did not confirm" })
    .waitFor();
  dropConfirmation = false;
  const issued = (
    await fixture.database.query(
      "SELECT session_hash FROM cloud_magic_confirmations WHERE id=$1",
      [confirmationId],
    )
  ).rows[0].session_hash;
  await fixture.restart();
  await requester.reload();
  await requester
    .getByRole("button", { name: "Sign in", exact: true })
    .waitFor();
  await requester.getByRole("button", { name: "Sign in", exact: true }).click();
  await requester.waitForURL(`${fixture.origin}/cloud/issues`);
  assert.equal(
    (
      await fixture.database.query(
        "SELECT count(*)::int AS count FROM cloud_sessions WHERE token_hash=$1",
        [issued],
      )
    ).rows[0].count,
    1,
  );
  passed(
    "A lost confirmation response survives restart and recovers the same session without reusing the email link",
  );

  await fixture.database.query("TRUNCATE cloud_login_limits");
  const stale = await requestLink("member@example.test");
  const member = (await api("administration")).members.find(
    (entry) => entry.email === "member@example.test",
  );
  await api(`members/${member.id}`, "PATCH", {
    revision: member.revision,
    role: member.role,
    active: false,
  });
  await api(`members/${member.id}`, "PATCH", {
    revision: member.revision + 1,
    role: member.role,
    active: true,
  });
  await requester.goto(stale);
  await requester
    .getByRole("alert")
    .filter({ hasText: "sign-in link is unavailable" })
    .waitFor();
  const fresh = await requestLink("member@example.test");
  await requester.goto(fresh);
  await requester
    .getByRole("button", { name: "Sign in", exact: true })
    .waitFor();
  const confirmationUrl = requester.url();
  await cloudApi(fixture, requesterContext, "auth/logout", "POST", {});
  await requester.goto(confirmationUrl);
  await requester
    .getByRole("alert")
    .filter({ hasText: "sign-in link is unavailable" })
    .waitFor();
  assert.deepEqual(fixture.pageErrors, []);
  passed(
    "Restoring membership does not revive old links or sessions, and logout removes prepared browser confirmations",
  );
  const nativeContext = await fixture.createContext();
  const nativePage = await nativeContext.newPage();
  const nativeDirectory = join(fixture.directory, "native-user");
  const workspace = join(fixture.directory, "native-workspace");
  setDefaultCACertificates([
    ...previousAuthorities,
    await readFile(join(fixture.directory, "tls.crt"), "utf8"),
  ]);
  process.env.MACHDOCH_USER_CONFIG_DIR = nativeDirectory;
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
        .getByRole("button", { name: "Email link", exact: true })
        .click();
      await nativePage
        .getByLabel("Email", { exact: true })
        .fill("owner@example.test");
      const before = messages.length;
      await nativePage
        .getByRole("button", { name: "Send sign-in link", exact: true })
        .click();
      await nativePage
        .getByRole("status")
        .filter({ hasText: "Open it on this device" })
        .waitFor();
      await assertEventually(() => messages.length > before);
      await nativePage.goto(linkFor(before));
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
  const tools = await manager.discoverServerById(workspace, "machdoch-cloud");
  const discoveredNames = tools.discovery.tools.map((tool) => tool.name);
  assert.ok(discoveredNames.includes("get_workspace"));
  assert.equal(discoveredNames.includes("create_issue"), false);
  assert.equal(discoveredNames.includes("start_run"), false);
  const result = await manager.callTool(
    workspace,
    "machdoch-cloud",
    "get_workspace",
    {},
  );
  assert.notEqual(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).actor.role, "owner");
  assert.deepEqual(fixture.pageErrors, []);
  passed(
    "The native Machdoch client completes email sign-in, consent, PKCE and loopback authorization before calling cloud tools",
  );
  await writeFile(
    join(fixture.directory, "magic-link-results.json"),
    JSON.stringify(
      {
        checks,
        messages: messages.length,
        tlsAuthenticatedConnections: authenticated,
      },
      null,
      2,
    ),
  );
  console.log(`Magic-link evidence: ${fixture.directory}`);
} catch (error) {
  dropConfirmation = false;
  await owner.screenshot({
    path: join(fixture.directory, "magic-link-owner-failure.png"),
    fullPage: true,
  });
  await requester.screenshot({
    path: join(fixture.directory, "magic-link-requester-failure.png"),
    fullPage: true,
  });
  console.error(`Magic-link evidence: ${fixture.directory}`);
  throw error;
} finally {
  await manager?.closeAll();
  await rm(join(fixture.directory, "native-user", "mcp.json"), { force: true });
  if (previousConfig === undefined) delete process.env.MACHDOCH_USER_CONFIG_DIR;
  else process.env.MACHDOCH_USER_CONFIG_DIR = previousConfig;
  setDefaultCACertificates(previousAuthorities);
  await new Promise((done) => server.close(done));
  await fixture.close();
}

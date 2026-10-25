import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { SMTPServer } from "smtp-server";
import { verifySmtpConnection } from "../src/server/cloud/auth/smtp.ts";
import {
  assertEventually,
  cloudApi,
  cloudBrowserFixture,
} from "./cloud-browser-fixture.mjs";

const fixture = await cloudBrowserFixture({
  serverEntry: "scripts/cloud-email-fixture.ts",
});
const page = await fixture.ownerContext.newPage();
const previousAuthorities = getCACertificates("default");
const key = await readFile(join(fixture.directory, "tls.key"));
const cert = await readFile(join(fixture.directory, "tls.crt"));
setDefaultCACertificates([...previousAuthorities, cert.toString("utf8")]);
const receivers = [],
  checks = [],
  serverErrors = [];
const password = "transport-fixture-secret";
const api = (path, method, body) =>
  cloudApi(fixture, fixture.ownerContext, path, method, body);
function passed(name) {
  checks.push(name);
  console.log(`PASS ${name}`);
}
async function receiver(mode, paused = false) {
  const authentication = [],
    closed = new Set(),
    greetings = [];
  let resolveConnected;
  const connected = new Promise((done) => {
    resolveConnected = done;
  });
  let messages = 0;
  const server = new SMTPServer({
    key,
    cert,
    secure: mode === "tls",
    logger: false,
    ...(mode === "plain"
      ? {
          disabledCommands: ["STARTTLS"],
          hideSTARTTLS: true,
          allowInsecureAuth: true,
        }
      : {}),
    onConnect(session, callback) {
      resolveConnected(session.id);
      if (paused) greetings.push(callback);
      else callback();
    },
    onClose(session) {
      closed.add(session.id);
    },
    onAuth(auth, session, callback) {
      authentication.push({ secure: session.secure });
      callback(
        auth.username === "smtp-user" && auth.password === password
          ? null
          : new Error("Credentials rejected"),
        { user: "fixture" },
      );
    },
    onData(stream, _session, callback) {
      stream.resume();
      stream.once("end", () => {
        messages++;
        callback();
      });
    },
  });
  server.on("error", (error) => serverErrors.push(error.code ?? error.name));
  receivers.push(server);
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      done();
    });
  });
  return {
    port: server.server.address().port,
    authentication,
    closed,
    connected,
    messages: () => messages,
    release: () => {
      paused = false;
      for (const callback of greetings.splice(0)) callback();
    },
  };
}
function connection(port, security) {
  return {
    host: "127.0.0.1",
    port,
    security,
    tlsName: null,
    username: "smtp-user",
    password,
    from: "signin@example.test",
  };
}
async function rawVerify(revision) {
  const csrf = (await fixture.ownerContext.cookies()).find(
    (cookie) => cookie.name === "__Host-machdoch_cloud_csrf",
  ).value;
  return fixture.ownerContext.request.post(
    `${fixture.origin}/api/v1/email-settings/verify`,
    {
      headers: { Origin: fixture.origin, "x-machdoch-cloud-csrf": csrf },
      data: { revision },
    },
  );
}
try {
  await api("auth/login", "POST", {
    email: "owner@example.test",
    password: fixture.password,
  });
  const starttls = await receiver("starttls");
  const configured = connection(starttls.port, "starttls");
  await api("email-settings", "PATCH", {
    ...configured,
    revision: 0,
    enabled: true,
  });
  await api("email-settings/verify", "POST", { revision: 1 });
  assert.deepEqual(starttls.authentication, [{ secure: true }]);
  assert.equal(starttls.messages(), 0);
  passed(
    "STARTTLS upgrades before authenticating and connection checks send no email",
  );

  const plaintext = await receiver("plain");
  await api("email-settings", "PATCH", {
    ...connection(plaintext.port, "starttls"),
    revision: 1,
    enabled: true,
  });
  const refusal = await rawVerify(2);
  assert.equal(refusal.status(), 422);
  assert.equal((await refusal.json()).code, "email_connection_failed");
  assert.deepEqual(plaintext.authentication, []);
  assert.equal(plaintext.messages(), 0);
  passed("A server without STARTTLS is rejected before receiving credentials");

  const delayed = await receiver("tls", true);
  const delayedConfig = connection(delayed.port, "tls");
  await api("email-settings", "PATCH", {
    ...delayedConfig,
    revision: 2,
    enabled: true,
  });
  const pending = rawVerify(3);
  await delayed.connected;
  assert.equal((await rawVerify(3)).status(), 429);
  await api("email-settings", "PATCH", {
    ...delayedConfig,
    revision: 3,
    from: "changed@example.test",
    enabled: true,
  });
  delayed.release();
  assert.equal((await pending).status(), 409);
  await api("email-settings/verify", "POST", { revision: 4 });
  passed(
    "Connection checks have bounded concurrency and cannot report success for a changed configuration",
  );

  const canceled = await receiver("tls", true);
  const abort = new AbortController();
  const cancellation = verifySmtpConnection(
    connection(canceled.port, "tls"),
    abort.signal,
  );
  const failed = assert.rejects(
    cancellation,
    (error) => error.name === "AbortError",
  );
  const canceledId = await canceled.connected;
  abort.abort();
  await failed;
  await assertEventually(() => canceled.closed.has(canceledId));
  canceled.release();
  const timeout = await receiver("tls", true);
  const timed = verifySmtpConnection(connection(timeout.port, "tls"));
  const timedResult = assert.rejects(
    timed,
    (error) => error.code === "timeout",
  );
  const timedId = await timeout.connected;
  await timedResult;
  await assertEventually(() => timeout.closed.has(timedId));
  timeout.release();
  passed(
    "Cancellation and a stalled SMTP greeting terminate the worker's connection",
  );

  await page.goto(`${fixture.origin}/cloud/settings`);
  await page
    .getByRole("button", { name: "Edit email settings", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Email sign-in",
    exact: true,
  });
  await dialog
    .getByLabel("Sender address", { exact: true })
    .fill("draft@example.test");
  await api("email-settings", "PATCH", {
    ...delayedConfig,
    revision: 4,
    from: "latest@example.test",
    enabled: true,
  });
  await dialog
    .getByRole("button", { name: "Save email settings", exact: true })
    .click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "Email settings changed" })
    .waitFor();
  assert.equal(
    await dialog.getByLabel("Sender address", { exact: true }).inputValue(),
    "draft@example.test",
  );
  await dialog
    .getByRole("button", { name: "Save email settings", exact: true })
    .click();
  assert.equal(
    (await api("email-settings")).settings.from,
    "latest@example.test",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Edit email settings", exact: true })
    .click();
  assert.equal(
    await dialog.getByLabel("Sender address", { exact: true }).inputValue(),
    "latest@example.test",
  );
  assert.equal(
    await dialog.getByLabel("Password", { exact: true }).inputValue(),
    "",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(fixture.directory, "email-settings-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
  assert.deepEqual(fixture.pageErrors, []);
  assert.ok(
    serverErrors.every((code) => ["ECONNRESET", "ETIMEDOUT"].includes(code)),
    JSON.stringify(serverErrors),
  );
  passed(
    "Stale email settings preserve the draft, require a fresh review and never refill the password field",
  );
  await writeFile(
    join(fixture.directory, "email-transport-results.json"),
    JSON.stringify({ checks, serverErrors }, null, 2),
  );
  console.log(`Email transport evidence: ${fixture.directory}`);
} catch (error) {
  await page.screenshot({
    path: join(fixture.directory, "email-transport-failure.png"),
    fullPage: true,
  });
  console.error(`Email transport evidence: ${fixture.directory}`);
  throw error;
} finally {
  for (const server of receivers)
    if (server.server.listening)
      await new Promise((done) => server.close(done));
  setDefaultCACertificates(previousAuthorities);
  await fixture.close();
}

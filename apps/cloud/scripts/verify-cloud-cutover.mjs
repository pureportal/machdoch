import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocket } from "ws";
import {
  gatewayProtocolVersion,
  productCapability,
} from "@machdoch/fleet-protocol";
import { createSecret } from "../src/server/crypto.ts";
import {
  cloudBrowserFixture,
  assertEventually,
} from "./cloud-browser-fixture.mjs";
import { createMobileDevice } from "./mobile-device-fixture.mjs";

const fixture = await cloudBrowserFixture({ initialize: false });
const page = await fixture.ownerContext.newPage();
const checks = [];
let socket;
const remoteApi = async (path, method = "GET", data) => {
  const csrf = (await fixture.ownerContext.cookies()).find(
    (cookie) => cookie.name === "__Host-machdoch_cloud_csrf",
  );
  const response = await fixture.ownerContext.request.fetch(
    `${fixture.origin}/api/${path}`,
    {
      method,
      headers: {
        Origin: fixture.origin,
        "X-Machdoch-Cloud-CSRF": csrf?.value ?? "",
      },
      ...(data === undefined ? {} : { data }),
    },
  );
  assert.ok(
    response.ok(),
    `${path}: ${response.status()} ${await response.text()}`,
  );
  return response.json();
};

try {
  await page.goto(fixture.origin);
  await page.waitForURL("**/cloud/setup");
  await page
    .getByLabel("Organization", { exact: true })
    .fill("Cutover verification");
  await page.getByLabel("Name", { exact: true }).fill("Owner");
  await page.getByLabel("Email", { exact: true }).fill("owner@example.test");
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page
    .getByRole("button", { name: "Create organization", exact: true })
    .click();
  await page.waitForURL("**/cloud/issues");
  checks.push("First-run browser setup with generated persisted credentials");
  await page
    .getByRole("navigation", { name: "Cloud navigation" })
    .getByRole("link", { name: "Clients", exact: true })
    .click();
  await page.getByRole("heading", { name: "Clients", exact: true }).waitFor();
  assert.equal(
    await page.getByText("Fleet Manager", { exact: true }).count(),
    0,
  );
  await page
    .getByRole("button", { name: "Enroll device", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Create enrollment key", exact: true })
    .click();
  const key = await dialog
    .getByLabel("Enrollment key", { exact: true })
    .inputValue();
  const instanceSecret = createSecret("mch_instance");
  const enrollment = await fixture.ownerContext.request.post(
    `${fixture.origin}/api/enroll`,
    {
      headers: { Authorization: `Bearer ${key}` },
      data: {
        instanceSecret,
        displayName: "Cutover workstation",
        productVersion: "36.0.0",
        protocolVersion: gatewayProtocolVersion,
      },
    },
  );
  assert.ok(enrollment.ok(), await enrollment.text());
  const { instanceId, managerId } = await enrollment.json();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  const connect = async () => {
    socket = new WebSocket(
      `${fixture.origin.replace("https:", "wss:")}/api/gateway/connect/${instanceId}`,
      {
        headers: { Authorization: `Bearer ${instanceSecret}` },
        rejectUnauthorized: false,
      },
    );
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    createMobileDevice(socket);
    socket.send(
      JSON.stringify({
        type: "hello",
        instanceId,
        protocolVersion: gatewayProtocolVersion,
        productVersion: "36.0.0",
        capabilities: [productCapability, "workspace-tools.v1"],
      }),
    );
    await assertEventually(async () =>
      (await remoteApi("instances")).instances.some(
        (instance) =>
          instance.instanceId === instanceId && instance.status === "online",
      ),
    );
  };
  await connect();
  await page.getByRole("button", { name: "Refresh devices" }).click();
  await page
    .getByRole("button", { name: "Cutover workstation", exact: true })
    .waitFor();
  await page.screenshot({
    path: join(fixture.directory, "cutover-clients-desktop.png"),
    fullPage: true,
  });
  await page.goto(
    `${fixture.origin}/instances/${instanceId}?session=session-1`,
  );
  await page
    .getByRole("textbox", { name: "Task composer", exact: true })
    .waitFor();
  checks.push(
    "Cloud session opens enrolled client controls over the WebSocket gateway",
  );
  socket.terminate();
  fixture.environment.MACHDOCH_CLOUD_ENCRYPTION_KEY = undefined;
  fixture.environment.MACHDOCH_CLOUD_ORIGIN = undefined;
  await fixture.restart();
  await connect();
  const identity = await fixture.database.query(
    "SELECT value FROM remote.metadata WHERE key='manager_id'",
  );
  assert.equal(identity.rows[0].value, managerId);
  await page.goto(`${fixture.origin}/instances`);
  await page.getByRole("heading", { name: "Clients", exact: true }).waitFor();
  checks.push(
    "Cloud login, installation identity and device credentials survive restart",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Cutover workstation", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Refresh devices", disabled: false })
    .waitFor();
  assert.ok(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth + 1,
    ),
  );
  await page.screenshot({
    path: join(fixture.directory, "cutover-clients-mobile.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Cutover workstation", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Revoke device", exact: true })
    .click();
  const closed = new Promise((resolve) => socket.once("close", resolve));
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Revoke device", exact: true })
    .click();
  await closed;
  await assertEventually(
    async () =>
      (await remoteApi("instances")).instances.find(
        (instance) => instance.instanceId === instanceId,
      )?.status === "revoked",
  );
  checks.push(
    "Mobile client controls revoke credentials and disconnect the device",
  );
  assert.deepEqual(fixture.pageErrors, []);
  await writeFile(
    join(fixture.directory, "cutover-result.json"),
    JSON.stringify({ passed: true, checks }, null, 2),
  );
  console.log(
    JSON.stringify(
      { passed: true, checks, directory: fixture.directory },
      null,
      2,
    ),
  );
} catch (error) {
  await page
    .screenshot({
      path: join(fixture.directory, "cutover-failure.png"),
      fullPage: true,
    })
    .catch(() => undefined);
  console.error(fixture.logs());
  throw error;
} finally {
  socket?.terminate();
  await fixture.close();
}

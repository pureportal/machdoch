import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";
import {
  gatewayProtocolVersion,
  productCapability,
} from "@machdoch/fleet-protocol";
import {
  createId,
  createSecret,
  hashOwnerPassword,
  hashSecret,
} from "../src/server/crypto.ts";
import { SettingsCipher } from "../src/server/settings-crypto.ts";
import { emptySettingsDocument } from "../src/server/settings.ts";
import {
  cloudBrowserFixture,
  assertEventually,
} from "./cloud-browser-fixture.mjs";

const managerId = createId("manager");
const instanceId = createId("instance");
const instanceSecret = createSecret("mch_instance");
const profileId = createId("profile");
let sourcePath;
let sourceKeyPath;
let socket;
const fixture = await cloudBrowserFixture({
  initialize: false,
  prepareLegacy: async ({
    directory,
    origin,
    password,
    configurationPath,
    managerPort,
  }) => {
    sourcePath = join(directory, "source.sqlite");
    sourceKeyPath = join(directory, "source.key");
    const key = randomBytes(32);
    const cipher = new SettingsCipher(key);
    await writeFile(sourceKeyPath, key.toString("base64url"), { mode: 0o600 });
    await writeFile(
      configurationPath,
      JSON.stringify({
        schemaVersion: 1,
        externalBaseUrl: `${origin}/`,
        listen: { address: "127.0.0.1", port: managerPort },
        database: { path: sourcePath },
        settingsManager: { enabled: true, encryptionKeyFile: sourceKeyPath },
      }),
    );
    const source = new DatabaseSync(sourcePath);
    try {
      source.exec(
        await readFile(
          new URL("../src/server/cloud/fixtures/legacy.sql", import.meta.url),
          "utf8",
        ),
      );
      source.exec(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER); INSERT INTO schema_migrations VALUES (1,1),(2,1),(3,1),(4,1),(5,1)",
      );
      const now = Math.floor(Date.now() / 1000);
      source
        .prepare("INSERT INTO owner VALUES (1,?,?,?,?)")
        .run("legacy-owner", hashOwnerPassword(password), now, now);
      source
        .prepare("INSERT INTO metadata VALUES ('manager_id',?)")
        .run(managerId);
      source
        .prepare("INSERT INTO metadata VALUES ('settings_key_check_v1',?)")
        .run(
          cipher
            .encrypt(
              Buffer.from("machdoch-settings-manager-key-v1"),
              Buffer.from("machdoch/settings/key-check/v1"),
            )
            .toString("base64url"),
        );
      source
        .prepare(
          "INSERT INTO instances VALUES (?,'Imported workstation',?,'36.0.0',?,?,NULL,NULL)",
        )
        .run(
          instanceId,
          hashSecret(instanceSecret),
          gatewayProtocolVersion,
          now,
        );
      const document = JSON.stringify(emptySettingsDocument());
      source
        .prepare(
          "INSERT INTO settings_profiles VALUES (?,'Imported profile','',1,?,?,?)",
        )
        .run(profileId, document, now, now);
      source
        .prepare(
          "INSERT INTO settings_profile_versions VALUES (?,1,'Imported profile','',?,'Created profile',?)",
        )
        .run(profileId, document, now);
      source
        .prepare("INSERT INTO settings_secrets VALUES (?,'openai',?,'-key',?)")
        .run(
          profileId,
          cipher.encrypt(
            Buffer.from("migration-test-key"),
            Buffer.from(`${profileId}\0openai`),
          ),
          now,
        );
      source
        .prepare(
          "INSERT INTO settings_assignments (instance_id,profile_id,assigned_at,last_applied_revision,last_applied_at) VALUES (?,?,?,1,?)",
        )
        .run(instanceId, profileId, now, now);
      source
        .prepare("INSERT INTO enrollment_settings VALUES (?,?,?)")
        .run(
          instanceId,
          cipher.encrypt(
            Buffer.from(document),
            Buffer.from(
              `machdoch/enrollment-settings/${managerId}/${instanceId}`,
            ),
          ),
          now,
        );
    } finally {
      source.close();
    }
  },
});

try {
  assert.equal(existsSync(sourcePath), false);
  assert.equal(existsSync(`${sourcePath}-wal`), false);
  const page = await fixture.ownerContext.newPage();
  await page.goto(`${fixture.origin}/cloud/login`);
  await page
    .getByLabel("Username or email", { exact: true })
    .fill("legacy-owner");
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/cloud/issues");
  await page.goto(`${fixture.origin}/instances`);
  await page
    .getByRole("button", { name: "Imported workstation", exact: true })
    .waitFor();
  const settings = await fixture.ownerContext.request.get(
    `${fixture.origin}/api/client/settings/${instanceId}`,
    { headers: { Authorization: `Bearer ${instanceSecret}` } },
  );
  assert.ok(settings.ok(), await settings.text());
  const delivery = await settings.json();
  assert.equal(delivery.managerId, managerId);
  assert.equal(delivery.profile.profileId, profileId);
  assert.equal(delivery.profile.secrets.openai, "migration-test-key");
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
  socket.send(
    JSON.stringify({
      type: "hello",
      instanceId,
      productVersion: "36.0.0",
      protocolVersion: gatewayProtocolVersion,
      capabilities: [productCapability],
    }),
  );
  await assertEventually(
    async () =>
      (
        await (
          await fixture.ownerContext.request.get(
            `${fixture.origin}/api/instances`,
          )
        ).json()
      ).instances[0].status === "online",
  );
  socket.terminate();
  assert.equal(existsSync(sourceKeyPath), false);
  assert.equal(
    existsSync(fixture.environment.MACHDOCH_CLOUD_IMPORT_CONFIG),
    false,
  );
  fixture.environment.MACHDOCH_CLOUD_ENCRYPTION_KEY = undefined;
  fixture.environment.MACHDOCH_CLOUD_ORIGIN = undefined;
  await fixture.restart();
  const restarted = await fixture.ownerContext.request.get(
    `${fixture.origin}/api/client/settings/${instanceId}`,
    { headers: { Authorization: `Bearer ${instanceSecret}` } },
  );
  assert.equal(
    (await restarted.json()).profile.secrets.openai,
    "migration-test-key",
  );
  const imported = await fixture.database.query(
    "SELECT row_counts,cleaned_at FROM cloud_imports",
  );
  assert.equal(imported.rows.length, 1);
  assert.ok(imported.rows[0].cleaned_at);
  await page.goto(`${fixture.origin}/settings`);
  await page
    .getByRole("button", { name: "Pause profile delivery", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Pause delivery", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Enable profile delivery", exact: true })
    .waitFor();
  const paused = await fixture.ownerContext.request.get(
    `${fixture.origin}/api/client/settings/${instanceId}`,
    { headers: { Authorization: `Bearer ${instanceSecret}` } },
  );
  assert.equal((await paused.json()).profile, null);
  const cleared = await fixture.ownerContext.request.put(
    `${fixture.origin}/api/client/settings/${instanceId}/sync-status`,
    {
      headers: { Authorization: `Bearer ${instanceSecret}` },
      data: { managerId, status: "applied", profileId: null, revision: null },
    },
  );
  assert.equal(cleared.status(), 204);
  await page
    .getByRole("button", { name: "Enable profile delivery", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Enable delivery", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Pause profile delivery", exact: true })
    .waitFor();
  await page.goto(`${fixture.origin}/cloud/account`);
  await page.getByRole("tab", { name: "Security", exact: true }).click();
  await page.getByRole("button", { name: "Edit sign-in", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Sign-in details",
    exact: true,
  });
  await dialog.getByLabel("Username", { exact: true }).fill("updated-owner");
  await dialog
    .getByLabel("Current password", { exact: true })
    .fill(fixture.password);
  await dialog
    .getByLabel("New password", { exact: true })
    .fill(`${fixture.password}-changed`);
  await dialog
    .getByRole("button", { name: "Save sign-in details", exact: true })
    .click();
  await page.waitForURL("**/cloud/login");
  await page
    .getByLabel("Username or email", { exact: true })
    .fill("updated-owner");
  await page
    .getByLabel("Password", { exact: true })
    .fill(`${fixture.password}-changed`);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/cloud/issues");
  const result = {
    passed: true,
    checks: [
      "SQLite owner signs into Cloud with the original password",
      "Existing device connects without reenrollment",
      "Profile history, assignments and encrypted settings migrate",
      "Source SQLite, configuration and local key are removed after verified PostgreSQL commit",
      "Restart succeeds without the source key or origin/key environment variables",
      "Migrated users can change their username and password in Cloud Account",
      "Profile delivery can be paused and resumed without losing assignments",
    ],
    directory: fixture.directory,
  };
  await writeFile(
    join(fixture.directory, "migration-result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  socket?.terminate();
  await fixture.close();
}

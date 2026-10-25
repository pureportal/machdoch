import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createPasswordInvitation,
  acceptPasswordInvitation,
  assertEventually,
  cloudApi,
  cloudBrowserFixture,
} from "./cloud-browser-fixture.mjs";

const fixture = await cloudBrowserFixture();
const page = await fixture.ownerContext.newPage();
const api = (path, method, body) =>
  cloudApi(fixture, fixture.ownerContext, path, method, body);
const checks = [];
const secret = "fixture-api-key-never-returned";
function passed(name) {
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}
const dialog = page.getByRole("dialog");
try {
  await api("auth/login", "POST", {
    email: "owner@example.test",
    password: fixture.password,
  });
  await page.goto(`${fixture.origin}/cloud/settings`);
  await page.getByRole("link", { name: "AI providers", exact: true }).click();
  await page.getByRole("button", { name: "Add provider", exact: true }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Development provider");
  await dialog.getByLabel("API key", { exact: true }).fill(secret);
  await dialog
    .getByLabel("Models", { exact: true })
    .fill("fixture-model\nfixture-fast-model");
  let dropped = false;
  await page.route("**/api/v1/ai-providers", async (route) => {
    if (route.request().method() === "POST" && !dropped) {
      dropped = true;
      await route.fetch();
      await route.abort("connectionclosed");
    } else await route.continue();
  });
  await dialog
    .getByRole("button", { name: "Save provider", exact: true })
    .click();
  await dialog.getByRole("alert").waitFor();
  assert.equal(
    await dialog.getByLabel("API key", { exact: true }).inputValue(),
    secret,
  );
  await dialog
    .getByRole("button", { name: "Save provider", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  await page.unroute("**/api/v1/ai-providers");
  const metadata = await api("ai-providers?view=manage");
  assert.equal(metadata.providers.length, 1);
  assert.equal(JSON.stringify(metadata).includes(secret), false);
  const stored = await fixture.database.query(
    "SELECT secret FROM cloud_ai_providers",
  );
  assert.equal(stored.rows[0].secret.includes(Buffer.from(secret)), false);
  passed(
    "Provider creation survives a lost response without duplication or credential exposure",
  );

  await page
    .getByRole("button", { name: "Edit provider", exact: true })
    .click();
  assert.equal(await dialog.getByLabel("API key", { exact: true }).count(), 0);
  await dialog.getByLabel("Name", { exact: true }).fill("Updated provider");
  await dialog
    .getByRole("button", { name: "Save provider", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  await page
    .getByRole("heading", { name: "Updated provider", exact: true })
    .waitFor();
  assert.deepEqual(
    (await fixture.database.query("SELECT secret FROM cloud_ai_providers"))
      .rows[0].secret,
    stored.rows[0].secret,
  );
  await page
    .getByRole("button", { name: "Edit provider", exact: true })
    .click();
  await dialog
    .getByRole("checkbox", { name: "Replace API key", exact: true })
    .check();
  await dialog
    .getByLabel("API key", { exact: true })
    .fill("replacement-fixture-key");
  await dialog
    .getByRole("button", { name: "Save provider", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  await assertEventually(
    async () =>
      (await api("ai-providers?view=manage")).providers[0].revision === 3,
  );
  assert.notDeepEqual(
    (await fixture.database.query("SELECT secret FROM cloud_ai_providers"))
      .rows[0].secret,
    stored.rows[0].secret,
  );
  passed(
    "Ordinary edits preserve credentials and explicit replacement rotates the ciphertext",
  );

  await page.reload();
  await page
    .getByRole("button", { name: "Edit provider", exact: true })
    .click();
  await dialog.getByLabel("Status", { exact: true }).selectOption("false");
  await dialog
    .getByRole("button", { name: "Save provider", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByText("Disabled", { exact: true }).waitFor();
  assert.deepEqual((await api("ai-providers")).providers, []);
  await fixture.restart();
  await page.reload();
  await page
    .getByRole("heading", { name: "Updated provider", exact: true })
    .waitFor();
  await page.getByText("Disabled", { exact: true }).waitFor();
  passed(
    "Disabled connections are excluded from available providers and settings survive restart",
  );

  const invitation = await createPasswordInvitation(
    fixture,
    fixture.ownerContext,
    {
      email: "member@example.test",
      role: "member",
    },
  );
  const member = await fixture.createContext();
  await acceptPasswordInvitation(fixture, member, invitation.url, {
    name: "Member",
    password: fixture.password,
  });
  const forbidden = await member.request.get(
    `${fixture.origin}/api/v1/ai-providers?view=manage`,
  );
  assert.equal(forbidden.status(), 403);
  const memberPage = await member.newPage();
  await memberPage.goto(`${fixture.origin}/cloud/providers`);
  await memberPage.waitForURL("**/cloud/issues");
  passed("Provider administration is unavailable to ordinary members");

  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: join(fixture.directory, "providers-mobile.png"),
    fullPage: true,
  });
  assert.deepEqual(fixture.pageErrors, []);
  await writeFile(
    join(fixture.directory, "results.json"),
    JSON.stringify(
      {
        checks,
        pageErrors: fixture.pageErrors,
        scope:
          "Provider configuration and credential storage; no live inference request.",
      },
      null,
      2,
    ),
  );
  process.stdout.write(`Evidence: ${fixture.directory}\n`);
} catch (error) {
  await page
    .screenshot({
      path: join(fixture.directory, "failure.png"),
      fullPage: true,
    })
    .catch(() => {});
  process.stderr.write(`${fixture.logs()}\nEvidence: ${fixture.directory}\n`);
  throw error;
} finally {
  await fixture.close();
}
